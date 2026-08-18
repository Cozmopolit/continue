import { BoardPendingResult } from "core";
import { IIdeMessenger } from "../../context/IdeMessenger";
import { appendBoardMessages } from "../slices/sessionSlice";
import { AppDispatch } from "../store";

/**
 * Shared MsgBoard consumption (board-wake-mode.md): fetch pending messages
 * for the workspace's subscriptions and accumulate them into session state.
 * Extracted from streamNormalInput so the run path (TTL-gated there) and the
 * idle watcher (60 s tick + jitter) consume through one seam. Best-effort:
 * failures are logged and swallowed — a board failure never blocks a run or
 * the watcher.
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
