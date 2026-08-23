import { ToolImpl } from ".";

// Agent self-compaction (agent-self-compaction.md, fork wiring:
// agent-self-compaction-fork-wiring.md): core-side confirmation only. The
// pending flag is set by the GUI tool-call thunk (callToolById), and the
// fork-with-summary compaction itself runs after the current run completes
// (streamResponseThunk post-wrapper) — so the tool can never fork
// mid-stream.

export const compactConversationImpl: ToolImpl = async () => {
  return [
    {
      name: "Compaction scheduled",
      description: "conversation compaction",
      content:
        "Compaction request registered. As soon as the current run completes, the conversation continues in a new session starting with a comprehensive summary; everything still said or done in the rest of this run is included in the summary. End the run when you are done.",
    },
  ];
};
