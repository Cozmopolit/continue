import fs from "fs";
import os from "os";
import path from "path";
import { pathToFileURL } from "url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { IDE } from "..";
import {
  BOARD_STATE_DIR_NAME,
  BOARD_STATE_FILE_NAME,
  loadBoardState,
  saveBoardState,
  validateBoardHandle,
} from "./boardState";

// Tests run against the real filesystem in a temp workspace directory:
// board-state.json is a plain workspace-local JSON file that users and agents
// may edit by hand, so load-time validation is exercised on real file content.

let wsDir: string;

const stateFilePath = () =>
  path.join(wsDir, BOARD_STATE_DIR_NAME, BOARD_STATE_FILE_NAME);

function makeIde(workspaceDirs: string[]): IDE {
  return {
    getWorkspaceDirs: async () => workspaceDirs,
  } as unknown as IDE;
}

const wsIde = () => makeIde([pathToFileURL(wsDir).href]);

function writeStateFile(content: string): void {
  fs.mkdirSync(path.join(wsDir, BOARD_STATE_DIR_NAME), { recursive: true });
  fs.writeFileSync(stateFilePath(), content, "utf8");
}

beforeEach(() => {
  wsDir = fs.mkdtempSync(path.join(os.tmpdir(), "board-state-test-"));
});

afterEach(() => {
  fs.rmSync(wsDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("validateBoardHandle", () => {
  it("accepts regular handles", () => {
    for (const handle of ["delta", "home-citt", "agent_1", "a b"]) {
      expect(validateBoardHandle(handle)).toBeUndefined();
    }
  });

  it("rejects empty and whitespace-only handles", () => {
    expect(validateBoardHandle("")).toBe("Board handle must not be empty");
    expect(validateBoardHandle("   ")).toBe("Board handle must not be empty");
  });

  it.each(["→", "·", "\n", "\r"])(
    "rejects envelope delimiter %j in handles",
    (char) => {
      expect(validateBoardHandle(`bad${char}handle`)).toContain(
        "envelope delimiters",
      );
    },
  );
});

describe("loadBoardState", () => {
  it("returns undefined when no workspace is open", async () => {
    expect(await loadBoardState(makeIde([]))).toBeUndefined();
  });

  it("returns undefined without warning when the file is missing (feature inactive)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await loadBoardState(wsIde())).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });

  it("parses a valid handle-only state file", async () => {
    writeStateFile(JSON.stringify({ handle: "delta" }, null, 2));
    expect(await loadBoardState(wsIde())).toEqual({ handle: "delta" });
  });

  it("ignores unknown extra keys beyond the handle", async () => {
    writeStateFile(JSON.stringify({ handle: "delta", futureKey: true }));
    expect(await loadBoardState(wsIde())).toEqual({ handle: "delta" });
  });

  it("returns undefined and warns when the file is not valid JSON", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    writeStateFile("{ not json");
    expect(await loadBoardState(wsIde())).toBeUndefined();
    // JSON.parse throws, so this lands in the read-failure path (the
    // "malformed" warning is reserved for parseable-but-invalid states)
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("Failed to read board state"),
    );
  });

  const malformedStates: Array<[string, unknown]> = [
    ["handle containing a delimiter", { handle: "bad→handle" }],
    ["empty handle", { handle: "" }],
    ["whitespace-only handle", { handle: "   " }],
    ["missing handle", {}],
    ["non-string handle", { handle: 42 }],
    ["null handle", { handle: null }],
  ];

  it.each(malformedStates)(
    "rejects malformed state: %s",
    async (_label, content) => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      writeStateFile(JSON.stringify(content));
      expect(await loadBoardState(wsIde())).toBeUndefined();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("malformed"));
    },
  );

  const legacyStates: Array<[string, unknown]> = [
    ["full legacy shape", { handle: "delta", topics: ["t1"], cursor: 42 }],
    ["legacy topics only", { handle: "delta", topics: [] }],
    ["legacy cursor only", { handle: "delta", cursor: 0 }],
  ];

  it.each(legacyStates)(
    "rejects the removed legacy format without compatibility: %s",
    async (_label, content) => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      writeStateFile(JSON.stringify(content));
      expect(await loadBoardState(wsIde())).toBeUndefined();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("legacy"));
    },
  );
});

describe("loadBoardState — closedTopicsSeen (V11b close notification)", () => {
  it("parses a valid closedTopicsSeen list", async () => {
    writeStateFile(
      JSON.stringify({ handle: "delta", closedTopicsSeen: ["a", "b"] }),
    );
    expect(await loadBoardState(wsIde())).toEqual({
      handle: "delta",
      closedTopicsSeen: ["a", "b"],
    });
  });

  it("filters invalid entries down to non-empty strings", async () => {
    writeStateFile(
      JSON.stringify({
        handle: "delta",
        closedTopicsSeen: ["a", 42, "", "   ", null, "b"],
      }),
    );
    expect(await loadBoardState(wsIde())).toEqual({
      handle: "delta",
      closedTopicsSeen: ["a", "b"],
    });
  });

  it("drops the field when nothing valid remains", async () => {
    writeStateFile(JSON.stringify({ handle: "delta", closedTopicsSeen: [] }));
    expect(await loadBoardState(wsIde())).toEqual({ handle: "delta" });
  });

  it("still rejects the legacy shape when closedTopicsSeen is also present", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    writeStateFile(
      JSON.stringify({
        handle: "delta",
        topics: ["t1"],
        closedTopicsSeen: ["a"],
      }),
    );
    expect(await loadBoardState(wsIde())).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("legacy"));
  });
});

describe("saveBoardState", () => {
  it("writes pretty JSON with a trailing newline", async () => {
    await saveBoardState(wsIde(), { handle: "delta" });
    expect(fs.readFileSync(stateFilePath(), "utf8")).toBe(
      `${JSON.stringify({ handle: "delta" }, null, 2)}\n`,
    );
  });

  it("creates the .continue directory when missing", async () => {
    // beforeEach gives a fresh empty workspace dir — no .continue yet.
    await saveBoardState(wsIde(), { handle: "delta" });
    expect(fs.existsSync(stateFilePath())).toBe(true);
  });

  it("leaves no tmp file behind", async () => {
    await saveBoardState(wsIde(), { handle: "delta" });
    expect(fs.existsSync(`${stateFilePath()}.tmp`)).toBe(false);
  });

  it("round-trips through loadBoardState", async () => {
    const state = { handle: "delta", closedTopicsSeen: ["a"] };
    await saveBoardState(wsIde(), state);
    expect(await loadBoardState(wsIde())).toEqual(state);
  });

  it("throws when no workspace is open", async () => {
    await expect(
      saveBoardState(makeIde([]), { handle: "delta" }),
    ).rejects.toThrow("no workspace open");
  });
});
