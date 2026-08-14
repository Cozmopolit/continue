import { waitFor } from "@testing-library/dom";
import React from "react";
import { Session } from "core";
import { MockIdeMessenger } from "../../context/MockIdeMessenger";
import { renderWithProviders } from "../../util/test/render";
import { newSession } from "../slices/sessionSlice";
import { setupStore } from "../store";
import { loadLastSession } from "./session";

// Always-boot-into-new-chat + workspace-aware resume
// (workspace-fresh-boot.md)

const WORKSPACE_1 = "file:///Users/user/workspace1";
const WORKSPACE_2 = "file:///Users/user/workspace2";

type ListCall = {
  offset?: number;
  limit?: number;
  workspaceDirectory?: string;
};
type LoadCall = { id: string };

const metadata = (sessionId: string) => ({
  sessionId,
  title: `Session ${sessionId}`,
  dateCreated: new Date().toString(),
  workspaceDirectory: WORKSPACE_1,
});

const fullSession = (sessionId: string): Session => ({
  sessionId,
  title: `Session ${sessionId}`,
  workspaceDirectory: WORKSPACE_1,
  history: [],
});

function setupMockMessenger(listCalls: ListCall[], loadCalls: LoadCall[]) {
  const mockIdeMessenger = new MockIdeMessenger();
  mockIdeMessenger.responseHandlers["history/list"] = async (input) => {
    listCalls.push(input);
    return [];
  };
  mockIdeMessenger.responseHandlers["history/load"] = async (input) => {
    loadCalls.push(input);
    return fullSession(input.id);
  };
  return mockIdeMessenger;
}

describe("loadLastSession (workspace-aware resume)", () => {
  beforeEach(() => {
    localStorage.clear();
    window.workspacePaths = [WORKSPACE_1, WORKSPACE_2];
    window.windowId = "test-window";
  });

  afterEach(() => {
    window.workspacePaths = undefined;
    localStorage.clear();
  });

  it("loads the newest session of this workspace, skipping the current session id", async () => {
    const listCalls: ListCall[] = [];
    const loadCalls: LoadCall[] = [];
    const mockIdeMessenger = setupMockMessenger(listCalls, loadCalls);
    const store = setupStore({ ideMessenger: mockIdeMessenger });
    const currentId = store.getState().session.id;

    // Newest entry is the current session (delete-current-session flow: the
    // file still exists on disk at query time) and must be skipped
    mockIdeMessenger.responseHandlers["history/list"] = async (input) => {
      listCalls.push(input);
      return [metadata(currentId), metadata("target-session")];
    };

    await store.dispatch(loadLastSession());

    expect(listCalls).toHaveLength(1);
    expect(listCalls[0].workspaceDirectory).toBe(WORKSPACE_1);
    expect(listCalls[0].limit).toBe(2);
    expect(loadCalls).toEqual([{ id: "target-session" }]);
    expect(store.getState().session.id).toBe("target-session");
  });

  it("falls back to a fresh session when the workspace has no sessions", async () => {
    const listCalls: ListCall[] = [];
    const loadCalls: LoadCall[] = [];
    const mockIdeMessenger = setupMockMessenger(listCalls, loadCalls);
    const store = setupStore({ ideMessenger: mockIdeMessenger });
    const idBefore = store.getState().session.id;

    await store.dispatch(loadLastSession());

    expect(listCalls).toHaveLength(1);
    expect(loadCalls).toHaveLength(0);
    expect(store.getState().session.id).not.toBe(idBefore);
    expect(store.getState().session.history).toHaveLength(0);
  });

  it("requests an unfiltered list when no workspace folders are open", async () => {
    window.workspacePaths = undefined;
    const listCalls: ListCall[] = [];
    const loadCalls: LoadCall[] = [];
    const mockIdeMessenger = setupMockMessenger(listCalls, loadCalls);
    const store = setupStore({ ideMessenger: mockIdeMessenger });
    mockIdeMessenger.responseHandlers["history/list"] = async (input) => {
      listCalls.push(input);
      return [metadata("target-session")];
    };

    await store.dispatch(loadLastSession());

    expect(listCalls[0].workspaceDirectory).toBeUndefined();
    expect(loadCalls).toEqual([{ id: "target-session" }]);
  });
});

describe("Boot behavior (always a fresh session)", () => {
  beforeEach(() => {
    localStorage.clear();
    window.workspacePaths = [WORKSPACE_1];
    window.windowId = "test-window";
  });

  afterEach(() => {
    window.workspacePaths = undefined;
    localStorage.clear();
  });

  it("boots into a fresh session instead of restoring the persisted one", async () => {
    const listCalls: ListCall[] = [];
    const loadCalls: LoadCall[] = [];
    const mockIdeMessenger = setupMockMessenger(listCalls, loadCalls);
    const store = setupStore({ ideMessenger: mockIdeMessenger });

    // Simulate redux-persist rehydration: a previously active session with
    // history. Old behavior would have re-loaded it via history/load on boot.
    store.dispatch(
      newSession({
        ...fullSession("persisted-session"),
        history: [
          {
            message: { role: "user", content: "old chat", id: "m1" },
            contextItems: [],
          },
        ] as any,
      }),
    );
    expect(store.getState().session.id).toBe("persisted-session");

    await renderWithProviders(React.createElement("div"), {
      mockIdeMessenger,
      store,
    });

    // Boot is done once the one-shot metadata refresh has run
    await waitFor(() => expect(listCalls.length).toBeGreaterThan(0), {
      timeout: 4000,
    });
    expect(loadCalls).toHaveLength(0);
    const session = store.getState().session;
    expect(session.id).not.toBe("persisted-session");
    expect(session.history).toHaveLength(0);
    // The old id is remembered for the "Last Session" button
    expect(session.lastSessionId).toBe("persisted-session");
  });
});
