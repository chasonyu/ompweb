import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { randomUUID } from "crypto";
import { getAgentDir } from "./omp/paths";

// Web-only preferences: never add UI metadata to the agent's session files.
export function readSessionPins(): string[] {
  try {
    const value: unknown = JSON.parse(readFileSync(join(getAgentDir(), "web-session-pins.json"), "utf8"));
    if (!Array.isArray(value) || value.some((id) => typeof id !== "string")) throw new Error("Invalid session pins file");
    return [...new Set(value as string[])];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error; // Do not overwrite corrupt preferences with an empty list.
  }
}

export function setSessionPinned(id: string, pinned: boolean): string[] {
  // Synchronous read/modify/atomic rename serializes requests in the server.
  const previous = readSessionPins();
  if (previous.includes(id) === pinned) return previous;
  const next = pinned ? [id, ...previous.filter((value) => value !== id)] : previous.filter((value) => value !== id);
  const dir = getAgentDir();
  mkdirSync(dir, { recursive: true });
  const target = join(dir, "web-session-pins.json");
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(next) + "\n", { mode: 0o600 });
    renameSync(temporary, target);
  } finally {
    rmSync(temporary, { force: true });
  }
  return next;
}
