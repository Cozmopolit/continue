import {
  fetchBoardLatest,
  syncBoardSubscription,
} from "../../board/boardClient";
import {
  BoardState,
  loadBoardState,
  saveBoardState,
  validateBoardHandle,
  validateBoardTopic,
} from "../../board/boardState";

import { ToolImpl } from ".";

// Board auto-topic-injection (board-auto-topic-injection.md): subscription
// management. All state lives in `.continue/board-state.json`; the only CITT
// roundtrips are the init-mode cursor bootstrap of the very first
// subscription and — once the workspace is migrated (msgboard-v2,
// msgboard-v2-fork-packages.md) — the best-effort propagation of changes to
// the gateway's server-side subscription state.

export const boardSubscribeImpl: ToolImpl = async (args, extras) => {
  const handle = String(args.handle ?? "");
  const topic = String(args.topic ?? "");

  const handleError = validateBoardHandle(handle);
  if (handleError) {
    throw new Error(handleError);
  }
  const topicError = validateBoardTopic(topic);
  if (topicError) {
    throw new Error(topicError);
  }

  const existing = await loadBoardState(extras.ide);

  if (existing && existing.handle !== handle) {
    throw new Error(
      `Board handle conflict: this workspace's state uses "${existing.handle}", refusing to subscribe as "${handle}". Handle identity comes from the session context and must not change per call.`,
    );
  }

  if (existing) {
    if (existing.topics.includes(topic)) {
      return [
        {
          name: "Already subscribed",
          description: topic,
          content: `Already subscribed to "${topic}" (handle: ${existing.handle}). Nothing changed.`,
        },
      ];
    }
    existing.topics.push(topic);
    await saveBoardState(extras.ide, existing);
    // Cursor already bootstrapped: the global cursor gives later-added topics
    // "from now on" semantics automatically (only id > cursor is delivered).
    // Migrated workspaces (msgboard-v2): propagate the change to the
    // gateway's server-side subscription state. On failure the migration
    // flag is dropped so the next consumption run self-heals via a full
    // re-migration — tell the agent what happened either way.
    const synced = await syncBoardSubscription(extras.ide, topic, true);
    const syncNote = synced
      ? ""
      : " Note: server-side subscription sync failed; the next board fetch re-migrates the full subscription set and heals this automatically.";
    return [
      {
        name: "Subscribed",
        description: topic,
        content: `Subscribed to "${topic}" (handle: ${existing.handle}). New messages (id > current cursor ${existing.cursor}) will be injected at the start of the next chat session. Older messages on this topic (id <= ${existing.cursor}) are not injected; if you need them, read the topic history with msg_list/msg_read.${syncNote}`,
      },
    ];
  }

  // First subscription in this workspace: create state and bootstrap the
  // cursor via an init-mode fetch ("from now on", no backlog dump).
  const state: BoardState = { handle, topics: [topic], cursor: 0 };
  const latest = await fetchBoardLatest([topic]);
  if (latest) {
    state.cursor = Math.max(0, ...Object.values(latest.latestByTopic));
    await saveBoardState(extras.ide, state);
    // Three-way distinction via latestByTopic/emptyTopics (contract annex
    // 5291256996): exists with messages / exists but empty / does not exist
    // (the latter warns about typos — a dead subscription delivers nothing).
    const hasMessages = topic in latest.latestByTopic;
    const isEmpty = latest.emptyTopics?.includes(topic) ?? false;
    const topicNote = hasMessages
      ? ""
      : isEmpty
        ? ` Note: topic "${topic}" exists but has no messages yet.`
        : ` Note: topic "${topic}" does not exist on the board (it is created by the first post — check the name for typos).`;
    return [
      {
        name: "Subscribed",
        description: topic,
        content: `Subscribed to "${topic}" (handle: ${handle}). Cursor set to ${state.cursor} — only newer messages will be injected; messages at or before #${state.cursor} are not (use msg_list/msg_read for the topic history).${topicNote}`,
      },
    ];
  }

  // No board-capable server connected right now: persist with cursor 0. The
  // first available fetch then delivers existing messages (capped).
  await saveBoardState(extras.ide, state);
  return [
    {
      name: "Subscribed",
      description: topic,
      content: `Subscribed to "${topic}" (handle: ${handle}). Note: no board-capable MCP server is connected right now, so the cursor could not be bootstrapped; the first available fetch may include existing messages.`,
    },
  ];
};

export const boardUnsubscribeImpl: ToolImpl = async (args, extras) => {
  const topic = String(args.topic ?? "");

  const topicError = validateBoardTopic(topic);
  if (topicError) {
    throw new Error(topicError);
  }

  const state = await loadBoardState(extras.ide);
  if (!state || !state.topics.includes(topic)) {
    throw new Error(`Not subscribed to "${topic}" — nothing to unsubscribe.`);
  }

  state.topics = state.topics.filter((t) => t !== topic);
  await saveBoardState(extras.ide, state);
  // Migrated workspaces (msgboard-v2): propagate the removal to the gateway
  // (`subscribed: false` removes the server-side subscription). Unlike the
  // subscribe path a failed removal cannot self-heal via re-migration
  // (upsert-only seam), so surface it: messages on the topic may still be
  // injected until the removal is retried successfully.
  const synced = await syncBoardSubscription(extras.ide, topic, false);
  const syncNote = synced
    ? ""
    : ` Note: local unsubscribe saved, but server-side propagation failed — messages on "${topic}" may still be injected until the removal is retried (re-subscribe to the topic, then unsubscribe again).`;
  return [
    {
      name: "Unsubscribed",
      description: topic,
      content: `Unsubscribed from "${topic}". Remaining topics: ${
        state.topics.length > 0 ? state.topics.join(", ") : "(none)"
      }${syncNote}`,
    },
  ];
};

export const boardSubscriptionsImpl: ToolImpl = async (_args, extras) => {
  const state = await loadBoardState(extras.ide);
  if (!state) {
    return [
      {
        name: "Board subscriptions",
        description: "none",
        content:
          "No board subscriptions in this workspace (no .continue/board-state.json). Use board_subscribe to create one.",
      },
    ];
  }
  const content = [
    `handle: ${state.handle}`,
    `cursor: ${state.cursor}`,
    state.topics.length > 0
      ? `topics:\n${state.topics.map((t) => `- ${t}`).join("\n")}`
      : "topics: (none)",
  ].join("\n");
  return [
    {
      name: "Board subscriptions",
      description: `${state.topics.length} topic(s)`,
      content,
    },
  ];
};
