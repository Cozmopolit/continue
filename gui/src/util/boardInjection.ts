import { BoardMessage, BoardPendingResult, RuleWithSource } from "core";

// Board auto-topic-injection (board-auto-topic-injection.md, revision 2):
// consumption runs on every LLM call, throttled by BOARD_FETCH_TTL_MS.
// Consumed messages accumulate in session state (bounded window) and are
// rendered into an always-apply system-message block, exactly like AGENTS.md.

/** At most one board fetch per this many milliseconds per session. */
export const BOARD_FETCH_TTL_MS = 15_000;

/** Session window caps, mirroring the server-side cap. */
export const BOARD_WINDOW_MAX_MESSAGES = 20;
export const BOARD_WINDOW_MAX_CHARS = 40_000;

/** Accumulated board state held in the redux session slice. */
export interface BoardSessionState {
  /** Consumed messages of this session, oldest first, bounded window. */
  messages: BoardMessage[];
  /** Count of window-dropped (oldest) messages, session-local. */
  droppedCount: number;
  /** Accumulated server-side omitted counts (cap-truncated at fetch time). */
  omittedTotal: number;
  /** Oldest id ever reported as omitted (for the backlog hint). */
  omittedOldestId?: number;
  /** Ids of messages that alone exceed the char cap (msg_read retrieval pointers). */
  tooLargeIds: number[];
  /** Epoch ms of the last board/consumePending attempt; undefined = never. */
  lastFetchAt?: number;
}

export const EMPTY_BOARD_SESSION_STATE: BoardSessionState = {
  messages: [],
  droppedCount: 0,
  omittedTotal: 0,
  omittedOldestId: undefined,
  tooLargeIds: [],
  lastFetchAt: undefined,
};

/**
 * TTL gate for board consumption: fetch when never fetched or when the last
 * attempt is at least BOARD_FETCH_TTL_MS old.
 */
export function shouldFetchBoard(
  lastFetchAt: number | undefined,
  now: number,
): boolean {
  return lastFetchAt === undefined || now - lastFetchAt >= BOARD_FETCH_TTL_MS;
}

/**
 * Pure accumulation of one board/consumePending result into the session
 * state: appends new messages, enforces the window caps (dropping oldest),
 * accumulates server-side omission info. `lastFetchAt` is carried through
 * untouched — the caller stamps the attempt separately.
 */
export function accumulateBoardFetch(
  current: BoardSessionState,
  result: BoardPendingResult,
): BoardSessionState {
  const messages = [...current.messages, ...result.messages];
  let droppedCount = current.droppedCount;

  const excess = messages.length - BOARD_WINDOW_MAX_MESSAGES;
  if (excess > 0) {
    messages.splice(0, excess);
    droppedCount += excess;
  }

  let chars = messages.reduce((sum, m) => sum + m.body.length, 0);
  while (chars > BOARD_WINDOW_MAX_CHARS && messages.length > 1) {
    const [oldest] = messages;
    chars -= oldest.body.length;
    messages.shift();
    droppedCount += 1;
  }

  // A single message that alone exceeds the char cap is dropped with a
  // retrieval pointer instead of blowing up the system message every turn;
  // the full text stays reachable via msg_read (contract omitted pattern).
  const tooLargeIds = [...current.tooLargeIds];
  if (
    messages.length === 1 &&
    messages[0].body.length > BOARD_WINDOW_MAX_CHARS
  ) {
    tooLargeIds.push(messages[0].id);
    messages.length = 0;
  }

  const omitted = result.omitted;
  return {
    messages,
    droppedCount,
    omittedTotal: current.omittedTotal + (omitted?.count ?? 0),
    tooLargeIds,
    omittedOldestId:
      omitted && omitted.count > 0
        ? Math.min(
            current.omittedOldestId ?? omitted.oldestOmittedId,
            omitted.oldestOmittedId,
          )
        : current.omittedOldestId,
    lastFetchAt: current.lastFetchAt,
  };
}

/**
 * Renders the accumulated session board state into the system-message block.
 * Returns undefined when there is nothing to show (no messages, no notes) so
 * the caller can skip adding the always-apply rule.
 */
export function renderBoardInjectionBlock(
  board: BoardSessionState,
  fetchedAt: Date = new Date(),
): string | undefined {
  if (
    board.messages.length === 0 &&
    board.droppedCount === 0 &&
    board.omittedTotal === 0 &&
    board.tooLargeIds.length === 0
  ) {
    return undefined;
  }

  const byTopic = new Map<string, BoardMessage[]>();
  for (const message of board.messages) {
    const list = byTopic.get(message.topic) ?? [];
    list.push(message);
    byTopic.set(message.topic, list);
  }

  const sections: string[] = [
    `# MsgBoard — neue Nachrichten (Stand: ${fetchedAt.toISOString()})`,
  ];
  for (const [topic, messages] of byTopic) {
    sections.push(`\n## Topic: ${topic}`);
    for (const message of messages) {
      const re = message.re != null ? ` · re: #${message.re}` : "";
      sections.push(
        `\n_[cittmsg] id ${message.id} · from: ${message.from} → to: ${message.to}${re} · ${message.createdAt}_\n\n${message.body}`,
      );
    }
  }
  if (board.droppedCount > 0 && board.messages.length > 0) {
    sections.push(
      `\n_${board.droppedCount} ältere Nachrichten dieser Session sind nicht mehr im Block (älter als #${board.messages[0].id}) — bei Bedarf per msg_list/msg_read nachladen._`,
    );
  }
  if (board.omittedTotal > 0) {
    sections.push(
      `\n_${board.omittedTotal} weitere Nachrichten (älter als #${board.omittedOldestId}) wurden nicht injiziert — bei Bedarf per msg_list/msg_read nachladen._`,
    );
  }
  if (board.tooLargeIds.length > 0) {
    sections.push(
      `\n_${board.tooLargeIds.length} Nachricht(en) übersteigen das Session-Fenster (~${BOARD_WINDOW_MAX_CHARS} Chars) und wurden nicht injiziert: ${board.tooLargeIds
        .map((id) => `#${id}`)
        .join(", ")} — vollständig per msg_read nachladen._`,
    );
  }
  return sections.join("\n");
}

export const BOARD_INJECTION_RULE_NAME = "MsgBoard Injection";

export function boardInjectionRule(block: string): RuleWithSource {
  return {
    name: BOARD_INJECTION_RULE_NAME,
    rule: block,
    source: "board",
    alwaysApply: true,
  };
}
