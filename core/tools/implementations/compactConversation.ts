import { ToolImpl } from ".";

// Agent self-compaction (agent-self-compaction.md, fork wiring:
// agent-self-compaction-fork-wiring.md, auto-continue:
// agent-self-compaction-auto-continue.md): core-side confirmation only. The
// pending flag is set by the GUI tool-call thunk (callToolById), and the
// fork-with-summary compaction itself runs after the current run completes
// (streamResponseThunk post-wrapper) — so the tool can never fork
// mid-stream. A non-blank continueMessage IS the auto-continue request
// (there is no separate flag) and the confirmation names the follow-up
// message; the GUI replaces this confirmation with a budget-denied message
// when the auto-continue circuit breaker is exhausted. The trim resolution
// below is mirrored in callToolById — keep both in sync.

export const compactConversationImpl: ToolImpl = async (params) => {
  const continueMessage =
    typeof params?.continueMessage === "string"
      ? params.continueMessage.trim()
      : "";
  const autoContinue = continueMessage.length > 0;
  return [
    {
      name: "Compaction scheduled",
      description: "conversation compaction",
      content: autoContinue
        ? `Compaction request registered. As soon as the current run completes, the conversation continues in a new session starting with a comprehensive summary; everything still said or done in the rest of this run is included in the summary. The new session then automatically starts a follow-up run with this user message: "${continueMessage}". End the run when you are done.`
        : "Compaction request registered. As soon as the current run completes, the conversation continues in a new session starting with a comprehensive summary; everything still said or done in the rest of this run is included in the summary. End the run when you are done.",
    },
  ];
};
