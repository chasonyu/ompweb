import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url, { alias: { "@/": fileURLToPath(new URL("../", import.meta.url)) } });
const { invalidateSessionListCache } = await jiti.import("./session-reader.ts");
const user = (content, extra = {}) => ({ type: "message", message: { role: "user", content, ...extra } });
const pinRoute = await jiti.import("../app/api/sessions/[id]/pin/route.ts");
const listRoute = await jiti.import("../app/api/sessions/route.ts");
const { readSessionPins, setSessionPinned } = await jiti.import("./session-pins.ts");
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
const pin = (id, pinned) => pinRoute.PATCH(new Request(`http://localhost/api/sessions/${id}/pin`, { method: "PATCH", body: JSON.stringify({ pinned }) }), { params: Promise.resolve({ id }) });

test("pins persist across reads, order newest first, unpin, and change session-list ETags", async () => fixture(async ({ write }) => {
  write("one", [user("one")]); write("two", [user("two")]);
  const before = await listRoute.GET(new Request("http://localhost/api/sessions"));
  assert.equal((await pin("one", true)).status, 200);
  assert.equal((await pin("two", true)).status, 200);
  assert.deepEqual(readSessionPins(), ["two", "one"]);
  const after = await listRoute.GET(new Request("http://localhost/api/sessions", { headers: { "if-none-match": before.headers.get("etag") } }));
  assert.equal(after.status, 200);
  assert.deepEqual((await after.json()).pinnedSessionIds, ["two", "one"]);
  assert.equal((await pin("two", false)).status, 200);
  assert.deepEqual(readSessionPins(), ["one"]);
  assert.equal((await pin("missing", true)).status, 404);
  assert.equal((await pin("one", "true")).status, 400);
  assert.deepEqual(readSessionPins(), ["one"]);
}));

test("deleted pins are excluded from lists and corrupt preferences are not overwritten", async () => fixture(async ({ dir, write }) => {
  write("exists", [user("exists")]);
  setSessionPinned("deleted", true);
  const response = await listRoute.GET(new Request("http://localhost/api/sessions"));
  assert.deepEqual((await response.json()).pinnedSessionIds, []);
  const path = join(dir, "web-session-pins.json");
  writeFileSync(path, "broken json");
  assert.throws(() => setSessionPinned("exists", true));
  assert.equal(readFileSync(path, "utf8"), "broken json");
}));
