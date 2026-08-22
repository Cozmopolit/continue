import { BoardConsumeResult, BoardMessage, RuleWithSource } from "core";

// Board auto-topic-injection (board-auto-topic-injection.md, revision 2):
// consumed messages accumulate in session state (bounded window) and are
// rendered into an always-apply system-message block, exactly like AGENTS.md.
// The revision-2 run-path consumption (TTL-gated fetch on every LLM call) is
// disabled — the board-wake watcher is the only fetcher. See the flag below.

/**
 * Kill switch for the revision-2 run-path fetch: TTL-gated board consumption
 * on every LLM call (board-auto-topic-injection.md). Disabled 2026-08-21 —
 * an injection block that mutates between tool-loop calls of one run is
 * invisible to the model; delivery is reduced to the board-wake watcher,
 * which polls immediately on activation and every run end (board-wake-mode.md
 * amendment 2026-08-21 "Run-Pfad-Abschaltung"). The run path stays intact in
 * streamNormalInput — flip back to true to re-enable.
 */
export const BOARD_RUN_PATH_FETCH_ENABLED = false;

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
  /**
   * Per-topic high-water marks of message ids this session has seen
   * (injected messages + oversized pointers) — the `board/ack` payload
   * source (board-wake-fetch-ack-entkopplung). Never cleared; the
   * server-side max-merge makes re-acking idempotent.
   */
  ackByTopic: Record<string, number>;
  /** Epoch ms of the last board/consumePending attempt; undefined = never. */
  lastFetchAt?: number;
  /**
   * Topics whose "closed" line is shown in this session — close-notification
   * dedupe (msgboard-v2-fork-packages.md, Revision 2026-08-21). Core already
   * diffs against board-state.json; this list guards re-delivered fetches
   * within the session.
   */
  closedTopicsNotified: string[];
  /**
   * Window ids (message ids + oversized pointers) already delivered to the
   * model by a completed turn (board-injection-delivered-marking.md).
   * Render filter only — the window keeps the delivered content as the
   * dedupe basis of accumulateBoardFetch. Pruned to the surviving window on
   * each accumulation.
   */
  deliveredIds: number[];
  /**
   * Subset of closedTopicsNotified already delivered by a completed turn;
   * render filter for the close lines. closedTopicsNotified itself stays
   * the fetch-dedupe guard and is never cleared.
   */
  closedTopicsDelivered: string[];
}

export const EMPTY_BOARD_SESSION_STATE: BoardSessionState = {
  messages: [],
  droppedCount: 0,
  omittedTotal: 0,
  omittedOldestId: undefined,
  tooLargeIds: [],
  ackByTopic: {},
  lastFetchAt: undefined,
  closedTopicsNotified: [],
  deliveredIds: [],
  closedTopicsDelivered: [],
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
 * accumulates server-side omission info, tracks the per-topic ack
 * high-water marks and appends fresh close-notification lines
 * (msgboard-v2-fork-packages.md, Revision 2026-08-21). `lastFetchAt` is
 * carried through untouched — the caller stamps the attempt separately.
 */
export function accumulateBoardFetch(
  current: BoardSessionState,
  result: BoardConsumeResult,
): BoardSessionState {
  // Fetch/ack decoupling (board-wake-fetch-ack-entkopplung): the pending
  // fetch is a non-consuming peek, so an unacked (or lost-ack) message is
  // re-delivered on the next fetch — dedupe by id against everything the
  // session has already seen and track the per-topic high-water marks.
  const knownIds = new Set<number>([
    ...current.messages.map((m) => m.id),
    ...current.tooLargeIds,
  ]);
  const ackByTopic = { ...current.ackByTopic };
  const incoming = result.messages.filter((m) => {
    if (knownIds.has(m.id)) {
      return false;
    }
    knownIds.add(m.id);
    ackByTopic[m.topic] = Math.max(ackByTopic[m.topic] ?? 0, m.id);
    return true;
  });

  const messages = [...current.messages, ...incoming];
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
  // Fetch/ack decoupling: the oversized id is acked too — under FIFO it
  // would otherwise clog the pending head permanently.
  const tooLargeIds = [...current.tooLargeIds];
  if (
    messages.length === 1 &&
    messages[0].body.length > BOARD_WINDOW_MAX_CHARS
  ) {
    tooLargeIds.push(messages[0].id);
    ackByTopic[messages[0].topic] = Math.max(
      ackByTopic[messages[0].topic] ?? 0,
      messages[0].id,
    );
    messages.length = 0;
  }

  // Close notification (V11b fork side): `newClosedTopics` is already the
  // core-side last-seen diff — accumulate deduped so a re-delivered fetch
  // never repeats a close line within the session.
  const closedTopicsNotified = [...current.closedTopicsNotified];
  for (const topic of result.newClosedTopics ?? []) {
    if (!closedTopicsNotified.includes(topic)) {
      closedTopicsNotified.push(topic);
    }
  }

  const omitted = result.omitted;
  // Delivered marking (board-injection-delivered-marking.md): prune the
  // delivered render filter to the ids still present in messages ∪
  // tooLargeIds after the eviction paths — ids evicted from the window need
  // no filter entry.
  const survivingIds = new Set<number>([
    ...messages.map((m) => m.id),
    ...tooLargeIds,
  ]);
  const deliveredIds = current.deliveredIds.filter((id) =>
    survivingIds.has(id),
  );
  return {
    messages,
    droppedCount,
    omittedTotal: current.omittedTotal + (omitted?.count ?? 0),
    tooLargeIds,
    ackByTopic,
    omittedOldestId:
      omitted && omitted.count > 0
        ? Math.min(
            current.omittedOldestId ?? omitted.oldestOmittedId,
            omitted.oldestOmittedId,
          )
        : current.omittedOldestId,
    lastFetchAt: current.lastFetchAt,
    closedTopicsNotified,
    deliveredIds,
    closedTopicsDelivered: current.closedTopicsDelivered,
  };
}

/**
 * Marks everything currently renderable as delivered
 * (board-injection-delivered-marking.md) — called via the sessionSlice
 * action at turn end, after the injection block was part of a completed
 * run. The window keeps the delivered content (dedupe basis of
 * accumulateBoardFetch); deliveredIds/closedTopicsDelivered are render
 * filters only. The dropped/omitted notes belong to the delivered block and
 * are zeroed with it.
 */
export function markDelivered(board: BoardSessionState): BoardSessionState {
  const deliveredIds = new Set(board.deliveredIds);
  for (const message of board.messages) {
    deliveredIds.add(message.id);
  }
  for (const id of board.tooLargeIds) {
    deliveredIds.add(id);
  }
  return {
    ...board,
    deliveredIds: [...deliveredIds],
    // closedTopicsDelivered ⊆ closedTopicsNotified always holds and
    // notified only grows within the session — copying is the union.
    closedTopicsDelivered: [...board.closedTopicsNotified],
    droppedCount: 0,
    omittedTotal: 0,
    omittedOldestId: undefined,
  };
}

/**
 * Renders the UNDELIVERED part of the accumulated session board state into
 * the system-message block (board-injection-delivered-marking.md): messages
 * and close lines already delivered by a completed turn are filtered out, so
 * a later run never sees them again as „neue Nachrichten". Returns undefined
 * when nothing undelivered remains, so the caller skips the always-apply
 * rule entirely.
 */
export function renderBoardInjectionBlock(
  board: BoardSessionState,
): string | undefined {
  const delivered = new Set(board.deliveredIds);
  const messages = board.messages.filter((m) => !delivered.has(m.id));
  const tooLargeIds = board.tooLargeIds.filter((id) => !delivered.has(id));
  const closedTopics = board.closedTopicsNotified.filter(
    (topic) => !board.closedTopicsDelivered.includes(topic),
  );

  if (
    messages.length === 0 &&
    board.droppedCount === 0 &&
    board.omittedTotal === 0 &&
    tooLargeIds.length === 0 &&
    closedTopics.length === 0
  ) {
    return undefined;
  }

  const byTopic = new Map<string, BoardMessage[]>();
  for (const message of messages) {
    const list = byTopic.get(message.topic) ?? [];
    list.push(message);
    byTopic.set(message.topic, list);
  }

  // Honest freshness (board-injection-delivered-marking.md): the newest
  // createdAt among the rendered messages, not the render time (ISO strings
  // compare lexicographically). Close/notes-only blocks carry no timestamp.
  const newestCreatedAt = messages.reduce<string | undefined>(
    (newest, message) =>
      newest === undefined || message.createdAt > newest
        ? message.createdAt
        : newest,
    undefined,
  );
  const sections: string[] = [
    newestCreatedAt !== undefined
      ? `# MsgBoard — neue Nachrichten (Stand: ${newestCreatedAt})`
      : `# MsgBoard — neue Nachrichten`,
  ];
  for (const [topic, topicMessages] of byTopic) {
    sections.push(`\n## Topic: ${topic}`);
    for (const message of topicMessages) {
      const re = message.re != null ? ` · re: #${message.re}` : "";
      sections.push(
        `\n_[cittmsg] id ${message.id} · from: ${message.from} → to: ${message.to}${re} · ${message.createdAt}_\n\n${message.body}`,
      );
    }
  }
  // Close notification (V11b fork side): own section, clearly a non-message —
  // a close is lifecycle information, not a posted comment. Rendered until
  // delivered (board-injection-delivered-marking.md).
  if (closedTopics.length > 0) {
    sections.push(`\n## Geschlossene Topics (keine Nachrichten)`);
    for (const topic of closedTopics) {
      sections.push(`- Topic '${topic}' wurde geschlossen`);
    }
  }
  if (board.droppedCount > 0 && messages.length > 0) {
    sections.push(
      `\n_${board.droppedCount} ältere Nachrichten dieser Session sind nicht mehr im Block (älter als #${messages[0].id}) — bei Bedarf per msg_list/msg_read nachladen._`,
    );
  }
  if (board.omittedTotal > 0) {
    sections.push(
      `\n_${board.omittedTotal} weitere Nachrichten (älter als #${board.omittedOldestId}) wurden nicht injiziert — bei Bedarf per msg_list/msg_read nachladen._`,
    );
  }
  if (tooLargeIds.length > 0) {
    sections.push(
      `\n_${tooLargeIds.length} Nachricht(en) übersteigen das Session-Fenster (~${BOARD_WINDOW_MAX_CHARS} Chars) und wurden nicht injiziert: ${tooLargeIds
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
