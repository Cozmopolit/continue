import { useBoardWatch } from "../hooks/useBoardWatch";

/**
 * Null-rendering host for useBoardWatch (board-wake-mode.md). Mounted inside
 * MainEditorProvider in App.tsx — ParallelListeners stays outside the
 * provider on purpose (rerender isolation), so the watcher gets its own
 * mount point with access to the main editor instance.
 */
export default function BoardWatch() {
  useBoardWatch();
  return null;
}
