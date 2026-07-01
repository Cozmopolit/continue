import { Tool } from "../..";

import { BUILT_IN_GROUP_NAME, BuiltInToolNames } from "../builtIn";

export const getWorkspaceRootTool: Tool = {
  type: "function",
  displayTitle: "Get Workspace Root",
  wouldLikeTo: "get the workspace root path",
  isCurrently: "getting workspace root path",
  hasAlready: "retrieved workspace root path",
  readonly: true,
  isInstant: true,
  group: BUILT_IN_GROUP_NAME,
  function: {
    name: BuiltInToolNames.GetWorkspaceRoot,
    description:
      "Returns absolute paths to workspace root directories. Use this to construct full paths for tools that require absolute paths.",
    parameters: {
      type: "object",
      properties: {},
    },
  },
  defaultToolPolicy: "allowedWithoutPermission",
  toolCallIcon: "FolderIcon",
};
