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

test("session pins stay above search relevance while unpinned results follow scores", () => {
  const sessions = [
    session("recent", { modified: "2026-10-28T00:00:00Z" }),
    session("relevant"),
    session("old-pin", { pinnedAt: 1 }),
    session("new-pin", { pinnedAt: 2 }),
  ];
  const scores = new Map([["recent", 1], ["relevant", 100], ["old-pin", 500], ["new-pin", 0]]);
  assert.deepEqual(buildSessionTree(sessions, scores).map(n => n.session.id),
    ["new-pin", "old-pin", "relevant", "recent"]);
});

const { orderProjects, groupSessionsByProject } = await jiti.import("./project-ordering.ts");
test("workspace pin order and session pin order remain independent", () => {
  const projects = [{ path: "/alpha", pinOrder: 1 }, { path: "/beta", pinOrder: 0 }];
  const sessions = [
    session("alpha-pin", { cwd: "/alpha", projectRoot: "/alpha", pinnedAt: 100 }),
    session("beta-ordinary", { cwd: "/beta", projectRoot: "/beta", modified: "2026-10-28T00:00:00Z" }),
    session("beta-pin", { cwd: "/beta", projectRoot: "/beta", pinnedAt: 1 }),
  ];
  const grouped = groupSessionsByProject(projects, sessions);
  assert.deepEqual(orderProjects(projects, "alphabetical", sessions, p => p.path).map(p => p.path), ["/beta", "/alpha"]);
  assert.deepEqual(buildSessionTree(grouped.get("/beta")).map(n => n.session.id), ["beta-pin", "beta-ordinary"]);
  assert.deepEqual(buildSessionTree(grouped.get("/alpha")).map(n => n.session.id), ["alpha-pin"]);
  assert.deepEqual(projects.map(p => p.pinOrder), [1, 0]);
});
