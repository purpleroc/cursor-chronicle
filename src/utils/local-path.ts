import path from "node:path";

/** Expand ~ and resolve to absolute path (Node fs). */
export function expandUserPath(input: string): string {
  const trimmed = input.trim();
  if (trimmed === "" || trimmed === "~") {
    return process.env.HOME ?? "";
  }
  if (trimmed.startsWith("~/")) {
    return path.join(process.env.HOME ?? "", trimmed.slice(2));
  }
  if (trimmed.startsWith("~\\")) {
    return path.join(process.env.HOME ?? "", trimmed.slice(2));
  }
  return path.resolve(trimmed);
}
