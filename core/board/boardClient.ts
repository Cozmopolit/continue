import { BoardPendingResult, IDE } from "..";
import { MCPManagerSingleton } from "../context/mcp/MCPManagerSingleton";

import {
  cursorAfterConsume,
  loadBoardState,
  saveBoardState,
} from "./boardState";

// Board auto-topic-injection (board-auto-topic-injection.md): gateway access.

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

const EMPTY_RESULT: BoardPendingResult = { messages: [], latestByTopic: {} };

/**
 * Run-start consumption: fetch pending messages for the workspace's
 * subscriptions and advance the persisted cursor. Best-effort by contract —
 * every failure path returns an empty result so a run is never blocked.
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
    const result = await connection.boardPending(state.topics, state.cursor);
    if (result.messages.length > 0) {
      const consumedCursor = cursorAfterConsume(state.cursor, result.messages);
      // Reload before saving: the RPC window (up to 5 s) allows concurrent
      // subscribe/unsubscribe/consume operations (other sessions on the same
      // workspace, tool calls, manual edits) to mutate the file. The fresh
      // topic list is authoritative; the cursor only moves forward.
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
