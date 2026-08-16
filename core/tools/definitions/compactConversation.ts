import { Tool } from "../..";

import { BUILT_IN_GROUP_NAME, BuiltInToolNames } from "../builtIn";

// Agent self-compaction (agent-self-compaction.md): the agent schedules an
// in-place (Type 1, non-trimming) conversation compaction for the end of the
// current run. The side effect is GUI-side: the tool-call thunk sets a
// pending flag, and streamResponseThunk runs the compaction post-wrapper.
// The core impl only confirms the request.

export const compactConversationTool: Tool = {
  type: "function",
  displayTitle: "Compact Conversation",
  wouldLikeTo: "schedule a conversation compaction for the end of this run",
  isCurrently: "scheduling the conversation compaction",
  hasAlready: "scheduled the conversation compaction",
  readonly: false,
  group: BUILT_IN_GROUP_NAME,
  function: {
    name: BuiltInToolNames.CompactConversation,
    description:
      "Schedule a compaction of this conversation for the moment the current run completes. Use it when a logical unit of work is done and the details of the conversation so far are not needed for the upcoming steps: the model context up to this point is replaced by a comprehensive summary, while the stored history itself is preserved (the compaction can be removed again). Whatever still happens in the rest of this run is included in the summary, so call it when the run is winding down. Do not call it mid-task while details are still needed.",
    parameters: {
      type: "object",
      properties: {},
    },
  },
  systemMessageDescription: {
    prefix: `When a logical unit of work is complete and the conversation detail is not needed for the next steps, use the ${BuiltInToolNames.CompactConversation} tool to compact the conversation at the end of the current run.`,
  },
  defaultToolPolicy: "allowedWithoutPermission",
};
