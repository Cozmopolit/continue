// continue-transcript-dump.md: renders a persisted Session to the minimal
// markdown transcript for the CITT memory dump. Only user/assistant text
// plus compact tool-call lines — no thinking, no system prompt, no
// timestamps. Pure by design.

import { ChatHistoryItem, MessageContent, Session } from "..";

type ToolCallStateItem = NonNullable<ChatHistoryItem["toolCallStates"]>[number];

const ARG_VALUE_MAX = 120;
const RESULT_MAX = 200;

function singleLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

function messageText(content: MessageContent): string {
  if (typeof content === "string") {
    return content;
  }
  return content
    .map((part) => (part.type === "text" ? part.text : "[image]"))
    .join("\n");
}

function formatArgValue(value: unknown): string {
  if (typeof value === "string") {
    return `"${singleLine(value, ARG_VALUE_MAX)}"`;
  }
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "object") {
    return singleLine(JSON.stringify(value) ?? "", ARG_VALUE_MAX);
  }
  return String(value);
}

function renderToolCall(state: ToolCallStateItem): string[] {
  const name = state.toolCall.function.name;
  const args = state.processedArgs ?? state.parsedArgs;
  let argsText = "";
  if (args && typeof args === "object") {
    argsText = Object.entries(args as Record<string, unknown>)
      .map(([key, value]) => `${key}=${formatArgValue(value)}`)
      .join(" ");
  } else {
    const raw = state.toolCall.function.arguments.trim();
    argsText = raw && raw !== "{}" ? singleLine(raw, RESULT_MAX) : "";
  }
  const lines = [`[tool: ${name}${argsText ? ` ${argsText}` : ""}]`];
  const outputText = (state.output ?? [])
    .map((item) => item.content)
    .join("\n")
    .trim();
  if (outputText && (state.status === "done" || state.status === "errored")) {
    const marker = state.status === "errored" ? "✗ error" : "→ ok";
    lines.push(`[${marker}: ${singleLine(outputText, RESULT_MAX)}]`);
  }
  return lines;
}

/**
 * Renders the cumulative transcript for one session dump. Items with no
 * renderable content (e.g. tool-result messages, thinking) are skipped.
 */
export function renderTranscript(session: Session): string {
  const sections: string[] = [`# ${session.title}`];
  for (const item of session.history) {
    const role = item.message.role;
    if (role !== "user" && role !== "assistant") {
      continue;
    }
    const body: string[] = [];
    const text = messageText(item.message.content).trim();
    if (text) {
      body.push(text);
    }
    if (role === "user") {
      for (const contextItem of item.contextItems ?? []) {
        body.push(`[context: ${contextItem.name}]`);
      }
    }
    for (const toolCallState of item.toolCallStates ?? []) {
      body.push(...renderToolCall(toolCallState));
    }
    if (body.length > 0) {
      sections.push(`## ${role}\n\n${body.join("\n")}`);
    }
    const summary = item.conversationSummary?.trim();
    if (summary) {
      // continue-transcript-dump.md: compaction is non-destructive, the
      // history stays complete in the dump. The summary marks "LLM context
      // condensed up to here"; on forks it carries the handoff into the new
      // session's transcript (the synthetic fork item itself renders empty).
      sections.push(`## summary\n\n${summary}`);
    }
  }
  return `${sections.join("\n\n")}\n`;
}
