import { BoardAck, BoardPendingResult, IDE } from "..";
import { MCPManagerSingleton } from "../context/mcp/MCPManagerSingleton";

import { loadBoardState } from "./boardState";

// MsgBoard consumption (msgboard-v2-fork-packages.md): subscriptions live
// SERVER-SIDE and are managed via CITT's subscription tools; the fork
// contributes only its handle (from `.continue/board-state.json`), registers
// it and fetches the server-resolved pending messages (`board/pending`
// without topics/sinceId). Best-effort by contract: every failure path
// returns the empty result so a run is never blocked.

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

// Board handle registration at connection setup (msgboard-v2-fork-packages.md,
// Revision 2026-08-21): identity is infrastructure, not a feature — the
// registration must never depend on the board-watch toggle. CITT's registry
// is PROCESS-SCOPED (in-memory, gone on MCP-host restart), so every
// connection establishment registers anew; the call is idempotent.
export const BOARD_REGISTER_RETRY_INTERVAL_MS = 2_000;
export const BOARD_REGISTER_RETRY_WINDOW_MS = 20_000;

/** Outcome of a single registration attempt. */
type RegistrationAttempt = "registered" | "skipped" | "retryable";

/**
 * One attempt to register the workspace's board handle (`board/register`).
 * Outcomes: `registered` on success; `skipped` when the workspace has no
 * board identity (`board-state.json` missing — terminal, retrying cannot
 * help); `retryable` when the gateway is not (yet) connected, not v2-capable
 * or the RPC failed — typically CITT.MCP still booting. Silent by contract:
 * the caller owns logging.
 */
export async function tryRegisterBoardIdentity(
  ide: IDE,
): Promise<RegistrationAttempt> {
  try {
    const state = await loadBoardState(ide);
    if (!state) {
      return "skipped";
    }
    const connection = findBoardConnection();
    if (!connection || !connection.proxyCapabilities?.boardV2) {
      return "retryable";
    }
    await connection.boardRegister(state.handle);
    return "registered";
  } catch {
    return "retryable";
  }
}

let registrationInFlight = false;

/**
 * Registers the board handle, retrying every
 * `BOARD_REGISTER_RETRY_INTERVAL_MS` until `BOARD_REGISTER_RETRY_WINDOW_MS`
 * have elapsed (CITT.MCP boots slowly — more than 10 s under system load).
 * Every attempt re-reads the live connection map, so a gateway that becomes
 * ready mid-window is picked up. A concurrency guard keeps repeated
 * connection-refresh triggers from stacking loops; after a finished loop the
 * next refresh starts a fresh attempt (needed after CITT restarts — the
 * registry is process-scoped). Best-effort: returns whether the handle was
 * registered and never throws.
 */
export async function registerBoardIdentity(
  ide: IDE,
  options?: {
    intervalMs?: number;
    windowMs?: number;
  },
): Promise<boolean> {
  if (registrationInFlight) {
    return false;
  }
  registrationInFlight = true;
  try {
    const intervalMs = options?.intervalMs ?? BOARD_REGISTER_RETRY_INTERVAL_MS;
    const windowMs = options?.windowMs ?? BOARD_REGISTER_RETRY_WINDOW_MS;
    const deadline = Date.now() + windowMs;
    let attempt = await tryRegisterBoardIdentity(ide);
    while (attempt === "retryable" && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
      attempt = await tryRegisterBoardIdentity(ide);
    }
    if (attempt === "retryable") {
      console.warn(
        `Board handle not registered within ${windowMs / 1000}s — giving up ` +
          "(the next connection refresh retries)",
      );
    }
    return attempt === "registered";
  } finally {
    registrationInFlight = false;
  }
}

/**
 * Run-start fetch: register the workspace's board handle (CITT's
 * registry is process-scoped, so this belongs to every consumption and is
 * idempotent), then peek the pending messages the gateway resolves for this
 * handle's server-side subscriptions. Since the fetch/ack decoupling
 * (board-wake-fetch-ack-entkopplung) this fetch is NON-consuming — the
 * cursor advances only through `ackBoard` below. Requires a v2 gateway; any
 * failure is logged and swallowed.
 */
export async function consumeBoardPending(
  ide: IDE,
): Promise<BoardPendingResult> {
  try {
    const state = await loadBoardState(ide);
    if (!state) {
      return EMPTY_RESULT;
    }
    const connection = findBoardConnection();
    if (!connection) {
      console.warn(
        "Board injection skipped: no board-capable MCP server connected",
      );
      return EMPTY_RESULT;
    }
    if (!connection.proxyCapabilities?.boardV2) {
      console.warn(
        "Board injection skipped: connected server does not support board/v2",
      );
      return EMPTY_RESULT;
    }
    await connection.boardRegister(state.handle);
    return await connection.boardPending();
  } catch (e) {
    console.warn(
      `Board injection skipped: ${e instanceof Error ? e.message : String(e)}`,
    );
    return EMPTY_RESULT;
  }
}

/**
 * Fetch/ack decoupling (board-wake-fetch-ack-entkopplung): `board/pending`
 * is a non-consuming peek; the per-topic cursor advances only through this
 * ack, sent after the injection block was delivered by a successful LLM
 * call. The gateway max-merges the high-water marks, so replays are
 * idempotent and a lost ack only costs a dedupe-filtered re-delivery.
 * Requires a v2 gateway; any failure is logged and swallowed.
 */
export async function ackBoard(ide: IDE, acks: BoardAck[]): Promise<void> {
  if (acks.length === 0) {
    return;
  }
  try {
    const state = await loadBoardState(ide);
    if (!state) {
      return;
    }
    const connection = findBoardConnection();
    if (!connection) {
      console.warn("Board ack skipped: no board-capable MCP server connected");
      return;
    }
    if (!connection.proxyCapabilities?.boardV2) {
      console.warn("Board ack skipped: server does not support board/v2");
      return;
    }
    await connection.boardRegister(state.handle);
    await connection.boardAck(acks);
  } catch (e) {
    console.warn(
      `Board ack skipped: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}
