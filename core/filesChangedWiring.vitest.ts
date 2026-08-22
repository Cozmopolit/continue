/**
 * Integration tests for the files/* handler wiring behind the watcher-SMB
 * mitigation (watcher-smb-hammering-mitigation.md):
 *
 * 1. `files/changed` must NOT blanket-invalidate `walkDirCache` (content
 *    changes never alter the file list); ignore-file changes still route to
 *    `index/forceReIndex`, which invalidates.
 * 2. `files/created`/`files/deleted` refreshes flow through the
 *    `SubmenuRefreshCoalescer`: N batches inside one window produce exactly
 *    one send per window edge, not one per batch.
 *
 * Harness: `InProcessMessenger` plays the IDE side of the protocol
 * (externalRequest = IDE -> Core dispatch, externalOn = capture Core -> IDE
 * sends); `FileSystemIde` over the shared TEST_DIR provides the filesystem.
 * Fake timers are installed BEFORE constructing Core because the coalescer
 * captures `setTimeout`/`Date.now` at construction time — that is what lets
 * the 30 s coalescing window be exercised without real waiting.
 */
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";

import { Core } from "./core";
import type { FileType } from "./index";
import { walkDirCache } from "./indexing/walkDir";
import type { FromCoreProtocol, ToCoreProtocol } from "./protocol";
import { InProcessMessenger } from "./protocol/messenger";
import {
  addToTestDir,
  setUpTestDir,
  tearDownTestDir,
  TEST_DIR,
} from "./test/testDir";
import FileSystemIde from "./util/filesystem";

// Matches SubmenuRefreshCoalescer's DEFAULT_WINDOW_MS (core.ts constructs it
// without options).
const WINDOW_MS = 30_000;
const OUTSIDE_WS_URI = "file:///outside-workspace/noise.ts";
const SEED_DIR_URI = `${TEST_DIR}/seeded-dir`;

let messenger: InProcessMessenger<ToCoreProtocol, FromCoreProtocol>;
let ide: FileSystemIde;
let core: Core;
let invalidateSpy: ReturnType<typeof vi.spyOn> | undefined;
const refreshSends: { providers: string[] }[] = [];

/** Flush microtasks and zero-delay timers under fake timers. */
async function flushMicrotasks(rounds = 25): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await vi.advanceTimersByTimeAsync(0);
  }
}

/** Poll a condition, advancing the fake clock in 1 ms steps. */
async function waitFor(cond: () => boolean, timeoutMs = 5_000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitFor timed out");
    }
    await vi.advanceTimersByTimeAsync(1);
  }
}

function seedWalkDirCache(): void {
  walkDirCache.dirListCache.set(SEED_DIR_URI, {
    time: Date.now(),
    entries: Promise.resolve([["placeholder.ts", 1 as FileType]]),
  });
}

beforeAll(async () => {
  setUpTestDir();
  addToTestDir([
    [".gitignore", "node_modules/\n"],
    "src/",
    ["src/a.ts", "export const a = 1;\n"],
  ]);

  ide = new FileSystemIde(TEST_DIR);

  // Must be active before `new Core()` so the coalescer picks up the fakes.
  vi.useFakeTimers();

  messenger = new InProcessMessenger<ToCoreProtocol, FromCoreProtocol>();
  messenger.externalOn("refreshSubmenuItems", (msg) => {
    refreshSends.push(msg.data);
  });
  // Core requests these during construction; request() throws without a
  // registered external listener.
  messenger.externalOn("getIdeInfo", () => ide.getIdeInfo());
  messenger.externalOn("getIdeSettings", async () => {
    const settings = await ide.getIdeSettings();
    return { ...settings, pauseCodebaseIndexOnStart: true };
  });
  // Requested from fire-and-forget chains (startup index skip, indexer
  // progress); keep it registered so nothing becomes an unhandled rejection.
  messenger.externalOn("indexProgress", async () => undefined);

  core = new Core(messenger, ide);
  invalidateSpy = vi.spyOn(walkDirCache, "invalidate");
  await flushMicrotasks();

  // Discard construction-time activity so each test starts from a clean
  // observation point.
  invalidateSpy.mockClear();
  refreshSends.length = 0;
}, 30_000);

afterAll(() => {
  invalidateSpy?.mockRestore();
  vi.useRealTimers();
  tearDownTestDir();
});

describe("Core construction smoke", () => {
  test("Core boots against InProcessMessenger + FileSystemIde", () => {
    expect(core).toBeInstanceOf(Core);
  });
});

describe("files/changed wiring: walkDirCache is not blanket-invalidated", () => {
  test("content changes leave the walkDir cache intact", async () => {
    seedWalkDirCache();

    await messenger.externalRequest("files/changed", {
      uris: [OUTSIDE_WS_URI],
    });
    await flushMicrotasks();

    expect(invalidateSpy!).not.toHaveBeenCalled();
    expect(walkDirCache.dirListCache.has(SEED_DIR_URI)).toBe(true);
  });

  test("ignore-file changes still invalidate via index/forceReIndex", async () => {
    seedWalkDirCache();

    await messenger.externalRequest("files/changed", {
      uris: [`${TEST_DIR}/.gitignore`],
    });
    // The forceReIndex handler runs fire-and-forget behind invoke(); poll
    // until its walkDirCache.invalidate() lands.
    await waitFor(() => invalidateSpy!.mock.calls.length > 0);

    expect(walkDirCache.dirListCache.size).toBe(0);
  });
});

describe("files/created wiring: refreshSubmenuItems is coalesced", () => {
  test("N batches within one window collapse to one send per edge", async () => {
    refreshSends.length = 0;

    // Cold window: first request sends immediately (leading edge).
    await messenger.externalRequest("files/created", {
      uris: [`${TEST_DIR}/src/a.ts`],
    });
    await flushMicrotasks();
    expect(refreshSends).toHaveLength(1);
    expect(refreshSends[0].providers).toEqual(["file"]);

    // Inside the window: further batches merge into one trailing send.
    await messenger.externalRequest("files/created", {
      uris: [`${TEST_DIR}/src/b.ts`],
    });
    await messenger.externalRequest("files/created", {
      uris: [`${TEST_DIR}/src/c.ts`],
    });
    await flushMicrotasks();
    expect(refreshSends).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(WINDOW_MS);
    expect(refreshSends).toHaveLength(2);
    expect(refreshSends[1].providers).toEqual(["file"]);
  });

  test("fully ignored batches produce no refresh send", async () => {
    refreshSends.length = 0;

    await messenger.externalRequest("files/created", {
      uris: [OUTSIDE_WS_URI],
    });
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(WINDOW_MS);

    expect(refreshSends).toHaveLength(0);
  });
});
