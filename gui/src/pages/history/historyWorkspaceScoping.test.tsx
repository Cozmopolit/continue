import { screen, waitFor } from "@testing-library/dom";
import { MockIdeMessenger } from "../../context/MockIdeMessenger";
import { renderWithProviders } from "../../util/test/render";
import HistoryPage from "./index";

// Workspace scoping (workspace-scoped-session-history.md): the GUI lists only
// sessions of the current workspace unless the per-window "Show all
// workspaces" toggle overrides it.

const WORKSPACE_1 = "file:///Users/user/workspace1";
const WORKSPACE_2 = "file:///Users/user/workspace2";
const WINDOW_ID = "test-window";
const TOGGLE_STORAGE_KEY = `historyAllWorkspaces_${WINDOW_ID}`;

type ListCall = {
  offset?: number;
  limit?: number;
  workspaceDirectory?: string;
};

const SESSIONS = [
  {
    title: "Workspace 1 session",
    sessionId: "session-ws1",
    dateCreated: new Date().toString(),
    workspaceDirectory: WORKSPACE_1,
  },
  {
    title: "Workspace 2 session",
    sessionId: "session-ws2",
    dateCreated: new Date().toString(),
    workspaceDirectory: WORKSPACE_2,
  },
];

function setupMockMessenger(listCalls: ListCall[]) {
  const mockIdeMessenger = new MockIdeMessenger();
  mockIdeMessenger.responseHandlers["history/list"] = async (input) => {
    listCalls.push(input);
    return SESSIONS;
  };
  return mockIdeMessenger;
}

describe("History workspace scoping", () => {
  beforeEach(() => {
    localStorage.clear();
    window.workspacePaths = [WORKSPACE_1, WORKSPACE_2];
    window.windowId = WINDOW_ID;
  });

  afterEach(() => {
    window.workspacePaths = undefined;
    localStorage.clear();
  });

  it("requests sessions scoped to the first workspace directory by default", async () => {
    const listCalls: ListCall[] = [];
    await renderWithProviders(<HistoryPage />, {
      mockIdeMessenger: setupMockMessenger(listCalls),
    });

    // The initial metadata fetch happens after config load (ParallelListeners)
    await waitFor(() => expect(listCalls.length).toBeGreaterThan(0), {
      timeout: 4000,
    });
    expect(
      listCalls.every((call) => call.workspaceDirectory === WORKSPACE_1),
    ).toBe(true);
  });

  it("shows the all-workspaces toggle only when workspace paths exist", async () => {
    const listCalls: ListCall[] = [];
    const { unmount } = await renderWithProviders(<HistoryPage />, {
      mockIdeMessenger: setupMockMessenger(listCalls),
    });
    expect(
      screen.getByTestId("history-all-workspaces-toggle"),
    ).toBeInTheDocument();
    unmount();

    window.workspacePaths = undefined;
    await renderWithProviders(<HistoryPage />, {
      mockIdeMessenger: setupMockMessenger(listCalls),
    });
    expect(
      screen.queryByTestId("history-all-workspaces-toggle"),
    ).not.toBeInTheDocument();
  });

  it("toggling persists the preference and re-requests without workspace scoping", async () => {
    const listCalls: ListCall[] = [];
    const { user } = await renderWithProviders(<HistoryPage />, {
      mockIdeMessenger: setupMockMessenger(listCalls),
    });

    // The clickable element is the switch track inside the toggle wrapper
    const track = screen
      .getByTestId("history-all-workspaces-toggle")
      .querySelector(".border-command-border") as HTMLElement;
    expect(track).not.toBeNull();
    await user.click(track);

    expect(JSON.parse(localStorage.getItem(TOGGLE_STORAGE_KEY)!)).toBe(true);
    await waitFor(() =>
      expect(
        listCalls.some((call) => call.workspaceDirectory === undefined),
      ).toBe(true),
    );
  });

  it("honors a persisted all-workspaces preference", async () => {
    localStorage.setItem(TOGGLE_STORAGE_KEY, "true");
    const listCalls: ListCall[] = [];
    await renderWithProviders(<HistoryPage />, {
      mockIdeMessenger: setupMockMessenger(listCalls),
    });

    await waitFor(() => expect(listCalls.length).toBeGreaterThan(0), {
      timeout: 4000,
    });
    expect(
      listCalls.every((call) => call.workspaceDirectory === undefined),
    ).toBe(true);
  });
});
