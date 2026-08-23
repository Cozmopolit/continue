import { Tool } from "../..";

import { BUILT_IN_GROUP_NAME, BuiltInToolNames } from "../builtIn";

// Agent self-compaction (agent-self-compaction.md, fork wiring:
// agent-self-compaction-fork-wiring.md): the agent schedules a
// fork-with-summary compaction ("compaction into a new conversation") for
// the end of the current run. The side effect is GUI-side: the tool-call
// thunk sets a pending flag, and streamResponseThunk runs the fork
// post-wrapper. The core impl only confirms the request.

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
      "Schedule a compaction of this conversation for the moment the current run completes. Use it when a logical unit of work is done and the details of the conversation so far are not needed for the upcoming steps: the conversation continues in a new session that starts with a comprehensive summary of everything so far, while the original conversation is preserved untouched and can be reopened (nothing is lost). Whatever still happens in the rest of this run is included in the summary, so call it when the run is winding down. Do not call it mid-task while details are still needed.",
    parameters: {
      type: "object",
      properties: {},
    },
  },
  systemMessageDescription: {
    prefix: `When a logical unit of work is complete and the conversation detail is not needed for the next steps, use the ${BuiltInToolNames.CompactConversation} tool to continue in a fresh conversation with a summary at the end of the current run.`,
  },
  defaultToolPolicy: "allowedWithoutPermission",
};
