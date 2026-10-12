// continue-transcript-dump.md: fire-and-forget dump of a saved Session into
// CITT memory via the proprietary `transcript/dump` JSON-RPC method (twin
// pattern: boardClient.ts).

import { IDE, Session } from "..";
import { loadBoardState } from "../board/boardState";
import type { ConfigHandler } from "../config/ConfigHandler";
import { MCPManagerSingleton } from "../context/mcp/MCPManagerSingleton";
import { renderTranscript } from "./renderer";

export const TRANSCRIPT_FALLBACK_MEMORY = "transcripts:continue";

/** Default throttle window (continue-transcript-dump.md, Save-Throttle). */
export const DEFAULT_DUMP_INTERVAL_SECONDS = 30;

interface DumpThrottleWindow {
  timer: ReturnType<typeof setTimeout>;
  pending?: { session: Session; ide: IDE; configHandler: ConfigHandler };
}

// Save-throttle state, keyed per session. An open window means one dump is
// done (leading) and further saves only mark `pending` (latest wins — dumps
// are cumulative full texts, intermediate states are obsolete). The window
// never resets on saves: during continuous tool-loop activity a dump goes
// out every interval, and the latest save is guaranteed to be dumped when
// its window closes (trailing).
const dumpThrottleWindows = new Map<string, DumpThrottleWindow>();

function onDumpWindowEnd(sessionId: string): void {
  const entry = dumpThrottleWindows.get(sessionId);
  if (!entry) {
    return;
  }
  dumpThrottleWindows.delete(sessionId);
  if (entry.pending) {
    // Full re-entry through dumpTranscript: gates re-checked with fresh
    // config, a fresh leading window opens, the latest state is dumped.
    void dumpTranscript(
      entry.pending.session,
      entry.pending.ide,
      entry.pending.configHandler,
    );
  }
}

/** Test hook: drops all throttle windows (pending trailing dumps discarded). */
export function resetDumpThrottle(): void {
  for (const entry of dumpThrottleWindows.values()) {
    clearTimeout(entry.timer);
  }
  dumpThrottleWindows.clear();
}

/**
 * Finds the connected transcript-capable CITT server. The `transcript`
 * capability piggybacks on the `proxy/capabilities` response fetched during
 * connect.
 */
export function findTranscriptConnection() {
  for (const connection of MCPManagerSingleton.getInstance().connections.values()) {
    if (
      connection.status === "connected" &&
      connection.proxyCapabilities?.transcript
    ) {
      return connection;
    }
  }
  return undefined;
}

/**
 * Renders and dumps the session transcript. Best-effort by contract: every
 * failure path logs at most a warning and returns — the save path is never
 * blocked, and the next turn's cumulative dump self-heals a missed one.
 * Throttled per session (continue-transcript-dump.md): the first save of a
 * window dumps immediately (leading), saves during the open window only mark
 * pending, and the latest pending state is dumped when the window closes
 * (trailing) — a dump per interval during long tool-loop runs instead of one
 * per save.
 */
export async function dumpTranscript(
  session: Session,
  ide: IDE,
  configHandler: ConfigHandler,
): Promise<void> {
  try {
    if (!session.history?.length) {
      return;
    }
    const { config } = await configHandler.loadConfig();
    const settings = config?.transcriptDump;
    if (settings?.enabled === false) {
      return;
    }
    const connection = findTranscriptConnection();
    if (!connection) {
      return; // capability gate: no transcript-capable server connected
    }
    // Throttle check-and-set is synchronous after the gate awaits — atomic
    // per JS run-to-completion, so concurrent saves of one session can never
    // open two windows. Windows must not be created before the gates: a save
    // that cannot dump (disabled, no capable server) leaves no state behind.
    const existingWindow = dumpThrottleWindows.get(session.sessionId);
    if (existingWindow) {
      existingWindow.pending = { session, ide, configHandler };
      return;
    }
    const intervalMs =
      Math.max(1, settings?.intervalSeconds ?? DEFAULT_DUMP_INTERVAL_SECONDS) *
      1000;
    const timer = setTimeout(
      () => onDumpWindowEnd(session.sessionId),
      intervalMs,
    );
    (timer as { unref?: () => void }).unref?.();
    dumpThrottleWindows.set(session.sessionId, { timer });
    const handle = (await loadBoardState(ide))?.handle;
    const memory =
      settings?.memory ??
      (handle ? `transcripts:${handle}` : TRANSCRIPT_FALLBACK_MEMORY);
    const name = `transcript-continue-${session.sessionId}`;
    const result = await connection.transcriptDump({
      memory,
      name,
      text: renderTranscript(session),
      meta: {
        workspace: session.workspaceDirectory || undefined,
        agent: handle,
        title: session.title,
      },
    });
    if (result.ok === false) {
      console.warn(`Transcript dump not acknowledged: ${name}`);
      return;
    }
    console.debug(`Transcript dumped: ${name} → ${memory}`);
  } catch (e) {
    console.warn(
      `Transcript dump skipped: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}
