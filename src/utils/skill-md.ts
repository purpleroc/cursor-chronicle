export function parseDescriptionFromSkillMd(content: string): string {
  const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!fmMatch) return "";
  const descMatch = fmMatch[1].match(/description:\s*>?\s*-?\s*\n?([\s\S]*?)(?=\n\w|\n---)/);
  if (descMatch) return descMatch[1].replace(/\s+/g, " ").trim().slice(0, 200);
  const inlineMatch = fmMatch[1].match(/description:\s*['"]?(.+?)['"]?\s*$/m);
  return inlineMatch ? inlineMatch[1].trim().slice(0, 200) : "";
}
