import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../board/boardState", () => ({
  loadBoardState: vi.fn(),
}));
vi.mock("../context/mcp/MCPManagerSingleton", () => ({
  MCPManagerSingleton: { getInstance: vi.fn() },
}));

import { ChatHistoryItem, IDE, Session } from "..";
import { loadBoardState } from "../board/boardState";
import type { ConfigHandler } from "../config/ConfigHandler";
import { MCPManagerSingleton } from "../context/mcp/MCPManagerSingleton";
import {
  dumpTranscript,
  findTranscriptConnection,
  resetDumpThrottle,
  TRANSCRIPT_FALLBACK_MEMORY,
} from "./client";

const loadBoardStateMock = vi.mocked(loadBoardState);
const getInstanceMock = vi.mocked(MCPManagerSingleton.getInstance);

function makeConnection(transcriptCapable: boolean) {
  return {
    status: "connected",
    proxyCapabilities: { proxy: true, transcript: transcriptCapable },
    transcriptDump: vi.fn().mockResolvedValue({
      ok: true,
      fragmentName: "transcript-continue-s1",
      chunks: 1,
      bytes: 10,
    }),
  };
}

function setConnections(connections: unknown[]) {
  getInstanceMock.mockReturnValue({
    connections: new Map(connections.map((c, i) => [`c${i}`, c])),
  } as never);
}

function makeConfigHandler(
  settings:
    | { memory?: string; enabled?: boolean; intervalSeconds?: number }
    | undefined,
): ConfigHandler {
  return {
    loadConfig: vi.fn().mockResolvedValue({
      config: settings === undefined ? {} : { transcriptDump: settings },
    }),
  } as unknown as ConfigHandler;
}

function makeSession(content = "hallo"): Session {
  return {
    sessionId: "s1",
    title: "T",
    workspaceDirectory: "C:\\ws",
    history: [
      {
        message: { role: "user", content },
        contextItems: [],
      } as unknown as ChatHistoryItem,
    ],
  };
}

const ide = {} as unknown as IDE;

beforeEach(() => {
  vi.clearAllMocks();
  resetDumpThrottle();
  loadBoardStateMock.mockResolvedValue(undefined);
});

describe("findTranscriptConnection", () => {
  it("returns the transcript-capable connected connection", () => {
    const capable = makeConnection(true);
    setConnections([makeConnection(false), capable]);
    expect(findTranscriptConnection()).toBe(capable);
  });

  it("ignores connections that are not connected", () => {
    const offline = { ...makeConnection(true), status: "not-connected" };
    setConnections([offline]);
    expect(findTranscriptConnection()).toBeUndefined();
  });

  it("returns undefined without capable server", () => {
    setConnections([makeConnection(false)]);
    expect(findTranscriptConnection()).toBeUndefined();
  });
});

describe("dumpTranscript", () => {
  it("dumps with handle-derived memory default and full meta", async () => {
    const conn = makeConnection(true);
    setConnections([conn]);
    loadBoardStateMock.mockResolvedValue({ handle: "citt-delta" });
    await dumpTranscript(makeSession(), ide, makeConfigHandler(undefined));
    expect(conn.transcriptDump).toHaveBeenCalledOnce();
    const payload = conn.transcriptDump.mock.calls[0][0];
    expect(payload.memory).toBe("transcripts:citt-delta");
    expect(payload.name).toBe("transcript-continue-s1");
    expect(payload.text).toContain("hallo");
    expect(payload.meta).toEqual({
      workspace: "C:\\ws",
      agent: "citt-delta",
      title: "T",
    });
  });

  it("config memory override wins over the handle default", async () => {
    const conn = makeConnection(true);
    setConnections([conn]);
    loadBoardStateMock.mockResolvedValue({ handle: "citt-delta" });
    await dumpTranscript(
      makeSession(),
      ide,
      makeConfigHandler({ memory: "transcripts:custom" }),
    );
    expect(conn.transcriptDump.mock.calls[0][0].memory).toBe(
      "transcripts:custom",
    );
  });

  it("falls back to the shared memory without board state", async () => {
    const conn = makeConnection(true);
    setConnections([conn]);
    await dumpTranscript(makeSession(), ide, makeConfigHandler(undefined));
    const payload = conn.transcriptDump.mock.calls[0][0];
    expect(payload.memory).toBe(TRANSCRIPT_FALLBACK_MEMORY);
    expect(payload.meta.agent).toBeUndefined();
  });

  it("skips silently when history is empty", async () => {
    const conn = makeConnection(true);
    setConnections([conn]);
    const configHandler = makeConfigHandler(undefined);
    await dumpTranscript({ ...makeSession(), history: [] }, ide, configHandler);
    expect(configHandler.loadConfig).not.toHaveBeenCalled();
    expect(conn.transcriptDump).not.toHaveBeenCalled();
  });

  it("skips when disabled via config", async () => {
    const conn = makeConnection(true);
    setConnections([conn]);
    await dumpTranscript(
      makeSession(),
      ide,
      makeConfigHandler({ enabled: false }),
    );
    expect(conn.transcriptDump).not.toHaveBeenCalled();
  });

  it("skips when no transcript-capable server is connected", async () => {
    const conn = makeConnection(false);
    setConnections([conn]);
    await dumpTranscript(makeSession(), ide, makeConfigHandler(undefined));
    expect(conn.transcriptDump).not.toHaveBeenCalled();
  });

  it("never throws on RPC failure — warns and returns", async () => {
    const conn = makeConnection(true);
    conn.transcriptDump.mockRejectedValue(new Error("rpc kaputt"));
    setConnections([conn]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(
      dumpTranscript(makeSession(), ide, makeConfigHandler(undefined)),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("rpc kaputt"));
    warn.mockRestore();
  });
});

describe("dumpTranscript throttle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("dumps the first save immediately (leading) and throttles a rapid second save into the window close (trailing)", async () => {
    const conn = makeConnection(true);
    setConnections([conn]);
    await dumpTranscript(
      makeSession("MARK_V1"),
      ide,
      makeConfigHandler(undefined),
    );
    expect(conn.transcriptDump).toHaveBeenCalledOnce();

    // Second save inside the open window: no dump, only pending.
    await dumpTranscript(
      makeSession("MARK_V2"),
      ide,
      makeConfigHandler(undefined),
    );
    expect(conn.transcriptDump).toHaveBeenCalledOnce();

    // Window close: trailing dump carries the latest state.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(conn.transcriptDump).toHaveBeenCalledTimes(2);
    expect(conn.transcriptDump.mock.calls[1][0].text).toContain("MARK_V2");
  });

  it("collapses a save storm into one trailing dump with the newest state", async () => {
    const conn = makeConnection(true);
    setConnections([conn]);
    await dumpTranscript(
      makeSession("MARK_V1"),
      ide,
      makeConfigHandler(undefined),
    );
    for (const marker of ["MARK_V2", "MARK_V3", "MARK_V4"]) {
      await dumpTranscript(
        makeSession(marker),
        ide,
        makeConfigHandler(undefined),
      );
    }
    expect(conn.transcriptDump).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(30_000);
    expect(conn.transcriptDump).toHaveBeenCalledTimes(2);
    expect(conn.transcriptDump.mock.calls[1][0].text).toContain("MARK_V4");
  });

  it("keeps dumping every interval during continuous activity", async () => {
    const conn = makeConnection(true);
    setConnections([conn]);
    const save = (marker: string) =>
      dumpTranscript(makeSession(marker), ide, makeConfigHandler(undefined));

    await save("MARK_V1"); // t=0: leading dump, window 0–30
    await vi.advanceTimersByTimeAsync(10_000);
    await save("MARK_V2"); // t=10: pending
    await vi.advanceTimersByTimeAsync(10_000);
    await save("MARK_V3"); // t=20: pending (latest)
    await vi.advanceTimersByTimeAsync(10_000); // t=30: trailing dump MARK_V3, window 30–60
    expect(conn.transcriptDump).toHaveBeenCalledTimes(2);
    expect(conn.transcriptDump.mock.calls[1][0].text).toContain("MARK_V3");

    await save("MARK_V4"); // t=30+: pending
    await vi.advanceTimersByTimeAsync(10_000);
    await save("MARK_V5"); // t=40: pending (latest)
    await vi.advanceTimersByTimeAsync(20_000); // t=60: trailing dump MARK_V5
    expect(conn.transcriptDump).toHaveBeenCalledTimes(3);
    expect(conn.transcriptDump.mock.calls[2][0].text).toContain("MARK_V5");
  });

  it("does not dump trailing when nothing was saved during the window", async () => {
    const conn = makeConnection(true);
    setConnections([conn]);
    await dumpTranscript(
      makeSession("MARK_V1"),
      ide,
      makeConfigHandler(undefined),
    );
    await vi.advanceTimersByTimeAsync(60_000);
    expect(conn.transcriptDump).toHaveBeenCalledOnce();
  });

  it("sizes the window from transcriptDump.intervalSeconds", async () => {
    const conn = makeConnection(true);
    setConnections([conn]);
    await dumpTranscript(
      makeSession("MARK_V1"),
      ide,
      makeConfigHandler({ intervalSeconds: 5 }),
    );
    await dumpTranscript(
      makeSession("MARK_V2"),
      ide,
      makeConfigHandler({ intervalSeconds: 5 }),
    );
    expect(conn.transcriptDump).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(5_000);
    expect(conn.transcriptDump).toHaveBeenCalledTimes(2);
    expect(conn.transcriptDump.mock.calls[1][0].text).toContain("MARK_V2");
  });
});
