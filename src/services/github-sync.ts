import { Buffer } from "node:buffer";
import { Octokit } from "@octokit/rest";
import { RemoteSkillMeta, SkillRecord } from "../models";
import { logInfo, logWarn, logDebug } from "../utils/logger";

interface RepoRef {
  owner: string;
  repo: string;
}

interface RepoPermissionResult {
  exists: boolean;
  canPush: boolean;
  permissionText: string;
}

export function parseDescriptionFromSkillMd(content: string): string {
  const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!fmMatch) return "";
  const descMatch = fmMatch[1].match(/description:\s*>?\s*-?\s*\n?([\s\S]*?)(?=\n\w|\n---)/);
  if (descMatch) return descMatch[1].replace(/\s+/g, " ").trim().slice(0, 200);
  const inlineMatch = fmMatch[1].match(/description:\s*['"]?(.+?)['"]?\s*$/m);
  return inlineMatch ? inlineMatch[1].trim().slice(0, 200) : "";
}

export class GitHubSyncService {
  private octokit: Octokit;

  constructor(token: string) {
    this.octokit = new Octokit({ auth: token });
  }

  parseRepo(input: string): RepoRef {
    const [owner, repo] = input.split("/");
    if (!owner || !repo) {
      throw new Error("仓库格式必须是 owner/repo");
    }
    return { owner, repo };
  }

  async ensureRepository(repoRef: RepoRef, createIfMissing: boolean, visibility: "private" | "public"): Promise<void> {
    logDebug(`GitHubSync.ensureRepository: checking ${repoRef.owner}/${repoRef.repo}`);
    try {
      await this.octokit.repos.get({
        owner: repoRef.owner,
        repo: repoRef.repo
      });
      return;
    } catch (e: unknown) {
      const status = (e as { status?: number }).status;
      if (status !== 404) {
        throw e;
      }
      if (!createIfMissing) {
        throw new Error(`仓库不存在: ${repoRef.owner}/${repoRef.repo}`);
      }
    }

    const me = await this.octokit.users.getAuthenticated();
    if (me.data.login !== repoRef.owner) {
      throw new Error("仅支持自动创建当前登录用户名下的仓库。");
    }

    logInfo(`GitHubSync: creating repository ${repoRef.owner}/${repoRef.repo} (${visibility})`);
    try {
      await this.octokit.repos.createForAuthenticatedUser({
        name: repoRef.repo,
        private: visibility === "private",
        auto_init: false
      });
    } catch (createErr: unknown) {
      const msg = createErr instanceof Error ? createErr.message : String(createErr);
      if (!msg.includes("name already exists")) {
        throw createErr;
      }
      logInfo("GitHubSync: repository already exists, using it");
    }
  }

  async getRepositoryPermission(repoRef: RepoRef): Promise<RepoPermissionResult> {
    try {
      const response = await this.octokit.repos.get({
        owner: repoRef.owner,
        repo: repoRef.repo
      });
      const perms = response.data.permissions;
      const canPush = Boolean(perms?.push || perms?.admin || perms?.maintain);
      const permissionText = perms
        ? [
          perms.admin ? "admin" : "",
          perms.maintain ? "maintain" : "",
          perms.push ? "push" : "",
          perms.triage ? "triage" : "",
          perms.pull ? "pull" : "",
        ].filter(Boolean).join(", ")
        : "unknown";
      return { exists: true, canPush, permissionText };
    } catch (e: unknown) {
      if ((e as { status?: number }).status === 404) {
        return { exists: false, canPush: false, permissionText: "none" };
      }
      throw e;
    }
  }

  async assertRepositoryWritable(repoRef: RepoRef): Promise<void> {
    const p = await this.getRepositoryPermission(repoRef);
    if (!p.exists) {
      throw new Error(`目标仓库不存在或不可访问: ${repoRef.owner}/${repoRef.repo}`);
    }
    if (!p.canPush) {
      throw new Error(`Token 对仓库 ${repoRef.owner}/${repoRef.repo} 无写权限（当前权限: ${p.permissionText}）`);
    }
  }

  async listRemoteSkills(repoRef: RepoRef): Promise<RemoteSkillMeta[]> {
    logDebug(`GitHubSync.listRemoteSkills: fetching from ${repoRef.owner}/${repoRef.repo}`);
    const indexMap = new Map<string, RemoteSkillMeta>();
    const index = await this.tryGetContent(repoRef, "skills/skills-index.json");
    if (index) {
      try {
        const parsed = JSON.parse(index.decoded) as { skills?: RemoteSkillMeta[] };
        if (Array.isArray(parsed.skills)) {
          for (const s of parsed.skills) indexMap.set(s.name, s);
        }
      } catch (e) {
        logWarn(`GitHubSync: corrupted skills-index.json — ${e instanceof Error ? e.message : e}`);
      }
    }

    const dirs = await this.listSkillDirectories(repoRef);
    logDebug(`GitHubSync.listRemoteSkills: found ${dirs.length} skill directories`);
    const skills: RemoteSkillMeta[] = [];
    for (const dir of dirs) {
      const existing = indexMap.get(dir);
      if (existing && existing.description) {
        skills.push(existing);
      } else {
        const description = await this.extractDescriptionFromRepo(repoRef, dir);
        skills.push({
          name: dir,
          description: description || existing?.description || "",
          updatedAt: existing?.updatedAt || "",
          files: existing?.files ?? await this.listFilesRecursive(repoRef, `skills/${dir}`)
        });
      }
    }
    return skills;
  }

  async downloadSkillFiles(repoRef: RepoRef, skillDir: string): Promise<Array<{ relativePath: string; content: string }>> {
    const root = `skills/${skillDir}`;
    const files = await this.listFilesRecursive(repoRef, root);
    const downloaded: Array<{ relativePath: string; content: string }> = [];

    for (const remoteFile of files) {
      const contentInfo = await this.tryGetContent(repoRef, remoteFile);
      if (!contentInfo) {
        continue;
      }
      downloaded.push({
        relativePath: remoteFile.replace(`${root}/`, ""),
        content: contentInfo.decoded
      });
    }

    return downloaded;
  }

  skillRemoteDir(skill: SkillRecord): string {
    if (skill.source === "project" && skill.projectName) {
      return `${skill.projectName}__${skill.skillName}`;
    }
    return skill.skillName;
  }

  private async extractDescriptionFromRepo(repoRef: RepoRef, skillDir: string): Promise<string> {
    try {
      const content = await this.tryGetContent(repoRef, `skills/${skillDir}/SKILL.md`);
      if (!content) return "";
      return parseDescriptionFromSkillMd(content.decoded);
    } catch {
      return "";
    }
  }

  private async tryGetContent(
    repoRef: RepoRef,
    remotePath: string
  ): Promise<{ sha: string; decoded: string } | null> {
    try {
      const response = await this.octokit.repos.getContent({
        owner: repoRef.owner,
        repo: repoRef.repo,
        path: remotePath
      });

      if (!("content" in response.data) || typeof response.data.content !== "string") {
        return null;
      }

      return {
        sha: response.data.sha,
        decoded: Buffer.from(response.data.content, "base64").toString("utf8")
      };
    } catch {
      return null;
    }
  }

  private async listSkillDirectories(repoRef: RepoRef): Promise<string[]> {
    try {
      const response = await this.octokit.repos.getContent({
        owner: repoRef.owner,
        repo: repoRef.repo,
        path: "skills"
      });
      if (!Array.isArray(response.data)) {
        return [];
      }
      return response.data
        .filter((item) => item.type === "dir")
        .map((item) => item.name);
    } catch {
      return [];
    }
  }

  private async listFilesRecursive(repoRef: RepoRef, remoteDir: string): Promise<string[]> {
    try {
      const response = await this.octokit.repos.getContent({
        owner: repoRef.owner,
        repo: repoRef.repo,
        path: remoteDir
      });

      if (!Array.isArray(response.data)) {
        return [];
      }

      const files: string[] = [];
      for (const item of response.data) {
        if (item.type === "file") {
          files.push(item.path);
        } else if (item.type === "dir") {
          files.push(...(await this.listFilesRecursive(repoRef, item.path)));
        }
      }
      return files;
    } catch {
      return [];
    }
  }
}
