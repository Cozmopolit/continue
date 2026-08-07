import { describe, expect, it, vi } from "vitest";
import { createMockStore, getEmptyRootState } from "../../util/test/mockStore";
import { ChatHistoryItemWithMessageId } from "../slices/sessionSlice";
import { RootState } from "../store";
import { cancelStream } from "./cancelStream";

const userItem = (): ChatHistoryItemWithMessageId => ({
  message: { id: "user-1", role: "user", content: "Hello" },
  contextItems: [],
});

const emptyAssistantItem = (): ChatHistoryItemWithMessageId => ({
  message: { id: "assistant-1", role: "assistant", content: "" },
  contextItems: [],
});

const thinkingItem = (content: string): ChatHistoryItemWithMessageId => ({
  message: { id: "thinking-1", role: "thinking", content },
  contextItems: [],
});

const buildState = (
  history: ChatHistoryItemWithMessageId[],
): Partial<RootState> => {
  const rootState = getEmptyRootState();
  rootState.session.history = history;
  rootState.session.isStreaming = true;
  return rootState;
};

describe("cancelStream", () => {
  it("should rescue dangling reasoning and save the session", async () => {
    const store = createMockStore(
      buildState([
        userItem(),
        emptyAssistantItem(),
        thinkingItem("Let me think this through"),
      ]),
    );
    const requestSpy = vi.spyOn(store.mockIdeMessenger, "request");

    await store.dispatch(cancelStream() as any);

    const finalState = store.getState() as RootState;
    expect(finalState.session.isStreaming).toBe(false);
    expect(finalState.session.history).toHaveLength(2);
    expect(finalState.session.history[1].message.role).toBe("assistant");
    expect(finalState.session.history[1].message.content).toContain(
      "Let me think this through",
    );
    expect(finalState.session.history[1].message.content).toContain(
      "[Response interrupted mid-stream",
    );

    const actionTypes = store.getActions().map((a) => a.type);
    expect(actionTypes).toContain("session/rescueInterruptedReasoning");
    expect(actionTypes).toContain("session/clearDanglingMessages");
    expect(actionTypes).toContain("session/saveCurrent/pending");
    expect(
      actionTypes.indexOf("session/rescueInterruptedReasoning"),
    ).toBeLessThan(actionTypes.indexOf("session/clearDanglingMessages"));

    expect(requestSpy).toHaveBeenCalledWith(
      "history/save",
      expect.objectContaining({ history: expect.any(Array) }),
    );
  });

  it("should not save the session when there is nothing to rescue", async () => {
    const store = createMockStore(
      buildState([userItem(), emptyAssistantItem()]),
    );
    const requestSpy = vi.spyOn(store.mockIdeMessenger, "request");

    await store.dispatch(cancelStream() as any);

    const actionTypes = store.getActions().map((a) => a.type);
    // The rescue reducer runs but is a no-op (no reasoning received yet)
    expect(actionTypes).toContain("session/rescueInterruptedReasoning");
    expect(actionTypes).toContain("session/clearDanglingMessages");
    expect(actionTypes).not.toContain("session/saveCurrent/pending");
    expect(requestSpy).not.toHaveBeenCalledWith(
      "history/save",
      expect.anything(),
    );
  });

  it("should keep stock cleanup behavior when the rescue is skipped", async () => {
    const store = createMockStore(
      buildState([
        userItem(),
        emptyAssistantItem(),
        thinkingItem("partial reasoning"),
      ]),
    );
    const requestSpy = vi.spyOn(store.mockIdeMessenger, "request");

    await store.dispatch(cancelStream({ skipReasoningRescue: true }) as any);

    const actionTypes = store.getActions().map((a) => a.type);
    expect(actionTypes).not.toContain("session/rescueInterruptedReasoning");
    expect(actionTypes).not.toContain("session/saveCurrent/pending");
    expect(actionTypes).toContain("session/clearDanglingMessages");

    // Stock behavior: clearDanglingMessages keeps the thinking item
    // (its content counts as a "valid assistant" there) and nothing is saved
    const finalState = store.getState() as RootState;
    expect(
      finalState.session.history.some(
        (item) => item.message.role === "thinking",
      ),
    ).toBe(true);
    expect(requestSpy).not.toHaveBeenCalledWith(
      "history/save",
      expect.anything(),
    );
  });
});
