import * as vscode from "vscode";
import path from "node:path";
import { TranscriptScanResult } from "../models";
import { resolveProjectName } from "../utils/project-name-resolver";

function cursorProjectsUri(folder: vscode.WorkspaceFolder): vscode.Uri | null {
  const wsPath = folder.uri.fsPath;
  if (!wsPath) return null;
  const parent = path.dirname(wsPath);
  const cursorProjectsFs = path.join(parent, ".cursor", "projects");
  return vscode.Uri.from({
    scheme: folder.uri.scheme,
    authority: folder.uri.authority,
    path: cursorProjectsFs,
  });
}

async function readDir(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
  try {
    return await vscode.workspace.fs.readDirectory(uri);
  } catch {
    return [];
  }
}

async function exists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

/**
 * Scan agent-transcripts on the remote host (Remote-SSH) via vscode.workspace.fs.
 */
export async function scanRemoteAgentTranscripts(
  ignoreProjectNames: string[] = []
): Promise<TranscriptScanResult[]> {
  if (!vscode.env.remoteName) return [];
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) return [];

  const projectsRoot = cursorProjectsUri(folder);
  if (!projectsRoot) return [];

  const ignored = new Set(ignoreProjectNames);
  const results: TranscriptScanResult[] = [];

  const projectEntries = await readDir(projectsRoot);
  for (const [name, type] of projectEntries) {
    if (type !== vscode.FileType.Directory || ignored.has(name)) continue;

    const transcriptRoot = vscode.Uri.joinPath(projectsRoot, name, "agent-transcripts");
    const sessionDirs = await readDir(transcriptRoot);
    for (const [sessionId, st] of sessionDirs) {
      if (st !== vscode.FileType.Directory) continue;
      const sessionPath = vscode.Uri.joinPath(transcriptRoot, sessionId);
      const mainUri = vscode.Uri.joinPath(sessionPath, `${sessionId}.jsonl`);
      if (!(await exists(mainUri))) continue;

      const subagentDir = vscode.Uri.joinPath(sessionPath, "subagents");
      const subEntries = await readDir(subagentDir);
      const subagentUris = subEntries
        .filter(([fn, ft]) => ft === vscode.FileType.File && fn.endsWith(".jsonl"))
        .map(([fn]) => vscode.Uri.joinPath(subagentDir, fn).toString());

      results.push({
        projectDirName: name,
        projectName: resolveProjectName(name),
        sessionId,
        mainTranscriptPath: "",
        mainTranscriptUri: mainUri.toString(),
        subagentPaths: [],
        subagentUris,
      });
    }
  }

  return results;
}
