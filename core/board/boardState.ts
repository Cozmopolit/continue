import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

import { BoardMessage, IDE } from "..";

// Board auto-topic-injection (board-auto-topic-injection.md): per-workspace
// subscription state. CITT is a stateless gateway by contract, so the fork
// owns this file: `<workspace>/.continue/board-state.json`.

export const BOARD_STATE_DIR_NAME = ".continue";
export const BOARD_STATE_FILE_NAME = "board-state.json";

export interface BoardState {
  handle: string;
  topics: string[];
  /** Global cursor across all topics (GitHub comment ids are monotonic). */
  cursor: number;
  /**
   * One-shot flag (msgboard-v2-fork-packages.md): set once
   * `board/migrateImport` succeeded on a v2 gateway. Enables mode (b) —
   * server-resolved `board/pending` — and makes the gateway the source of
   * truth for subscriptions until M3 removes this store. Absent = not
   * migrated. Never written back to `false`; absence is normalized away.
   */
  migrated?: boolean;
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

export function validateBoardTopic(topic: string): string | undefined {
  if (!topic || !topic.trim()) {
    return "Board topic must not be empty";
  }
  if (INVALID_SEGMENT_PATTERN.test(topic)) {
    return 'Board topic must not contain envelope delimiters ("→", "·") or newlines';
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
    // validate on load: handle must pass segment validation, cursor must be a
    // non-negative integer (NaN/corrupt cursors would break every fetch).
    if (
      typeof parsed?.handle === "string" &&
      validateBoardHandle(parsed.handle) === undefined &&
      Array.isArray(parsed?.topics) &&
      typeof parsed?.cursor === "number" &&
      Number.isInteger(parsed.cursor) &&
      parsed.cursor >= 0
    ) {
      return {
        handle: parsed.handle,
        // Salvage valid topics (existing filter behavior extended to segment
        // validation): one bad topic must not drop the whole subscription set.
        topics: parsed.topics.filter(
          (t: unknown) =>
            typeof t === "string" && validateBoardTopic(t) === undefined,
        ),
        cursor: parsed.cursor,
        // Normalize: only `true` is meaningful; `false`/garbage = not migrated.
        ...(parsed.migrated === true ? { migrated: true } : {}),
      };
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

export async function saveBoardState(
  ide: IDE,
  state: BoardState,
): Promise<void> {
  const statePath = await getBoardStatePath(ide);
  if (!statePath) {
    throw new Error("Cannot save board state: no workspace open");
  }
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

/** at-least-once: only advance, never backwards (ids are monotonic). */
export function cursorAfterConsume(
  current: number,
  messages: BoardMessage[],
): number {
  let cursor = current;
  for (const message of messages) {
    if (message.id > cursor) {
      cursor = message.id;
    }
  }
  return cursor;
}
