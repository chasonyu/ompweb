import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import { fileURLToPath } from "node:url";
const jiti = createJiti(import.meta.url, { alias: { "@/": fileURLToPath(new URL("../", import.meta.url)) } });
const { buildSessionTree } = await jiti.import("../components/SessionSidebar-helpers.ts");
const session = (id, extra = {}) => ({ id, modified: "2026-09-18T00:00:00Z", ...extra });

test("pinned branches move above recent roots without duplicates and unpin restores ancestry", () => {
  const sessions = [session("parent"), session("recent", { modified: "2026-09-19T00:00:00Z" }), session("child", { parentSessionId: "parent", pinnedAt: 1 })];
  const tree = buildSessionTree(sessions);
  assert.deepEqual(tree.map(n => n.session.id), ["child", "recent", "parent"]);
  assert.equal(tree[2].children.length, 0);
  assert.equal(tree[2].hasBranches, true, "a pinned child must still prevent archiving its parent");
  const restored = buildSessionTree(sessions.map(s => ({ ...s, pinnedAt: undefined })));
  assert.equal(restored.find(n => n.session.id === "parent").children[0].session.id, "child");
});

test("pinned ordering stays independent of conversation activity", () => {
  assert.deepEqual(buildSessionTree([session("old-pin", { pinnedAt: 1, modified: "2027-01-01" }), session("new-pin", { pinnedAt: 2 })]).map(n => n.session.id), ["new-pin", "old-pin"]);
});

const { visibleSessionRoots } = await jiti.import("../components/SessionSidebar-helpers.ts");
test("all pins remain visible without consuming the five ordinary root slots", () => {
  const pinned = Array.from({ length: 7 }, (_, i) => session(`pin-${i}`, { pinnedAt: i + 1 }));
  const ordinary = Array.from({ length: 9 }, (_, i) => session(`ordinary-${i}`));
  const visible = visibleSessionRoots(buildSessionTree([...ordinary, ...pinned]));
  assert.equal(visible.length, 12);
  assert.equal(visible.filter(n => n.session.pinnedAt).length, 7);
});
