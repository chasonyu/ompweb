import assert from "node:assert/strict";
import "../tests/setup-dom.mjs";
import test, { afterEach } from "node:test";
import React from "react";
import { render, cleanup, fireEvent } from "@testing-library/react/pure.js";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const { renderActivityPieces, CommittedTranscript, TranscriptTailContext } = await jiti.import("./ChatWindow.tsx");

const { MessageView } = await jiti.import("./MessageView.tsx");
afterEach(cleanup);

const call = (id, name = "bash") => ({ type: "toolCall", toolCallId: id, toolName: name, input: { command: id } });
const assistant = (content) => ({ role: "assistant", provider: "p", model: "m", content });

test("folded activity keeps tool calls from separate messages as separate entries", () => {
  const thinking = { type: "thinking", thinking: "plan" };
  const messages = [
    { role: "user", content: "go" },
    assistant([call("a")]),
    assistant([thinking, call("b"), call("c")]),
    { role: "custom", customType: "developer", content: "notice", display: true },
    assistant([call("d")]),
  ];
  const pieces = [
    { index: 1, blocks: messages[1].content },
    { index: 2, blocks: messages[2].content },
    { index: 3 },
    { index: 4, blocks: messages[4].content },
  ];
  const calls = [];
  renderActivityPieces(messages, pieces, (idx, options) => { calls.push({ idx, options }); return null; });

  // One entry per piece, in order: nothing merged across messages, and the
  // parallel calls of message 2 stay together with their thinking block.
  assert.deepEqual(calls.map(({ idx }) => idx), [1, 2, 3, 4]);
  assert.deepEqual(
    calls.map(({ options }) => options.messageOverride?.content.map((b) => b.toolCallId ?? b.type)),
    [["a"], ["thinking", "b", "c"], undefined, ["d"]],
  );
  assert.deepEqual(calls[1].options.sourceBlockIndices, [0, 1, 2]);
  assert.equal(new Set(calls.map(({ idx, options }) => `${options.keyPrefix}-${idx}`)).size, calls.length);
});

const text = (value) => ({ type: "text", text: value });
function transcriptProps(messages) {
  return {
    messages, entryIds: messages.map((_, i) => `entry-${i}`),
    conversationMeta: { toolResultsMap: new Map(), lastAnchorIdx: 0, visibleRefIndexByMessage: new Map() },
    messageRefs: { current: [] }, isStreaming: false, sessionBusy: false, isCompacting: false,
    externalRunActive: false, isNew: false, forkingEntryId: null, editingEntryId: null,
    handleFork() {}, handleEdit: async () => true, modelNames: { "p:m": "Original model" },
    toolCallsDefaultCollapsed: true, hideToolActivity: true, expandThinkingByDefault: false,
    hideThinkingBlock: false, visibleCount: 100, nearBottom: true, sentinelRef: { current: null }, handleLoadMoreClick() {},
  };
}

function tail(message) {
  return function renderTail(modelLabelLayout) {
    return message
      ? React.createElement(MessageView, { message, modelNames: { "p:m": "Original model" }, modelLabelLayout })
      : modelLabelLayout?.(null);
  };
}
function transcript(props, message) {
  return React.createElement(TranscriptTailContext.Provider, { value: tail(message) }, React.createElement(CommittedTranscript, props));
}
function assertHeaderModel(container, expected = "Original model") {
  const button = container.querySelector(".process-details-toggle");
  assert.ok(button);
  const row = button.parentElement;
  assert.equal(row.style.display, "flex");
  assert.ok(row.textContent.includes(expected), "the original model label belongs to the process header row");
  assert.equal(button.textContent.includes(expected), false, "model label must not become part of the toggle button");
  return button;
}

test("model label shares the process header when collapsed and expanded", () => {
  const props = transcriptProps([{ role: "user", content: "go" }, assistant([call("a")]), assistant([text("answer")])]);
  const view = render(transcript(props));
  const button = assertHeaderModel(view.container);
  fireEvent.click(button);
  assert.equal(button.getAttribute("aria-expanded"), "true");
  assertHeaderModel(view.container);
  assert.ok(view.getByText("answer"));
});

test("each activity/text segment retains its own identical model label", () => {
  const props = transcriptProps([{ role: "user", content: "go" }, assistant([call("a"), text("first"), call("b"), text("second")])]);
  const view = render(transcript(props));
  const buttons = view.container.querySelectorAll(".process-details-toggle");
  assert.equal(buttons.length, 2);
  for (const button of buttons) assert.ok(button.parentElement.textContent.includes("Original model"));
  assert.equal(view.getAllByText("Original model").length, 2);
});

test("missing provider and no process preserve the original label behavior", () => {
  const noProvider = { role: "assistant", model: "m", content: [text("answer")] };
  const props = transcriptProps([{ role: "user", content: "go" }, assistant([call("a")]), noProvider]);
  const view = render(transcript(props));
  assert.equal(view.queryByText("Original model"), null);
  assert.ok(view.container.querySelector(".process-details-toggle"));
  view.rerender(transcript(transcriptProps([{ role: "user", content: "go" }, assistant([text("answer")])])));
  assert.equal(view.container.querySelector(".process-details-toggle"), null);
  assert.ok(view.getByText("Original model"));
});

test("tail label appears only with its original message, survives held state and commit", () => {
  const messages = [{ role: "user", content: "go" }, assistant([call("a")])];
  const props = transcriptProps(messages);
  const view = render(transcript(props));
  assert.ok(view.container.querySelector(".process-details-toggle"));
  assert.equal(view.queryByText("Original model"), null);
  fireEvent.click(view.container.querySelector(".process-details-toggle"));
  const streamed = assistant([text("streamed answer")]);
  view.rerender(transcript(props, streamed));
  const button = assertHeaderModel(view.container);
  assert.equal(button.getAttribute("aria-expanded"), "true");
  view.rerender(transcript(props, { ...streamed, content: [text("held answer")] }));
  assertHeaderModel(view.container);
  assert.equal(view.container.querySelector(".process-details-toggle").getAttribute("aria-expanded"), "true");
  view.rerender(transcript(transcriptProps([...messages, streamed])));
  assertHeaderModel(view.container);
  assert.equal(view.container.querySelector(".process-details-toggle").getAttribute("aria-expanded"), "true");
  assert.equal(view.getAllByText("Original model").filter((node) => node.parentElement.style.display !== "none").length, 1);
});


test("streaming context updates do not read or re-render committed history", () => {
  let reads = 0;
  const messages = new Proxy([{ role: "user", content: "go" }, assistant([call("a")])], {
    get(target, key, receiver) { reads++; return Reflect.get(target, key, receiver); },
  });
  const props = transcriptProps(messages);
  const view = render(transcript(props, assistant([text("one")])));
  reads = 0;
  view.rerender(transcript(props, assistant([text("two")])));
  assert.equal(reads, 0);
  assertHeaderModel(view.container);
  assert.ok(view.getByText("two"));
});

test("navigation refs survive process expansion for a following separate message", () => {
  const props = transcriptProps([{ role: "user", content: "go" }, assistant([call("a")]), assistant([text("answer")])]);
  props.conversationMeta.visibleRefIndexByMessage = new Map([[0, 0], [1, 1], [2, 2]]);
  const view = render(transcript(props));
  const answerRef = props.messageRefs.current[2];
  assert.ok(answerRef?.isConnected);
  fireEvent.click(view.container.querySelector(".process-details-toggle"));
  assert.equal(props.messageRefs.current[2], answerRef);
  assert.ok(answerRef.isConnected);
});

test("tail containing activity keeps the original model row hidden without hiding process details", () => {
  const props = transcriptProps([{ role: "user", content: "go" }, assistant([call("a")])]);
  const view = render(transcript(props, assistant([{ type: "thinking", thinking: "planning" }, text("answer")])));
  const model = view.getByText("Original model");
  assert.equal(model.parentElement.style.display, "none");
  assert.ok(view.container.querySelector(".process-details-toggle"));
});

test("model layout preserves live metrics and original provider/name fallback rules", () => {
  for (const message of [
    assistant([text("a sufficiently long live answer")]),
    { ...assistant([text("a sufficiently long live answer")]), provider: undefined },
  ]) {
    const props = { message, isStreaming: true, liveTokensPerSecond: 42, modelNames: { "p:m": "Provider model", m: "Generic model" } };
    const original = render(React.createElement(MessageView, props));
    const labelText = original.container.querySelector(".chat-message").firstElementChild.textContent;
    original.unmount();
    const moved = render(React.createElement(MessageView, { ...props,
      modelLabelLayout: (label) => React.createElement("div", { "data-model-slot": true }, label),
    }));
    assert.equal(moved.container.querySelector("[data-model-slot]").textContent, labelText);
    assert.ok(labelText.includes("42.0"));
    assert.equal(labelText.includes("Provider model"), !!message.provider);
    moved.unmount();
  }
});

test("flat live turns and empty tail messages preserve process visibility", () => {
  const props = transcriptProps([{ role: "user", content: "go" }, assistant([call("a")])]);
  const view = render(transcript(props, assistant([])));
  assert.ok(view.container.querySelector(".process-details-toggle"));
  assert.equal(view.queryByText("Original model"), null);
  view.rerender(transcript({ ...props, hideToolActivity: false, sessionBusy: true }, assistant([text("live answer")])));
  assert.equal(view.container.querySelector(".process-details-toggle"), null);
  const label = view.getAllByText("Original model").find((node) => node.parentElement.style.display !== "none");
  assert.ok(label);
});

test("expanded tool DOM, state and focus survive missing, streaming, held and committed tails", () => {
  const messages = [{ role: "user", content: "go" }, assistant([call("a")])];
  const props = transcriptProps(messages);
  const view = render(transcript(props));
  fireEvent.click(view.container.querySelector(".process-details-toggle"));
  const toolButton = view.container.querySelector('button[aria-expanded]:not(.process-details-toggle)');
  assert.ok(toolButton);
  fireEvent.click(toolButton);
  toolButton.focus();
  assert.equal(toolButton.getAttribute("aria-expanded"), "true");
  const answer = assistant([text("answer")]);
  for (const [nextProps, nextTail] of [
    [props, answer],
    [props, { ...answer, content: [text("held answer")] }],
    [transcriptProps([...messages, answer]), undefined],
  ]) {
    view.rerender(transcript(nextProps, nextTail));
    assert.ok(view.container.querySelector('button[aria-expanded]:not(.process-details-toggle)') === toolButton, "tool DOM identity must survive tail changes");
    assert.equal(toolButton.getAttribute("aria-expanded"), "true");
    assert.ok(document.activeElement === toolButton, "tool focus must survive tail changes");
    assertHeaderModel(view.container);
  }
});

test("a custom advisor tail cannot remove preceding process details", () => {
  const props = transcriptProps([{ role: "user", content: "go" }, assistant([call("a")])]);
  const view = render(transcript(props));
  const button = view.container.querySelector(".process-details-toggle");
  fireEvent.click(button);
  view.rerender(transcript(props, { role: "custom", customType: "advisor", content: "Consider the edge case.", display: true }));
  assert.equal(view.container.querySelector(".process-details-toggle"), button);
  assert.equal(button.getAttribute("aria-expanded"), "true");
  assert.ok(view.getByText("Consider the edge case."));
});

function persistentActions(container) {
  return [...container.querySelectorAll('[data-actions-always-visible="true"]')];
}

test("only the last conversational message keeps actions visible, including a last user prompt", () => {
  const messages = [{ role: "user", content: "first user" }, assistant([text("first answer")]), { role: "user", content: "last user" }];
  const view = render(transcript(transcriptProps(messages)));
  assert.equal(persistentActions(view.container).length, 1);
  assert.ok(persistentActions(view.container)[0].textContent.includes("last user"));
  view.rerender(transcript(transcriptProps([...messages, assistant([text("last answer")])])));
  assert.equal(persistentActions(view.container).length, 1);
  assert.ok(persistentActions(view.container)[0].textContent.includes("last answer"));
});

test("split replies mark only the last text segment; trailing tool results do not take its place", () => {
  const messages = [{ role: "user", content: "go" }, assistant([text("first part"), call("a"), text("last part"), call("b")]), { role: "toolResult", toolCallId: "b", content: [text("result")] }];
  const view = render(transcript(transcriptProps(messages)));
  assert.equal(persistentActions(view.container).length, 1);
  assert.ok(persistentActions(view.container)[0].textContent.includes("last part"));
  assert.equal(view.getByText("first part").closest(".chat-message").querySelector(".message-actions"), null);
  assert.equal(view.container.querySelectorAll(".chat-message > .message-actions").length, 1);
  for (const button of view.container.querySelectorAll('.process-details-toggle')) fireEvent.click(button);
  assert.equal(persistentActions(view.container).length, 1);
  assert.equal(view.container.querySelectorAll(".chat-message > .message-actions").length, 1);
});

test("intermediate replies have no footer while each turn keeps its final reply actions", () => {
  const messages = [
    { role: "user", content: "old prompt" },
    assistant([text("old progress"), call("old")]),
    assistant([text("old final")]),
    { role: "user", content: "new prompt" },
    assistant([text("first progress"), call("a")]),
    assistant([text("second progress"), call("b")]),
    assistant([text("new final")]),
  ];
  for (const hideToolActivity of [true, false]) {
    const props = { ...transcriptProps(messages), hideToolActivity, sessionBusy: true };
    props.conversationMeta.lastAnchorIdx = 3;
    const view = render(transcript(props));
    for (const button of view.container.querySelectorAll(".process-details-toggle")) fireEvent.click(button);
    for (const value of ["old progress", "first progress", "second progress"]) {
      const message = view.getByText(value).closest(".chat-message");
      fireEvent.mouseEnter(message);
      assert.equal(message.querySelector(".message-actions"), null, `${value} must not reserve a footer`);
    }
    for (const value of ["old final", "new final"]) {
      assert.ok(view.getByText(value).closest(".chat-message").querySelector(".message-actions"));
    }
    assert.equal(view.container.querySelectorAll(".chat-message > .message-actions").length, 2);
    assert.equal(persistentActions(view.container).length, 1);
    assert.ok(persistentActions(view.container)[0].textContent.includes("new final"));
    view.unmount();
  }
});

test("streaming reply takes persistent actions from history, returning on commit", () => {
  const messages = [{ role: "user", content: "go" }, assistant([text("saved answer")])];
  const props = transcriptProps(messages);
  const view = render(transcript(props));
  assert.equal(persistentActions(view.container).length, 1);
  view.rerender(transcript({ ...props, hasStreamingReply: true }));
  assert.equal(persistentActions(view.container).length, 0);
  assert.equal(view.getByText("saved answer").closest(".chat-message").querySelector(".message-actions"), null);
  view.rerender(transcript(transcriptProps([...messages, assistant([text("committed answer")])])));
  assert.equal(persistentActions(view.container).length, 1);
  assert.ok(persistentActions(view.container)[0].textContent.includes("committed answer"));
  assert.equal(view.container.querySelectorAll(".chat-message > .message-actions").length, 1);
});

test("live status moves to the latest process header and clears without remounting", () => {
 const messages=[{role:'user',content:'go'}];
 const props={...transcriptProps(messages),liveStatus:'Waiting for model...'};
 const view=render(transcript(props));
 assert.equal(view.container.querySelectorAll('.transcript-live-status').length,1);
 assert.equal(view.container.querySelector('.transcript-live-status').closest('.process-details-header'),null);
 const next={...transcriptProps([...messages,assistant([call('a')])]),liveStatus:props.liveStatus};
 view.rerender(transcript(next));
 const header=view.container.querySelector('.process-details-header');
 assert.equal(header.querySelector('.transcript-live-status').textContent,props.liveStatus);
 assert.equal(view.container.querySelectorAll('.transcript-live-status').length,1);
 const toggle=header.querySelector('button');fireEvent.click(toggle);
 view.rerender(transcript({...next,liveStatus:'Compacting context...'}));
 assert.equal(toggle.getAttribute('aria-expanded'),'true');
 view.rerender(transcript({...next,liveStatus:null}));
 assert.equal(view.container.querySelectorAll('.transcript-live-status').length,0);
 assert.equal(toggle.getAttribute('aria-expanded'),'true');
});

test("live status belongs only to newest activity after the model label", () => {
 const messages=[{role:'user',content:'go'},assistant([call('a'),text('first'),call('b'),text('last')])];
 const view=render(transcript({...transcriptProps(messages),liveStatus:'Waiting for model...'}));
 const headers=view.container.querySelectorAll('.process-details-header');
 assert.equal(headers.length,2);assert.equal(headers[0].querySelector('.transcript-live-status'),null);
 assert.equal(headers[1].lastElementChild.textContent,'Waiting for model...');
 assert.ok(headers[1].textContent.indexOf('Original model')<headers[1].textContent.indexOf('Waiting for model...'));
});

test("new user and flat live tail never attach status to historical activity", () => {
 const old=[{role:'user',content:'old'},assistant([call('a'),text('done')])];
 for(const flat of [false,true]){
  const messages=[...old,{role:'user',content:'new'},...(flat?[assistant([call('b')])]:[])];
  const props={...transcriptProps(messages),sessionBusy:true,hideToolActivity:!flat,liveStatus:'Thinking...'};props.conversationMeta.lastAnchorIdx=2;
  const view=render(transcript(props));
  assert.equal(view.container.querySelectorAll('.transcript-live-status').length,1);
  assert.equal(view.container.querySelector('.transcript-live-status').closest('.process-details-header'),null);
  view.unmount();
 }
});
