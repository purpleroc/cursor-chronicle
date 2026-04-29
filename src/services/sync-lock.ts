import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

// Use os.tmpdir() to avoid permission issues on Windows where os.homedir()
// may resolve to a protected directory (e.g. C:\Program Files\cursor).
const LOCK_DIR = path.join(os.tmpdir(), "cursor-chronicle");
const LOCK_PATH = path.join(LOCK_DIR, "sync.lock");
const STALE_MS = 5 * 60 * 1000;

/** 使用 wx 标志原子性创建锁文件（文件已存在时失败），避免 TOCTOU 竞争条件。 */
async function tryCreateLock(): Promise<boolean> {
  try {
    await fs.writeFile(LOCK_PATH, String(Date.now()), { flag: "wx" });
    return true;
  } catch {
    return false;
  }
}

export async function acquireSyncLock(): Promise<boolean> {
  try {
    await fs.mkdir(LOCK_DIR, { recursive: true });

    if (await tryCreateLock()) return true;

    // 锁已存在，检查是否过期
    try {
      const content = await fs.readFile(LOCK_PATH, "utf8");
      const lockTime = parseInt(content.trim(), 10);
      if (!isNaN(lockTime) && Date.now() - lockTime < STALE_MS) {
        return false; // 有效锁，另一个实例正在运行
      }
      // 过期锁，删除后重试
      await fs.unlink(LOCK_PATH).catch(() => {});
    } catch {
      // 锁文件在两次检查之间消失，继续重试
    }

    return tryCreateLock();
  } catch {
    return false;
  }
}

export async function releaseSyncLock(): Promise<void> {
  try { await fs.unlink(LOCK_PATH); } catch { /* already released */ }
}
