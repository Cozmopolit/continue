import { BoardPendingResult, IDE } from "..";
import { MCPManagerSingleton } from "../context/mcp/MCPManagerSingleton";

import {
  BoardState,
  cursorAfterConsume,
  loadBoardState,
  saveBoardState,
} from "./boardState";

// Board auto-topic-injection (board-auto-topic-injection.md): gateway access.
// MsgBoard v2 (msgboard-v2-fork-packages.md): registration + one-shot
// migration + mode (b) consumption against the frozen contract in
// 02-board-state-watcher.md. Deployment-order safe by construction: every v2
// step fails closed into the proven mode (a), so this build works against
// pre-[4] and post-[4] CITT builds alike.

/**
 * Finds the connected board-capable CITT server. The `board` capability
 * piggybacks on the `proxy/capabilities` response fetched during connect.
 */
export function findBoardConnection() {
  for (const connection of MCPManagerSingleton.getInstance().connections.values()) {
    if (
      connection.status === "connected" &&
      connection.proxyCapabilities?.board
    ) {
      return connection;
    }
  }
  return undefined;
}

/** Structural type for the board gateway surface this module drives. */
type BoardConnection = NonNullable<ReturnType<typeof findBoardConnection>>;

const EMPTY_RESULT: BoardPendingResult = { messages: [], latestByTopic: {} };

/**
 * Registers the workspace's board handle on the given connection. CITT's
 * registry is process-scoped, so this must run (idempotently) on every
 * connection before `boardMigrateImport` or mode (b) `boardPending`.
 * Best-effort: failure keeps mode (a) alive and never blocks a run.
 */
async function ensureBoardRegistration(
  connection: BoardConnection,
  handle: string,
): Promise<boolean> {
  try {
    await connection.boardRegister(handle);
    return true;
  } catch (e) {
    console.warn(
      `Board registration failed (mode (a) stays active): ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
    return false;
  }
}

/**
 * One-shot v2 migration: pushes the workspace's subscriptions and cursors to
 * the gateway (`boardMigrateImport`, idempotent server-side), then flips the
 * store's `migrated` flag via the reload-before-save pattern. Returns whether
 * the workspace is migrated afterwards. On RPC failure the flag is untouched
 * (retry on the next run, mode (a) stays active).
 */
async function runBoardMigration(
  ide: IDE,
  connection: BoardConnection,
  state: BoardState,
): Promise<boolean> {
  try {
    await connection.boardMigrateImport(
      state.topics.map((topic) => ({
        topic,
        sinceId: state.cursor,
        subscribed: true,
      })),
    );
  } catch (e) {
    console.warn(
      `Board migration deferred, mode (a) stays active: ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
    return false;
  }
  const fresh = await loadBoardState(ide);
  if (!fresh) {
    // Store removed during the RPC: the import ran, but there is nothing to
    // flag — respect the removal and stay on mode (a).
    return false;
  }
  fresh.migrated = true;
  await saveBoardState(ide, fresh);
  return true;
}

/**
 * Run-start consumption: fetch pending messages for the workspace's
 * subscriptions and advance the persisted cursor. On v2 gateways this first
 * registers the handle and runs the one-shot migration, then consumes via
 * mode (b) (server-resolved subscriptions); any failure on that path falls
 * back to the proven mode (a). Best-effort by contract — every failure path
 * returns an empty result so a run is never blocked.
 */
export async function consumeBoardPending(
  ide: IDE,
): Promise<BoardPendingResult> {
  try {
    const state = await loadBoardState(ide);
    if (!state || state.topics.length === 0) {
      return EMPTY_RESULT;
    }
    const connection = findBoardConnection();
    if (!connection) {
      console.warn(
        "Board injection skipped: no board-capable MCP server connected",
      );
      return EMPTY_RESULT;
    }

    // v2 path: register on every connection (process-scoped registry), then
    // migrate once. Mode (b) requires BOTH to hold on this tick — without a
    // live registration the gateway would resolve subscriptions under a
    // fallback identity (wrong agent on shared instances).
    let useServerResolved = false;
    if (connection.proxyCapabilities?.boardV2) {
      const registered = await ensureBoardRegistration(
        connection,
        state.handle,
      );
      if (registered) {
        useServerResolved =
          state.migrated === true ||
          (await runBoardMigration(ide, connection, state));
      }
    }

    const result = useServerResolved
      ? await connection.boardPending() // mode (b): no topics, no sinceId
      : await connection.boardPending(state.topics, state.cursor);
    if (result.messages.length > 0) {
      const consumedCursor = cursorAfterConsume(state.cursor, result.messages);
      // Reload before saving: the RPC window (up to 5 s) allows concurrent
      // subscribe/unsubscribe/consume operations (other sessions on the same
      // workspace, tool calls, manual edits) to mutate the file. The fresh
      // topic list is authoritative; the cursor only moves forward. The
      // cursor keeps advancing under mode (b) too — it is the fallback
      // source whenever a later tick drops back to mode (a).
      const fresh = await loadBoardState(ide);
      if (fresh) {
        fresh.cursor = Math.max(fresh.cursor, consumedCursor);
        await saveBoardState(ide, fresh);
      }
      // fresh === undefined: the state file was removed during the RPC —
      // respect that and do not resurrect it.
    }
    return result;
  } catch (e) {
    console.warn(
      `Board injection skipped: ${e instanceof Error ? e.message : String(e)}`,
    );
    return EMPTY_RESULT;
  }
}

/**
 * Init-mode fetch (no sinceId): returns only `latestByTopic`. Used by
 * `board_subscribe` to bootstrap the cursor ("from now on", no backlog
 * dump). Undefined when no board-capable server is connected.
 */
export async function fetchBoardLatest(
  topics: string[],
): Promise<BoardPendingResult | undefined> {
  const connection = findBoardConnection();
  if (!connection) {
    return undefined;
  }
  return await connection.boardPending(topics);
}

/**
 * Propagates a subscription change to the gateway once the workspace is
 * migrated: mode (b) resolves subscriptions server-side, so a store-only
 * change would be invisible there. Uses the same idempotent
 * `boardMigrateImport` upsert/remove seam (frozen contract).
 *
 * Failure handling is asymmetric by design:
 * - subscribe (subscribed=true): clears the `migrated` flag, so the next
 *   consumption run re-migrates the FULL topic list and self-heals the drift.
 * - unsubscribe (subscribed=false): a full re-migration cannot express
 *   removals (upsert-only), so the flag stays and the caller surfaces the
 *   failure (possible over-delivery until the change is retried).
 *
 * Returns true when the change is synced or syncing is not applicable
 * (not migrated / no v2 gateway); false when a required sync failed.
 */
export async function syncBoardSubscription(
  ide: IDE,
  topic: string,
  subscribed: boolean,
): Promise<boolean> {
  try {
    const state = await loadBoardState(ide);
    if (!state || state.migrated !== true) {
      // Pre-migration: the gateway has no subscription state for this
      // workspace yet — the migration itself will carry it over.
      return true;
    }
    const connection = findBoardConnection();
    if (!connection || !connection.proxyCapabilities?.boardV2) {
      return true; // downgraded/absent gateway: mode (a) semantics apply
    }
    if (!(await ensureBoardRegistration(connection, state.handle))) {
      throw new Error("registration failed");
    }
    await connection.boardMigrateImport([
      { topic, sinceId: state.cursor, subscribed },
    ]);
    return true;
  } catch (e) {
    if (subscribed) {
      // Self-heal: drop the flag so the next run re-migrates everything
      // (including the new topic). Save errors here are logged and ignored —
      // worst case the flag lingers and the drift persists visibly.
      try {
        const fresh = await loadBoardState(ide);
        if (fresh && fresh.migrated === true) {
          delete fresh.migrated;
          await saveBoardState(ide, fresh);
        }
      } catch (resetError) {
        console.warn(
          `Board migration-flag reset failed: ${
            resetError instanceof Error
              ? resetError.message
              : String(resetError)
          }`,
        );
      }
    }
    console.warn(
      `Board subscription sync failed (${topic}, subscribed=${subscribed}): ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
    return false;
  }
}
