import { ComposerBubble, ComposerMeta } from "./composer-db-reader";
import { ContentBlock, Conversation, TurnRole } from "../models";

export function metaToConversation(meta: ComposerMeta, bubbles: ComposerBubble[]): Conversation {
  const turns = bubbles
    .filter((b) => b.type === 1 || b.type === 2)
    .map((b) => {
      const blocks: ContentBlock[] = [];
      if (b.thinking) {
        blocks.push({
          type: "text",
          text: `<details>\n<summary>Thinking</summary>\n\n${b.thinking}\n\n</details>\n\n${b.text}`,
        });
      } else {
        blocks.push({ type: "text", text: b.text });
      }
      return {
        role: (b.type === 1 ? "user" : "assistant") as TurnRole,
        blocks,
      };
    });

  const wsPath = meta.workspacePath;
  const projectName = wsPath
    ? wsPath.split("/").filter(Boolean).pop() ?? "unknown"
    : "unknown";

  return {
    id: meta.composerId,
    projectName,
    title: meta.name,
    createdAt: new Date(meta.createdAt),
    turns,
    sourcePath: "",
    subagentPaths: [],
  };
}
