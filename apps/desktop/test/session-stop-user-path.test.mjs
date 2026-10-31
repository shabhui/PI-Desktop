import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const require = createRequire(join(root, "packages/agent-runtime/package.json"));
const { build } = require("esbuild");
const temp = await mkdtemp(join(process.env.PI_SCRATCH_DIR || tmpdir(), "session-stop-user-path-"));
const output = join(temp, "fixture.mjs");
await build({
  stdin: {
    contents: `export { useAppStore } from './apps/desktop/src/stores/app-store';
      export { IPC } from '@pi-desktop/shared';`,
    resolveDir: root,
    loader: "ts",
  },
  outfile: output,
  bundle: true,
  platform: "node",
  format: "esm",
  alias: {
    "@pi-desktop/shared": join(root, "packages/shared/src/index.ts"),
    "@pi-desktop/i18n": join(root, "packages/i18n/src/index.ts"),
  },
  loader: { ".css": "empty", ".gif": "dataurl", ".png": "dataurl" },
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
});
const storage = new Map();
globalThis.localStorage = {
  getItem: (key) => storage.get(key) ?? null,
  setItem: (key, value) => storage.set(key, String(value)),
  removeItem: (key) => storage.delete(key),
};
test.after(() => { delete globalThis.localStorage; delete globalThis.window; });
const { useAppStore: store, IPC } = await import(pathToFileURL(output).href);
test.after(() => rm(temp, { recursive: true, force: true }));

const timestamp = "2026-10-31T00:00:00.000Z";
let sequence = 0;
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function row(id, role, status = "complete") {
  return { id, role, content: id, status, createdAt: timestamp };
}
function harness({ source = "desktop", canStop = true } = {}) {
  const id = `${source === "remote" ? "remote:fixture:" : ""}stop-${++sequence}`;
  const session = {
    id, source, title: "Stop fixture", createdAt: timestamp, updatedAt: timestamp,
    mode: "agent", permissionMode: "ask", thinkingLevel: "inherit", messageCount: 0,
    ...(source === "remote" ? { capabilities: { canPrompt: true, canStop, canRefresh: true } } : {}),
  };
  store.setState({
    ...store.getInitialState(),
    sessions: [session], activeSessionId: id, page: "chat", messages: [],
    retainedSessionIds: [id], retainedTranscripts: {}, sessionHistory: {},
    runningSessions: {}, agentStatuses: {}, pendingPermissions: {}, pendingAsks: {},
    pendingPlans: {}, planningStates: {}, latestTurnResults: {}, sessionOutcomes: {},
  });
  const handlers = new Map();
  const calls = [];
  globalThis.window = {
    matchMedia: () => ({ matches: false }),
    piDesktop: {
      platform: process.platform,
      on: () => () => {},
      invoke: async (channel, input) => {
        calls.push({ channel, input });
        const handler = handlers.get(channel);
        const data = handler ? await handler(input) : channel === IPC.invoke.sessionGet
          ? { session: { ...session, messages: store.getState().messages } }
          : channel === IPC.invoke.sessionList ? { sessions: [session] }
          : channel === IPC.invoke.agentQueueList ? { entries: [] }
          : { ok: true };
        return { ok: true, data };
      },
    },
  };
  const h = {
    id, session, handlers, calls,
    state: () => store.getState(),
    count: (channel) => calls.filter((call) => call.channel === channel).length,
    event: (event, turnId) => store.getState().handleAgentEvent({ sessionId: id, turnId, ts: 1000 + sequence, event }),
    async send(text, { reply = true, turnId = `${id}:${text}`, publishStatus = true, draft = { text, fileReferences: [] } } = {}) {
      assert.equal(await store.getState().sendPrompt(text, draft, id), true);
      if (publishStatus) h.event({ type: "status", status: { sessionId: id, isRunning: true, pendingToolConfirmations: 0, currentTurnId: turnId } }, turnId);
      if (reply) h.event({ type: "message_start", message: row(`${turnId}:assistant`, "assistant", "streaming") }, turnId);
      return turnId;
    },
    stop: () => store.getState().abort(),
    stopSession: () => store.getState().abortSession(id),
  };
  return h;
}

for (const action of ["stop", "stopSession"]) {
  test(`${action}: a rejected cancellation stays running and a second attempt can succeed`, async () => {
    const h = harness();
    await h.send("first");
    const before = h.state().messages;
    h.handlers.set(IPC.invoke.agentAbort, () => { throw Object.assign(new Error("Cancellation transport failed"), { code: "IPC_FAILED" }); });
    await h[action]().catch(() => {});
    assert.equal(h.state().isRunning, true, "a failed RPC is not evidence that the backend stopped");
    assert.equal(h.state().runningSessions[h.id], true);
    assert.deepEqual(h.state().messages, before);
    if (action === "stop") assert.match(h.state().error ?? "", /Cancellation transport failed/);
    h.handlers.set(IPC.invoke.agentAbort, () => ({ ok: true }));
    await h[action]();
    assert.equal(h.count(IPC.invoke.agentAbort), 2);
    assert.equal(h.state().isRunning, false);
  });

  test(`${action}: repeated clicks share cancellation and do not settle before its acknowledgement`, async () => {
    const h = harness();
    const turnId = await h.send("first");
    const request = deferred();
    const entered = deferred();
    h.handlers.set(IPC.invoke.agentAbort, () => { entered.resolve(); return request.promise; });
    const first = h[action]();
    await entered.promise;
    const second = h[action]();
    const countWhilePending = h.count(IPC.invoke.agentAbort);
    const runningWhilePending = h.state().isRunning;
    request.resolve({ ok: true });
    await Promise.all([first, second]);
    assert.equal(runningWhilePending, true);
    assert.equal(countWhilePending, 1, "one in-flight stop owns this turn");
    assert.deepEqual(h.calls.find((call) => call.channel === IPC.invoke.agentAbort).input, { sessionId: h.id, turnId });
    assert.equal(h.state().isRunning, false);
  });

  test(`${action}: a turn mismatch acknowledgement cannot falsely stop the current turn`, async () => {
    const h = harness();
    await h.send("first");
    const before = h.state().messages;
    h.handlers.set(IPC.invoke.agentAbort, () => ({ ok: false, aborted: false }));
    await h[action]();
    assert.equal(h.state().runningSessions[h.id], true);
    assert.deepEqual(h.state().messages, before);
  });
}

for (const completed of [false, true]) {
  test(`a late stop preserves a newer ${completed ? "completed" : "running"} turn and its permissions and composer`, async () => {
    const h = harness();
    const oldTurn = await h.send("old");
    const request = deferred();
    const entered = deferred();
    h.handlers.set(IPC.invoke.agentAbort, () => { entered.resolve(); return request.promise; });
    const stop = h.stop();
    await entered.promise;
    h.event({ type: "agent_end" }, oldTurn);
    const newTurn = await h.send("new");
    if (completed) {
      h.event({ type: "message_end", message: row(`${newTurn}:assistant`, "assistant") }, newTurn);
      h.event({ type: "agent_end" }, newTurn);
    }
    const permission = { sessionId: h.id, requestId: "new-permission", toolName: "Bash", reason: "New turn permission" };
    const draft = { sessionId: h.id, text: "next draft", fileReferences: [] };
    store.setState({ pendingPermissions: { [h.id]: [permission] }, composerPrefill: draft });
    const before = h.state();
    request.resolve({ ok: true });
    await stop;
    assert.equal(h.state().runningSessions[h.id], !completed);
    assert.deepEqual(h.state().messages, before.messages);
    assert.deepEqual(h.state().pendingPermissions, before.pendingPermissions);
    assert.equal(h.state().composerPrefill, draft);
    assert.deepEqual(h.state().latestTurnResults, before.latestTurnResults);
  });
}

test("stopping a background session does not release another active session", async () => {
  const h = harness();
  await h.send("old");
  const request = deferred();
  const entered = deferred();
  h.handlers.set(IPC.invoke.agentAbort, () => { entered.resolve(); return request.promise; });
  const stop = h.stop();
  await entered.promise;
  const other = { ...h.session, id: `${h.id}:other` };
  const messages = [row("other-user", "user"), row("other-assistant", "assistant", "streaming")];
  store.setState({ sessions: [h.session, other], activeSessionId: other.id, messages, isRunning: true,
    runningSessions: { [h.id]: true, [other.id]: true } });
  request.resolve({ ok: true });
  await stop;
  assert.equal(h.state().isRunning, true);
  assert.equal(h.state().runningSessions[other.id], true);
  assert.equal(h.state().runningSessions[h.id], false);
  assert.deepEqual(h.state().messages, messages);
});

test("an unanswered send is retracted once only after cancellation settles, restoring its structured draft", async () => {
  const h = harness();
  const draft = { text: "inspect these", fileReferences: [
    { path: join(temp, "fixture.ts"), name: "fixture.ts", kind: "file" },
    { path: join(temp, "fixture.png"), name: "fixture.png", kind: "image", mimeType: "image/png" },
  ] };
  const expected = structuredClone(draft);
  await h.send("serialized references", { reply: false, draft });
  draft.fileReferences[0].name = "edited after submission";
  const request = deferred();
  const entered = deferred();
  h.handlers.set(IPC.invoke.agentAbort, () => { entered.resolve(); return request.promise; });
  h.handlers.set(IPC.invoke.sessionRetractPendingPrompt, () => ({ ok: true, retracted: true }));
  const first = h.stop();
  await entered.promise;
  const second = h.stop();
  const mutationsBeforeSettlement = h.count(IPC.invoke.sessionRetractPendingPrompt);
  request.resolve({ ok: true });
  await Promise.all([first, second]);
  assert.equal(mutationsBeforeSettlement, 0);
  assert.equal(h.count(IPC.invoke.agentAbort), 1);
  assert.equal(h.count(IPC.invoke.sessionRetractPendingPrompt), 1);
  assert.deepEqual(h.state().composerPrefill, { ...expected, sessionId: h.id });
  assert.deepEqual(h.state().messages, []);
});

test("a newer completed turn during smart-stop reload cannot resurrect the old submitted draft", async () => {
  const h = harness();
  const oldTurn = await h.send("old", { reply: false });
  const oldMessages = h.state().messages;
  const detail = deferred();
  const entered = deferred();
  h.handlers.set(IPC.invoke.sessionGet, () => { entered.resolve(); return detail.promise; });
  const stop = h.stop();
  await entered.promise;
  h.event({ type: "agent_end" }, oldTurn);
  const newTurn = await h.send("new", { reply: false });
  h.event({ type: "agent_end" }, newTurn);
  const draft = { sessionId: h.id, text: "new next draft", fileReferences: [] };
  store.setState({ composerPrefill: draft });
  const messages = h.state().messages;
  detail.resolve({ session: { ...h.session, messages: oldMessages } });
  await stop;
  assert.equal(h.count(IPC.invoke.sessionRetractPendingPrompt), 0);
  assert.deepEqual(h.state().messages, messages);
  assert.deepEqual(h.state().retainedTranscripts[h.id], messages);
  assert.equal(h.state().composerPrefill, draft);
  assert.equal(h.state().error, null);
});

for (const source of ["pi-native", "remote"]) {
  test(`${source}: late post-stop detail cannot overwrite a newer turn`, async () => {
    const h = harness({ source });
    const oldTurn = await h.send("old");
    const oldMessages = h.state().messages;
    const detail = deferred();
    const entered = deferred();
    h.handlers.set(IPC.invoke.sessionGet, () => { entered.resolve(); return detail.promise; });
    const stop = h.stop();
    await entered.promise;
    h.event({ type: "agent_end" }, oldTurn);
    const newTurn = await h.send("new");
    const messages = h.state().messages;
    detail.resolve({ session: { ...h.session, messages: oldMessages } });
    await stop;
    assert.equal(h.state().runningSessions[h.id], true);
    assert.equal(h.state().agentStatuses[h.id].currentTurnId, newTurn);
    assert.deepEqual(h.state().messages, messages);
    assert.deepEqual(h.state().retainedTranscripts[h.id], messages);
  });
}

test("remote stop capability remains fail-closed through both entry points", async () => {
  const h = harness({ source: "remote", canStop: false });
  store.setState({ isRunning: true, runningSessions: { [h.id]: true } });
  await h.stop();
  await h.stopSession();
  assert.equal(h.count(IPC.invoke.agentAbort), 0);
  assert.equal(h.state().isRunning, true);
});

for (const [firstAction, secondAction] of [["stop", "stopSession"], ["stopSession", "stop"]]) {
  test(`${firstAction} and ${secondAction} share the same pending backend cancellation`, async () => {
    const h = harness();
    await h.send("first");
    const request = deferred();
    const entered = deferred();
    h.handlers.set(IPC.invoke.agentAbort, () => { entered.resolve(); return request.promise; });
    const first = h[firstAction]();
    await entered.promise;
    const second = h[secondAction]();
    assert.equal(h.state().isRunning, true);
    request.resolve({ ok: true });
    await Promise.all([first, second]);
    assert.equal(h.count(IPC.invoke.agentAbort), 1);
    assert.equal(h.state().isRunning, false);
  });
}

test("Stop during admission accepts the first status without dispatching a second cancellation", async () => {
  const h = harness();
  const turnId = await h.send("admitting", { publishStatus: false });
  const request = deferred();
  const entered = deferred();
  h.handlers.set(IPC.invoke.agentAbort, () => { entered.resolve(); return request.promise; });
  const first = h.stop();
  await entered.promise;
  h.event({ type: "status", status: { sessionId: h.id, isRunning: true, currentTurnId: turnId } }, turnId);
  const second = h.stop();
  request.resolve({ ok: true });
  await Promise.all([first, second]);
  assert.equal(h.count(IPC.invoke.agentAbort), 1);
  assert.deepEqual(h.calls.find((call) => call.channel === IPC.invoke.agentAbort).input, { sessionId: h.id });
  assert.equal(h.state().isRunning, false);
});

for (const source of ["desktop", "pi-native", "remote"]) {
  test(`${source}: a detail reload failure after acknowledged cancellation preserves history but releases running state`, async () => {
    const h = harness({ source });
    await h.send("unanswered", { reply: false });
    const before = h.state().messages;
    h.handlers.set(IPC.invoke.sessionGet, () => { throw new Error("Stopped history unavailable"); });
    await h.stop();
    assert.equal(h.count(IPC.invoke.agentAbort), 1);
    assert.equal(h.state().runningSessions[h.id], false, "reload failure cannot undo acknowledged cancellation");
    assert.equal(h.state().isRunning, false);
    assert.deepEqual(h.state().messages, before);
    assert.equal(h.state().composerPrefill, null);
    assert.match(h.state().error ?? "", /Stopped history unavailable/);
    assert.equal(h.count(IPC.invoke.sessionRetractPendingPrompt), 0);
  });
}

test("remote aborted:false is not an acknowledgement of cancellation", async () => {
  const h = harness({ source: "remote" });
  await h.send("running");
  const before = h.state().messages;
  h.handlers.set(IPC.invoke.agentAbort, () => ({ aborted: false }));
  await h.stop();
  assert.equal(h.state().isRunning, true);
  assert.deepEqual(h.state().messages, before);
  assert.equal(h.count(IPC.invoke.sessionGet), 0);
});

test("Stop waits for captured permission denials and never removes a later request", async () => {
  const h = harness();
  await h.send("permission");
  const oldPermission = { sessionId: h.id, requestId: "old-permission", toolName: "Bash", reason: "Old request" };
  const nextPermission = { ...oldPermission, requestId: "next-permission" };
  store.setState({ pendingPermissions: { [h.id]: [oldPermission] } });
  const abort = deferred();
  const denied = deferred();
  const entered = deferred();
  const acknowledged = deferred();
  h.handlers.set(IPC.invoke.agentAbort, async () => { await abort.promise; acknowledged.resolve(); return { ok: true }; });
  h.handlers.set(IPC.invoke.toolResolvePermission, () => { entered.resolve(); return denied.promise; });
  const stop = h.stop();
  await entered.promise;
  store.setState({ pendingPermissions: { [h.id]: [oldPermission, nextPermission] } });
  abort.resolve();
  await acknowledged.promise;
  assert.equal(h.state().isRunning, true);
  assert.deepEqual(h.state().pendingPermissions[h.id], [oldPermission, nextPermission]);
  denied.resolve({ ok: true });
  await stop;
  assert.deepEqual(h.state().pendingPermissions[h.id], [nextPermission]);
  assert.equal(h.state().isRunning, false);
  assert.deepEqual(h.calls.filter((call) => call.channel === IPC.invoke.toolResolvePermission).map((call) => call.input), [
    { requestId: oldPermission.requestId, decision: "deny" },
  ]);
});

test("abortSession propagates cancellation failure to destructive callers", async () => {
  const h = harness();
  await h.send("running");
  h.handlers.set(IPC.invoke.agentAbort, () => { throw new Error("Cancellation refused"); });
  await assert.rejects(h.stopSession(), /Cancellation refused/);
  assert.equal(h.state().runningSessions[h.id], true);
});

test("late successful retraction cannot overwrite a newer completed turn or its draft", async () => {
  const h = harness();
  const oldTurn = await h.send("old", { reply: false });
  const retracted = deferred();
  const entered = deferred();
  h.handlers.set(IPC.invoke.sessionRetractPendingPrompt, () => { entered.resolve(); return retracted.promise; });
  const stop = h.stop();
  await entered.promise;
  h.event({ type: "agent_end" }, oldTurn);
  const newTurn = await h.send("new");
  h.event({ type: "message_end", message: row(`${newTurn}:assistant`, "assistant") }, newTurn);
  h.event({ type: "agent_end" }, newTurn);
  const draft = { sessionId: h.id, text: "next", fileReferences: [] };
  store.setState({ composerPrefill: draft });
  const before = h.state();
  retracted.resolve({ ok: true, retracted: true });
  await stop;
  assert.deepEqual(h.state().messages, before.messages);
  assert.deepEqual(h.state().retainedTranscripts[h.id], before.messages);
  assert.equal(h.state().composerPrefill, draft);
  assert.deepEqual(h.state().latestTurnResults, before.latestTurnResults);
});

test("retraction after a pane switch updates only the stopped session's retained transcript and scoped draft", async () => {
  const h = harness();
  await h.send("unanswered", { reply: false });
  const retracted = deferred();
  const entered = deferred();
  h.handlers.set(IPC.invoke.sessionRetractPendingPrompt, () => { entered.resolve(); return retracted.promise; });
  const stop = h.stop();
  await entered.promise;
  const other = { ...h.session, id: `${h.id}:other` };
  const messages = [row("other-user", "user"), row("other-assistant", "assistant", "streaming")];
  store.setState({ sessions: [h.session, other], activeSessionId: other.id, messages, isRunning: true,
    runningSessions: { ...h.state().runningSessions, [other.id]: true } });
  retracted.resolve({ ok: true, retracted: true });
  await stop;
  assert.deepEqual(h.state().retainedTranscripts[h.id], []);
  assert.deepEqual(h.state().messages, messages);
  assert.equal(h.state().isRunning, true);
  assert.equal(h.state().runningSessions[h.id], false);
  assert.equal(h.state().composerPrefill?.sessionId, h.id);
  assert.equal(h.state().composerPrefill?.text, "unanswered");
});

for (const switchesPane of [false, true]) {
  test(`failed retraction after acknowledged Stop ${switchesPane ? "in a background pane" : "in the active pane"} preserves history and releases only its turn`, async () => {
    const h = harness();
    await h.send("unanswered", { reply: false });
    const original = h.state().messages;
    const retracted = deferred();
    const entered = deferred();
    h.handlers.set(IPC.invoke.sessionRetractPendingPrompt, () => { entered.resolve(); return retracted.promise; });
    const stop = h.stop();
    await entered.promise;
    const other = { ...h.session, id: `${h.id}:other` };
    const visible = switchesPane ? [row("other-user", "user"), row("other-assistant", "assistant", "streaming")] : original;
    if (switchesPane) {
      store.setState({ sessions: [h.session, other], activeSessionId: other.id, messages: visible, isRunning: true,
        runningSessions: { ...h.state().runningSessions, [other.id]: true } });
    }
    retracted.reject(Object.assign(new Error("Retraction unavailable"), { code: "RETRACT_FAILED" }));
    await stop;
    assert.equal(h.state().runningSessions[h.id], false, "accepted cancellation settles even if retraction fails after navigation");
    assert.equal(h.state().isRunning, switchesPane);
    assert.deepEqual(h.state().messages, visible);
    assert.deepEqual(h.state().retainedTranscripts[h.id], original);
    assert.equal(h.state().composerPrefill, null, "failed retraction must not remove or restore the pending prompt");
    if (switchesPane) {
      assert.equal(h.state().error, null, "background errors cannot appear on another session");
      assert.equal(h.state().errorCode, null);
      assert.equal(h.state().runningSessions[other.id], true);
    } else {
      assert.match(h.state().error ?? "", /Retraction unavailable/);
      assert.equal(h.state().errorCode, "RETRACT_FAILED");
    }
    store.setState({ activeSessionId: h.id, messages: original, isRunning: false });
    assert.equal(await h.state().sendPrompt("follow-up", { text: "follow-up", fileReferences: [] }, h.id), true);
    assert.equal(h.count(IPC.invoke.agentPrompt), 2, "the next prompt starts instead of being silently queued");
  });
}
