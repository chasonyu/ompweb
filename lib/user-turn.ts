import type { CustomMessage, UserMessage } from "./types";
import { isRecord } from "./type-guards";

export type UserTurnMessage = UserMessage | (CustomMessage & { attribution: "user" });

/** OMP transport roles are not turn ownership: explicit skill/collab inputs are custom messages. */
export function isUserTurnMessage(message: unknown): message is UserTurnMessage {
  if (!isRecord(message)) return false;
  if (message.role === "user") return message.attribution !== "agent";
  return message.role === "custom" && message.attribution === "user" && message.display !== false
    && (message.customType === "skill-prompt" || message.customType === "collab-prompt");
}

function textContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter(isRecord).filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text).join("\n");
}

/** Compact input for display, editing, history and queue acknowledgement, never the expanded skill body. */
export function getUserPromptText(message: unknown): string | undefined {
  if (!isUserTurnMessage(message)) return undefined;
  if (message.role === "user") return textContent(message.content);
  const details = isRecord(message.details) ? message.details : {};
  if (typeof details.__queueChipText === "string" && details.__queueChipText.trim()) return details.__queueChipText;
  if (message.customType !== "skill-prompt") return textContent(message.content);
  if (typeof details.prompt === "string" && details.prompt.trim()) return details.prompt;
  const name = typeof details.name === "string" ? details.name.trim() : "";
  const args = typeof details.args === "string" ? details.args.trim() : "";
  return `${name ? `/skill:${name}` : "/skill"}${args ? ` ${args}` : ""}`;
}

/** Read the same semantics directly from JSONL without changing its entry identity or payload. */
export function getEntryUserPromptText(entry: unknown): string | undefined {
  if (!isRecord(entry)) return undefined;
  if (entry.type === "message") return getUserPromptText(entry.message);
  if (entry.type === "custom_message") return getUserPromptText({ ...entry, role: "custom" });
  return undefined;
}

/** Older OMP builds retain skill name/args but not the original separator whitespace. */
export function matchesQueuedUserPrompt(queued: string, delivered: unknown): boolean {
  const text = getUserPromptText(delivered);
  if (!text) return false;
  if (queued === text) return true;
  if (!isUserTurnMessage(delivered) || delivered.role !== "custom" || delivered.customType !== "skill-prompt") return false;
  const normalize = (value: string) => {
    const match = value.trim().match(/^\/skill:([^\s]+)(?:\s+([\s\S]*))?$/);
    return match ? `/skill:${match[1]}${match[2]?.trim() ? ` ${match[2].trim()}` : ""}` : value;
  };
  return normalize(queued) === normalize(text);
}
