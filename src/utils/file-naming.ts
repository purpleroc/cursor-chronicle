function pad(num: number): string {
  return `${num}`.padStart(2, "0");
}

export function formatTimestampForFilename(date: Date): string {
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}_${pad(date.getUTCHours())}-${pad(date.getUTCMinutes())}-${pad(date.getUTCSeconds())}Z`;
}

export function sanitizeFilenamePart(input: string): string {
  const normalized = input
    .trim()
    .replace(/[\\/:*?"<>|]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

  return normalized || "untitled";
}

export function buildConversationFilename(date: Date, title: string): string {
  return `${formatTimestampForFilename(date)}-${sanitizeFilenamePart(title)}.md`;
}
