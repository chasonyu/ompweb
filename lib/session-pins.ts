import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { randomUUID } from "crypto";
import { getAgentDir } from "./omp/paths";
import { isRecord } from "./type-guards";

export function loadSessionPins(): Record<string, number> {
  let raw: string;
  try {
    raw = readFileSync(join(getAgentDir(), "session-pins.json"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  const parsed: unknown = JSON.parse(raw);
  if (!isRecord(parsed)) throw new Error("Invalid session pin configuration");
  return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, number] => typeof entry[1] === "number" && Number.isSafeInteger(entry[1]) && entry[1] > 0));
}

export function setSessionPinned(id: string, pinned: boolean): number | undefined {
  // Keep read/modify/write synchronous so requests in this server cannot lose
  // another session's pin while awaiting file I/O.
  const pins = loadSessionPins();
  if (pinned) {
    if (!Object.hasOwn(pins, id)) pins[id] = Object.values(pins).reduce((time, previous) => Math.max(time, previous + 1), Date.now());
  } else {
    delete pins[id];
  }
  const dir = getAgentDir();
  mkdirSync(dir, { recursive: true });
  const target = join(dir, "session-pins.json");
  const temp = `${target}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, `${JSON.stringify(pins, null, 2)}\n`, { mode: 0o600 });
    renameSync(temp, target);
  } finally {
    rmSync(temp, { force: true });
  }
  return Object.hasOwn(pins, id) ? pins[id] : undefined;
}
