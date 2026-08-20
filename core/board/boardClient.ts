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
