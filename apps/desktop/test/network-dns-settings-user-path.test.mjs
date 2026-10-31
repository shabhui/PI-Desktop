import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { repositoryRoot, resolveElectronBinary } from "../../../scripts/e2e/boot.mjs";

const root = repositoryRoot();
const { build } = createRequire(join(root, "packages/agent-runtime/package.json"))("esbuild");
const rendererSource = String.raw`
import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { catalogs, flattenCatalog } from "@pi-desktop/i18n";
import { NetworkProxySection } from "../../apps/desktop/src/components/settings/NetworkProxySection";
import { useAppStore } from "../../apps/desktop/src/stores/app-store";
import { api } from "../../apps/desktop/src/lib/api";

let stored = {
  defaultMode: "agent", theme: "light", language: "en", enterToSend: true,
  networkProxy: { mode: "custom", url: "http://127.0.0.1:7890", bypass: "localhost" },
};
const originalProxy = JSON.stringify(stored.networkProxy);
const writes = [];
const toasts = [];
let failNextWrite = false;
let heldWrite;
let releaseWrite;
window.piDesktop = {
  platform: "win32", on() { return () => {}; },
  async invoke(channel, value) {
    if (channel === "pi-desktop/settings/get") return { ok: true, data: structuredClone(stored) };
    if (channel !== "pi-desktop/settings/set") throw new Error("Unexpected fixture IPC: " + channel);
    writes.push(structuredClone(value));
    if (failNextWrite) { failNextWrite = false; return { ok: false, error: { code: "INTERNAL_ERROR", message: "fixture write failed" } }; }
    if (heldWrite) { const pending = heldWrite; heldWrite = undefined; await pending; }
    stored = { ...stored, ...structuredClone(value) };
    return { ok: true, data: structuredClone(stored) };
  },
};
await i18n.use(initReactI18next).init({
  lng: "en", fallbackLng: "en", keySeparator: false,
  resources: { en: { translation: flattenCatalog(catalogs.en) } },
  interpolation: { escapeValue: false },
});
useAppStore.setState({ settings: await api.getSettings(), showToast: (message) => toasts.push(message) });
let remount;
function Harness() {
  const settings = useAppStore((state) => state.settings);
  const [generation, setGeneration] = React.useState(0);
  remount = () => setGeneration((value) => value + 1);
  return React.createElement(NetworkProxySection, {
    key: generation, settings,
    saveSettings: async (patch) => {
      await api.setSettings({ ...useAppStore.getState().settings, ...patch });
      useAppStore.setState({ settings: await api.getSettings() });
    },
  });
}
flushSync(() => createRoot(document.getElementById("root")).render(React.createElement(Harness)));
const frame = () => new Promise(requestAnimationFrame);
async function waitFor(predicate, message) {
  for (let attempt = 0; attempt < 180; attempt += 1) {
    if (predicate()) return;
    await frame();
  }
  throw new Error(message);
}
const control = (key) => document.querySelector('[aria-label="' + i18n.t(key) + '"]');
const toggle = () => control("settings.dns");
const endpoint = () => control("settings.dnsServer");
const fallback = () => control("settings.dnsFallback");
const click = (node) => flushSync(() => node.click());
function input(value) {
  const node = endpoint();
  node.focus();
  flushSync(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(node, value);
    node.dispatchEvent(new Event("input", { bubbles: true }));
  });
  flushSync(() => node.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
}

window.networkDnsProbe = async () => {
  const defaultOff = toggle().getAttribute("aria-checked") === "false" && !endpoint();
  click(toggle());
  await waitFor(() => endpoint() && !endpoint().disabled, "DNS did not turn on");
  const secureDefault = stored.networkDns.mode === "doh"
    && stored.networkDns.serverUrl === "https://1.1.1.1/dns-query"
    && stored.networkDns.allowSystemFallback === false;

  const count = writes.length;
  input("http://resolver.invalid/dns-query");
  await waitFor(() => endpoint().getAttribute("aria-invalid") === "true", "invalid endpoint was not announced");
  const invalidRejected = writes.length === count && Boolean(document.getElementById(endpoint().getAttribute("aria-describedby")));
  input("https://127.0.0.1:9443/dns-query");
  await waitFor(() => stored.networkDns.serverUrl.includes(":9443/") && !endpoint().disabled, "custom endpoint was not saved");

  heldWrite = new Promise((resolve) => { releaseWrite = resolve; });
  click(fallback());
  await waitFor(() => fallback().disabled, "pending save did not disable controls");
  const busyCount = writes.length;
  click(fallback());
  const duplicatePrevented = writes.length === busyCount && toggle().disabled && endpoint().disabled;
  releaseWrite();
  await waitFor(() => stored.networkDns.allowSystemFallback && !fallback().disabled, "fallback preference was not saved");

  click(toggle());
  await waitFor(() => !endpoint() && !toggle().disabled, "DNS did not turn off");
  const disabledRetainsPreferences = stored.networkDns.mode === "system"
    && stored.networkDns.serverUrl === "https://127.0.0.1:9443/dns-query"
    && stored.networkDns.allowSystemFallback === true;
  flushSync(() => remount());
  click(toggle());
  await waitFor(() => endpoint() && !endpoint().disabled, "DNS did not restore after remount");
  const restored = endpoint().value === "https://127.0.0.1:9443/dns-query" && fallback().getAttribute("aria-checked") === "true";

  input("invalid");
  await waitFor(() => endpoint().getAttribute("aria-invalid") === "true", "invalid draft was not marked");
  click(toggle());
  await waitFor(() => !endpoint() && !toggle().disabled, "invalid draft prevented disabling DNS");
  const invalidDraftCanDisable = stored.networkDns.serverUrl === "https://127.0.0.1:9443/dns-query";
  failNextWrite = true;
  click(toggle());
  await waitFor(() => toasts.length === 1 && !toggle().disabled, "save failure was not visible");
  return {
    defaultOff, secureDefault, invalidRejected, duplicatePrevented,
    disabledRetainsPreferences, restored, invalidDraftCanDisable,
    failureDoesNotPretendSuccess: toggle().getAttribute("aria-checked") === "false" && !endpoint(),
    unrelatedProxyPreserved: writes.every((write) => JSON.stringify(write.networkProxy) === originalProxy),
  };
};
`;

test("Network settings save, restore and validate native DoH through the renderer API", {
  timeout: 60_000,
  skip: process.platform === "linux" && !process.env.DISPLAY ? "Isolated Electron UI test requires a display" : false,
}, async () => {
  const temp = await mkdtemp(join(process.env.PI_SCRATCH_DIR || tmpdir(), "pi-network-dns-ui-"));
  try {
    await build({
      stdin: { contents: rendererSource, resolveDir: join(root, "scripts/e2e"), loader: "tsx" },
      outfile: join(temp, "renderer.js"), bundle: true, platform: "browser", format: "esm", jsx: "automatic",
      define: { "process.env.NODE_ENV": '"production"' },
      alias: {
        "@pi-desktop/i18n": join(root, "packages/i18n/src"),
        react: join(root, "apps/desktop/node_modules/react"),
        "react-dom": join(root, "apps/desktop/node_modules/react-dom"),
        i18next: join(root, "apps/desktop/node_modules/i18next"),
        "react-i18next": join(root, "apps/desktop/node_modules/react-i18next"),
      },
      nodePaths: [join(root, "apps/desktop/node_modules")],
    });
    await writeFile(join(temp, "index.html"), '<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'self\'; style-src \'self\' \'unsafe-inline\'"><div id="root"></div><script type="module" src="renderer.js"></script>');
    await writeFile(join(temp, "main.cjs"), `
      const { app, BrowserWindow } = require("electron");
      const path = require("node:path");
      app.setPath("userData", path.join(__dirname, "profile"));
      app.whenReady().then(async () => {
        const win = new BrowserWindow({ show: false, width: 1000, height: 800,
          webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
        win.webContents.on("console-message", (event) => console.error(event.message));
        try {
          await win.loadFile(path.join(__dirname, "index.html"));
          // Focus the document without showing or attaching to a user window.
          win.webContents.focus();
          const result = await win.webContents.executeJavaScript("window.networkDnsProbe()");
          console.log("NETWORK_DNS_UI " + JSON.stringify(result));
          app.exit(0);
        } catch (error) { console.error(error?.stack ?? error); app.exit(1); }
      });
    `);
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(resolveElectronBinary(root).electronBinary, [join(temp, "main.cjs")], { env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    for (const stream of [child.stdout, child.stderr]) {
      stream.setEncoding("utf8");
      stream.on("data", (chunk) => { output = (output + chunk).slice(-64_000); });
    }
    const timer = setTimeout(() => child.kill("SIGKILL"), 45_000);
    let code;
    try {
      code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
    } finally { clearTimeout(timer); }
    assert.equal(code, 0, output);
    const line = output.split(/\r?\n/).find((value) => value.startsWith("NETWORK_DNS_UI "));
    assert(line, output);
    const result = JSON.parse(line.slice("NETWORK_DNS_UI ".length));
    for (const [behavior, passed] of Object.entries(result)) assert.equal(passed, true, behavior);
    assert.equal(Object.keys(result).length, 9);
  } finally { await rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); }
});
