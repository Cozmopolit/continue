import { useAppDispatch, useAppSelector } from "../redux/hooks";
import { deleteCompaction } from "../redux/slices/sessionSlice";
import { compactConversationThunk } from "../redux/thunks/compactConversation";
import { forkWithSummaryThunk } from "../redux/thunks/forkWithSummary";
import { saveCurrentSession } from "../redux/thunks/session";

export const useCompactConversation = () => {
  const dispatch = useAppDispatch();
  const currentSessionId = useAppSelector((state) => state.session.id);

  return async (index: number) => {
    if (!currentSessionId) {
      return;
    }

    // Agent self-compaction (agent-self-compaction.md): delegates to the
    // hook-free inline runner (UI button path; the agent run-end trigger
    // uses the fork runner instead — agent-self-compaction-fork-wiring.md).
    await dispatch(
      compactConversationThunk({ sessionId: currentSessionId, index }),
    );
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
  const currentSessionId = useAppSelector((state) => state.session.id);
  const isStreaming = useAppSelector((state) => state.session.isStreaming);

  return async (index: number) => {
    if (!currentSessionId || isStreaming) {
      return;
    }

    // Agent self-compaction fork wiring (agent-self-compaction-fork-wiring.md):
    // shared hook-free runner — identical semantics for the UI button and the
    // run-end trigger (streamResponseThunk).
    await dispatch(
      forkWithSummaryThunk({ sessionId: currentSessionId, index }),
    );
  };
};
