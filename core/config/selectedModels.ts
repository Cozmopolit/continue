import { ModelRole } from "@continuedev/config-yaml";

import { ContinueConfig, ILLM } from "..";
import { LLMConfigurationStatuses } from "../llm/constants";
import {
  GlobalContext,
  GlobalContextModelSelections,
} from "../util/GlobalContext";

export function rectifySelectedModelsFromGlobalContext(
  continueConfig: ContinueConfig,
  profileId: string,
): ContinueConfig {
  const configCopy = { ...continueConfig };

  const globalContext = new GlobalContext();
  const currentSelectedModels = globalContext.get("selectedModelsByProfileId");
  const currentForProfile: GlobalContextModelSelections =
    currentSelectedModels?.[profileId] ?? {};

  let fellBack = false;

  // summarize not implemented yet
  const roles: ModelRole[] = [
    "autocomplete",
    "apply",
    "edit",
    "embed",
    "rerank",
    "chat",
  ];

  for (const role of roles) {
    let newModel: ILLM | null = null;
    const currentSelection = currentForProfile[role] ?? null;
    const availableModels = continueConfig.modelsByRole[role];

    if (currentSelection) {
      const match = availableModels.find((m) => m.title === currentSelection);
      if (match) {
        newModel = match;
      }
    }

    // Only fallback to first available if we have models AND no persisted selection
    // This prevents losing selection when models haven't been discovered yet (e.g., MCP startup race)
    if (!newModel && availableModels.length > 0) {
      newModel = availableModels[0];
    }

    // Don't mark as fellBack if we simply have no models available yet
    // This preserves the persisted selection for when models become available
    const shouldUpdateSelection = availableModels.length > 0;
    if (
      shouldUpdateSelection &&
      currentSelection !== (newModel?.title ?? null)
    ) {
      fellBack = true;
    }

    // Currently only check for configuration status for apply
    if (
      role === "apply" &&
      newModel?.getConfigurationStatus() !== LLMConfigurationStatuses.VALID
    ) {
      continue;
    }

    // Only update selection if we have a model or models were available
    // When no models are available (e.g., pre-MCP-discovery), preserve existing selection
    if (newModel || availableModels.length > 0) {
      configCopy.selectedModelByRole[role] = newModel;
    }
  }

  // In the case shared config wasn't respected,
  // Rewrite the shared config
  if (fellBack) {
    globalContext.update("selectedModelsByProfileId", {
      ...currentSelectedModels,
      [profileId]: Object.fromEntries(
        Object.entries(configCopy.selectedModelByRole).map(([key, value]) => [
          key,
          value?.title ?? null,
        ]),
      ),
    });
  }

  return configCopy;
}
