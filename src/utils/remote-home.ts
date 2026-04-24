import * as vscode from "vscode";
import { logDebug, logWarn } from "./logger";

export async function detectRemoteHome(): Promise<vscode.Uri | undefined> {
  if (!vscode.env.remoteName) return undefined;

  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder || folder.uri.scheme === "file") return undefined;

  const parts = folder.uri.path.split("/").filter(Boolean);

  const candidates: string[] = [];
  if (parts[0] === "home" && parts.length >= 2) {
    candidates.push(`/home/${parts[1]}`);
  }
  if (parts[0] === "Users" && parts.length >= 2) {
    candidates.push(`/Users/${parts[1]}`);
  }
  candidates.push("/root");

  for (let i = Math.min(parts.length - 1, 5); i >= 1; i--) {
    const p = "/" + parts.slice(0, i).join("/");
    if (!candidates.includes(p)) candidates.push(p);
  }

  logDebug(`detectRemoteHome: probing ${candidates.length} candidates`);

  for (const home of candidates) {
    const cursorUri = folder.uri.with({ path: `${home}/.cursor` });
    try {
      const stat = await vscode.workspace.fs.stat(cursorUri);
      if (stat.type & vscode.FileType.Directory) {
        logDebug(`detectRemoteHome: found at ${home}`);
        return folder.uri.with({ path: home });
      }
    } catch {
      continue;
    }
  }

  logWarn("detectRemoteHome: no remote home detected");
  return undefined;
}

export function isRemoteSession(): boolean {
  return !!vscode.env.remoteName;
}

export function getRemoteHost(): string {
  return vscode.env.remoteName ?? "";
}
