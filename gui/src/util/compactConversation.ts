import { useContext } from "react";
import { IdeMessengerContext } from "../context/IdeMessenger";
import { useAppDispatch, useAppSelector } from "../redux/hooks";
import {
  setCompactionLoading,
  deleteCompaction,
} from "../redux/slices/sessionSlice";
import { loadSession, saveCurrentSession } from "../redux/thunks/session";

export const useCompactConversation = () => {
  const dispatch = useAppDispatch();
  const ideMessenger = useContext(IdeMessengerContext);
  const currentSessionId = useAppSelector((state) => state.session.id);

  return async (index: number) => {
    if (!currentSessionId) {
      return;
    }

    try {
      // Set loading state
      dispatch(setCompactionLoading({ index, loading: true }));

      await ideMessenger.request("conversation/compact", {
        index,
        sessionId: currentSessionId,
      });

      // Reload the current session to refresh the conversation state
      dispatch(
        loadSession({
          sessionId: currentSessionId,
          saveCurrentSession: false,
        }),
      );
    } catch (error) {
      console.error("Error compacting conversation:", error);
    } finally {
      // Clear loading state
      dispatch(setCompactionLoading({ index, loading: false }));
    }
  };
};

export const useDeleteCompaction = () => {
  const dispatch = useAppDispatch();

  return (index: number) => {
    // Update local state and save to persistence
    dispatch(deleteCompaction(index));
    dispatch(
      saveCurrentSession({
        openNewSession: false,
        generateTitle: false,
      }),
    );
  };
};

export const useForkWithSummary = () => {
  const dispatch = useAppDispatch();
  const ideMessenger = useContext(IdeMessengerContext);
  const currentSessionId = useAppSelector((state) => state.session.id);
  const isStreaming = useAppSelector((state) => state.session.isStreaming);

  return async (index: number) => {
    if (!currentSessionId || isStreaming) {
      return;
    }

    try {
      // Set loading state (source session shows the summary spinner panel)
      dispatch(setCompactionLoading({ index, loading: true }));

      // conversation-fork-with-summary.md: the source session stays untouched;
      // errors are surfaced via toast instead of being swallowed.
      const result = await ideMessenger.request(
        "conversation/forkWithSummary",
        {
          index,
          sessionId: currentSessionId,
        },
      );

      if (result.status === "error") {
        throw new Error(result.error);
      }

      // Switch to the freshly created fork session
      dispatch(
        loadSession({
          sessionId: result.content.newSessionId,
          saveCurrentSession: false,
        }),
      );
    } catch (error) {
      console.error("Error forking conversation:", error);
      ideMessenger.post("showToast", [
        "error",
        "Failed to start new conversation with summary",
      ]);
    } finally {
      // Clear loading state
      dispatch(setCompactionLoading({ index, loading: false }));
    }
  };
};
