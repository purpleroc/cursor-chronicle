import * as vscode from "vscode";

let channel: vscode.OutputChannel | undefined;

export function initLogger(): vscode.OutputChannel {
  if (!channel) {
    channel = vscode.window.createOutputChannel("Cursor Chronicle");
  }
  return channel;
}

function ts(): string {
  return new Date().toISOString();
}

export function logInfo(msg: string): void {
  channel?.appendLine(`[${ts()}] [INFO] ${msg}`);
}

export function logWarn(msg: string): void {
  channel?.appendLine(`[${ts()}] [WARN] ${msg}`);
}

export function logError(msg: string, err?: unknown): void {
  const detail = err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : err != null ? String(err) : "";
  channel?.appendLine(`[${ts()}] [ERROR] ${msg}${detail ? " — " + detail : ""}`);
}

export function logDebug(msg: string): void {
  channel?.appendLine(`[${ts()}] [DEBUG] ${msg}`);
}
