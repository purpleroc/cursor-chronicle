import { promises as fs } from "node:fs";
import * as vscode from "vscode";
import { ContentBlock, Conversation, Turn } from "../models";
import { TranscriptScanResult } from "../models";
import { getCursorTitle } from "./title-resolver";

interface RawMessage {
  role?: string;
  message?: {
    content?: Array<{
      type?: string;
      text?: string;
      name?: string;
      input?: Record<string, unknown>;
    }>;
  };
}

const USER_QUERY_TAG = /<user_query>\s*([\s\S]*?)\s*<\/user_query>/i;

export class TranscriptParser {
  async parse(scanResult: TranscriptScanResult): Promise<Conversation | null> {
    const mainTurns = scanResult.mainTranscriptUri
      ? await this.parseUri(vscode.Uri.parse(scanResult.mainTranscriptUri))
      : await this.parseFile(scanResult.mainTranscriptPath);
    if (mainTurns.length === 0) {
      return null;
    }

    const subagentTurns: Turn[] = [];
    const subUris = scanResult.subagentUris ?? [];
    if (subUris.length > 0) {
      for (const u of subUris) {
        const parsed = await this.parseUri(vscode.Uri.parse(u));
        if (parsed.length > 0) {
          subagentTurns.push({
            role: "assistant",
            blocks: [{ type: "text", text: `--- Subagent ---` }],
          });
          subagentTurns.push(...parsed);
        }
      }
    } else {
      for (const subagentPath of scanResult.subagentPaths) {
        const parsed = await this.parseFile(subagentPath);
        if (parsed.length > 0) {
          subagentTurns.push({
            role: "assistant",
            blocks: [{ type: "text", text: `--- Subagent ---` }],
          });
          subagentTurns.push(...parsed);
        }
      }
    }

    let createdAt: Date;
    if (scanResult.mainTranscriptUri) {
      const st = await vscode.workspace.fs.stat(vscode.Uri.parse(scanResult.mainTranscriptUri));
      createdAt = new Date(st.ctime > 0 ? st.ctime : st.mtime);
    } else {
      const stats = await fs.stat(scanResult.mainTranscriptPath);
      createdAt = stats.birthtime.getTime() > 0 ? stats.birthtime : stats.mtime;
    }
    const allTurns = [...mainTurns, ...subagentTurns];

    const cursorTitle = await getCursorTitle(scanResult.sessionId);
    const title = cursorTitle ?? this.extractTitleFromContent(allTurns);

    return {
      id: scanResult.sessionId,
      projectName: scanResult.projectName,
      title,
      createdAt,
      turns: allTurns,
      sourcePath: scanResult.mainTranscriptUri ?? scanResult.mainTranscriptPath,
      subagentPaths: scanResult.subagentPaths,
    };
  }

  private async parseUri(uri: vscode.Uri): Promise<Turn[]> {
    const bytes = await vscode.workspace.fs.readFile(uri);
    const content = new TextDecoder().decode(bytes);
    return this.parseJsonlContent(content);
  }

  private async parseFile(filePath: string): Promise<Turn[]> {
    const content = await fs.readFile(filePath, "utf8");
    return this.parseJsonlContent(content);
  }

  private parseJsonlContent(content: string): Turn[] {
    const lines = content.split(/\r?\n/).filter((line) => line.trim().length > 0);
    const turns: Turn[] = [];

    for (const line of lines) {
      let parsed: RawMessage;
      try {
        parsed = JSON.parse(line) as RawMessage;
      } catch {
        continue;
      }

      const role = parsed.role === "assistant" ? "assistant" : parsed.role === "user" ? "user" : null;
      if (!role) {
        continue;
      }

      const blocks: ContentBlock[] = [];
      for (const item of parsed.message?.content ?? []) {
        if (item.type === "text" && typeof item.text === "string") {
          blocks.push({ type: "text", text: item.text });
        } else if (item.type === "tool_use" && item.name) {
          blocks.push({
            type: "tool_use",
            name: item.name,
            input: item.input ?? {}
          });
        }
      }

      turns.push({ role, blocks });
    }

    return turns;
  }

  private extractTitleFromContent(turns: Turn[]): string {
    const firstUserText = turns
      .filter((turn) => turn.role === "user")
      .flatMap((turn) => turn.blocks)
      .find((block): block is { type: "text"; text: string } => block.type === "text");

    if (!firstUserText) {
      return "Untitled";
    }

    const match = firstUserText.text.match(USER_QUERY_TAG);
    const raw = (match?.[1] ?? firstUserText.text)
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    if (!raw) {
      return "Untitled";
    }

    return raw.slice(0, 50);
  }
}
