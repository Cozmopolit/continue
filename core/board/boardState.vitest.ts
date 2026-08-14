import fs from "fs";
import os from "os";
import path from "path";
import { pathToFileURL } from "url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { IDE } from "..";
import {
  BOARD_STATE_DIR_NAME,
  BOARD_STATE_FILE_NAME,
  BoardState,
  cursorAfterConsume,
  loadBoardState,
  saveBoardState,
  validateBoardHandle,
  validateBoardTopic,
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

function writeValidState(state: BoardState): void {
  writeStateFile(JSON.stringify(state, null, 2));
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

describe("validateBoardTopic", () => {
  it("accepts regular topics", () => {
    expect(validateBoardTopic("auto-topic-injection")).toBeUndefined();
  });

  it("rejects empty and whitespace-only topics", () => {
    expect(validateBoardTopic("")).toBe("Board topic must not be empty");
    expect(validateBoardTopic("   ")).toBe("Board topic must not be empty");
  });

  it.each(["→", "·", "\n", "\r"])(
    "rejects envelope delimiter %j in topics",
    (char) => {
      expect(validateBoardTopic(`bad${char}topic`)).toContain(
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

  it("parses a valid state file", async () => {
    writeValidState({ handle: "delta", topics: ["t1", "t2"], cursor: 42 });
    expect(await loadBoardState(wsIde())).toEqual({
      handle: "delta",
      topics: ["t1", "t2"],
      cursor: 42,
    });
  });

  it("accepts cursor 0 as a valid boundary", async () => {
    writeValidState({ handle: "delta", topics: [], cursor: 0 });
    expect(await loadBoardState(wsIde())).toEqual({
      handle: "delta",
      topics: [],
      cursor: 0,
    });
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
    [
      "handle containing a delimiter",
      { handle: "bad→handle", topics: [], cursor: 0 },
    ],
    ["empty handle", { handle: "", topics: [], cursor: 0 }],
    ["missing handle", { topics: [], cursor: 0 }],
    ["non-string handle", { handle: 42, topics: [], cursor: 0 }],
    ["topics not an array", { handle: "delta", topics: "t1", cursor: 0 }],
    ["missing cursor", { handle: "delta", topics: [] }],
    ["non-number cursor", { handle: "delta", topics: [], cursor: "42" }],
    ["negative cursor", { handle: "delta", topics: [], cursor: -1 }],
    ["non-integer cursor", { handle: "delta", topics: [], cursor: 1.5 }],
    ["null cursor", { handle: "delta", topics: [], cursor: null }],
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

  it("salvages valid topics and drops invalid ones", async () => {
    writeStateFile(
      JSON.stringify({
        handle: "delta",
        topics: ["good", "bad·topic", 42, "", "   ", "also-good"],
        cursor: 5,
      }),
    );
    const state = await loadBoardState(wsIde());
    expect(state?.topics).toEqual(["good", "also-good"]);
    expect(state?.handle).toBe("delta");
    expect(state?.cursor).toBe(5);
  });
});

describe("saveBoardState", () => {
  it("writes pretty-printed JSON with a trailing newline, creating .continue recursively", async () => {
    const state: BoardState = { handle: "delta", topics: ["t1"], cursor: 7 };
    await saveBoardState(wsIde(), state);
    const raw = fs.readFileSync(stateFilePath(), "utf8");
    expect(raw).toBe(`${JSON.stringify(state, null, 2)}\n`);
  });

  it("throws when no workspace is open", async () => {
    const state: BoardState = { handle: "delta", topics: [], cursor: 0 };
    await expect(saveBoardState(makeIde([]), state)).rejects.toThrow(
      "Cannot save board state: no workspace open",
    );
  });

  it("round-trips through loadBoardState", async () => {
    const state: BoardState = {
      handle: "delta",
      topics: ["t1", "t2"],
      cursor: 99,
    };
    await saveBoardState(wsIde(), state);
    expect(await loadBoardState(wsIde())).toEqual(state);
  });
});

describe("cursorAfterConsume", () => {
  const message = (id: number) => ({
    topic: "t1",
    id,
    from: "home-citt",
    to: "*",
    createdAt: "2026-08-14T00:00:00Z",
    body: `body ${id}`,
  });

  it("returns the current cursor when there are no messages", () => {
    expect(cursorAfterConsume(100, [])).toBe(100);
  });

  it("advances to the highest message id (unsorted input)", () => {
    expect(
      cursorAfterConsume(100, [message(101), message(175), message(150)]),
    ).toBe(175);
  });

  it("never moves backwards", () => {
    expect(cursorAfterConsume(200, [message(101), message(150)])).toBe(200);
  });

  it("advances from cursor 0", () => {
    expect(cursorAfterConsume(0, [message(7)])).toBe(7);
  });
});
