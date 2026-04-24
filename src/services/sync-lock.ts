import { promises as fs } from "node:fs";
import path from "node:path";

const LOCK_DIR = path.join(process.env.HOME ?? "", ".cursor", "cursor-chronicle");
const LOCK_PATH = path.join(LOCK_DIR, "sync.lock");
const STALE_MS = 5 * 60 * 1000;

export async function acquireSyncLock(): Promise<boolean> {
  try {
    await fs.mkdir(LOCK_DIR, { recursive: true });
    try {
      const content = await fs.readFile(LOCK_PATH, "utf8");
      const lockTime = parseInt(content.trim(), 10);
      if (!isNaN(lockTime) && Date.now() - lockTime < STALE_MS) {
        return false;
      }
    } catch { /* no lock file */ }
    await fs.writeFile(LOCK_PATH, String(Date.now()), "utf8");
    return true;
  } catch {
    return false;
  }
}

export async function releaseSyncLock(): Promise<void> {
  try { await fs.unlink(LOCK_PATH); } catch { /* already released */ }
}
