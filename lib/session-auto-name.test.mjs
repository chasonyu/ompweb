import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, truncateSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url, { alias: { "@/": fileURLToPath(new URL("../", import.meta.url)) } });
const { invalidateSessionListCache } = await jiti.import("./session-reader.ts");
const user = (content, extra = {}) => ({ type: "message", message: { role: "user", content, ...extra } });
const autoName = await jiti.import("../app/api/sessions/[id]/auto-name/route.ts");
const { readFirstUserMessage, scanSessionInfo, setSessionTitle, forEachFileLineSync } = await jiti.import("./omp/session-files.ts");
async function fixture(run) {
  const dir = mkdtempSync(join(tmpdir(), "ompweb-management-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  mkdirSync(join(dir, "sessions", "project"), { recursive: true });
  invalidateSessionListCache();
  const write = (id, entries) => {
    const file = join(dir, "sessions", "project", `${id}.jsonl`);
    writeFileSync(file, [{ type: "session", version: 3, id, cwd: dir, timestamp: "2026-01-01T00:00:00.000Z" }, ...entries].map(JSON.stringify).join("\n") + "\n");
    return file;
  };
  try { await run({ dir, write }); }
  finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    invalidateSessionListCache();
    rmSync(dir, { recursive: true, force: true });
  }
}
const name = (id) => autoName.POST(new Request(`http://localhost/api/sessions/${id}/auto-name`, { method: "POST" }), { params: Promise.resolve({ id }) });
test("auto-name finds the real user beyond large system/metadata records and persists the result", async () => fixture(async ({ write }) => {
  const file = write("long", [
    { type: "session_init", systemPrompt: "instructions ".repeat(20000), example: { role: "user", content: "not a user message" } },
    { type: "message", message: { role: "developer", content: "developer instructions" } },
    user("synthetic context", { synthetic: true }),
    user([{ type: "image", data: "" }]),
    user([{ type: "text", text: "修复真正的用户任务" }]),
  ]);
  assert.equal(scanSessionInfo(file, false).firstMessage, "(no messages)");
  assert.equal(readFirstUserMessage(file), "修复真正的用户任务");
  const response = await name("long");
  assert.equal(response.status, 200);
  assert.equal((await response.json()).title, "修复真正的用户任务");
  assert.equal(scanSessionInfo(file, false).title, "修复真正的用户任务");
}));

test("naming does not mistake developer or assistant text for a user message", async () => fixture(async ({ write }) => {
  write("no-user", [{ type: "message", message: { role: "developer", content: "Do not use this title" } }]);
  const response = await name("no-user");
  assert.equal(response.status, 409);
  assert.equal((await response.json()).code, "session_no_messages_to_name");
}));

test("a live RPC process owns the title write; refresh sees its persisted title", async () => fixture(async ({ write }) => {
  const file = write("live", [user("Name and persist this task")]);
  const commands = [];
  globalThis.__ompSessions ??= new Map();
  globalThis.__ompSessions.set("live", {
    sessionFile: file,
    isAlive: () => true,
    send: async (command) => {
      commands.push(command);
      if (command.type === "get_state") return {};
      assert.equal(command.type, "set_session_name");
      setSessionTitle(file, command.name, "user");
    },
  });
  try {
    const response = await name("live");
    assert.equal(response.status, 200);
    assert.deepEqual(commands.map((c) => c.type), ["get_state", "set_session_name"]);
    assert.equal(scanSessionInfo(file, false).title, "Name and persist this task");
  } finally { globalThis.__ompSessions.delete("live"); }
}));

test("automatic naming preserves an explicit user title", async () => fixture(async ({ write }) => {
  const file = write("named", [user("Different message")]);
  setSessionTitle(file, "My chosen title", "user");
  assert.equal((await (await name("named")).json()).title, "My chosen title");
}));

test("line scanning can stop without reading later transcript records", async () => fixture(async ({ write }) => {
  const file = write("early", [user("first"), user("later")]);
  const lines = [];
  forEachFileLineSync(file, (line) => { lines.push(line); return false; });
  assert.equal(lines.length, 1);
  truncateSync(file, 1024 * 1024 * 1024 + 1);
  assert.throws(() => readFirstUserMessage(file), RangeError);
}));

