import { fileURLToPath } from "url";

import { ToolImpl } from ".";

function uriToNativePath(uri: string): string {
  if (uri.startsWith("file://")) {
    return fileURLToPath(uri);
  }
  return uri;
}

export const getWorkspaceRootImpl: ToolImpl = async (_args, extras) => {
  const workspaceDirs = await extras.ide.getWorkspaceDirs();
  const nativePaths = workspaceDirs.map(uriToNativePath);

  return [
    {
      name: "Workspace Root",
      description: "Absolute paths to workspace root directories",
      content:
        nativePaths.length > 0
          ? nativePaths.join("\n")
          : "No workspace directories found",
    },
  ];
};
