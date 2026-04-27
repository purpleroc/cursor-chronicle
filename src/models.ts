export type TurnRole = "user" | "assistant";

export interface TextBlock {
  type: "text";
  text: string;
}

export interface ToolUseBlock {
  type: "tool_use";
  name: string;
  input: Record<string, unknown>;
}

export type ContentBlock = TextBlock | ToolUseBlock;

export interface Turn {
  role: TurnRole;
  blocks: ContentBlock[];
}

export interface Conversation {
  id: string;
  projectName: string;
  title: string;
  createdAt: Date;
  turns: Turn[];
  sourcePath: string;
  subagentPaths: string[];
}

export interface TranscriptScanResult {
  projectDirName: string;
  projectName: string;
  sessionId: string;
  mainTranscriptPath: string;
  /** When set, read transcript via vscode.workspace.fs (remote). */
  mainTranscriptUri?: string;
  subagentPaths: string[];
  /** Remote subagent URIs (optional). */
  subagentUris?: string[];
}

export interface SkillRecord {
  source: "user" | "project";
  projectName?: string;
  skillName: string;
  absolutePath: string;
  files: string[];
}

export interface SyncState {
  lastSyncTime?: string;
  files: Record<string, string>;
  conversations: Record<string, string>;
}

export interface RemoteSkillMeta {
  name: string;
  description: string;
  updatedAt: string;
  files: string[];
  /** MD5 hash per file — used to detect actual content changes. */
  fileHashes?: Record<string, string>;
}
