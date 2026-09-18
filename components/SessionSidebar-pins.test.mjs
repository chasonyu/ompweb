import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import React from "react";
import { cleanup, render, screen } from "@testing-library/react/pure.js";
import userEvent from "@testing-library/user-event";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { SessionItem, SessionTreeItem } = await jiti.import("./SessionSidebar-rows.tsx");
afterEach(() => { cleanup(); localStorage.clear(); });
const session = { id: "pin-me", name: "My task", firstMessage: "Do work", cwd: "/tmp/project", modified: new Date().toISOString(), created: new Date().toISOString(), messageCount: 2 };

test("session menu pins/unpins without selecting the session", async () => {
  const user = userEvent.setup();
  const pins = [];
  let selections = 0;
  const props = { session, isSelected: false, relativeTimeNow: Date.now(), onClick: () => selections++, onTogglePin: (id) => pins.push(id) };
  const view = render(React.createElement(SessionItem, props));
  await user.click(screen.getByRole("button", { name: /actions/i }));
  await user.click(screen.getByRole("menuitem", { name: "Pin session" }));
  assert.deepEqual(pins, ["pin-me"]);
  assert.equal(selections, 0);
  view.rerender(React.createElement(SessionItem, { ...props, isPinned: true }));
  await user.click(screen.getByRole("button", { name: /actions/i }));
  await user.click(screen.getByRole("menuitem", { name: "Unpin session" }));
  assert.deepEqual(pins, ["pin-me", "pin-me"]);
  assert.equal(selections, 0);
});

test("pin changes reach nested fork rows through memoized tree parents", async () => {
  const user = userEvent.setup();
  const child = { ...session, id: "child", name: "Child task" };
  const props = { node: { session, children: [{ session: child, children: [] }] }, selectedSessionId: null, runningSessionIds: new Set(), unreadSessionIds: new Set(), relativeTimeNow: Date.now(), onSelectSession() {}, onTogglePin() {}, depth: 0 };
  const view = render(React.createElement(SessionTreeItem, { ...props, pinnedSessionIds: new Set() }));
  view.rerender(React.createElement(SessionTreeItem, { ...props, pinnedSessionIds: new Set(["child"]) }));
  await user.click(screen.getAllByRole("button", { name: /actions/i })[1]);
  assert.ok(screen.getByRole("menuitem", { name: "Unpin session" }));
});
