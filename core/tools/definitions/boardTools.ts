import { Tool } from "../..";

import { BUILT_IN_GROUP_NAME, BuiltInToolNames } from "../builtIn";

// Board auto-topic-injection (board-auto-topic-injection.md): subscription
// management for the MsgBoard run-start injection. State lives in the
// workspace (`.continue/board-state.json`); CITT is a stateless gateway.

export const boardSubscribeTool: Tool = {
  type: "function",
  displayTitle: "Board Subscribe",
  wouldLikeTo: "subscribe to a MsgBoard topic",
  isCurrently: "subscribing to the MsgBoard topic",
  hasAlready: "subscribed to the MsgBoard topic",
  readonly: false,
  group: BUILT_IN_GROUP_NAME,
  function: {
    name: BuiltInToolNames.BoardSubscribe,
    description:
      "Subscribe this workspace's agent to a MsgBoard topic. New messages on subscribed topics are injected into the agent context at the start of each new chat session. The handle identifies this agent on the board (it comes from the session context, e.g. AGENTS.md — never invent one).",
    parameters: {
      type: "object",
      properties: {
        handle: {
          type: "string",
          description: "This agent's board handle (from the session context)",
        },
        topic: {
          type: "string",
          description: "The board topic to subscribe to",
        },
      },
      required: ["handle", "topic"],
    },
  },
  systemMessageDescription: {
    prefix: `To receive messages from a MsgBoard topic at the start of every new chat session, use the ${BuiltInToolNames.BoardSubscribe} tool with your board handle and the topic name.`,
  },
  defaultToolPolicy: "allowedWithPermission",
};

export const boardUnsubscribeTool: Tool = {
  type: "function",
  displayTitle: "Board Unsubscribe",
  wouldLikeTo: "unsubscribe from a MsgBoard topic",
  isCurrently: "unsubscribing from the MsgBoard topic",
  hasAlready: "unsubscribed from the MsgBoard topic",
  readonly: false,
  group: BUILT_IN_GROUP_NAME,
  function: {
    name: BuiltInToolNames.BoardUnsubscribe,
    description: "Unsubscribe this workspace's agent from a MsgBoard topic.",
    parameters: {
      type: "object",
      properties: {
        topic: {
          type: "string",
          description: "The board topic to unsubscribe from",
        },
      },
      required: ["topic"],
    },
  },
  systemMessageDescription: {
    prefix: `To stop receiving messages from a MsgBoard topic, use the ${BuiltInToolNames.BoardUnsubscribe} tool with the topic name.`,
  },
  defaultToolPolicy: "allowedWithPermission",
};

export const boardSubscriptionsTool: Tool = {
  type: "function",
  displayTitle: "Board Subscriptions",
  wouldLikeTo: "list the MsgBoard subscriptions",
  isCurrently: "listing the MsgBoard subscriptions",
  hasAlready: "listed the MsgBoard subscriptions",
  readonly: true,
  isInstant: true,
  group: BUILT_IN_GROUP_NAME,
  function: {
    name: BuiltInToolNames.BoardSubscriptions,
    description:
      "List this workspace's MsgBoard subscriptions (handle, topics, cursor).",
    parameters: {
      type: "object",
      properties: {},
    },
  },
  systemMessageDescription: {
    prefix: `To see which MsgBoard topics this workspace subscribes to, use the ${BuiltInToolNames.BoardSubscriptions} tool.`,
  },
  defaultToolPolicy: "allowedWithoutPermission",
};
