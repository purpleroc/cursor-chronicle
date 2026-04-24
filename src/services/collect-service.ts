import * as vscode from "vscode";
import { ComposerDbReader } from "./composer-db-reader";
import { TranscriptParser } from "./transcript-parser";
import { TranscriptScanner } from "./transcript-scanner";
import { MarkdownGenerator } from "./markdown-generator";
import { LocalStore } from "./local-store";
import { scanRemoteAgentTranscripts } from "./remote-transcript-scanner";
import { metaToConversation } from "./conversation-builder";
import { SkillsCollector } from "./skills-collector";
import { detectRemoteHome } from "../utils/remote-home";
import { logInfo, logDebug } from "../utils/logger";

export class CollectService {
  constructor(
    private readonly dbReader: ComposerDbReader,
    private readonly parser: TranscriptParser,
    private readonly mdGen: MarkdownGenerator,
    private readonly localStore: LocalStore,
    private readonly scanner: TranscriptScanner,
    private readonly skillsCollector: SkillsCollector
  ) {}

  async collectAll(): Promise<{ conversationsWritten: number; skillsMirrored: number }> {
    logInfo("CollectService.collectAll: starting");
    await this.localStore.init();
    let conversationsWritten = 0;
    const seen = new Set<string>();

    if (this.dbReader.available) {
      const metas = this.dbReader.listAll();
      logDebug(`CollectService: found ${metas.length} conversations in SQLite`);
      let skippedUp = 0;
      let skippedEmpty = 0;
      for (const meta of metas) {
        seen.add(meta.composerId);
        if (await this.localStore.shouldSkipConversation(meta)) {
          skippedUp++;
          continue;
        }
        const bubbles = this.dbReader.readBubbles(meta.composerId);
        if (bubbles.length === 0) {
          skippedEmpty++;
          continue;
        }
        const conv = metaToConversation(meta, bubbles);
        const md = this.mdGen.generate(conv);
        await this.localStore.writeConversation(
          conv.projectName,
          conv.createdAt,
          conv.title,
          meta,
          md,
          "local"
        );
        conversationsWritten += 1;
      }
      logDebug(`CollectService: SQLite — written=${conversationsWritten}, skippedUnchanged=${skippedUp}, skippedEmpty=${skippedEmpty}`);
    } else {
      logDebug("CollectService: SQLite DB not available, skipping DB scan");
    }

    const config = vscode.workspace.getConfiguration("cursorChronicle");
    const ignore = config.get<string[]>("ignore.projects", []);

    const isRemote = !!vscode.env.remoteName;
    logDebug(`CollectService: scanning JSONL transcripts (remote=${isRemote})`);
    const jsonlScans = isRemote
      ? await scanRemoteAgentTranscripts(ignore)
      : await this.scanner.scan(ignore);
    logDebug(`CollectService: found ${jsonlScans.length} JSONL transcripts`);

    const wf = vscode.workspace.workspaceFolders?.[0];
    const wUri = wf?.uri.toString();
    const wPath = wf?.uri.fsPath;

    let jsonlWritten = 0;
    let jsonlSkippedSeen = 0;
    let jsonlSkippedEmpty = 0;
    let jsonlSkippedUp = 0;
    for (const scan of jsonlScans) {
      if (seen.has(scan.sessionId)) {
        jsonlSkippedSeen++;
        continue;
      }
      const conv = await this.parser.parse(scan);
      if (!conv || conv.turns.length === 0) {
        jsonlSkippedEmpty++;
        continue;
      }
      const ts = conv.createdAt.getTime();
      if (await this.localStore.shouldSkipJsonl(scan.sessionId, ts)) {
        jsonlSkippedUp++;
        continue;
      }

      const md = this.mdGen.generate(conv);
      await this.localStore.writeConversationFromJsonl(
        conv.projectName,
        conv.createdAt,
        conv.title,
        scan.sessionId,
        ts,
        wUri,
        wPath,
        md,
        isRemote ? "remote" : "local"
      );
      seen.add(scan.sessionId);
      jsonlWritten += 1;
      conversationsWritten += 1;
    }
    logDebug(`CollectService: JSONL — written=${jsonlWritten}, skippedDuplicate=${jsonlSkippedSeen}, skippedEmpty=${jsonlSkippedEmpty}, skippedUnchanged=${jsonlSkippedUp}`);

    const remoteHome = await detectRemoteHome();
    logDebug(`CollectService: collecting skills (remoteHome=${remoteHome?.toString() ?? "none"})`);
    const skills = await this.skillsCollector.collect(remoteHome);
    const skillsMirrored = skills.length;

    logInfo(`CollectService.collectAll: done — ${conversationsWritten} conversations, ${skillsMirrored} skills scanned`);
    return { conversationsWritten, skillsMirrored };
  }
}
