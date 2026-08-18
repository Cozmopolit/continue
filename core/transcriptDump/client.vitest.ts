import { beforeEach, describe, expect, it, vi } from "vitest";

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
  settings: { memory?: string; enabled?: boolean } | undefined,
): ConfigHandler {
  return {
    loadConfig: vi.fn().mockResolvedValue({
      config: settings === undefined ? {} : { transcriptDump: settings },
    }),
  } as unknown as ConfigHandler;
}

function makeSession(): Session {
  return {
    sessionId: "s1",
    title: "T",
    workspaceDirectory: "C:\\ws",
    history: [
      {
        message: { role: "user", content: "hallo" },
        contextItems: [],
      } as unknown as ChatHistoryItem,
    ],
  };
}

const ide = {} as unknown as IDE;

beforeEach(() => {
  vi.clearAllMocks();
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
    loadBoardStateMock.mockResolvedValue({
      handle: "citt-delta",
      topics: [],
      cursor: 0,
    });
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
    loadBoardStateMock.mockResolvedValue({
      handle: "citt-delta",
      topics: [],
      cursor: 0,
    });
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
