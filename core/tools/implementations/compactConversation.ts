import { ToolImpl } from ".";

// Agent self-compaction (agent-self-compaction.md): core-side confirmation
// only. The pending flag is set by the GUI tool-call thunk (callToolById),
// and the compaction itself runs after the current run completes
// (streamResponseThunk post-wrapper) — so the tool can never compact
// mid-stream.

export const compactConversationImpl: ToolImpl = async () => {
  return [
    {
      name: "Compaction scheduled",
      description: "conversation compaction",
      content:
        "Compaction request registered. The conversation will be compacted into a summary as soon as the current run completes; everything still said or done in the rest of this run is included in the summary. End the run when you are done.",
    },
  ];
};
