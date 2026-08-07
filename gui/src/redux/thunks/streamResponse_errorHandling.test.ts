import { JSONContent } from "@tiptap/core";
import { InputModifiers } from "core";
import { describe, expect, it, vi } from "vitest";
import { createMockStore, getEmptyRootState } from "../../util/test/mockStore";
import { streamResponseThunk } from "./streamResponse";

// Mock external dependencies only - let selectors run naturally
// Removed: modelSupportsNativeTools - let it run naturally

// Removed: addSystemMessageToolsToSystemMessage - let it run naturally

// Mock system message construction to keep test readable
vi.mock("../util/getBaseSystemMessage", () => ({
  getBaseSystemMessage: vi.fn(),
}));

import { getBaseSystemMessage } from "../util/getBaseSystemMessage";

// Removed: shouldAutoEnableSystemMessageTools - let it run naturally

vi.mock("uuid", () => ({
  v4: vi.fn(() => "mock-uuid-123"),
}));

vi.mock(
  "../../components/mainInput/TipTapEditor/utils/resolveEditorContent",
  () => ({
    resolveEditorContent: vi.fn(),
  }),
);

import { unwrapResult } from "@reduxjs/toolkit";
import { resolveEditorContent } from "../../components/mainInput/TipTapEditor/utils/resolveEditorContent";
import { MockIdeMessenger } from "../../context/MockIdeMessenger";
import { getRootStateWithClaude } from "./streamResponse.test";

const mockGetBaseSystemMessage = vi.mocked(getBaseSystemMessage);

const mockResolveEditorContent = vi.mocked(resolveEditorContent);

// Mock editor state (what user types in the input)
const mockEditorState: JSONContent = {
  type: "doc",
  content: [
    {
      type: "paragraph",
      content: [{ type: "text", text: "Hello, please help me with this code" }],
    },
  ],
};

// Mock input modifiers (codebase context, etc.)
const mockModifiers: InputModifiers = {
  useCodebase: true,
  noContext: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockResolveEditorContent.mockResolvedValue({
    selectedContextItems: [],
    selectedCode: [],
    content: "Hello, please help me with this code",
    legacyCommandWithInput: undefined,
  });

  // Mock getBaseSystemMessage to return simple system message for readable tests
  mockGetBaseSystemMessage.mockReturnValue("You are a helpful assistant.");
});

describe("streamResponseThunk", () => {
  it("should throw error when no chat model is selected", async () => {
    const noModelState = getEmptyRootState();
    noModelState.session.history = [
      {
        message: { id: "1", role: "user", content: "Hello" },
        contextItems: [],
      },
    ];

    // Create store with no selected chat model
    const mockStoreNoModel = createMockStore(noModelState);
    const requestSpy = vi.spyOn(mockStoreNoModel.mockIdeMessenger, "request");
    const chatSpy = vi.spyOn(
      mockStoreNoModel.mockIdeMessenger,
      "llmStreamChat",
    );

    // Execute thunk and expect it to be rejected
    const result = await mockStoreNoModel.dispatch(
      streamResponseThunk({
        editorState: mockEditorState,
        modifiers: mockModifiers,
      }) as any,
    );

    // Verify the thunk completed successfully but shows error dialog
    expect(result.type).toBe("chat/streamResponse/fulfilled");

    // Verify the complete error handling flow
    const dispatchedActions = mockStoreNoModel.getActions();
    expect(dispatchedActions).toEqual([
      {
        type: "chat/streamResponse/pending",
        meta: expect.objectContaining({
          arg: { editorState: mockEditorState, modifiers: mockModifiers },
          requestStatus: "pending",
        }),
        payload: undefined,
      },
      {
        type: "chat/streamWrapper/pending",
        meta: expect.objectContaining({
          requestStatus: "pending",
        }),
        payload: undefined,
      },
      {
        type: "chat/cancelStream/pending",
        meta: expect.objectContaining({
          arg: undefined,
          requestStatus: "pending",
        }),
        payload: undefined,
      },
      {
        type: "session/setInactive",
        payload: undefined,
      },
      {
        type: "session/abortStream",
        payload: undefined,
      },
      {
        type: "session/rescueInterruptedReasoning",
        payload: undefined,
      },
      {
        type: "session/clearDanglingMessages",
        payload: undefined,
      },
      {
        type: "chat/cancelStream/fulfilled",
        meta: expect.objectContaining({
          arg: undefined,
          requestStatus: "fulfilled",
        }),
        payload: undefined,
      },
      {
        type: "ui/setDialogMessage",
        payload: expect.objectContaining({
          props: expect.objectContaining({
            error: expect.objectContaining({
              message: "No chat model selected",
            }),
          }),
        }),
      },
      {
        type: "ui/setShowDialog",
        payload: true,
      },
      {
        type: "chat/streamWrapper/fulfilled",
        meta: expect.objectContaining({
          requestStatus: "fulfilled",
        }),
        payload: undefined,
      },
      {
        type: "chat/streamResponse/fulfilled",
        meta: expect.objectContaining({
          arg: { editorState: mockEditorState, modifiers: mockModifiers },
          requestStatus: "fulfilled",
        }),
        payload: undefined,
      },
    ]);

    // Verify no IDE messenger calls were made
    expect(requestSpy).not.toHaveBeenCalled();
    expect(chatSpy).not.toHaveBeenCalled();

    // Verify final state shows error dialog and inactive streaming
    const finalState = mockStoreNoModel.getState();
    expect(finalState).toEqual({
      ...noModelState,
      session: {
        ...noModelState.session,
        streamAborter: expect.any(AbortController),
        history: [
          { ...noModelState.session.history[0], isGatheringContext: false },
        ],
      },
      ui: {
        ...noModelState.ui,
        showDialog: true, // Error dialog is shown
        dialogMessage: expect.objectContaining({
          props: expect.objectContaining({
            error: expect.objectContaining({
              message: "No chat model selected",
            }),
          }),
        }),
      },
    });
  });

  it("should handle compilation error - not enough context", async () => {
    const initialState = getRootStateWithClaude();
    initialState.session.history = [
      {
        message: { id: "1", role: "user", content: "Hello" },
        contextItems: [],
      },
    ];
    initialState.session.id = "session-123";
    const mockStore = createMockStore(initialState);
    const mockIdeMessenger = mockStore.mockIdeMessenger;
    const requestSpy = vi.spyOn(mockIdeMessenger, "request");
    const chatSpy = vi.spyOn(mockIdeMessenger, "llmStreamChat");

    requestSpy.mockImplementation(async (message, data) => {
      if (message === "llm/compileChat") {
        return {
          done: true,
          status: "error",
          error: "Not enough context available for this request",
        };
      } else {
        return await new MockIdeMessenger().request(message, data);
      }
    });

    // Execute thunk
    const result = await mockStore.dispatch(
      streamResponseThunk({
        editorState: mockEditorState,
        modifiers: mockModifiers,
      }) as any,
    );
    unwrapResult(result);

    // Verify thunk completed successfully (doesn't throw, handles error gracefully)
    expect(result.type).toBe("chat/streamResponse/fulfilled");

    // Verify exact action sequence for this error path
    const dispatchedActions = mockStore.getActions();
    expect(dispatchedActions).toEqual([
      {
        type: "chat/streamResponse/pending",
        meta: expect.objectContaining({
          arg: { editorState: mockEditorState, modifiers: mockModifiers },
          requestStatus: "pending",
        }),
        payload: undefined,
      },
      {
        type: "chat/streamWrapper/pending",
        meta: expect.objectContaining({
          requestStatus: "pending",
        }),
        payload: undefined,
      },
      {
        type: "session/submitEditorAndInitAtIndex",
        payload: {
          editorState: mockEditorState,
          index: 1,
        },
      },
      {
        type: "session/resetNextCodeBlockToApplyIndex",
        payload: undefined,
      },
      {
        type: "symbols/updateFromContextItems/pending",
        meta: expect.objectContaining({
          arg: [],
          requestStatus: "pending",
        }),
        payload: undefined,
      },
      {
        type: "session/updateHistoryItemAtIndex",
        payload: {
          index: 1,
          updates: {
            contextItems: [],
            message: {
              content: "Hello, please help me with this code",
              id: "mock-uuid-123",
              role: "user",
            },
          },
        },
      },
      {
        type: "chat/streamNormalInput/pending",
        meta: expect.objectContaining({
          arg: { legacySlashCommandData: undefined },
          requestStatus: "pending",
        }),
        payload: undefined,
      },
      {
        type: "symbols/updateFromContextItems/fulfilled",
        meta: expect.objectContaining({
          arg: [],
          requestStatus: "fulfilled",
        }),
        payload: undefined,
      },
      {
        type: "session/setAppliedRulesAtIndex",
        payload: {
          appliedRules: [],
          index: 1,
        },
      },
      {
        type: "session/setActive",
        payload: undefined,
      },
      {
        type: "session/setInlineErrorMessage",
        payload: undefined,
      },
      {
        type: "session/setInlineErrorMessage",
        payload: "out-of-context",
      },
      {
        type: "session/setInactive",
        payload: undefined,
      },
      {
        type: "chat/streamNormalInput/fulfilled",
        meta: expect.objectContaining({
          arg: { legacySlashCommandData: undefined },
          requestStatus: "fulfilled",
        }),
        payload: undefined,
      },
      {
        type: "session/saveCurrent/pending",
        meta: expect.objectContaining({
          arg: { generateTitle: true, openNewSession: false },
          requestStatus: "pending",
        }),
        payload: undefined,
      },
      {
        type: "session/update/pending",
        meta: expect.objectContaining({
          arg: expect.objectContaining({
            sessionId: "session-123",
            title: "Hello",
          }),
          requestStatus: "pending",
        }),
        payload: undefined,
      },
      {
        type: "session/updateSessionMetadata",
        payload: {
          sessionId: "session-123",
          title: "Hello",
        },
      },
      {
        type: "session/refreshMetadata/pending",
        meta: expect.objectContaining({
          requestStatus: "pending",
        }),
        payload: undefined,
      },
      {
        type: "session/setIsSessionMetadataLoading",
        payload: false,
      },
      {
        type: "session/setAllSessionMetadata",
        payload: [],
      },
      {
        type: "session/refreshMetadata/fulfilled",
        meta: expect.objectContaining({
          requestStatus: "fulfilled",
        }),
        payload: [],
      },
      {
        type: "session/update/fulfilled",
        meta: expect.objectContaining({
          arg: expect.objectContaining({
            sessionId: "session-123",
            title: "Hello",
          }),
          requestStatus: "fulfilled",
        }),
        payload: undefined,
      },
      {
        type: "session/saveCurrent/fulfilled",
        meta: expect.objectContaining({
          arg: { generateTitle: true, openNewSession: false },
          requestStatus: "fulfilled",
        }),
        payload: undefined,
      },
      {
        type: "chat/streamWrapper/fulfilled",
        meta: expect.objectContaining({
          requestStatus: "fulfilled",
        }),
        payload: undefined,
      },
      {
        type: "chat/streamResponse/fulfilled",
        meta: expect.objectContaining({
          arg: { editorState: mockEditorState, modifiers: mockModifiers },
          requestStatus: "fulfilled",
        }),
        payload: undefined,
      },
    ]);

    // Verify IDE messenger was called for compilation but not streaming
    // System message now includes env block with workspace_root and platform
    expect(requestSpy).toHaveBeenCalledWith("llm/compileChat", {
      messages: [
        {
          role: "system",
          content: expect.stringContaining("You are a helpful assistant."),
        },
        {
          role: "user",
          content: [
            {
              text: "Hello",
              type: "text",
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              text: "Hello, please help me with this code",
              type: "text",
            },
          ],
        },
      ],
      options: {},
    });
    expect(chatSpy).not.toHaveBeenCalled();

    // Verify final state shows error condition
    const finalState = mockStore.getState();
    expect(finalState).toEqual({
      ...initialState,
      session: {
        ...initialState.session,
        title: "Hello",
        history: [
          {
            contextItems: [],
            message: {
              content: "Hello",
              id: "1",
              role: "user",
            },
          },
          {
            appliedRules: [],
            contextItems: [],
            editorState: {
              type: "doc",
              content: [
                {
                  type: "paragraph",
                  content: [
                    {
                      type: "text",
                      text: "Hello, please help me with this code",
                    },
                  ],
                },
              ],
            },
            message: {
              content: "Hello, please help me with this code",
              id: "mock-uuid-123",
              role: "user",
            },
          },
          {
            contextItems: [],
            isGatheringContext: false,
            message: {
              content: "",
              id: "mock-uuid-123",
              role: "assistant",
            },
          },
        ],
        streamAborter: expect.any(AbortController),
        inlineErrorMessage: "out-of-context", // Error message set
      },
    });
  });

  it("should throw error for other compilation errors", async () => {
    const initialState = getRootStateWithClaude();
    initialState.session.history = [
      {
        message: { id: "1", role: "user", content: "Hello" },
        contextItems: [],
      },
    ];
    const mockStore = createMockStore(initialState);
    const mockIdeMessenger = mockStore.mockIdeMessenger;
    // Capture the original implementation before spying — calling
    // mockIdeMessenger.request inside the spy fallback would recurse infinitely
    const originalRequest = mockIdeMessenger.request.bind(mockIdeMessenger);
    const requestSpy = vi.spyOn(mockIdeMessenger, "request");
    const chatSpy = vi.spyOn(mockIdeMessenger, "llmStreamChat");

    // Mock compilation failure with generic error
    requestSpy.mockImplementation(async (message, data) => {
      if (message === "llm/compileChat") {
        return {
          done: true,
          status: "error",
          error: "Model configuration is invalid",
        };
      } else {
        return await originalRequest(message, data);
      }
    });

    // Execute thunk and expect it to be rejected
    const result = await mockStore.dispatch(
      streamResponseThunk({
        editorState: mockEditorState,
        modifiers: mockModifiers,
      }) as any,
    );

    // Verify thunk completed successfully but shows error dialog
    expect(result.type).toBe("chat/streamResponse/fulfilled");

    // Verify exact action sequence for compilation error with dialog
    const dispatchedActions = mockStore.getActions();
    expect(dispatchedActions).toEqual([
      {
        type: "chat/streamResponse/pending",
        meta: expect.objectContaining({
          arg: { editorState: mockEditorState, modifiers: mockModifiers },
          requestStatus: "pending",
        }),
        payload: undefined,
      },
      {
        type: "chat/streamWrapper/pending",
        meta: expect.objectContaining({
          requestStatus: "pending",
        }),
        payload: undefined,
      },
      {
        type: "session/submitEditorAndInitAtIndex",
        payload: {
          editorState: mockEditorState,
          index: 1,
        },
      },
      {
        type: "session/resetNextCodeBlockToApplyIndex",
        payload: undefined,
      },
      {
        type: "symbols/updateFromContextItems/pending",
        meta: expect.objectContaining({
          arg: [],
          requestStatus: "pending",
        }),
        payload: undefined,
      },
      {
        type: "session/updateHistoryItemAtIndex",
        payload: {
          index: 1,
          updates: {
            contextItems: [],
            message: {
              content: "Hello, please help me with this code",
              id: "mock-uuid-123",
              role: "user",
            },
          },
        },
      },
      {
        type: "chat/streamNormalInput/pending",
        meta: expect.objectContaining({
          arg: { legacySlashCommandData: undefined },
          requestStatus: "pending",
        }),
        payload: undefined,
      },
      {
        type: "symbols/updateFromContextItems/fulfilled",
        meta: expect.objectContaining({
          arg: [],
          requestStatus: "fulfilled",
        }),
        payload: undefined,
      },
      {
        type: "session/setAppliedRulesAtIndex",
        payload: {
          appliedRules: [],
          index: 1,
        },
      },
      {
        type: "session/setActive",
        payload: undefined,
      },
      {
        type: "session/setInlineErrorMessage",
        payload: undefined,
      },
      {
        type: "chat/streamNormalInput/rejected",
        meta: expect.objectContaining({
          arg: { legacySlashCommandData: undefined },
          requestStatus: "rejected",
        }),
        payload: undefined,
        error: expect.objectContaining({
          message: "Model configuration is invalid",
        }),
      },
      {
        type: "chat/cancelStream/pending",
        meta: expect.objectContaining({
          arg: undefined,
          requestStatus: "pending",
        }),
        payload: undefined,
      },
      {
        type: "session/setInactive",
        payload: undefined,
      },
      {
        type: "session/abortStream",
        payload: undefined,
      },
      {
        type: "session/rescueInterruptedReasoning",
        payload: undefined,
      },
      {
        type: "session/clearDanglingMessages",
        payload: undefined,
      },
      {
        type: "chat/cancelStream/fulfilled",
        meta: expect.objectContaining({
          arg: undefined,
          requestStatus: "fulfilled",
        }),
        payload: undefined,
      },
      {
        type: "ui/setDialogMessage",
        payload: expect.objectContaining({
          props: expect.objectContaining({
            error: expect.objectContaining({
              message: "Model configuration is invalid",
            }),
          }),
        }),
      },
      {
        type: "ui/setShowDialog",
        payload: true,
      },
      {
        type: "chat/streamWrapper/fulfilled",
        meta: expect.objectContaining({
          requestStatus: "fulfilled",
        }),
        payload: undefined,
      },
      {
        type: "chat/streamResponse/fulfilled",
        meta: expect.objectContaining({
          arg: { editorState: mockEditorState, modifiers: mockModifiers },
          requestStatus: "fulfilled",
        }),
        payload: undefined,
      },
    ]);

    // Verify IDE messenger was called for compilation but not streaming
    expect(requestSpy).toHaveBeenCalledWith("llm/compileChat", {
      messages: [
        {
          role: "system",
          content: expect.stringContaining("You are a helpful assistant."),
        },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "Hello",
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "Hello, please help me with this code",
            },
          ],
        },
      ],
      options: {},
    });
    expect(chatSpy).not.toHaveBeenCalled();

    // Verify final state shows error dialog and inactive streaming
    const finalState = mockStore.getState();
    expect(finalState).toEqual({
      ...initialState,
      session: {
        ...initialState.session,
        streamAborter: expect.any(AbortController),
        mainEditorContentTrigger: mockEditorState, // Editor content that triggered the request
      },
      ui: {
        ...initialState.ui,
        showDialog: true, // Error dialog is shown
        dialogMessage: expect.objectContaining({
          props: expect.objectContaining({
            error: expect.objectContaining({
              message: "Model configuration is invalid",
            }),
          }),
        }),
      },
    });
  });
});
