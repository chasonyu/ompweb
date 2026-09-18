import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url, { alias: { "@/": fileURLToPath(new URL("../", import.meta.url)) } });
const { loadSessionPins, setSessionPinned } = await jiti.import("./session-pins.ts");
const { PUT } = await jiti.import("../app/api/sessions/[id]/pin/route.ts");
const { GET } = await jiti.import("../app/api/sessions/route.ts");
const { cacheSessionPath, invalidateSessionListCache, invalidateSessionPathCache } = await jiti.import("./session-reader.ts");

test("pin API persists across reload, changes list ETag, and never rewrites transcripts", async () => {
  const dir = mkdtempSync(join(tmpdir(), "omp-pin-test-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  invalidateSessionListCache();
  invalidateSessionPathCache();
  const file = join(dir, "sessions", "project", "session.jsonl");
  mkdirSync(join(dir, "sessions", "project"), { recursive: true });
  const body = JSON.stringify({ type: "session", id: "test-pin-session", version: 3, cwd: dir, timestamp: new Date().toISOString() }) + "\n";
  writeFileSync(file, body);
  cacheSessionPath("test-pin-session", file);
  const put = (body, id = "test-pin-session") => PUT(new Request(`http://localhost/api/sessions/${id}/pin`, { method: "PUT", body: JSON.stringify(body) }), { params: Promise.resolve({ id }) });
  try {
    assert.deepEqual(loadSessionPins(), {});
    assert.equal((await put({ pinned: "yes" })).status, 400);
    assert.equal((await put({ pinned: true }, "missing")).status, 404);
    const before = await GET(new Request("http://localhost/api/sessions"));
    const result = await put({ pinned: true });
    assert.equal(result.status, 200);
    const { pinnedAt } = await result.json();
    assert.ok(pinnedAt > 0);
    assert.equal(loadSessionPins()["test-pin-session"], pinnedAt);
    assert.equal((await (await put({ pinned: true })).json()).pinnedAt, pinnedAt, "pinning again must not reorder an existing pin");
    setSessionPinned("another", true);
    const listed = await GET(new Request("http://localhost/api/sessions", { headers: { "if-none-match": before.headers.get("etag") } }));
    assert.equal(listed.status, 200);
    assert.equal((await listed.json()).sessions.find(s => s.id === "test-pin-session").pinnedAt, pinnedAt);
    assert.equal((await put({ pinned: false })).status, 200);
    assert.equal(loadSessionPins()["test-pin-session"], undefined);
    assert.ok(loadSessionPins().another, "unpinning must preserve unrelated pins");
    assert.equal(readFileSync(file, "utf8"), body);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    invalidateSessionListCache();
    invalidateSessionPathCache();
    rmSync(dir, { recursive: true, force: true });
  }
});
