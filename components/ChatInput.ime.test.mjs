import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";
import React, { act } from "react";
import { cleanup, fireEvent, render } from "@testing-library/react/pure.js";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { ChatInput } = await jiti.import("./ChatInput.tsx");
const { setSubmitDuringRunBehavior } = await jiti.import("@/lib/composer-prefs");
const realNow = Date.now;
let now;

beforeEach(() => {
  now = 200000;
  Date.now = () => now;
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
});
afterEach(() => {
  cleanup();
  Date.now = realNow;
  localStorage.clear();
  delete window.matchMedia;
});

function composer(props = {}) {
  const sent = [];
  const view = render(React.createElement(ChatInput, {
    isStreaming: false,
    onSend: async (text) => { sent.push(text); return { status: "accepted" }; },
    onAbort() {},
    ...props,
  }));
  const box = view.getByRole("textbox");
  fireEvent.change(box, { target: { value: "你好" } });
  return { box, sent };
}

async function enter(box, options = {}) {
  let allowed;
  await act(async () => {
    allowed = fireEvent.keyDown(box, { key: "Enter", code: "Enter", keyCode: 13, isComposing: false, ...options });
    fireEvent.keyUp(box, { key: "Enter", code: "Enter", keyCode: 13 });
  });
  return allowed;
}

for (const delay of [0, 40, 99, 150]) {
  test(`Enter sends once ${delay}ms after committing an IME candidate`, async () => {
    const { box, sent } = composer();
    fireEvent.compositionStart(box);
    fireEvent.compositionEnd(box, { data: "你好" });
    now += delay;
    await enter(box);
    assert.deepEqual(sent, ["你好"]);
    assert.equal(box.value, "");
    await enter(box);
    assert.deepEqual(sent, ["你好"], "a second Enter must not duplicate the message");
  });
}

for (const protection of ["composition ref", "native isComposing", "keyCode 229"]) {
  test(`IME confirmation is not sent when protected by ${protection}`, async () => {
    const { box, sent } = composer();
    if (protection === "composition ref") fireEvent.compositionStart(box);
    await enter(box, {
      isComposing: protection === "native isComposing",
      keyCode: protection === "keyCode 229" ? 229 : 13,
    });
    assert.deepEqual(sent, []);
    assert.equal(box.value, "你好");
  });
}

test("compositionend before the confirming keydown stays safe, then the next Enter sends", async () => {
  const { box, sent } = composer();
  fireEvent.compositionStart(box);
  fireEvent.compositionEnd(box, { data: "你好" });
  await enter(box, { keyCode: 229 });
  assert.deepEqual(sent, []);
  now += 40;
  await enter(box);
  assert.deepEqual(sent, ["你好"]);
});

test("confirming keydown before compositionend stays safe, then the next Enter sends", async () => {
  const { box, sent } = composer();
  fireEvent.compositionStart(box);
  await enter(box, { isComposing: true, keyCode: 229 });
  assert.deepEqual(sent, []);
  fireEvent.compositionEnd(box, { data: "你好" });
  now += 40;
  await enter(box);
  assert.deepEqual(sent, ["你好"]);
});

test("Shift+Enter after composition keeps the browser newline action", async () => {
  const { box, sent } = composer();
  fireEvent.compositionStart(box);
  fireEvent.compositionEnd(box, { data: "你好" });
  assert.equal(await enter(box, { shiftKey: true }), true);
  assert.deepEqual(sent, []);
});

test("Enter without composition still sends", async () => {
  const { box, sent } = composer();
  await enter(box);
  assert.deepEqual(sent, ["你好"]);
});

for (const behavior of ["queue", "steer"]) {
  test(`fast Enter after composition preserves ${behavior} while streaming`, async () => {
    setSubmitDuringRunBehavior(behavior);
    const queued = [];
    const { box, sent } = composer({
      isStreaming: true,
      onSteer: async (text) => { queued.push(["steer", text]); return true; },
      onFollowUp: async (text) => { queued.push(["queue", text]); return true; },
    });
    fireEvent.compositionStart(box);
    fireEvent.compositionEnd(box, { data: "你好" });
    now += 40;
    await enter(box);
    assert.deepEqual(queued, [[behavior, "你好"]]);
    assert.deepEqual(sent, []);
  });
}
