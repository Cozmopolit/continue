import { JSONContent } from "@tiptap/core";
import { InputModifiers } from "core";
import { useContext, useEffect, useRef } from "react";
import { useStore } from "react-redux";
import { useMainEditor } from "../components/mainInput/TipTapEditor/MainEditorProvider";
import { hasValidEditorContent } from "../components/mainInput/TipTapEditor/utils/editorConfig";
import { IdeMessengerContext } from "../context/IdeMessenger";
import { useAppDispatch, useAppSelector } from "../redux/hooks";
import { selectIsConversationIdle } from "../redux/selectors/selectToolCalls";
import { RootState } from "../redux/store";
import { fetchBoardPending } from "../redux/thunks/fetchBoardPending";
import { streamResponseThunk } from "../redux/thunks/streamResponse";

/** Poll cadence while idle-watching (board-wake-mode.md). */
const BOARD_WATCH_INTERVAL_MS = 30_000;

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
 * - Priming: on entering the active state, consume once WITHOUT waking
 *   (cursor hygiene — the just-finished run's own posts and already-injected
 *   messages must not wake).
 * - Composer guard: never dispatch while the user has text in the composer;
 *   accumulated messages render in the next run regardless.
 * - No further guards by design (no backoff/rate-limits/filters): the mode
 *   toggle is the kill switch.
 */
export function useBoardWatch() {
  const dispatch = useAppDispatch();
  const store = useStore<RootState>();
  const ideMessenger = useContext(IdeMessengerContext);
  const { mainEditor } = useMainEditor();
  const boardWatchMode = useAppSelector((store) => store.ui.boardWatchMode);
  const isIdle = useAppSelector(selectIsConversationIdle);
  const active = boardWatchMode && isIdle;

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

    // Priming consume (no wake, board-wake-mode.md).
    void fetchBoardPending(dispatch, ideMessenger);

    const interval = setInterval(() => {
      void (async () => {
        const result = await fetchBoardPending(dispatch, ideMessenger);
        if (cancelled || !result || result.messages.length === 0) {
          return;
        }
        const editor = mainEditorRef.current;
        if (!editor || hasValidEditorContent(editor.getJSON())) {
          // No composer access or user is typing: stay quiet — the messages
          // are accumulated and will render in the next run.
          return;
        }
        // Recheck run state immediately before dispatching: a user-started
        // run may have begun while the fetch was in flight.
        if (!selectIsConversationIdle(store.getState())) {
          return;
        }
        dispatch(
          streamResponseThunk({
            editorState: WAKE_DOC,
            modifiers: WAKE_MODIFIERS,
          }),
        );
      })();
    }, BOARD_WATCH_INTERVAL_MS);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [active, dispatch, ideMessenger, store]);
}
