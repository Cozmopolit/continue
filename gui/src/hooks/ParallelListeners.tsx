import { useCallback, useContext, useEffect, useRef } from "react";
import { IdeMessengerContext } from "../context/IdeMessenger";

import { FromCoreProtocol } from "core/protocol";
import { useAppDispatch, useAppSelector } from "../redux/hooks";
import { setConfigLoading, setConfigResult } from "../redux/slices/configSlice";
import { setLastNonEditSessionEmpty } from "../redux/slices/editState";
import { updateIndexingStatus } from "../redux/slices/indexingSlice";
import {
  initializeProfilePreferences,
  setProfiles,
  setSelectedProfile,
} from "../redux/slices/profilesSlice";
import {
  addContextItemsAtIndex,
  newSession,
  setHasReasoningEnabled,
  setIsSessionMetadataLoading,
} from "../redux/slices/sessionSlice";
import { createFreshTab, setTabs } from "../redux/slices/tabsSlice";
import { setAutoApproveAllTools, setTTSActive } from "../redux/slices/uiSlice";

import { modelSupportsReasoning } from "core/llm/autodetect";
import { cancelStream } from "../redux/thunks/cancelStream";
import { handleApplyStateUpdate } from "../redux/thunks/handleApplyStateUpdate";
import { refreshSessionMetadata } from "../redux/thunks/session";
import { updateFileSymbolsFromHistory } from "../redux/thunks/updateFileSymbols";
import {
  setDocumentStylesFromLocalStorage,
  setDocumentStylesFromTheme,
} from "../styles/theme";
import { isJetBrains } from "../util";
import { setLocalStorage } from "../util/localStorage";
import { migrateLocalStorage } from "../util/migrateLocalStorage";
import { useWebviewListener } from "./useWebviewListener";

function ParallelListeners() {
  const dispatch = useAppDispatch();
  const ideMessenger = useContext(IdeMessengerContext);
  const history = useAppSelector((store) => store.session.history);
  const isInEdit = useAppSelector((store) => store.session.isInEdit);
  const selectedProfileId = useAppSelector(
    (store) => store.profiles.selectedProfileId,
  );
  const reasoningSettings = useAppSelector(
    (store) => store.ui.reasoningSettings,
  );
  const hasDoneInitialConfigLoad = useRef(false);

  // Load symbols for chat on any session change
  const sessionId = useAppSelector((state) => state.session.id);

  const handleConfigUpdate = useCallback(
    async (isInitial: boolean, result: FromCoreProtocol["configUpdate"][0]) => {
      const { result: configResult, profileId, profiles } = result;
      if (isInitial && hasDoneInitialConfigLoad.current) {
        return;
      }
      if (configResult.configLoadInterrupted || !configResult.config) {
        return;
      }
      hasDoneInitialConfigLoad.current = true;
      dispatch(setProfiles(profiles));
      dispatch(setSelectedProfile(profileId));
      dispatch(setConfigResult(configResult));

      const isNewProfileId = profileId && profileId !== selectedProfileId;

      if (isNewProfileId) {
        dispatch(
          initializeProfilePreferences({
            defaultSlashCommands: [],
            profileId,
          }),
        );
      }

      // Perform any actions needed with the config
      if (configResult.config?.ui?.fontSize) {
        setLocalStorage("fontSize", configResult.config.ui.fontSize);
        document.body.style.fontSize = `${configResult.config.ui.fontSize}px`;
      }

      const chatModel = configResult.config?.selectedModelByRole.chat;
      const supportsReasoning = modelSupportsReasoning(chatModel);
      const isReasoningDisabled =
        chatModel?.completionOptions?.reasoning === false;
      const wasReasoningPreviouslyEnabled = chatModel?.title
        ? reasoningSettings[chatModel.title] !== false
        : true;
      dispatch(
        setHasReasoningEnabled(
          supportsReasoning &&
            !isReasoningDisabled &&
            wasReasoningPreviouslyEnabled,
        ),
      );
    },
    [dispatch, hasDoneInitialConfigLoad, selectedProfileId, reasoningSettings],
  );

  // Load config from the IDE
  useEffect(() => {
    async function initialLoadConfig() {
      dispatch(setIsSessionMetadataLoading(true));
      dispatch(setConfigLoading(true));

      // Load IDE settings (including YOLO mode)
      const ideSettingsResult = await ideMessenger.request(
        "getIdeSettings",
        undefined,
      );
      if (ideSettingsResult.status === "success") {
        dispatch(
          setAutoApproveAllTools(
            ideSettingsResult.content.autoApproveAllTools ?? false,
          ),
        );
      }

      const result = await ideMessenger.request(
        "config/getSerializedProfileInfo",
        undefined,
      );
      if (result.status === "success") {
        await handleConfigUpdate(true, result.content);
      }
      dispatch(setConfigLoading(false));
      // Always boot into a fresh session (workspace-fresh-boot.md): the
      // previous chat stays on disk and is the top entry of the
      // workspace-scoped history list ("Last Session" button resumes it).
      // The boot also resets the tab bar to a single fresh tab — tabs are
      // per-window-lifetime UI state, and without the reset every boot
      // accumulated one more tab. The TabBar session listener binds the
      // fresh session to the reset tab.
      dispatch(newSession());
      dispatch(setTabs([createFreshTab()]));
    }
    void initialLoadConfig();
    const interval = setInterval(() => {
      if (hasDoneInitialConfigLoad.current) {
        // Init to run on initial config load
        ideMessenger.post("docs/initStatuses", undefined);
        void dispatch(updateFileSymbolsFromHistory());
        void dispatch(refreshSessionMetadata({}));

        // This triggers sending pending status to the GUI for relevant docs indexes
        clearInterval(interval);
      } else {
        void initialLoadConfig();
      }
    }, 2_000);

    return () => clearInterval(interval);
  }, [hasDoneInitialConfigLoad, ideMessenger]);

  useWebviewListener(
    "configUpdate",
    async (update) => {
      if (!update) {
        return;
      }
      await handleConfigUpdate(false, update);
    },
    [handleConfigUpdate],
  );

  useEffect(() => {
    if (sessionId) {
      void dispatch(updateFileSymbolsFromHistory());
    }
  }, [sessionId]);

  // ON LOAD
  useEffect(() => {
    // Override persisted state (no reasoning rescue during webview init,
    // see rescue-interrupted-reasoning.md)
    void dispatch(cancelStream({ skipReasoningRescue: true }));

    const jetbrains = isJetBrains();
    setDocumentStylesFromLocalStorage(jetbrains);

    if (jetbrains) {
      // Save theme colors to local storage for immediate loading in JetBrains
      void ideMessenger
        .request("jetbrains/getColors", undefined)
        .then((result) => {
          if (result.status === "success") {
            setDocumentStylesFromTheme(result.content);
          }
        });

      // Tell JetBrains the webview is ready
      void ideMessenger
        .request("jetbrains/onLoad", undefined)
        .then((result) => {
          if (result.status === "error") {
            return;
          }

          const msg = result.content;
          (window as any).windowId = msg.windowId;
          (window as any).serverUrl = msg.serverUrl;
          (window as any).workspacePaths = msg.workspacePaths;
          (window as any).vscMachineId = msg.vscMachineId;
          (window as any).vscMediaUrl = msg.vscMediaUrl;
        });
    }
  }, []);

  useWebviewListener(
    "jetbrains/setColors",
    async (data) => {
      setDocumentStylesFromTheme(data);
    },
    [],
  );

  // IDE event listeners
  useWebviewListener(
    "getWebviewHistoryLength",
    async () => {
      return history.length;
    },
    [history],
  );

  useWebviewListener(
    "getCurrentSessionId",
    async () => {
      return sessionId;
    },
    [sessionId],
  );

  useWebviewListener("setInactive", async () => {
    void dispatch(cancelStream());
  });

  useWebviewListener("setTTSActive", async (status) => {
    dispatch(setTTSActive(status));
  });

  useWebviewListener("addContextItem", async (data) => {
    dispatch(
      addContextItemsAtIndex({
        index: data.historyIndex,
        contextItems: [data.item],
      }),
    );
  });

  useWebviewListener("indexing/statusUpdate", async (data) => {
    dispatch(updateIndexingStatus(data));
  });

  useWebviewListener(
    "updateApplyState",
    async (state) => {
      void dispatch(handleApplyStateUpdate(state));
    },
    [],
  );

  useEffect(() => {
    if (!isInEdit) {
      dispatch(setLastNonEditSessionEmpty(history.length === 0));
    }
  }, [isInEdit, history]);

  useEffect(() => {
    migrateLocalStorage(dispatch);
  }, []);

  return <></>;
}

export default ParallelListeners;
