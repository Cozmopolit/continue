import { ChatHistoryItem, ILLM, Session, ToolResultChatMessage } from "..";
import { HistoryManager } from "./history";
import { stripImages } from "./messageContent";

export interface CompactionParams {
  sessionId: string;
  index: number;
  historyManager: HistoryManager;
  currentModel: ILLM;
}

/**
 * Generates a summary of the session's history up to (and including) index.
 * Shared by in-place compaction (compactConversation) and session forking
 * (conversation-fork-with-summary.md): incremental re-compaction (integrates
 * the most recent previous summary, excluding one on the target item itself),
 * explicit "Tool cancelled" results for dangling tool calls, fixed 6-point
 * prompt, single non-streaming chat call, images stripped from the result.
 *
 * @param session - The already loaded session (read-only here)
 * @param index - Summarize history up to and including this index
 * @param currentModel - The chat model used to generate the summary
 * @returns The generated summary text (images stripped)
 * @throws Error when the effective summarize input contains no non-empty message
 */
export async function generateConversationSummary(
  session: Session,
  index: number,
  currentModel: ILLM,
): Promise<string> {
  const historyUpToIndex = session.history.slice(0, index + 1);

  // Apply the same filtering logic as in constructMessages, but exclude the target message
  // if it already has a summary (we're re-compacting)
  let summaryContent = "";
  let filteredHistory = historyUpToIndex;

  // First, check if the target message already has a summary and ignore it
  const targetMessageHasSummary = historyUpToIndex[index].conversationSummary;
  const searchHistory = targetMessageHasSummary
    ? historyUpToIndex.slice(0, index)
    : historyUpToIndex;

  // Find the most recent conversation summary (excluding target if it has one)
  for (let i = searchHistory.length - 1; i >= 0; i--) {
    const summary = searchHistory[i].conversationSummary;
    if (summary) {
      summaryContent = summary;
      // Only include messages that come AFTER the message with the summary
      filteredHistory = historyUpToIndex.slice(i + 1);
      break;
    }
  }

  const messages: ChatHistoryItem["message"][] = [];

  // add cancelled chat messages explicitly for cancelled tool calls
  filteredHistory.forEach((item) => {
    messages.push(item.message);
    // toolcalls only exist in an assistant message
    if (item.message.role === "assistant" && item.message.toolCalls) {
      // for every toolcall, if there is no tool message with a tool call id already, add a chat message saying that it is empty
      item.message.toolCalls.forEach((toolCall) => {
        if (
          !filteredHistory.find(
            (item) =>
              item.message.role === "tool" &&
              item.message.toolCallId === toolCall.id,
          )
        ) {
          messages.push({
            role: "tool",
            content: "Tool cancelled",
            toolCallId: toolCall.id,
          } as ToolResultChatMessage);
        }
      });
    }
  });

  // conversation-fork-with-summary.md: refuse degenerate inputs (e.g. forking
  // at the synthetic fork item, whose only message is empty and whose own
  // summary is excluded from the re-compaction search above)
  const hasNonEmptyMessage = filteredHistory.some((item) => {
    const content = item.message.content;
    return typeof content === "string"
      ? content.trim().length > 0
      : Array.isArray(content) && content.length > 0;
  });
  if (!hasNonEmptyMessage && !summaryContent) {
    throw new Error(
      "Cannot generate summary: effective input contains no non-empty messages",
    );
  }

  // If there's a previous summary, include it as a user message at the beginning
  if (summaryContent) {
    messages.unshift({
      role: "user",
      content: `Previous conversation summary:\n\n${summaryContent}`,
    });
  }

  const compactionPrompt = {
    role: "user" as const,
    content:
      "Create a comprehensive summary of this conversation that captures all essential information needed to continue the work seamlessly. Structure your response to preserve technical accuracy and context continuity.\n\nYour summary should include:\n\n1. **Conversation Overview**: Describe the main topic and progression of the discussion, including any shifts in focus or direction.\n\n2. **Active Development**: Detail what was being implemented, modified, or debugged most recently. Include specific technical approaches and methodologies used.\n\n3. **Technical Stack**: List all relevant technologies, frameworks, libraries, coding patterns, and architectural decisions discussed.\n\n4. **File Operations**: Document all files that were created, modified, or referenced, including their purposes and key changes. Include important code snippets and their locations.\n\n5. **Solutions & Troubleshooting**: Summarize problems encountered and how they were resolved, including any debugging steps or workarounds applied.\n\n6. **Outstanding Work**: Clearly identify any incomplete tasks, pending implementations, or next steps that were discussed. Include direct references to user requests and current progress.\n\nIf there's a previous summary in the conversation, integrate its relevant information while removing outdated details. Focus on technical precision and include specific identifiers (file paths, function names, class names, etc.) that would be essential for continuation. Write in third person and maintain an objective, technical tone.",
  };

  // Generate the summary using the current model
  const response = await currentModel.chat(
    [...messages, compactionPrompt],
    new AbortController().signal,
    {},
  );

  return stripImages(response.content);
}

/**
 * Compacts conversation history up to a specified index by generating a
 * summary and storing it on the target history item (non-destructive; the
 * history itself is kept).
 *
 * @param params - Object containing sessionId, index, historyManager, and currentModel
 * @returns Promise<void> - Updates the session with the conversation summary
 */
export async function compactConversation({
  sessionId,
  index,
  historyManager,
  currentModel,
}: CompactionParams): Promise<void> {
  // Get the current session
  const session = historyManager.load(sessionId);
  const summary = await generateConversationSummary(
    session,
    index,
    currentModel,
  );

  // Update the target message with the conversation summary
  const updatedHistory = [...session.history];
  updatedHistory[index] = {
    ...updatedHistory[index],
    conversationSummary: summary,
  };

  // Update the session with the new history
  const updatedSession = {
    ...session,
    history: updatedHistory,
  };

  historyManager.save(updatedSession);
}
