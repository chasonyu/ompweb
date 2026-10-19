import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { scanSessionInfo, serializeTitleSlot, forEachFileLineSync } = await jiti.import("./session-files.ts");

function withSession(entries, check, title = "", prelude = "初始化信息".repeat(2000)) {
  const dir = mkdtempSync(join(tmpdir(), "omp-listing-"));
  const file = join(dir, "session.jsonl");
  const body = serializeTitleSlot({ title, updatedAt: "2026-09-18T00:00:00.000Z" }) + [
    { type: "session", version: 3, id: "session", cwd: "/project", timestamp: "2026-09-18T00:00:00.000Z" },
    { type: "custom_message", content: prelude },
    ...entries,
  ].map((entry) => JSON.stringify(entry)).join("\n") + "\n";
  try {
    writeFileSync(file, body);
    check(file);
    assert.equal(readFileSync(file, "utf8"), body, "listing must not rename or rewrite a session");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a user skill after a long prelude supplies the original prompt and survives refresh", () => {
  withSession([
    { type: "custom_message", customType: "skill-prompt", attribution: "agent", display: true, content: "Auto-injected instructions", details: { name: "auto" } },
    { type: "custom_message", customType: "skill-prompt", attribution: "user", display: true, content: "Expanded instructions", details: { name: "check", args: "测试", prompt: "/skill:check 测试" } },
    { type: "message", message: { role: "assistant", content: "Done" } },
  ], (file) => {
    assert.equal(scanSessionInfo(file).firstMessage, "/skill:check 测试");
    assert.ok(scanSessionInfo(file).messageCount >= 1);
  });
});

test("lists the first user text after a long initialization prelude", () => {
  withSession([
    { type: "message", message: { role: "user", content: [{ type: "image", data: "image" }] } },
    { type: "message", message: { role: "assistant", content: "Assistant text is not the session name" } },
    { type: "message", message: { role: "user", content: [{ type: "text", text: "帮我排查 DNS 缓存问题" }] } },
    { type: "message", message: { role: "user", content: "Later question" } },
  ], (file) => {
    const info = scanSessionInfo(file);
    assert.equal(info.firstMessage, "帮我排查 DNS 缓存问题");
    assert.ok(info.messageCount >= 1);
    assert.equal(info.title, undefined);
  });
});

test("keeps an explicit title and empty-session placeholders", () => {
  withSession([], (file) => {
    assert.equal(scanSessionInfo(file).firstMessage, "(no messages)");
  });
  withSession([], (file) => {
    assert.equal(scanSessionInfo(file).title, "手动标题");
  }, "手动标题");
});

test("prefers user text beyond the prefix over assistant initialization text", () => {
  withSession([
    { type: "message", message: { role: "assistant", content: "初始化说明" } },
    { type: "custom_message", content: "长初始化信息".repeat(2000) },
    { type: "message", message: { role: "user", content: "真正用户问题" } },
  ], (file) => {
    assert.equal(scanSessionInfo(file).firstMessage, "真正用户问题");
  }, "", "");
});

test("line scanning can stop as soon as the needed entry is found", () => {
  withSession([], (file) => {
    const lines = [];
    forEachFileLineSync(file, (line) => {
      lines.push(JSON.parse(line).type);
      return false;
    });
    assert.deepEqual(lines, ["title"]);
  });
});

test("an optional extended scan failure never hides readable session metadata", async (t) => {
  const read = fs.readSync;
  let failScan = false;
  let attempted = false;
  const mock = t.mock.method(fs, "readSync", (...args) => {
    if (failScan && args[4] === null) {
      attempted = true;
      throw new RangeError("Invalid string length");
    }
    return read(...args);
  });
  syncBuiltinESMExports();
  try {
    const isolated = createJiti(import.meta.url, { moduleCache: false, tryNative: false });
    const { scanSessionInfo: scan } = await isolated.import("./session-files.ts");
    failScan = true;
    withSession([], (file) => {
      const info = scan(file);
      assert.equal(attempted, true);
      assert.equal(info?.id, "session");
      assert.equal(info.firstMessage, "(no messages)");
    });
  } finally {
    mock.mock.restore();
    syncBuiltinESMExports();
  }
});

test("an explicitly titled session still exposes its first user prompt beyond injected context", () => {
  withSession([
    { type: "custom_message", customType: "collab-prompt", attribution: "user", display: true, content: "Review the deployment" },
  ], (file) => {
    const info = scanSessionInfo(file);
    assert.equal(info.title, "Saved title");
    assert.equal(info.firstMessage, "Review the deployment");
  }, "Saved title");
});

test("extended user prompt previews are bounded to the upstream 4096-character limit", () => {
  withSession([
    { type: "custom_message", customType: "skill-prompt", attribution: "user", display: true, content: "Expanded instructions", details: { prompt: "x".repeat(5000) } },
  ], (file) => {
    assert.equal(scanSessionInfo(file).firstMessage, "x".repeat(4096));
  });
});
