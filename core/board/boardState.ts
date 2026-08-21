import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

import { IDE } from "..";

// MsgBoard (msgboard-v2-fork-packages.md): per-workspace board identity.
// Subscriptions and cursors live SERVER-SIDE (managed via CITT's
// subscription tools); this file is the handle source for `board/register`
// and additionally carries the close-notification last-seen state
// (`closedTopicsSeen`, Revision 2026-08-21 "Close-Notification"). The loader
// rejects the removed legacy `{ topics, cursor }` shape without a
// compatibility window (cutover is the consistent deploy snapshot).

export const BOARD_STATE_DIR_NAME = ".continue";
export const BOARD_STATE_FILE_NAME = "board-state.json";

export interface BoardState {
  handle: string;
  /**
   * Close-notification last-seen state (V11b, Revision 2026-08-21): topics
   * already reported as closed. Diffed against every board/pending
   * `closedTopics` list so the wake fires only on the last-seen diff.
   */
  closedTopicsSeen?: string[];
}

// Envelope-delimiter hygiene mirrors the MsgBoard handle validation
// (msg_post): no "→", "·" or newlines; non-empty.
const INVALID_SEGMENT_PATTERN = /[→·\r\n]/;

export function validateBoardHandle(handle: string): string | undefined {
  if (!handle || !handle.trim()) {
    return "Board handle must not be empty";
  }
  if (INVALID_SEGMENT_PATTERN.test(handle)) {
    return 'Board handle must not contain envelope delimiters ("→", "·") or newlines';
  }
  return undefined;
}

async function getBoardStatePath(ide: IDE): Promise<string | undefined> {
  const workspaceDirs = await ide.getWorkspaceDirs();
  if (workspaceDirs.length === 0) {
    return undefined;
  }
  const root = fileURLToPath(workspaceDirs[0]);
  return path.join(root, BOARD_STATE_DIR_NAME, BOARD_STATE_FILE_NAME);
}

export async function loadBoardState(
  ide: IDE,
): Promise<BoardState | undefined> {
  const statePath = await getBoardStatePath(ide);
  if (!statePath) {
    return undefined;
  }
  try {
    const raw = fs.readFileSync(statePath, "utf8");
    const parsed = JSON.parse(raw);
    // The file is workspace-local and may be edited by users or agents, so
    // validate on load: handle must pass segment validation. The removed
    // legacy `{ topics, cursor }` shape is rejected outright — no
    // compatibility window; installations deploy as consistent snapshots
    // (handle-reduced files + handle-only build).
    if (
      typeof parsed?.handle === "string" &&
      validateBoardHandle(parsed.handle) === undefined
    ) {
      if ("topics" in parsed || "cursor" in parsed) {
        console.warn(
          `Board state file uses the removed legacy format (topics/cursor), ignoring: ${statePath}`,
        );
        return undefined;
      }
      const state: BoardState = { handle: parsed.handle };
      // Last-seen state is best-effort metadata (V11b close notification):
      // tolerate hand-edited files and keep only non-empty strings.
      if (Array.isArray(parsed.closedTopicsSeen)) {
        const seen = parsed.closedTopicsSeen.filter(
          (t: unknown) => typeof t === "string" && t.trim().length > 0,
        );
        if (seen.length > 0) {
          state.closedTopicsSeen = seen;
        }
      }
      return state;
    }
    console.warn(`Board state file is malformed, ignoring: ${statePath}`);
    return undefined;
  } catch (e) {
    // Missing file = feature inactive. Anything else is worth logging.
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn(
        `Failed to read board state (${statePath}): ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
    return undefined;
  }
}

/**
 * Persists the board state (handle + close-notification last-seen state).
 * Atomic via write-to-temp-then-rename so a crash never leaves a corrupt
 * identity file — a malformed board-state.json disables the whole board
 * feature for the workspace. Throws on failure; callers are best-effort and
 * own the logging.
 */
export async function saveBoardState(
  ide: IDE,
  state: BoardState,
): Promise<void> {
  const statePath = await getBoardStatePath(ide);
  if (!statePath) {
    throw new Error("Cannot save board state: no workspace open");
  }
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  const tmpPath = `${statePath}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  fs.renameSync(tmpPath, statePath);
}
