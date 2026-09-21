import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { isUserTurnMessage, getUserPromptText, getEntryUserPromptText, matchesQueuedUserPrompt } = await jiti.import("./user-turn.ts");
const skill = { role: "custom", customType: "skill-prompt", attribution: "user", display: true, content: "Expanded skill instructions", details: { name: "check", args: "测试", prompt: "/skill:check 测试" } };

test("user turns distinguish attribution and command semantics from transport roles", () => {
  assert.equal(isUserTurnMessage({ role: "user", content: [] }), true);
  assert.equal(isUserTurnMessage(skill), true);
  assert.equal(isUserTurnMessage({ ...skill, customType: "collab-prompt" }), true);
  for (const message of [null, {}, { role: "user", attribution: "agent" }, { ...skill, display: false }, { ...skill, attribution: undefined }, { ...skill, attribution: "agent" }, { ...skill, customType: "magic-keyword-instructions", display: false }, { ...skill, customType: "advisor" }]) {
    assert.equal(isUserTurnMessage(message), false);
  }
});

test("skill display and queue matching use original input, never expanded instructions", () => {
  assert.equal(getUserPromptText(skill), "/skill:check 测试");
  assert.equal(getUserPromptText({ ...skill, details: { name: "check", args: "测试" } }), "/skill:check 测试");
  assert.equal(getUserPromptText({ ...skill, details: { ...skill.details, __queueChipText: "/skill:check queued" } }), "/skill:check queued");
  assert.equal(getUserPromptText({ ...skill, details: null }), "/skill");
  assert.equal(getUserPromptText({ ...skill, attribution: "agent" }), undefined);
  assert.equal(getUserPromptText({ ...skill, customType: "collab-prompt", content: "Peer input", details: { from: "peer" } }), "Peer input");
  assert.equal(getUserPromptText({ role: "user", content: [{ type: "text", text: "hello" }, { type: "image" }, { type: "text", text: "world" }] }), "hello\nworld");
});

test("file entries and live messages share the user-turn contract", () => {
  const entry = { ...skill };
  delete entry.role;
  assert.equal(getEntryUserPromptText({ ...entry, type: "custom_message" }), getUserPromptText(skill));
  assert.equal(getEntryUserPromptText({ type: "message", message: { role: "user", content: "hello" } }), "hello");
  assert.equal(getEntryUserPromptText({ type: "custom", ...entry }), undefined);
});

test("queue matching tolerates only skill invocation separator differences", () => {
  assert.equal(matchesQueuedUserPrompt("/skill:check    测试", skill), true);
  assert.equal(matchesQueuedUserPrompt("/skill:other 测试", skill), false);
  assert.equal(matchesQueuedUserPrompt("hello  world", { role: "user", content: "hello world" }), false);
  assert.equal(matchesQueuedUserPrompt("/skill:check a  b", { ...skill, details: { name: "check", args: "a b" } }), false);
  assert.equal(matchesQueuedUserPrompt("/skill:check 测试", { ...skill, attribution: "agent" }), false);
});
