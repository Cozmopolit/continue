import { BoardAck, BoardPendingResult } from "core";
import { IIdeMessenger } from "../../context/IdeMessenger";
import { appendBoardMessages } from "../slices/sessionSlice";
import { AppDispatch } from "../store";

/**
 * Shared MsgBoard seam (board-wake-mode.md): peek the pending messages for
 * the workspace's subscriptions and accumulate them into session state.
 * Since the fetch/ack decoupling (board-wake-fetch-ack-entkopplung) the
 * fetch is a non-consuming peek; acknowledgment happens via
 * `ackBoardMessages` below after successful delivery. The idle watcher
 * (60 s tick + jitter, immediate on run end) is the only caller: the
 * run-path fetch is disabled (BOARD_RUN_PATH_FETCH_ENABLED,
 * board-wake-mode.md amendment 2026-08-21 "Run-Pfad-Abschaltung").
 * Best-effort: failures are logged and swallowed — a board failure never
 * blocks a run or the watcher.
 *
 * Returns the result on success (callers may inspect `messages`), undefined
 * on failure.
 */
export async function fetchBoardPending(
  dispatch: AppDispatch,
  ideMessenger: IIdeMessenger,
): Promise<BoardPendingResult | undefined> {
  try {
    const boardRes = await ideMessenger.request(
      "board/consumePending",
      undefined,
    );
    if (boardRes.status === "error") {
      console.warn(`Board injection skipped: ${boardRes.error}`);
      return undefined;
    }
    if (boardRes.content.warning) {
      console.warn(`MsgBoard: ${boardRes.content.warning}`);
    }
    dispatch(appendBoardMessages(boardRes.content));
    return boardRes.content;
  } catch (e) {
    console.warn(
      `Board injection skipped: ${e instanceof Error ? e.message : String(e)}`,
    );
    return undefined;
  }
}

/**
 * Fetch/ack decoupling (board-wake-fetch-ack-entkopplung): acknowledges the
 * per-topic high-water marks after the injection block was delivered by a
 * successful LLM call. Fire-and-forget by contract — a lost ack only costs a
 * dedupe-filtered re-delivery; never blocks a run.
 */
export async function ackBoardMessages(
  ideMessenger: IIdeMessenger,
  acks: BoardAck[],
): Promise<void> {
  if (acks.length === 0) {
    return;
  }
  try {
    const res = await ideMessenger.request("board/ack", { acks });
    if (res.status === "error") {
      console.warn(`MsgBoard ack skipped: ${res.error}`);
    }
  } catch (e) {
    console.warn(
      `MsgBoard ack skipped: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}
