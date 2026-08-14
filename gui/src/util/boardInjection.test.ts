import { BoardMessage, BoardPendingResult } from "core";
import { describe, expect, it } from "vitest";

import {
  BOARD_INJECTION_RULE_NAME,
  boardInjectionRule,
  renderBoardInjectionBlock,
} from "./boardInjection";

// Explicit timestamp keeps all assertions deterministic (the production
// default is `new Date()`).
const FETCHED_AT = new Date("2026-08-14T10:00:00.000Z");

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
  overrides: Partial<BoardPendingResult> & {
    messages: BoardMessage[];
  },
): BoardPendingResult => ({
  latestByTopic: {},
  ...overrides,
});

describe("renderBoardInjectionBlock", () => {
  it("renders only the header with ISO timestamp when there are no messages", () => {
    const block = renderBoardInjectionBlock(
      result({ messages: [] }),
      FETCHED_AT,
    );
    expect(block).toBe(
      "# MsgBoard — neue Nachrichten (Stand: 2026-08-14T10:00:00.000Z)",
    );
  });

  it("groups messages by topic in first-appearance order, preserving message order", () => {
    const block = renderBoardInjectionBlock(
      result({
        messages: [
          makeMessage({ id: 1, topic: "alpha", body: "a1" }),
          makeMessage({ id: 2, topic: "beta", body: "b1" }),
          makeMessage({ id: 3, topic: "alpha", body: "a2" }),
        ],
      }),
      FETCHED_AT,
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
    const block = renderBoardInjectionBlock(
      result({
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
      FETCHED_AT,
    );
    expect(block).toContain(
      "_[cittmsg] id 5 · from: home-citt → to: delta · re: #3 · 2026-08-14T09:30:00Z_",
    );
    expect(block).toContain("hello");
  });

  it("omits the re segment when the message is not a reply", () => {
    const block = renderBoardInjectionBlock(
      result({ messages: [makeMessage({ id: 6, topic: "t" })] }),
      FETCHED_AT,
    );
    expect(block).toContain(
      "_[cittmsg] id 6 · from: delta → to: * · 2026-08-14T09:30:00Z_",
    );
    expect(block).not.toContain("re: #");
  });

  it("notes omitted older messages with a backlog hint", () => {
    const block = renderBoardInjectionBlock(
      result({
        messages: [],
        omitted: { count: 3, oldestOmittedId: 10 },
      }),
      FETCHED_AT,
    );
    expect(block).toContain("3 weitere Nachrichten (älter als #10)");
    expect(block).toContain("msg_list/msg_read");
  });

  it("renders no omission note when count is 0", () => {
    const block = renderBoardInjectionBlock(
      result({
        messages: [],
        omitted: { count: 0, oldestOmittedId: 1 },
      }),
      FETCHED_AT,
    );
    expect(block).not.toContain("weitere Nachrichten");
  });

  it("renders the board warning line", () => {
    const block = renderBoardInjectionBlock(
      result({ messages: [], warning: "cap reached" }),
      FETCHED_AT,
    );
    expect(block).toContain("_Warning vom Board: cap reached_");
  });

  it("keeps header, sections, omission note and warning in that order", () => {
    const block = renderBoardInjectionBlock(
      result({
        messages: [makeMessage({ id: 1, topic: "t", body: "body" })],
        omitted: { count: 2, oldestOmittedId: 5 },
        warning: "something",
      }),
      FETCHED_AT,
    );
    expect(block.indexOf("# MsgBoard")).toBe(0);
    expect(block.indexOf("## Topic: t")).toBeGreaterThan(
      block.indexOf("# MsgBoard"),
    );
    expect(block.indexOf("weitere Nachrichten")).toBeGreaterThan(
      block.indexOf("## Topic: t"),
    );
    expect(block.indexOf("Warning vom Board")).toBeGreaterThan(
      block.indexOf("weitere Nachrichten"),
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
