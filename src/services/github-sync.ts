import { Octokit } from "@octokit/rest";
import { SkillRecord } from "../models";
import { logInfo, logDebug } from "../utils/logger";

interface RepoRef {
  owner: string;
  repo: string;
}

interface RepoPermissionResult {
  exists: boolean;
  canPush: boolean;
  permissionText: string;
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

  skillRemoteDir(skill: SkillRecord): string {
    if (skill.source === "project" && skill.projectName) {
      return `${skill.projectName}__${skill.skillName}`;
    }
    return skill.skillName;
  }
}
