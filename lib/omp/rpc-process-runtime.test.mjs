import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import { createJiti } from "jiti";

const isolatedAgentDir = mkdtempSync(join(tmpdir(), "omp-rpc-runtime-test-"));
process.env.PI_CODING_AGENT_DIR = isolatedAgentDir;
test.after(() => {
  globalThis.__ompNotificationStore?.db.close();
  globalThis.__ompNotificationStore = undefined;
  rmSync(isolatedAgentDir, { recursive: true, force: true });
});
const jiti = createJiti(import.meta.url);
const { RpcProcess, RpcCommandTimeoutError } = jiti("./rpc-process.ts");
const { AgentSessionWrapper } = jiti("../rpc-manager.ts");

/** Outbound v2 chunk records exactly as OMP emits them. */
function chunkRecords(frame, chunkId, payloadBytes = 256 * 1024) {
  const bytes = Buffer.from(JSON.stringify(frame), "utf8");
  const count = Math.ceil(bytes.byteLength / payloadBytes);
  return Array.from({ length: count }, (_, index) => ({
    type: "rpc_chunk",
    chunkId,
    index,
    count,
    byteLength: bytes.byteLength,
    data: bytes.subarray(index * payloadBytes, (index + 1) * payloadBytes).toString("base64"),
  }));
}
function makeTransport() {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const child = Object.assign(new EventEmitter(), {
    stdin,
    stdout,
    stderr,
    pid: 4321,
    kill() {
      queueMicrotask(() => child.emit("exit", 0, null));
      return true;
    },
  });
  const commands = [];
  const spawnCalls = [];
  let partial = "";
  let onCommand = () => {};
  stdin.on("data", (chunk) => {
    partial += chunk.toString("utf8");
    const lines = partial.split("\n");
    partial = lines.pop();
    for (const line of lines) {
      if (!line) continue;
      const command = JSON.parse(line);
      commands.push(command);
      onCommand(command);
    }
  });
  stdin.on("end", () => queueMicrotask(() => child.emit("exit", 0, null)));
  queueMicrotask(() => {
    stdout.write(`${JSON.stringify({ type: "ready", supportedProtocolVersions: [1, 2] })}\n`);
  });

  return {
    commands,
    spawnCalls,
    child,
    set onCommand(callback) { onCommand = callback; },
    send(frame) { stdout.write(`${JSON.stringify(frame)}\n`); },
    sendFrames(frames) { for (const frame of frames) stdout.write(frame); },
    spawn(...args) { spawnCalls.push(args); return child; },
  };
}

function startProcess(transport) {
  return new RpcProcess({
    cwd: process.cwd(),
    dependencies: {
      resolveOmpBin: () => "fake-omp",
      spawn: transport.spawn,
    },
  });
}

test("RpcProcess negotiates v2 and correlates out-of-order command responses", async () => {
  const transport = makeTransport();
  transport.onCommand = (command) => {
    if (command.type === "negotiate_protocol") {
      transport.send({ type: "response", id: command.id, command: command.type, success: true, data: { protocolVersion: 2 } });
    }
  };
  const proc = startProcess(transport);
  const ready = await proc.waitReady();
  assert.equal(await proc.negotiateProtocol(ready), 2);

  const first = proc.sendCommand({ type: "first" });
  const second = proc.sendCommand({ type: "second" });
  // Commands are serialized through a FIFO queue, so they land asynchronously.
  while (transport.commands.length < 2) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  const [firstCommand, secondCommand] = transport.commands.slice(-2);
  transport.send({ type: "response", id: secondCommand.id, command: "second", success: true, data: "second" });
  transport.send({ type: "response", id: firstCommand.id, command: "first", success: true, data: "first" });

  assert.equal(await first, "first");
  assert.equal(await second, "second");
  await proc.dispose(0);
});

test("RpcProcess does not create a separate Windows console", async () => {
  const transport = makeTransport();
  const proc = startProcess(transport);
  assert.equal(transport.spawnCalls[0][2].windowsHide, true);
  if (process.platform === "win32") assert.equal(transport.spawnCalls[0][2].detached, false);
  await proc.dispose(0);
});

test("RpcProcess reassembles v2 events and rejects pending commands when the child crashes", async () => {
  const transport = makeTransport();
  transport.onCommand = (command) => {
    if (command.type === "negotiate_protocol") {
      transport.send({ type: "response", id: command.id, command: command.type, success: true, data: { protocolVersion: 2 } });
    }
  };
  const proc = startProcess(transport);
  const ready = await proc.waitReady();
  await proc.negotiateProtocol(ready);

  const frames = [];
  proc.onFrame((frame) => frames.push(frame));
  const expected = { type: "message_update", content: "x".repeat(1024 * 1024) };
  transport.sendFrames(chunkRecords(expected, "event-1").map((record) => `${JSON.stringify(record)}\n`));
  assert.deepEqual(frames, [expected]);

  const pending = proc.sendCommand({ type: "never_returns" });
  transport.child.emit("exit", 7, null);
  await assert.rejects(pending, /omp exited/);
});

test("RpcProcess times out commands with RpcCommandTimeoutError and ignores late responses", async () => {
  const transport = makeTransport();
  transport.onCommand = (command) => {
    if (command.type === "negotiate_protocol") {
      transport.send({ type: "response", id: command.id, command: command.type, success: true, data: { protocolVersion: 2 } });
    }
  };
  const proc = startProcess(transport);
  const ready = await proc.waitReady();
  await proc.negotiateProtocol(ready);

  const frameEvents = [];
  proc.onFrame((frame) => frameEvents.push(frame));

  const keepAlive = setInterval(() => {}, 10);
  try {
    const pending = proc.sendCommand({ type: "slow_command" }, 20);
    await assert.rejects(
      pending,
      (err) => {
        assert.ok(err instanceof RpcCommandTimeoutError || err.name === "RpcCommandTimeoutError");
        assert.equal(err.command, "slow_command");
        assert.equal(err.timeoutMs, 20);
        return true;
      },
    );
  } finally {
    clearInterval(keepAlive);
  }
  // Verify late response is routed to frame listener and does not re-settle or throw
  const slowCommand = transport.commands.find((c) => c.type === "slow_command");
  assert.ok(slowCommand);
  transport.send({ type: "response", id: slowCommand.id, command: "slow_command", success: true, data: "late" });
  await new Promise((resolve) => setImmediate(resolve));

  assert.ok(frameEvents.some((f) => f.type === "response" && f.command === "slow_command"));
  await proc.dispose(0);
});

for (const type of ["remove_queued_message", "promote_queued_message"]) {
  test(`${type} times out without replaying, misrouting late ACKs, or interrupting long commands`, async (t) => {
    const transport = makeTransport();
    const proc = startProcess(transport);
    await proc.waitReady();
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const wrapper = new AgentSessionWrapper(proc, process.cwd());
    wrapper.start();

    try {
      let loginSettled = false;
      const login = wrapper.send({ type: "login", provider: "test" });
      void login.then(() => { loginSettled = true; }, () => { loginSettled = true; });
      let mutationError;
      const mutation = wrapper.send({ type, messageId: "queued-first" });
      void mutation.catch((error) => { mutationError = error; });
      await new Promise((resolve) => setImmediate(resolve));
      const first = transport.commands.find((command) => command.type === type);
      assert.ok(first, "the child accepted the queue mutation but withheld its ACK");

      t.mock.timers.tick(5_000);
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(mutationError?.name, "RpcCommandTimeoutError", "a hung queue mutation must reject within five seconds");
      assert.equal(mutationError.command, type);
      assert.equal(wrapper.isAlive(), true, "queue timeout must not kill unrelated work");
      assert.equal(loginSettled, false);

      let nextSettled = false;
      const next = wrapper.send({ type, messageId: "queued-next" });
      void next.then(() => { nextSettled = true; }, () => { nextSettled = true; });
      await new Promise((resolve) => setImmediate(resolve));
      const mutations = transport.commands.filter((command) => command.type === type);
      assert.equal(mutations.length, 2, "the timed-out mutation must not be automatically replayed");
      const second = mutations[1];
      transport.send({ type: "response", id: first.id, command: type, success: true, data: { messageId: "queued-first" } });
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(nextSettled, false, "a late ACK must not settle a subsequent queue mutation");

      transport.send({ type: "response", id: second.id, command: type, success: true, data: { messageId: "queued-next" } });
      assert.deepEqual(await next, { messageId: "queued-next" });
      t.mock.timers.tick(60_000);
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(loginSettled, false, "long unrelated commands retain their unlimited transport wait");
      const loginCommand = transport.commands.find((command) => command.type === "login");
      transport.send({ type: "response", id: loginCommand.id, command: "login", success: true, data: { loggedIn: true } });
      assert.deepEqual(await login, { loggedIn: true });
    } finally {
      await wrapper.destroyAndWait();
    }
  });
}

test('dialog resolutions wait for the real RpcProcess pipe callback and failed writes stay pending', async(t) => {
  const transport = makeTransport();
  const proc = startProcess(transport);
  await proc.waitReady();
  const previous = globalThis.__ompAgentBell;
  const resolutions = [];
  let gaps = 0;
  globalThis.__ompAgentBell = { adapter: { frame() {}, discard() {}, uncertain() { gaps++; }, respond(...args) { resolutions.push(args); } }, runtime: { client: { markGap() {} } } };
  const wrapper = new AgentSessionWrapper(proc, process.cwd(), null, false, 'write-confirmation', 0);
  wrapper.start();
  t.after(async()=>{await wrapper.destroyAndWait();globalThis.__ompAgentBell=previous;});
  transport.send({type:'extension_ui_request',id:'q',method:'input'});
  let callback;
  transport.child.stdin.write = (_line, done) => { callback = done; return true; };
  const sending = wrapper.send({type:'extension_ui_response',id:'q',value:'yes'});
  await new Promise(r=>setImmediate(r));
  assert.equal(resolutions.length,0,'enqueueing a write is not a successful send');
  callback(null);
  await sending;
  assert.equal(resolutions.length,1);
  transport.send({type:'extension_ui_request',id:'failed',method:'input'});
  const failing = wrapper.send({type:'extension_ui_response',id:'failed',value:'yes'});
  const rejected = assert.rejects(failing,/broken pipe/);
  await new Promise(r=>setImmediate(r));
  callback(new Error('broken pipe'));
  await rejected;
  assert.equal(gaps,1);
  assert.equal(resolutions.length,1);
  const replay=[];const detach=wrapper.onEvent(e=>replay.push(e));detach();
  assert.ok(replay.some(e=>e.id==='failed'));
});
