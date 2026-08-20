import { BoardPendingResult, IDE } from "..";
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
 * Run-start consumption: register the workspace's board handle (CITT's
 * registry is process-scoped, so this belongs to every consumption and is
 * idempotent), then fetch the pending messages the gateway resolves for this
 * handle's server-side subscriptions. Requires a v2 gateway; any failure is
 * logged and swallowed.
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
