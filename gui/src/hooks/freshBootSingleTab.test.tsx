import { waitFor } from "@testing-library/dom";
import { TabBar } from "../components/TabBar/TabBar";
import { MockIdeMessenger } from "../context/MockIdeMessenger";
import { setupStore } from "../redux/store";
import { setTabs } from "../redux/slices/tabsSlice";
import { loadSession } from "../redux/thunks/session";
import { renderWithProviders } from "../util/test/render";

// Fresh boot (workspace-fresh-boot.md): a reload/restart must open exactly
// one new chat. Regression: before the boot tab reset, every boot appended
// one more tab (TabBar.handleSessionChange saw the unknown fresh session id
// next to a bound active tab) and the persisted tabs accumulated across
// reloads.

describe("fresh boot tab reset", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it("boots into a single fresh tab bound to the fresh session", async () => {
    const mockIdeMessenger = new MockIdeMessenger();
    mockIdeMessenger.responseHandlers["history/load"] = async (input) => ({
      sessionId: input.id,
      title: "Bitte find...",
      workspaceDirectory: "file:///Users/user/workspace1",
      history: [],
    });
    const store = setupStore({ ideMessenger: mockIdeMessenger });

    // Simulate the rehydrated state from before the reload: a loaded
    // session bound to the active tab.
    await store.dispatch(
      loadSession({ sessionId: "prev-session", saveCurrentSession: false }),
    );
    store.dispatch(
      setTabs([
        {
          id: "old-tab",
          title: "Bitte find...",
          isActive: true,
          sessionId: "prev-session",
        },
      ]),
    );

    // renderWithProviders mounts ParallelListeners (boot) alongside the UI.
    await renderWithProviders(<TabBar />, { store, mockIdeMessenger });

    await waitFor(
      () => {
        const state = store.getState();
        // Boot must have run (fresh id) before the tab assertions mean
        // anything — pre-boot there is also exactly one tab.
        expect(state.session.id).not.toBe("prev-session");
        expect(state.tabs.tabs).toHaveLength(1);
        expect(state.tabs.tabs[0].sessionId).toBe(state.session.id);
        expect(state.tabs.tabs[0].title).toBe(state.session.title);
      },
      { timeout: 5000 },
    );

    // The previous chat stays recorded for the "Last Session" button.
    expect(store.getState().session.lastSessionId).toBe("prev-session");
  });
});
