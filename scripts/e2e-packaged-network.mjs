#!/usr/bin/env node
/** Windows ZIP acceptance against the actual packaged executable and resources. */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { Host } from "./e2e/host.mjs";

assert.equal(process.platform, "win32", "This acceptance covers Windows ZIP packages only");
const { values } = parseArgs({ options: { "package-dir": { type: "string" } } });
assert.ok(values["package-dir"], "Pass --package-dir with the candidate ZIP's extracted directory");
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const packageDir = await realpath(resolve(values["package-dir"]));
const executable = join(packageDir, "PI-Desktop.exe");
const resources = join(packageDir, "resources");
const hostBinary = join(resources, "bin", "pi-desktop-host-core.exe");
const archive = join(resources, "app.asar");
const desktopRequire = createRequire(join(root, "apps/desktop/package.json"));
const builderRequire = createRequire(desktopRequire.resolve("electron-builder"));
const { extractFile } = createRequire(builderRequire.resolve("app-builder-lib"))("@electron/asar");
const metadata = JSON.parse(extractFile(archive, "package.json").toString("utf8"));
assert.equal(metadata.piDistribution, "zip", "The personal package must retain manual-update ZIP semantics");
const expectedMetadata = JSON.parse(await readFile(join(root, "apps/desktop/package.json"), "utf8"));
assert.equal(metadata.version, expectedMetadata.version);
const git = (args) => execFileSync("git", args, {
  cwd: root, encoding: "utf8", timeout: 15_000, maxBuffer: 1024 * 1024,
}).trim();
const candidate = git(["rev-parse", "HEAD"]);
const base = git(["rev-parse", process.env.PI_DESKTOP_E2E_BASE_REF || "origin/main"]);
git(["merge-base", "--is-ancestor", base, "HEAD"]);
const workingDiff = git(["status", "--porcelain", "--untracked-files=normal"]) !== "";
async function fingerprint(path) {
  const info = await stat(path);
  assert.ok(info.isFile() && info.size < 1024 * 1024 * 1024, `Not a bounded regular build artifact: ${path}`);
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return { bytes: info.size, sha256: hash.digest("hex") };
}
const hashes = {};
for (const [name, packaged, built] of [
  ["host", hostBinary, join(root, "target/release/pi-desktop-host-core.exe")],
  ["sidecar", join(resources, "agent-runtime/sidecar.js"), join(root, "packages/agent-runtime/dist-bundle/sidecar.js")],
]) {
  hashes[name] = await fingerprint(packaged);
  assert.deepEqual(hashes[name], await fingerprint(built), `${name} differs from the current candidate build`);
}
for (const entry of ["out/main/index.js", "out/preload/index.cjs", "out/preload/plugin-panel.js"]) {
  const bundled = extractFile(archive, entry);
  assert.deepEqual(bundled, await readFile(join(root, "apps/desktop", entry)), `${entry} is stale in the package`);
  if (entry.startsWith("out/preload/")) {
    assert.doesNotMatch(bundled.toString("utf8"), /require\(["']\.\//, "Sandbox preloads must be self-contained");
  }
}
hashes.executable = await fingerprint(executable);
hashes.archive = await fingerprint(archive);
const evidenceDir = await mkdtemp(join(process.env.PI_SCRATCH_DIR || tmpdir(), "pi-packaged-network-"));
const results = [];
const errors = [];
const deadline = async (promise, milliseconds, message) => {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
};
async function boot(env, name) {
  const child = spawn(executable, [], { cwd: packageDir, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let closed = false;
  let output = "";
  const probes = [];
  const pendingLines = new Map();
  let bytes = 0;
  let rejectOverflow;
  const overflow = new Promise((_, reject) => { rejectOverflow = reject; });
  const exit = new Promise((resolveExit, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => { closed = true; resolveExit({ code, signal }); });
  });
  for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk) => {
    bytes += chunk.length;
    if (bytes > 2 * 1024 * 1024) {
      rejectOverflow(new Error("Packaged boot exceeded its 2 MiB output budget"));
      return;
    }
    output += String(chunk);
    const lines = `${pendingLines.get(stream) ?? ""}${chunk}`.split(/\r?\n/);
    pendingLines.set(stream, lines.pop());
    for (const line of lines) if (line.startsWith("BOOT_PROBE ")) probes.push(line);
  });
  let result;
  try {
    result = await deadline(Promise.race([exit, overflow]), 90_000, "Packaged boot exceeded 90 seconds");
  } finally {
    try {
      if (!closed && child.pid) {
        // Only the process tree launched by this fixture may be terminated.
        execFileSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
          timeout: 15_000, windowsHide: true, stdio: "pipe",
        });
        await deadline(exit, 10_000, "Packaged process did not close after task-owned cleanup");
      }
    } finally {
      await writeFile(join(evidenceDir, `${name}.log`), output, { flag: "wx" });
    }
  }
  assert.equal(result.code, 0, `Packaged executable failed: ${output.slice(-3000)}`);
  assert.equal(probes.length, 1, "Expected exactly one real packaged boot probe");
  const probe = JSON.parse(probes[0].slice("BOOT_PROBE ".length));
  assert.equal(probe.ok, true, JSON.stringify(probe));
  assert.equal(probe.appName, "PI-Desktop");
  assert.equal(probe.version, metadata.version);
  assert.equal(probe.hostProtocol, 11);
  assert.equal(probe.platform, "win32");
  assert.equal(probe.maximized, true);
  assert.equal(probe.menuCount, 0);
  assert.equal(probe.ctrlRBlocked, true);
  assert.deepEqual(probe.projectRemove, { ok: true, removed: false, sessionsRemoved: 0 });
  const sessions = probe.sessionList;
  assert.ok(sessions.returnedCount >= 800 && sessions.complete && sessions.capabilitiesConsistent);
  assert.equal(sessions.listDurationsMs.length, 8);
  assert.ok(sessions.listDurationsMs.every((value) => value < 1000));
  assert.ok(sessions.maxMainGapMs < 1000);
  assert.ok(sessions.heartbeatDurationsMs.length > 0 && sessions.heartbeatDurationsMs.every((value) => value < 1000));
  return probe;
}
for (const mode of ["doh", "system"]) {
  const profile = await mkdtemp(join(evidenceDir, "pi-desktop-boot-"));
  const home = join(profile, "fixture-home");
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("PI_DESKTOP_") || /(?:API_KEY|TOKEN|SECRET|PASSWORD)$/i.test(key) || [
      "ELECTRON_RUN_AS_NODE", "NODE_OPTIONS", "NODE_EXTRA_CA_CERTS", "PORTABLE_EXECUTABLE_FILE",
      "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy",
    ].includes(key)) env[key] = undefined;
  }
  Object.assign(env, {
    HOME: home, USERPROFILE: home, APPDATA: join(home, "AppData/Roaming"), LOCALAPPDATA: join(home, "AppData/Local"),
    XDG_CONFIG_HOME: join(home, ".config"), PI_DESKTOP_AGENTS_DIR: join(home, "agents"),
    PI_DESKTOP_DATA_DIR: profile, PI_DESKTOP_BOOT_PROBE: "1", PI_DESKTOP_START_MAXIMIZED: "1",
    ELECTRON_RENDERER_URL: "", TMP: evidenceDir, TEMP: evidenceDir,
  });
  await Promise.all([home, env.APPDATA, env.LOCALAPPDATA, env.XDG_CONFIG_HOME, env.PI_DESKTOP_AGENTS_DIR]
    .map((path) => mkdir(path, { recursive: true })));
  const host = new Host(hostBinary, profile, { env, quiet: true });
  const networkDns = { mode, serverUrl: "https://127.0.0.1:9/dns-query", allowSystemFallback: false };
  const retry = mode === "doh"
    ? { providerRetryMaxAttempts: 3, providerRetryInitialDelayMs: 1250 }
    : { providerRetryMaxAttempts: 0, providerRetryInitialDelayMs: 0 };
  let passed = false;
  try {
    await host.start();
    assert.deepEqual(await host.call("settings.set", {
      ...retry, networkDns, networkProxy: { mode: "direct" }, updatePreference: "manual",
    }), { ok: true });
    await host.stop();
    const probe = await boot(env, mode);
    const runtimeLogPath = join(profile, "logs/app/runtime.log");
    assert.ok((await stat(runtimeLogPath)).size < 2 * 1024 * 1024, "Runtime log exceeded its fixture budget");
    const runtimeLog = await readFile(runtimeLogPath, "utf8");
    const events = runtimeLog.trim().split(/\r?\n/).map((line) => JSON.parse(line));
    assert.ok(events.some((event) => event.message === "agent sidecar configured"), "Packaged sidecar must finish real configuration");
    assert.ok(!events.some((event) => event.message === "backend boot failed" || event.message === "agent sidecar exited unexpectedly"));
    await writeFile(join(evidenceDir, `${mode}-runtime.log`), runtimeLog, { flag: "wx" });
    await host.start();
    const stored = await host.call("settings.get");
    for (const [key, value] of Object.entries(retry)) assert.equal(stored[key], value);
    assert.deepEqual(stored.networkDns, networkDns);
    assert.equal(stored.updatePreference, "manual");
    await host.stop();
    results.push({ mode, retry, settingsPersisted: true, sidecarConfigured: true, probe });
    passed = true;
  } catch (error) {
    errors.push(error);
    console.error(`PACKAGED_NETWORK_FAILED ${mode}: ${error.stack ?? error}`);
  } finally {
    try { await host.stop(); } catch (error) { errors.push(error); passed = false; }
    if (passed) {
      try { await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
      catch (error) { errors.push(error); }
    }
  }
  if (errors.length) break;
}
assert.deepEqual(await fingerprint(hostBinary), hashes.host, "Packaged Host changed during acceptance");
assert.deepEqual(await fingerprint(join(resources, "agent-runtime/sidecar.js")), hashes.sidecar);
assert.deepEqual(await fingerprint(archive), hashes.archive);
assert.deepEqual(await fingerprint(executable), hashes.executable);
const report = { candidate, base, workingDiff, executable, evidenceDir, hashes, results, result: errors.length ? "failed" : "passed" };
await writeFile(join(evidenceDir, "result.json"), JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
console.log("PACKAGED_NETWORK " + JSON.stringify(report));
if (errors.length) process.exitCode = 1;
