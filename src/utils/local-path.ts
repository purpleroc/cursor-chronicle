import path from "node:path";
import os from "node:os";

/**
 * Returns the real user home directory in a cross-platform way.
 * On Windows, os.homedir() may return the app installation directory
 * (e.g. C:\Program Files\cursor) when environment variables are misconfigured.
 * Prefer USERPROFILE (the Windows-native user home var) over HOME and os.homedir().
 */
export function getUserHome(): string {
  if (process.platform === "win32") {
    return process.env.USERPROFILE || process.env.HOME || os.homedir();
  }
  return process.env.HOME || os.homedir();
}

/** Expand ~ and resolve to absolute path (Node fs). */
export function expandUserPath(input: string): string {
  const trimmed = input.trim();
  if (trimmed === "" || trimmed === "~") {
    return getUserHome();
  }
  if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) {
    return path.join(getUserHome(), trimmed.slice(2));
  }
  return path.resolve(trimmed);
}
