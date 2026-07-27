/**
 * Converts a file:// URI (as returned by IDE.getWorkspaceDirs()) into a
 * native absolute path for prompt display.
 *
 * VS Code's Uri.toString() percent-encodes the drive-letter colon and
 * lowercases the drive letter (file:///c%3A/Users/...), which is not usable
 * for tools that expect absolute native paths (C:\Users\...).
 *
 * Detection is driven by URI shape, not host platform: drive-letter and
 * authority (UNC) forms only occur on Windows, anything else is POSIX.
 * Non-file:// URIs (e.g. vscode-remote://) pass through unchanged.
 */
export function fileUriToNativePath(uri: string): string {
  if (!uri.startsWith("file://")) {
    return uri;
  }

  let decoded: string;
  try {
    decoded = decodeURIComponent(uri);
  } catch {
    // Malformed percent-encoding — leave the URI untouched
    return uri;
  }

  const withoutScheme = decoded.slice("file://".length);

  // Windows drive path: "/c:/Users/..." → "C:\Users\..."
  const driveMatch = withoutScheme.match(/^\/([a-zA-Z]):(?=[\\/]|$)/);
  if (driveMatch) {
    const driveLetter = driveMatch[1].toUpperCase();
    const rest = withoutScheme.slice(driveMatch[0].length).replace(/\//g, "\\");
    return `${driveLetter}:${rest}`;
  }

  // UNC path (URI authority): "server/share/..." → "\\server\share\..."
  if (withoutScheme.length > 0 && !withoutScheme.startsWith("/")) {
    return `\\\\${withoutScheme.replace(/\//g, "\\")}`;
  }

  // POSIX path: "/home/user/..." — already native
  return withoutScheme;
}
