import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

import { IDE } from "..";

// MsgBoard (msgboard-v2-fork-packages.md): per-workspace board identity.
// Subscriptions and cursors live SERVER-SIDE (managed via CITT's
// subscription tools); this file is the handle source for `board/register`
// and carries nothing else. The loader expects exactly the handle-only
// format: the removed legacy `{ topics, cursor }` shape is rejected without
// a compatibility window (cutover is the consistent deploy snapshot).

export const BOARD_STATE_DIR_NAME = ".continue";
export const BOARD_STATE_FILE_NAME = "board-state.json";

export interface BoardState {
  handle: string;
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
      return { handle: parsed.handle };
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
