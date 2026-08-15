import { v4 as uuidv4 } from "uuid";

import { ChatHistoryItem, ILLM } from "..";
import { NEW_SESSION_TITLE } from "./constants";
import { generateConversationSummary } from "./conversationCompaction";
import { HistoryManager } from "./history";

export interface ForkWithSummaryParams {
  sessionId: string;
  index: number;
  historyManager: HistoryManager;
  currentModel: ILLM;
}

/**
 * conversation-fork-with-summary.md: creates a new session whose history is a
 * single synthetic item carrying a summary of the source session's history up
 * to (and including) index. The source session is strictly read-only — the
 * summary is persisted solely on the new session.
 *
 * Throws on validation or LLM errors; the core handler deliberately does not
 * swallow them (the GUI surfaces them via toast).
 *
 * @param params - Object containing sessionId, index, historyManager, and currentModel
 * @returns The new session id
 */
export async function forkSessionWithSummary({
  sessionId,
  index,
  historyManager,
  currentModel,
}: ForkWithSummaryParams): Promise<string> {
  // Read-only load of the source session — it is never saved back
  const sourceSession = historyManager.load(sessionId);

  if (sourceSession.history.length === 0) {
    throw new Error("Cannot fork session: history is empty");
  }
  if (index < 0 || index >= sourceSession.history.length) {
    throw new Error(
      `Cannot fork session: index ${index} out of range (history length ${sourceSession.history.length})`,
    );
  }

  // Also throws when the effective summarize input is empty
  // (e.g. forking at the synthetic fork item itself)
  const summary = await generateConversationSummary(
    sourceSession,
    index,
    currentModel,
  );

  const forkItem: ChatHistoryItem = {
    message: { role: "assistant", content: "" },
    contextItems: [],
    conversationSummary: summary,
    continuedFromSessionId: sessionId,
    forkedFromIndex: index,
  };

  const newSessionId = uuidv4();
  historyManager.save({
    sessionId: newSessionId,
    title:
      sourceSession.title === NEW_SESSION_TITLE
        ? NEW_SESSION_TITLE
        : `${sourceSession.title} (continued)`,
    workspaceDirectory: sourceSession.workspaceDirectory,
    history: [forkItem],
    ...(sourceSession.mode !== undefined ? { mode: sourceSession.mode } : {}),
    ...(sourceSession.chatModelTitle !== undefined
      ? { chatModelTitle: sourceSession.chatModelTitle }
      : {}),
  });

  return newSessionId;
}
