import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { repositoryRoot, resolveElectronBinary } from "../../../scripts/e2e/boot.mjs";

const root = repositoryRoot();
const { build } = createRequire(join(root, "packages/agent-runtime/package.json"))("esbuild");
const fixture = String.raw`
import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { IPC } from "@pi-desktop/shared";
import { useSessionTiming } from "../../apps/desktop/src/features/chat/context-usage/useSessionTiming";

const epoch = Date.parse("2026-10-31T00:00:00.000Z");
const at = (ms) => new Date(epoch + ms).toISOString();
let now = epoch + 10000;
Date.now = () => now;
const clocks = new Map();
let clockId = 0;
window.setInterval = (callback, delay) => {
  if (delay !== 1000) throw new Error("Unexpected fixture interval");
  clocks.set(++clockId, callback);
  return clockId;
};
window.clearInterval = (id) => clocks.delete(id);
let completedRowReads = 0;
const completed = Array.from({ length: 256 }, (_, n) => Object.freeze({
  id: "a-" + n, role: "assistant", status: "complete", content: "done", createdAt: at(1000),
  providerWaitMs: 2,
  get responseDurationMs() { completedRowReads += 1; return 5; },
}));
const completedTool = { id: "tool", role: "tool", status: "complete", toolStatus: "done", content: "done",
  createdAt: at(2000), toolDurationMs: 1000 };
const historyRequests = [];
let historyResponseMs = 100;
let releaseB;
const heldB = new Promise((resolve) => { releaseB = resolve; });
window.piDesktop = { platform: "win32", on() { return () => {}; },
  async invoke(channel, input) {
    if (channel !== IPC.invoke.sessionGet) throw new Error("Unexpected timing IPC");
    historyRequests.push(input);
    if (input.id === "timing-b") await heldB;
    return { ok: true, data: { session: { messageStart: 0, hasMoreBefore: false, messages: [
      { role: "assistant", status: "complete", createdAt: at(0), responseDurationMs: input.id === "timing-b" ? 999999 : historyResponseMs, providerWaitMs: 50 },
      { role: "tool", status: "complete", toolStatus: "done", createdAt: at(500), toolDurationMs: 200 },
    ] } } };
  },
};
let input = { sessionId: "timing-a", session: { createdAt: at(0), updatedAt: at(10000) },
  messages: [...completed, completedTool], history: { messageStart: 2, hasMoreBefore: true }, isRunning: false };
let view;
function Surface({ input }) {
  const [open, setOpen] = React.useState(false);
  view = useSessionTiming({ ...input, enabled: open });
  return React.createElement(React.Fragment, null,
    React.createElement("button", { id: "toggle", onClick: () => setOpen(!open) }, open ? "Close timing" : "Open timing"),
    React.createElement("output", null, JSON.stringify(view)));
}
const rootNode = createRoot(document.getElementById("root"));
const render = () => flushSync(() => rootNode.render(React.createElement(Surface, { input: { ...input } })));
const frame = () => new Promise(requestAnimationFrame);
async function settle() { await frame(); await frame(); }
const failures = [];
function check(condition, message) { if (!condition) failures.push(message); }
async function until(predicate, message) {
  for (let n = 0; n < 180; n += 1) { if (predicate()) return; await frame(); }
  throw new Error(message);
}
async function toggle() { flushSync(() => document.getElementById("toggle").click()); await settle(); }
window.sessionTimingProbe = async () => {
  try {
    render(); await settle();
    check(clocks.size === 0 && historyRequests.length === 0 && completedRowReads === 0, "closed inspector performed timing work");
    await toggle(); await until(() => view.historyStatus === "ready", "initial history did not load");
    check(view.timing.modelResponseMs === 1380 && view.breakdown.toolCallMs === 1200, "idle timing totals changed");
    check(clocks.size === 0, "idle inspector keeps a one-second clock");
    const idleReads = completedRowReads;
    render(); await settle();
    check(completedRowReads === idleReads, "unrelated render rescans immutable completed messages");
    check(historyRequests.length === 1, "stable history was fetched again");

    input = { ...input, isRunning: true, messages: [...completed, completedTool,
      { id: "live-assistant", role: "assistant", status: "streaming", content: "partial", createdAt: at(9000) },
      { id: "live-tool", role: "tool", status: "streaming", toolStatus: "running", content: "running", createdAt: at(9000) },
    ] };
    render(); await settle();
    check(clocks.size === 1, "running inspector must own exactly one clock");
    check(completedRowReads === idleReads, "starting a turn rescans unchanged completed messages");
    const runningReads = completedRowReads;
    now = epoch + 11000;
    flushSync(() => { for (const callback of clocks.values()) callback(); });
    await settle();
    check(view.timing.elapsedMs === 11000 && view.timing.modelResponseMs === 3380 && view.breakdown.toolCallMs === 3200,
      "live model or overlapping tool timing stopped advancing");
    check(completedRowReads === runningReads, "clock tick rescans completed historical messages");
    input = { ...input, messages: input.messages.map((message) => message.id === "live-assistant"
      ? { ...message, content: "another streaming chunk" } : message) };
    render(); await settle();
    check(completedRowReads === runningReads, "streaming chunks rescan unchanged completed messages");

    historyResponseMs = 200;
    input = { ...input, session: { ...input.session, updatedAt: at(12000) },
      messages: [{ ...completed[0], responseDurationMs: 25 }, ...input.messages.slice(1)] };
    render(); await until(() => view.historyStatus === "ready" && historyRequests.length === 2, "historical edit did not invalidate the cache");
    check(view.timing.modelResponseMs === 3500, "historical edit left stale timing totals");
    await toggle();
    const closedReads = completedRowReads;
    input = { ...input, messages: [...input.messages] };
    render(); await settle();
    check(clocks.size === 0 && completedRowReads === closedReads, "closing a running inspector did not suspend work");
    await toggle(); await until(() => view.historyStatus === "ready", "cached history did not reopen");
    check(historyRequests.length === 2 && clocks.size === 1, "reopening duplicated history loads or clocks");
    input = { ...input, isRunning: false, messages: input.messages.map((message) => {
      if (message.id === "live-assistant") return { ...message, status: "complete", responseDurationMs: 2000 };
      if (message.id === "live-tool") return { ...message, status: "complete", toolStatus: "done", toolDurationMs: 2000 };
      return message;
    }) };
    render(); await settle();
    check(clocks.size === 0 && view.timing.modelResponseMs === 3500 && view.breakdown.toolCallMs === 3200,
      "completed turn kept a clock or lost finalized timing");

    input = { ...input, sessionId: "timing-b" }; render();
    await until(() => historyRequests.some((request) => request.id === "timing-b"), "held session did not request history");
    input = { ...input, sessionId: "timing-c" }; render();
    await until(() => view.historyStatus === "ready" && historyRequests.some((request) => request.id === "timing-c"), "replacement session did not load");
    const current = JSON.stringify(view);
    releaseB(); await settle();
    check(JSON.stringify(view) === current, "late historical load overwrote another session");
    flushSync(() => rootNode.unmount());
    check(clocks.size === 0, "unmount leaked a timing clock");
    if (failures.length) throw new Error(failures.join("; "));
    return { passed: true, completedRows: completed.length, historyRequests: historyRequests.length };
  } finally {
    releaseB();
    flushSync(() => rootNode.unmount());
  }
};
`;

test("timing inspector suspends idle/closed work, reuses immutable totals, and invalidates changed history", {
  skip: process.platform === "linux" && !process.env.DISPLAY ? "Electron requires a display" : false,
}, async () => {
  const temp = await mkdtemp(join(process.env.PI_SCRATCH_DIR || tmpdir(), "pi-session-timing-ui-"));
  let child;
  try {
    await build({
      stdin: { contents: fixture, resolveDir: join(root, "scripts/e2e"), loader: "tsx" },
      outfile: join(temp, "renderer.js"), bundle: true, platform: "browser", format: "esm", jsx: "automatic",
      define: { "process.env.NODE_ENV": '"production"' },
      alias: {
        "@pi-desktop/i18n": join(root, "packages/i18n/src"),
        "@pi-desktop/shared": join(root, "packages/shared/src"),
        react: join(root, "apps/desktop/node_modules/react"),
        "react-dom": join(root, "apps/desktop/node_modules/react-dom"),
      },
      nodePaths: [join(root, "apps/desktop/node_modules")],
    });
    await writeFile(join(temp, "index.html"), '<!doctype html><meta charset="utf-8"><div id="root"></div><script type="module" src="renderer.js"></script>');
    await writeFile(join(temp, "main.cjs"), `
const { app, BrowserWindow } = require("electron");
const path = require("node:path");
app.setPath("userData", path.join(__dirname, "profile"));
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  win.webContents.session.webRequest.onBeforeRequest((details, done) => done({ cancel: !details.url.startsWith("file:") }));
  try {
    await win.loadFile(path.join(__dirname, "index.html"));
    console.log("SESSION_TIMING_PROBE " + JSON.stringify(await win.webContents.executeJavaScript("window.sessionTimingProbe()")));
    app.exit(0);
  } catch (error) { console.error(error?.stack ?? error); app.exit(1); }
});`);
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    child = spawn(resolveElectronBinary(root).electronBinary, [join(temp, "main.cjs")], { env, stdio: ["ignore", "pipe", "pipe"] });
    const exited = new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
    const kill = () => {
      if (!child.pid || child.exitCode !== null) return;
      if (process.platform === "win32") spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, timeout: 10000, stdio: "ignore" });
      else child.kill("SIGKILL");
    };
    let output = "";
    let overflow = false;
    for (const stream of [child.stdout, child.stderr]) {
      stream.setEncoding("utf8");
      stream.on("data", (chunk) => {
        if (output.length + chunk.length > 2 * 1024 * 1024) { overflow = true; kill(); }
        else output += chunk;
      });
    }
    const timer = setTimeout(kill, 60000);
    let code;
    try { code = await exited; } finally { clearTimeout(timer); kill(); }
    assert.equal(overflow, false, "Timing fixture output exceeded its budget");
    assert.equal(code, 0, output.slice(-6000));
    const lines = output.split(/\r?\n/).filter((line) => line.startsWith("SESSION_TIMING_PROBE "));
    assert.equal(lines.length, 1, output.slice(-6000));
    assert.deepEqual(JSON.parse(lines[0].slice("SESSION_TIMING_PROBE ".length)), { passed: true, completedRows: 256, historyRequests: 4 });
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
