import { BoardConsumeResult, BoardMessage } from "core";
import { describe, expect, it } from "vitest";
import {
  accumulateBoardFetch,
  BOARD_INJECTION_RULE_NAME,
  BOARD_WINDOW_MAX_CHARS,
  BOARD_WINDOW_MAX_MESSAGES,
  boardInjectionRule,
  BoardSessionState,
  EMPTY_BOARD_SESSION_STATE,
  renderBoardInjectionBlock,
} from "./boardInjection";

// Board auto-topic-injection (board-auto-topic-injection.md, revision 2):
// pure unit tests for the bounded accumulation and the block rendering.
// (The TTL gate of the disabled run path is untested by design —
// BOARD_RUN_PATH_FETCH_ENABLED, board-wake-mode.md amendment 2026-08-21
// "Run-Pfad-Abschaltung".)

function makeMessage(
  overrides: Partial<BoardMessage> & Pick<BoardMessage, "id" | "topic">,
): BoardMessage {
  return {
    from: "delta",
    to: "*",
    createdAt: "2026-08-14T09:30:00Z",
    body: "message body",
    ...overrides,
  };
}

const result = (
  overrides: Partial<BoardConsumeResult> & {
    messages: BoardMessage[];
  },
): BoardConsumeResult => ({
  latestByTopic: {},
  ...overrides,
});

const stateWith = (
  overrides: Partial<BoardSessionState>,
): BoardSessionState => ({
  ...EMPTY_BOARD_SESSION_STATE,
  ...overrides,
});

/** Renders and asserts a defined block; the undefined case is tested separately. */
const renderDefined = (board: BoardSessionState): string => {
  const block = renderBoardInjectionBlock(board);
  expect(block).toBeDefined();
  return block as string;
};

describe("constants", () => {
  it("uses the agreed window caps", () => {
    expect(BOARD_WINDOW_MAX_MESSAGES).toBe(20);
    expect(BOARD_WINDOW_MAX_CHARS).toBe(40_000);
  });
});

describe("accumulateBoardFetch", () => {
  it("appends new messages in order and starts without drops or omissions", () => {
    const next = accumulateBoardFetch(
      EMPTY_BOARD_SESSION_STATE,
      result({
        messages: [
          makeMessage({ id: 1, topic: "t" }),
          makeMessage({ id: 2, topic: "t" }),
        ],
      }),
    );
    expect(next.messages.map((m) => m.id)).toEqual([1, 2]);
    expect(next.droppedCount).toBe(0);
    expect(next.omittedTotal).toBe(0);
    expect(next.omittedOldestId).toBeUndefined();
    expect(next.tooLargeIds).toEqual([]);
  });

  it("carries lastFetchAt through untouched", () => {
    const next = accumulateBoardFetch(
      stateWith({ lastFetchAt: 42 }),
      result({ messages: [] }),
    );
    expect(next.lastFetchAt).toBe(42);
  });

  it("accumulates across fetches preserving order", () => {
    const first = accumulateBoardFetch(
      EMPTY_BOARD_SESSION_STATE,
      result({ messages: [makeMessage({ id: 1, topic: "t" })] }),
    );
    const second = accumulateBoardFetch(
      first,
      result({ messages: [makeMessage({ id: 2, topic: "t" })] }),
    );
    expect(second.messages.map((m) => m.id)).toEqual([1, 2]);
  });

  it("drops oldest messages beyond the message cap and counts them", () => {
    const current = stateWith({
      messages: Array.from({ length: 18 }, (_, i) =>
        makeMessage({ id: i + 1, topic: "t" }),
      ),
    });
    const next = accumulateBoardFetch(
      current,
      result({
        messages: Array.from({ length: 5 }, (_, i) =>
          makeMessage({ id: 100 + i, topic: "t" }),
        ),
      }),
    );
    expect(next.messages).toHaveLength(BOARD_WINDOW_MAX_MESSAGES);
    expect(next.messages[0].id).toBe(4); // ids 1..3 dropped
    expect(next.messages[BOARD_WINDOW_MAX_MESSAGES - 1].id).toBe(104);
    expect(next.droppedCount).toBe(3);
  });

  it("drops oldest messages beyond the char cap but keeps at least one", () => {
    // big alone sits exactly at the cap; adding "small" tips over it
    const big = "x".repeat(BOARD_WINDOW_MAX_CHARS);
    const current = stateWith({
      messages: [makeMessage({ id: 1, topic: "t", body: "small" })],
    });
    const next = accumulateBoardFetch(
      current,
      result({ messages: [makeMessage({ id: 2, topic: "t", body: big })] }),
    );
    expect(next.messages.map((m) => m.id)).toEqual([2]);
    expect(next.droppedCount).toBe(1);
  });

  it("drops a single oversized message below the cap and keeps a retrieval pointer", () => {
    const huge = "x".repeat(BOARD_WINDOW_MAX_CHARS * 2);
    const next = accumulateBoardFetch(
      EMPTY_BOARD_SESSION_STATE,
      result({ messages: [makeMessage({ id: 1, topic: "t", body: huge })] }),
    );
    expect(next.messages).toHaveLength(0);
    expect(next.droppedCount).toBe(0);
    expect(next.tooLargeIds).toEqual([1]);
  });

  it("drops an oversized message even when smaller ones preceded it", () => {
    const huge = "x".repeat(BOARD_WINDOW_MAX_CHARS * 2);
    const current = stateWith({
      messages: [makeMessage({ id: 1, topic: "t", body: "small" })],
    });
    const next = accumulateBoardFetch(
      current,
      result({ messages: [makeMessage({ id: 2, topic: "t", body: huge })] }),
    );
    // "small" fell to the char-cap window drop, the oversized one to tooLarge
    expect(next.messages).toHaveLength(0);
    expect(next.droppedCount).toBe(1);
    expect(next.tooLargeIds).toEqual([2]);
  });

  it("accumulates server-side omitted counts and keeps the oldest omitted id", () => {
    const first = accumulateBoardFetch(
      EMPTY_BOARD_SESSION_STATE,
      result({ messages: [], omitted: { count: 3, oldestOmittedId: 10 } }),
    );
    const second = accumulateBoardFetch(
      first,
      result({ messages: [], omitted: { count: 2, oldestOmittedId: 4 } }),
    );
    expect(second.omittedTotal).toBe(5);
    expect(second.omittedOldestId).toBe(4);
  });

  it("leaves omission info untouched when the result has none", () => {
    const next = accumulateBoardFetch(
      stateWith({ omittedTotal: 2, omittedOldestId: 7 }),
      result({ messages: [] }),
    );
    expect(next.omittedTotal).toBe(2);
    expect(next.omittedOldestId).toBe(7);
  });
});

describe("renderBoardInjectionBlock", () => {
  it("returns undefined when there is nothing to show", () => {
    expect(
      renderBoardInjectionBlock(EMPTY_BOARD_SESSION_STATE),
    ).toBeUndefined();
  });

  it("renders the header with the newest rendered message createdAt (board-injection-delivered-marking.md)", () => {
    const block = renderBoardInjectionBlock(
      stateWith({
        messages: [
          makeMessage({ id: 1, topic: "t", createdAt: "2026-08-14T09:30:00Z" }),
          makeMessage({ id: 2, topic: "t", createdAt: "2026-08-14T11:45:00Z" }),
        ],
      }),
    );
    expect(block).toContain(
      "# MsgBoard — neue Nachrichten (Stand: 2026-08-14T11:45:00Z)",
    );
    expect(block).toContain(
      "_[cittmsg] id 1 · from: delta → to: * · 2026-08-14T09:30:00Z_",
    );
  });

  it("groups messages by topic in first-appearance order, preserving message order", () => {
    const block = renderDefined(
      stateWith({
        messages: [
          makeMessage({ id: 1, topic: "alpha", body: "a1" }),
          makeMessage({ id: 2, topic: "beta", body: "b1" }),
          makeMessage({ id: 3, topic: "alpha", body: "a2" }),
        ],
      }),
    );

    const alphaIdx = block.indexOf("## Topic: alpha");
    const betaIdx = block.indexOf("## Topic: beta");
    expect(alphaIdx).toBeGreaterThan(-1);
    expect(betaIdx).toBeGreaterThan(alphaIdx);
    // one section per topic, messages in original order within their section
    expect(block.match(/## Topic: alpha/g)).toHaveLength(1);
    expect(block.indexOf("a1")).toBeLessThan(block.indexOf("a2"));
    expect(block.indexOf("a2")).toBeLessThan(betaIdx);
  });

  it("renders the envelope line with a re reference", () => {
    const block = renderDefined(
      stateWith({
        messages: [
          makeMessage({
            id: 5,
            topic: "t",
            from: "home-citt",
            to: "delta",
            re: 3,
            body: "hello",
          }),
        ],
      }),
    );
    expect(block).toContain(
      "_[cittmsg] id 5 · from: home-citt → to: delta · re: #3 · 2026-08-14T09:30:00Z_",
    );
    expect(block).toContain("hello");
  });

  it("omits the re segment when the message is not a reply", () => {
    const block = renderDefined(
      stateWith({ messages: [makeMessage({ id: 6, topic: "t" })] }),
    );
    expect(block).toContain(
      "_[cittmsg] id 6 · from: delta → to: * · 2026-08-14T09:30:00Z_",
    );
    expect(block).not.toContain("re: #");
  });

  it("notes window-dropped older messages with the oldest kept id", () => {
    const block = renderDefined(
      stateWith({
        messages: [makeMessage({ id: 21, topic: "t" })],
        droppedCount: 5,
      }),
    );
    expect(block).toContain(
      "5 ältere Nachrichten dieser Session sind nicht mehr im Block (älter als #21)",
    );
    expect(block).toContain("msg_list/msg_read");
  });

  it("notes accumulated server omissions with a backlog hint", () => {
    const block = renderDefined(
      stateWith({ omittedTotal: 3, omittedOldestId: 10 }),
    );
    expect(block).toContain("3 weitere Nachrichten (älter als #10)");
    expect(block).toContain("msg_list/msg_read");
  });

  it("notes oversized dropped messages with msg_read retrieval pointers", () => {
    const block = renderDefined(stateWith({ tooLargeIds: [7, 9] }));
    expect(block).toContain("2 Nachricht(en) übersteigen das Session-Fenster");
    expect(block).toContain("#7, #9");
    expect(block).toContain("msg_read");
  });

  it("renders no notes when counters are zero", () => {
    const block = renderDefined(
      stateWith({ messages: [makeMessage({ id: 1, topic: "t" })] }),
    );
    expect(block).not.toContain("weitere Nachrichten");
    expect(block).not.toContain("nicht mehr im Block");
  });

  it("keeps header, sections, dropped note and omitted note in that order", () => {
    const block = renderDefined(
      stateWith({
        messages: [makeMessage({ id: 30, topic: "t", body: "body" })],
        droppedCount: 2,
        omittedTotal: 2,
        omittedOldestId: 5,
      }),
    );
    expect(block.indexOf("# MsgBoard")).toBe(0);
    expect(block.indexOf("## Topic: t")).toBeGreaterThan(
      block.indexOf("# MsgBoard"),
    );
    expect(block.indexOf("nicht mehr im Block")).toBeGreaterThan(
      block.indexOf("## Topic: t"),
    );
    expect(block.indexOf("weitere Nachrichten")).toBeGreaterThan(
      block.indexOf("nicht mehr im Block"),
    );
  });
});

describe("boardInjectionRule", () => {
  it("wraps the block as an always-apply rule with source 'board'", () => {
    expect(boardInjectionRule("BLOCK")).toEqual({
      name: BOARD_INJECTION_RULE_NAME,
      rule: "BLOCK",
      source: "board",
      alwaysApply: true,
    });
  });

  it("uses the stable rule name", () => {
    expect(BOARD_INJECTION_RULE_NAME).toBe("MsgBoard Injection");
  });
});

describe("accumulateBoardFetch — close notification", () => {
  // V11b fork side (msgboard-v2-fork-packages.md, Revision 2026-08-21):
  // `newClosedTopics` is already the core-side last-seen diff — the session
  // only accumulates it deduped against re-delivered fetches.
  it("appends fresh closed topics to closedTopicsNotified", () => {
    const next = accumulateBoardFetch(EMPTY_BOARD_SESSION_STATE, {
      messages: [],
      latestByTopic: {},
      newClosedTopics: ["x", "y"],
    });
    expect(next.closedTopicsNotified).toEqual(["x", "y"]);
  });

  it("dedupes re-delivered close notifications", () => {
    const once = accumulateBoardFetch(EMPTY_BOARD_SESSION_STATE, {
      messages: [],
      latestByTopic: {},
      newClosedTopics: ["x"],
    });
    const twice = accumulateBoardFetch(once, {
      messages: [],
      latestByTopic: {},
      newClosedTopics: ["x"],
    });
    expect(twice.closedTopicsNotified).toEqual(["x"]);
  });

  it("keeps notified closes across fetches and appends new ones", () => {
    const first = accumulateBoardFetch(EMPTY_BOARD_SESSION_STATE, {
      messages: [],
      latestByTopic: {},
      newClosedTopics: ["x"],
    });
    const second = accumulateBoardFetch(first, {
      messages: [],
      latestByTopic: {},
      newClosedTopics: ["y"],
    });
    expect(second.closedTopicsNotified).toEqual(["x", "y"]);
  });

  it("leaves closedTopicsNotified untouched when the result carries no diff", () => {
    const next = accumulateBoardFetch(
      stateWith({ closedTopicsNotified: ["x"] }),
      result({ messages: [] }),
    );
    expect(next.closedTopicsNotified).toEqual(["x"]);
  });
});

describe("renderBoardInjectionBlock — close notification", () => {
  it("renders close lines as a clearly marked non-message section", () => {
    const block = renderDefined(
      stateWith({ closedTopicsNotified: ["x", "y"] }),
    );
    expect(block).toContain("## Geschlossene Topics (keine Nachrichten)");
    expect(block).toContain("- Topic 'x' wurde geschlossen");
    expect(block).toContain("- Topic 'y' wurde geschlossen");
    expect(block).not.toContain("[cittmsg]");
  });

  it("renders a block for close lines alone (no messages, no timestamp)", () => {
    const block = renderBoardInjectionBlock(
      stateWith({ closedTopicsNotified: ["x"] }),
    );
    expect(block).toBeDefined();
    expect(block).not.toContain("Stand:");
  });

  it("renders close lines alongside message sections", () => {
    const block = renderDefined(
      stateWith({
        messages: [makeMessage({ id: 1, topic: "t" })],
        closedTopicsNotified: ["x"],
      }),
    );
    expect(block).toContain("## Topic: t");
    expect(block).toContain("## Geschlossene Topics (keine Nachrichten)");
  });
});
