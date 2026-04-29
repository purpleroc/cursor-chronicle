function pad(num: number): string {
  return `${num}`.padStart(2, "0");
}

export function formatTimestampForFilename(date: Date): string {
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}_${pad(date.getUTCHours())}-${pad(date.getUTCMinutes())}-${pad(date.getUTCSeconds())}Z`;
}

// Keep filenames short enough to stay within Windows MAX_PATH limits.
// Timestamps add ~21 chars + separators, so 120 chars for the title part is safe.
const MAX_TITLE_LENGTH = 120;

export function sanitizeFilenamePart(input: string): string {
  const normalized = input
    .trim()
    .replace(/[\\/:*?"<>|]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, MAX_TITLE_LENGTH)
    .replace(/-+$/, ""); // clean up trailing dashes after truncation

  return normalized || "untitled";
}

export function buildConversationFilename(date: Date, title: string): string {
  return `${formatTimestampForFilename(date)}-${sanitizeFilenamePart(title)}.md`;
}
