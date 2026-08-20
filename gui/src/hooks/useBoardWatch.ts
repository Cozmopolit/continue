import { JSONContent } from "@tiptap/core";
import { InputModifiers } from "core";
import { useContext, useEffect, useRef } from "react";
import { useStore } from "react-redux";
import { useMainEditor } from "../components/mainInput/TipTapEditor/MainEditorProvider";
import { hasValidEditorContent } from "../components/mainInput/TipTapEditor/utils/editorConfig";
import { IdeMessengerContext } from "../context/IdeMessenger";
import { useAppDispatch, useAppSelector } from "../redux/hooks";
import {
  selectConversationIsStarted,
  selectIsCompactionRunning,
  selectIsConversationIdle,
} from "../redux/selectors/selectToolCalls";
import { RootState } from "../redux/store";
import { fetchBoardPending } from "../redux/thunks/fetchBoardPending";
import { streamResponseThunk } from "../redux/thunks/streamResponse";

/**
 * Poll cadence while idle-watching (board-wake-mode.md). Doubled from 30 s
 * after the 2026-08-18 GitHub rate-limit incident — together with the
 * per-tick jitter below this is the fork half of the KISS interim
 * (board-rate-limit-polling-regime.md).
 */
const BOARD_WATCH_INTERVAL_MS = 60_000;

/**
 * Per-tick delay: interval ± 25 % jitter. Concurrently booted windows used
 * to tick phase-locked (same boot window → same 30-s phase → synchronized
 * bursts into the shared GitHub quota; incident 2026-08-18). Independently
 * jittered delays decorrelate the windows within a few ticks; the draw also
 * staggers the first tick after activation.
 */
export function nextWatchDelayMs(): number {
  return BOARD_WATCH_INTERVAL_MS * (0.75 + Math.random() * 0.5);
}

const WAKE_MODIFIERS: InputModifiers = {
  useCodebase: false,
  noContext: true,
};

const WAKE_DOC: JSONContent = {
  type: "doc",
  content: [
    {
      type: "paragraph",
      content: [
        {
          type: "text",
          text: "[board-wake] Neue Nachrichten in subscribed Topics (Injection oben im Kontext). Prüfen; bei Nichtbedarf diesen Run sofort beenden.",
        },
      ],
    },
  ],
};

/**
 * Board wake mode (board-wake-mode.md): while the mode is toggled on and the
 * conversation is idle, poll the MsgBoard for new messages on the
 * workspace's subscribed topics and start a run with a synthetic
 * [board-wake] user message when any arrive. Message contents reach the
 * model through the regular always-apply injection block — the wake message
 * is only the trigger.
 *
 * - No priming (msgboard-v2-fork-packages.md, Paket 3): since CITT-side
 *   self-exclusion keeps this agent's own posts out of board/pending,
 *   activation no longer needs a silent consume for cursor hygiene.
 *   Deliberate behavior change: foreign messages that piled up while a run
 *   was active wake in the first tick after activation instead of rendering
 *   silently in the next run.
 * - Deliver-before-consume (amendment 2026-08-21, to-zenith loss incident
 *   2026-08-20): since the fetch/ack decoupling (board-wake-fetch-ack-
 *   entkopplung) `board/pending` is a NON-consuming peek — the cursor
 *   advances only through `board/ack`, fired after a successful render —
 *   so a fetch can no longer lose messages by itself. The gates remain: a
 *   tick only fetches when it can deliver (conversation idle and started,
 *   no compaction running or pending, composer empty), keeping wakes
 *   well-formed and avoiding pointless re-peeks that would re-wake every
 *   tick on unacked messages. While blocked, messages stay server-side and
 *   are delivered by the first run-start fetch of the next run (rendered
 *   in the same call) or the first unblocked tick.
 * - Compaction pause: while a compaction runs OR a self-compaction is
 *   pending, the watcher is fully paused. The finishing loadSession resets
 *   the board buffer, so no wake may race it
 *   (agent-self-compaction.md, board-wake-mode.md).
 * - Composer guard: while the user has text in the composer, neither
 *   consume nor dispatch (deliver-before-consume, amendment 2026-08-21);
 *   the run-start fetch of the run the user sends delivers the messages.
 * - Fresh-conversation guard: never consume or dispatch into a conversation
 *   that has not started yet (no user message and no conversation summary)
 *   — the first message of a fresh conversation belongs to the user, not
 *   the board. A fork-with-summary session counts as started: it is a
 *   continuation, not a fresh conversation (amendment 2026-08-17). The
 *   first real run's run-start fetch delivers the messages
 *   (amendment 2026-08-21).
 * - Cadence: 60 s ± 25 % jitter per tick (nextWatchDelayMs). The
 *   rate-limit incident (2026-08-18) showed phase-synchronized windows
 *   bursting every 30 s into the shared GitHub quota. Jitter is a stagger,
 *   not a guard: no further guards by design (no backoff/rate-limits/
 *   filters), the mode toggle is the kill switch. The 403/429 backoff
 *   lives CITT-side (vesta, KISS interim).
 */
export function useBoardWatch() {
  const dispatch = useAppDispatch();
  const store = useStore<RootState>();
  const ideMessenger = useContext(IdeMessengerContext);
  const { mainEditor } = useMainEditor();
  const boardWatchMode = useAppSelector((store) => store.ui.boardWatchMode);
  const isIdle = useAppSelector(selectIsConversationIdle);
  // Compaction pause (agent-self-compaction.md): pending counts as running —
  // no tick may race the loadSession that resets the board buffer.
  const compactionRunning = useAppSelector(selectIsCompactionRunning);
  const active = boardWatchMode && isIdle && !compactionRunning;

  // The editor can mount after the watcher starts — mirror into a ref so the
  // interval callback always reads the current instance.
  const mainEditorRef = useRef(mainEditor);
  useEffect(() => {
    mainEditorRef.current = mainEditor;
  }, [mainEditor]);

  useEffect(() => {
    if (!active) {
      return;
    }
    let cancelled = false;

    let timer: ReturnType<typeof setTimeout> | undefined;

    const tick = async () => {
      // Deliver-before-consume gate (board-wake-mode.md, amendment
      // 2026-08-21): since the fetch/ack decoupling the fetch is a
      // non-consuming peek — nothing can be lost by fetching — but a tick
      // still only fetches when it can deliver: idle, started, no
      // compaction, empty composer. Unacked messages would otherwise
      // re-wake every tick. Messages arriving while blocked are delivered
      // by the first run-start fetch of the next run (rendered in the same
      // call) or the first unblocked tick.
      const pre = store.getState();
      if (
        selectIsCompactionRunning(pre) ||
        !selectIsConversationIdle(pre) ||
        !selectConversationIsStarted(pre)
      ) {
        return;
      }
      const editor = mainEditorRef.current;
      if (!editor || hasValidEditorContent(editor.getJSON())) {
        return;
      }
      const result = await fetchBoardPending(dispatch, ideMessenger);
      if (cancelled || !result || result.messages.length === 0) {
        return;
      }
      // Recheck immediately before dispatching: a user-started run, a
      // compaction or composer input may have begun while the fetch was in
      // flight. Under peek semantics nothing is lost here — the messages
      // stay in the buffer (dedupe-filtered) and render in the next run;
      // they are acked only after a successful delivery
      // (board-wake-fetch-ack-entkopplung).
      const state = store.getState();
      const postEditor = mainEditorRef.current;
      if (
        !selectIsConversationIdle(state) ||
        !selectConversationIsStarted(state) ||
        selectIsCompactionRunning(state) ||
        !postEditor ||
        hasValidEditorContent(postEditor.getJSON())
      ) {
        return;
      }
      dispatch(
        streamResponseThunk({
          editorState: WAKE_DOC,
          modifiers: WAKE_MODIFIERS,
        }),
      );
    };

    // Recursive setTimeout instead of setInterval: every round re-rolls the
    // jittered delay (decorrelates phase-locked windows), and a slow fetch
    // can never overlap the next tick.
    const scheduleNext = () => {
      timer = setTimeout(() => {
        void tick().finally(() => {
          if (!cancelled) {
            scheduleNext();
          }
        });
      }, nextWatchDelayMs());
    };
    scheduleNext();

    return () => {
      cancelled = true;
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    };
  }, [active, dispatch, ideMessenger, store]);
}
