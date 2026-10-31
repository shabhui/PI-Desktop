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
let electron = null;
try {
  electron = resolveElectronBinary(root).electronBinary;
} catch {
  electron = null;
}

// The real AI-tab rows, the real store toast action and the real shared
// normalizers. The surface owns settings the way SettingsPage does: a patch is
// merged into the current object and that object is what a reload would read.
const fixture = String.raw`
import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { catalogs, flattenCatalog } from "@pi-desktop/i18n";
import { ProviderRetrySettingsRows } from "../../apps/desktop/src/features/settings/provider-retry-settings";
import { runActivityLabel } from "../../apps/desktop/src/features/chat/transcript/ActivityGroup";
import { useAppStore } from "../../apps/desktop/src/stores/app-store";
import "../../apps/desktop/src/styles/settings.css";

await i18n.use(initReactI18next).init({ lng: "en", keySeparator: false,
  resources: { en: { translation: flattenCatalog(catalogs.en) } },
  interpolation: { escapeValue: false } });
window.piDesktop = { platform: "win32", on() { return () => {}; },
  invoke() { throw new Error("Unexpected IPC in provider retry settings test"); } };

const saved = [];
let failNext = false;
let stored = { defaultMode: "agent", theme: "light" };
function Surface() {
  const [settings, setSettings] = React.useState(stored);
  const saveSettings = async (patch) => {
    if (failNext) { failNext = false; throw new Error("stored rejected"); }
    saved.push(patch);
    stored = { ...stored, ...patch };
    setSettings(stored);
  };
  return React.createElement(ProviderRetrySettingsRows, { settings, saveSettings });
}
const rootNode = createRoot(document.getElementById("root"));
flushSync(() => rootNode.render(React.createElement(Surface)));
const frame = () => new Promise(requestAnimationFrame);
async function settle() { await frame(); await frame(); }
function check(condition, message) { if (!condition) throw new Error(message); }
const toasts = () => useAppStore.getState().toasts;
const clearToasts = () => useAppStore.setState({ toasts: [] });
const inputFor = (key) => document.querySelector('input[aria-label="' + i18n.t(key) + '"]');
function type(input, text) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
  setter.call(input, text);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}
// A commit never happens per keystroke: the row saves when the field is left,
// A hidden window still has a focused document once its webContents is
// focused, which is what makes the real focus/blur/Enter paths below run. The
// probe never shows a window.
function setDraft(input, text) {
  input.focus();
  check(document.activeElement === input, "the field did not take focus");
  flushSync(() => type(input, text));
}
async function blurCommit(input) {
  flushSync(() => input.blur());
  await settle();
}
async function typeAndBlur(input, text) {
  setDraft(input, text);
  await settle();
  await blurCommit(input);
}
async function typeAndEnter(input, text) {
  setDraft(input, text);
  await settle();
  flushSync(() => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
  await settle();
}

window.retryProbe = async () => {
  await settle();
  const attempts = inputFor("settings.providerRetryMaxAttempts");
  const delay = inputFor("settings.providerRetryInitialDelayMs");
  check(attempts && delay, "retry rows are not rendered");
  // Nothing stored: both fields stay empty and the count shows the default.
  check(attempts.value === "" && delay.value === "", "unstored rows must start empty");
  check(attempts.placeholder === "10" && delay.placeholder === "", "placeholder copy is wrong");
  await typeAndBlur(delay, "");
  check(saved.length === 0, "an already-unset row should not write");
  const toggle = document.querySelector('button[role="switch"]');
  check(toggle && toggle.getAttribute("aria-label") === i18n.t("settings.infiniteProviderRetry"),
    "infinite retry switch is missing");
  await typeAndBlur(attempts, "3");
  check(attempts.value === "3", "saved count is not shown");
  check(JSON.stringify(saved) === JSON.stringify([{ providerRetryMaxAttempts: 3 }]), "count was not saved: " + JSON.stringify(saved));
  // Enter is the keyboard path to the same commit.
  await typeAndEnter(delay, "25");
  check(JSON.stringify(saved.at(-1)) === JSON.stringify({ providerRetryInitialDelayMs: 25 }), "delay was not saved");
  check(delay.value === "25", "saved delay is not shown");

  // The transcript consumer must report the effective budget, not always ten.
  const retryActivity = { phase: "retrying", since: 1000, retryDelayMs: 2000, attempt: 2 };
  const translate = (key, options) => i18n.t(key, options);
  for (const [override, ceiling] of [
    [{}, 10],
    [{ maxAttempts: stored.providerRetryMaxAttempts }, 3],
    [{ maxAttempts: 50 }, 50],
    [{ maxAttempts: 3, infinite: true }, "∞"],
  ]) {
    check(
      runActivityLabel({ ...retryActivity, ...override }, translate, 1500) ===
        i18n.t("chat.retryingModel", { delaySeconds: 2, attempt: 2, maxAttempts: ceiling }),
      "the retry activity did not report its effective ceiling: " + ceiling,
    );
  }
  check(
    runActivityLabel({ ...retryActivity, maxAttempts: 3 }, translate, 4000) ===
      i18n.t("chat.retryingModel", { delaySeconds: 0, attempt: 2, maxAttempts: 3 }),
    "the retry activity countdown did not stop at zero",
  );

  // A stored zero is a real value: unlimited attempts, immediate retry.
  await typeAndBlur(attempts, "0");
  check(saved.at(-1).providerRetryMaxAttempts === 0, "zero attempts did not persist");
  check(attempts.value === "0", "zero attempts reverted to empty");
  await typeAndBlur(delay, "0");
  check(saved.at(-1).providerRetryInitialDelayMs === 0, "zero delay did not persist");
  check(delay.value === "0", "zero delay reverted to empty");

  // An invalid entry is refused locally, reverted, and explained.
  clearToasts();
  const before = saved.length;
  await typeAndBlur(delay, "-5");
  check(saved.length === before, "an invalid delay was written");
  check(delay.value === "0", "an invalid delay did not revert to the stored value");
  const invalid = toasts().at(-1);
  check(invalid && invalid.variant === "error" && invalid.message === i18n.t("settings.providerRetryInvalidValue"),
    "invalid entry did not raise the localized error toast");

  // Chromium preserves a native invalid number draft as value="" + badInput.
  // It is not an intentional request to clear the saved override.
  clearToasts();
  delay.focus();
  delay.select();
  flushSync(() => document.execCommand("insertText", false, "e"));
  check(delay.value === "" && delay.validity.badInput, "the browser did not create a native invalid number draft");
  await blurCommit(delay);
  check(saved.length === before, "a native invalid number cleared the saved delay");
  check(delay.value === "0", "a native invalid number did not restore the saved delay");
  check(toasts().at(-1)?.message === i18n.t("settings.providerRetryInvalidValue"),
    "a native invalid number did not raise the validation error");

  // Clearing a saved override restores both built-in delay classes, not zero.
  clearToasts();
  await typeAndBlur(delay, "");
  check(saved.at(-1).providerRetryInitialDelayMs === null, "an empty field did not clear the saved delay");
  check(delay.value === "", "a cleared delay should show the built-in defaults");
  await typeAndEnter(attempts, "");
  check(saved.at(-1).providerRetryMaxAttempts === null, "an empty field did not clear the saved count");
  check(attempts.value === "", "a cleared count should show the default placeholder");

  // A rejected write is reverted and reported instead of leaving a fake value.
  clearToasts();
  failNext = true;
  await typeAndBlur(attempts, "4");
  check(attempts.value === "", "a rejected write stayed in the field");
  const failed = toasts().at(-1);
  check(failed && failed.variant === "error" && failed.message === i18n.t("settings.providerRetrySaveError"),
    "a rejected write did not raise the localized save error");

  // The released opt-in toggle keeps its own persisted semantics.
  clearToasts();
  const toggled = saved.length;
  flushSync(() => toggle.click());
  await settle();
  check(saved.at(-1).infiniteProviderRetry === true, "enabling infinite retry was not saved");
  flushSync(() => toggle.click());
  await settle();
  check(saved.at(-1).infiniteProviderRetry === false, "disabling infinite retry was not saved");
  check(saved.length === toggled + 2, "the toggle wrote unexpected values");
  check(toggle.getAttribute("aria-checked") === "false", "the switch did not follow the stored value");
  flushSync(() => rootNode.render(React.createElement(Surface, { key: "reload" })));
  await settle();
  check(inputFor("settings.providerRetryMaxAttempts").value === "", "a reset count did not survive reload");
  check(inputFor("settings.providerRetryInitialDelayMs").value === "", "a reset delay did not survive reload");
  flushSync(() => rootNode.unmount());
  return { passed: true, saved };
};
`;

test(
  "retry settings rows save, reset and reject unusable input",
  {
    skip: electron
      ? process.platform === "linux" && !process.env.DISPLAY
        ? "Electron requires a display"
        : false
      : "Electron binary is not installed",
  },
  async () => {
    const temp = await mkdtemp(join(process.env.PI_SCRATCH_DIR || tmpdir(), "pi-provider-retry-ui-"));
    try {
      await build({
        stdin: { contents: fixture, resolveDir: join(root, "scripts/e2e"), loader: "tsx" },
        outfile: join(temp, "renderer.js"),
        bundle: true,
        platform: "browser",
        format: "esm",
        jsx: "automatic",
        loader: { ".woff": "file", ".woff2": "file", ".ttf": "file" },
        define: { "process.env.NODE_ENV": '"production"' },
        alias: {
          "@pi-desktop/i18n": join(root, "packages/i18n/src"),
          "@pi-desktop/shared": join(root, "packages/shared/src"),
          react: join(root, "apps/desktop/node_modules/react"),
          "react-dom": join(root, "apps/desktop/node_modules/react-dom"),
          i18next: join(root, "apps/desktop/node_modules/i18next"),
          "react-i18next": join(root, "apps/desktop/node_modules/react-i18next"),
        },
        nodePaths: [join(root, "apps/desktop/node_modules")],
      });
      await writeFile(
        join(temp, "index.html"),
        '<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'self\'; style-src \'self\' \'unsafe-inline\'"><link rel="stylesheet" href="renderer.css"><div id="root"></div><script type="module" src="renderer.js"></script>',
      );
      await writeFile(
        join(temp, "main.cjs"),
        `
const { app, BrowserWindow } = require("electron");
const path = require("node:path");
app.setPath("userData", path.join(__dirname, "profile"));
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1000, height: 760,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  try {
    await win.loadFile(path.join(__dirname, "index.html"));
    // Focusing the webContents focuses the document without showing a window;
    // without it, focus()/blur() fire no events and no row could commit.
    win.webContents.focus();
    console.log("RETRY_PROBE " + JSON.stringify(await win.webContents.executeJavaScript("window.retryProbe()")));
    app.exit(0);
  } catch (error) { console.error(error?.stack ?? error); app.exit(1); }
});`,
      );
      const env = { ...process.env };
      delete env.ELECTRON_RUN_AS_NODE;
      const child = spawn(electron, [join(temp, "main.cjs")], {
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      for (const stream of [child.stdout, child.stderr]) {
        stream.setEncoding("utf8");
        stream.on("data", (chunk) => {
          output += chunk;
        });
      }
      const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
      let code;
      try {
        code = await new Promise((resolve, reject) => {
          child.once("error", reject);
          child.once("close", resolve);
        });
      } finally {
        clearTimeout(timer);
      }
      assert.equal(code, 0, output.slice(-6000));
      const line = output.split(/\r?\n/).find((item) => item.startsWith("RETRY_PROBE "));
      assert.ok(line, output.slice(-6000));
      assert.deepEqual(JSON.parse(line.slice("RETRY_PROBE ".length)), {
        passed: true,
        saved: [
          { providerRetryMaxAttempts: 3 },
          { providerRetryInitialDelayMs: 25 },
          { providerRetryMaxAttempts: 0 },
          { providerRetryInitialDelayMs: 0 },
          { providerRetryInitialDelayMs: null },
          { providerRetryMaxAttempts: null },
          { infiniteProviderRetry: true },
          { infiniteProviderRetry: false },
        ],
      });
    } finally {
      await rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  },
);
