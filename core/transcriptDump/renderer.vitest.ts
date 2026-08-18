import { describe, expect, it } from "vitest";

import { ChatHistoryItem, Session } from "..";
import { renderTranscript } from "./renderer";

// continue-transcript-dump.md: the renderer is the fidelity owner of the
// dump — user/assistant text + compact tool-call lines only.

function makeSession(history: unknown[], title = "Test Session"): Session {
  return {
    sessionId: "s1",
    title,
    workspaceDirectory: "C:\\ws",
    history: history as ChatHistoryItem[],
  };
}

function userItem(
  content: unknown,
  contextItems: unknown[] = [],
): ChatHistoryItem {
  return {
    message: { role: "user", content },
    contextItems,
  } as unknown as ChatHistoryItem;
}

function assistantItem(
  content: unknown,
  toolCallStates?: unknown[],
): ChatHistoryItem {
  return {
    message: { role: "assistant", content },
    contextItems: [],
    toolCallStates,
  } as unknown as ChatHistoryItem;
}

function toolCallState(overrides: Record<string, unknown> = {}) {
  return {
    toolCallId: "tc1",
    toolCall: {
      id: "tc1",
      type: "function",
      function: { name: "read_file", arguments: "{}" },
    },
    status: "done",
    parsedArgs: undefined,
    ...overrides,
  };
}

describe("renderTranscript", () => {
  it("renders title, user and assistant text in order", () => {
    const out = renderTranscript(
      makeSession([
        userItem("Hallo"),
        assistantItem("Antwort"),
        userItem("Nachfrage"),
      ]),
    );
    expect(out).toBe(
      "# Test Session\n\n## user\n\nHallo\n\n## assistant\n\nAntwort\n\n## user\n\nNachfrage\n",
    );
  });

  it("skips thinking, system and tool messages", () => {
    const out = renderTranscript(
      makeSession([
        { message: { role: "system", content: "sys" }, contextItems: [] },
        { message: { role: "thinking", content: "denkt" }, contextItems: [] },
        {
          message: { role: "tool", content: "ergebnis", toolCallId: "x" },
          contextItems: [],
        },
        userItem("nur das"),
      ]),
    );
    expect(out).toBe("# Test Session\n\n## user\n\nnur das\n");
  });

  it("skips items with no renderable content", () => {
    const out = renderTranscript(makeSession([userItem(""), userItem("da")]));
    expect(out).toBe("# Test Session\n\n## user\n\nda\n");
  });

  it("renders empty history as bare title", () => {
    expect(renderTranscript(makeSession([]))).toBe("# Test Session\n");
  });

  it("renders image parts as [image] and joins text parts", () => {
    const out = renderTranscript(
      makeSession([
        userItem([
          { type: "text", text: "vorher" },
          { type: "imageUrl", imageUrl: { url: "data:..." } },
          { type: "text", text: "nachher" },
        ]),
      ]),
    );
    expect(out).toBe("# Test Session\n\n## user\n\nvorher\n[image]\nnachher\n");
  });

  it("renders user context items as [context: name]", () => {
    const out = renderTranscript(
      makeSession([
        userItem("schau hier", [
          {
            name: "AGENTS.md",
            content: "…",
            description: "",
            id: { providerTitle: "file", itemId: "1" },
          },
        ]),
      ]),
    );
    expect(out).toContain("## user\n\nschau hier\n[context: AGENTS.md]");
  });

  it("renders tool calls from processedArgs (preferred over parsedArgs)", () => {
    const out = renderTranscript(
      makeSession([
        assistantItem("", [
          toolCallState({
            parsedArgs: { path: "RAW" },
            processedArgs: { path: "C:\\a.ts", firstLine: 1 },
          }),
        ]),
      ]),
    );
    expect(out).toContain(
      '## assistant\n\n[tool: read_file path="C:\\a.ts" firstLine=1]',
    );
    expect(out).not.toContain("RAW");
  });

  it("falls back to raw arguments string when no parsed args exist", () => {
    const out = renderTranscript(
      makeSession([
        assistantItem("", [
          toolCallState({
            processedArgs: undefined,
            parsedArgs: undefined,
            toolCall: {
              id: "tc1",
              type: "function",
              function: {
                name: "grep",
                arguments: '{"pattern":"foo"}',
              },
            },
          }),
        ]),
      ]),
    );
    expect(out).toContain('[tool: grep {"pattern":"foo"}]');
  });

  it("renders done result trimmed to one line", () => {
    const out = renderTranscript(
      makeSession([
        assistantItem("", [
          toolCallState({
            output: [
              {
                name: "r",
                description: "",
                content: "Zeile1\nZeile2\nZeile3",
              },
            ],
          }),
        ]),
      ]),
    );
    expect(out).toContain("[→ ok: Zeile1 Zeile2 Zeile3]");
  });

  it("marks errored tool calls with ✗", () => {
    const out = renderTranscript(
      makeSession([
        assistantItem("", [
          toolCallState({
            status: "errored",
            output: [{ name: "e", description: "", content: "boom" }],
          }),
        ]),
      ]),
    );
    expect(out).toContain("[✗ error: boom]");
  });

  it("renders no result line for unfinished calls even with output", () => {
    const out = renderTranscript(
      makeSession([
        assistantItem("", [
          toolCallState({
            status: "calling",
            output: [{ name: "p", description: "", content: "partial" }],
          }),
        ]),
      ]),
    );
    expect(out).toContain("[tool: read_file]");
    expect(out).not.toContain("partial");
  });

  it("truncates long arg values at 120 chars", () => {
    const value = "a".repeat(200);
    const out = renderTranscript(
      makeSession([
        assistantItem("", [
          toolCallState({ processedArgs: { content: value } }),
        ]),
      ]),
    );
    expect(out).toContain(`"${"a".repeat(120)}…"`);
    expect(out).not.toContain("a".repeat(121));
  });

  it("keeps arg values at exactly 120 chars untruncated", () => {
    const value = "b".repeat(120);
    const out = renderTranscript(
      makeSession([
        assistantItem("", [
          toolCallState({ processedArgs: { content: value } }),
        ]),
      ]),
    );
    expect(out).toContain(`"${value}"`);
    expect(out).not.toContain("…");
  });

  it("truncates results at 200 chars", () => {
    const out = renderTranscript(
      makeSession([
        assistantItem("", [
          toolCallState({
            output: [{ name: "r", description: "", content: "c".repeat(300) }],
          }),
        ]),
      ]),
    );
    expect(out).toContain(`${"c".repeat(200)}…`);
    expect(out).not.toContain("c".repeat(201));
  });

  it("serializes object args as compact JSON", () => {
    const out = renderTranscript(
      makeSession([
        assistantItem("", [
          toolCallState({
            toolCall: {
              id: "tc1",
              type: "function",
              function: { name: "msg_post", arguments: "{}" },
            },
            processedArgs: { re: 5, wait: true, meta: { a: 1 } },
          }),
        ]),
      ]),
    );
    expect(out).toContain('[tool: msg_post re=5 wait=true meta={"a":1}]');
  });
});
