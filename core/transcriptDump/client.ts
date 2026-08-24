// continue-transcript-dump.md: fire-and-forget dump of a saved Session into
// CITT memory via the proprietary `transcript/dump` JSON-RPC method (twin
// pattern: boardClient.ts).

import { IDE, Session } from "..";
import { loadBoardState } from "../board/boardState";
import type { ConfigHandler } from "../config/ConfigHandler";
import { MCPManagerSingleton } from "../context/mcp/MCPManagerSingleton";
import { renderTranscript } from "./renderer";

export const TRANSCRIPT_FALLBACK_MEMORY = "transcripts:continue";

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
