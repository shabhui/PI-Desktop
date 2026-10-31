#!/usr/bin/env node
/** Real Host persistence/restart and local-only configuration-sync acceptance. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { approveAll, config, PASSWORD, rpc } from "./e2e/config-sync-journey.mjs";
import { startS3Fixture } from "./e2e/config-sync-s3-fixture.mjs";
import { Host } from "./e2e/host.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
assert.equal(process.argv.length, 2, "This acceptance has no live-service mode");
assert.ok(process.env.PI_DESKTOP_HOST_BIN, "Set PI_DESKTOP_HOST_BIN to the candidate's built Host");
const binary = await realpath(resolve(process.env.PI_DESKTOP_HOST_BIN));
const binaryStat = await stat(binary);
assert.ok(binaryStat.isFile() && binaryStat.size < 128 * 1024 * 1024, "Expected a bounded Host executable");
const binarySha256 = createHash("sha256").update(await readFile(binary)).digest("hex");
const git = (args) => execFileSync("git", args, {
  cwd: root, encoding: "utf8", timeout: 15_000, maxBuffer: 1024 * 1024,
}).trim();
const candidate = git(["rev-parse", "HEAD"]);
const baseRef = process.env.PI_DESKTOP_E2E_BASE_REF || "origin/main";
const base = git(["rev-parse", baseRef]);
git(["merge-base", "--is-ancestor", base, "HEAD"]);
const workingDiff = git(["status", "--porcelain", "--untracked-files=normal"]) !== "";
const dataRoot = await mkdtemp(join(process.env.PI_SCRATCH_DIR || tmpdir(), "pi-native-network-host-"));
const hosts = [];
const errors = [];
const completed = [];
let store;
let cleanup;
let remoteEvidence;
let currentStep = "setup";
const scenario = async (name, run) => {
  currentStep = name;
  console.log(`NATIVE_NETWORK_HOST_STEP ${name}`);
  await run();
  completed.push(name);
};
const get = (host) => rpc(host, "settings.get");
const set = (host, patch) => rpc(host, "settings.set", patch);
const sync = async (host) => approveAll(host, await rpc(host, "configSync.syncNow"));
const retryFields = ["providerRetryMaxAttempts", "providerRetryInitialDelayMs"];
function expectRetry(value, count, delay) {
  for (const [index, expected] of [count, delay].entries()) {
    const field = retryFields[index];
    assert.equal(Object.hasOwn(value, field), expected !== undefined, `${field} presence`);
    if (expected !== undefined) assert.equal(value[field], expected, field);
  }
}
const dnsA = { mode: "doh", serverUrl: "https://resolver-a.invalid/dns-query", allowSystemFallback: false };
const dnsB = { mode: "system", serverUrl: "https://resolver-b.invalid/dns-query", allowSystemFallback: true };
try {
  for (const name of ["a", "b"]) {
    const home = join(dataRoot, name, "home");
    const env = {
      HOME: home, USERPROFILE: home, APPDATA: join(home, "AppData", "Roaming"),
      LOCALAPPDATA: join(home, "AppData", "Local"), XDG_CONFIG_HOME: join(home, ".config"),
      PI_DESKTOP_AGENTS_DIR: join(home, "agents"), DEBUG_HOST: "",
    };
    for (const key of [
      "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY",
      "PI_DESKTOP_PROXY_JSON", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
      "http_proxy", "https_proxy", "all_proxy", "no_proxy",
    ]) env[key] = undefined;
    await Promise.all([home, env.APPDATA, env.LOCALAPPDATA, env.XDG_CONFIG_HOME, env.PI_DESKTOP_AGENTS_DIR]
      .map((path) => mkdir(path, { recursive: true })));
    hosts.push(new Host(binary, join(dataRoot, name, "data"), { env }));
  }
  await Promise.all(hosts.map((host) => host.start()));
  const [a, b] = hosts;
  await scenario("default-off-and-unset-overrides", async () => {
    for (const host of hosts) {
      const value = await get(host);
      expectRetry(value, undefined, undefined);
      assert.equal(value.networkDns?.mode ?? "system", "system");
      await set(host, { networkPolicy: { mode: "relaxed" }, networkProxy: { mode: "direct" } });
    }
  });
  await scenario("save-and-omitted-fields-preserve-values", async () => {
    assert.deepEqual(await set(a, { providerRetryMaxAttempts: 3, providerRetryInitialDelayMs: 1250, networkDns: dnsA }), { ok: true });
    await set(a, { theme: "dark" });
    const value = await get(a);
    expectRetry(value, 3, 1250);
    assert.deepEqual(value.networkDns, dnsA);
  });
  await scenario("invalid-writes-are-atomic", async () => {
    const before = await get(a);
    for (const field of retryFields) {
      for (const invalid of [-1, 0.5, "3", true, [], Number.MAX_SAFE_INTEGER + 1]) {
        await assert.rejects(set(a, { [field]: invalid, theme: "light" }), { errorCode: "INVALID_PARAMS" });
        assert.deepEqual(await get(a), before, `${field} invalid write must not mutate settings`);
      }
    }
    for (const invalid of [
      { mode: "unknown" }, { mode: "doh", serverUrl: "http://resolver.invalid/dns-query" },
      { serverUrl: "https://user:fixture@resolver.invalid/dns-query" },
      { serverUrl: "https://resolver.invalid/dns-query#fragment" }, { allowSystemFallback: "yes" },
    ]) {
      await assert.rejects(set(a, { networkDns: invalid, theme: "light" }), { errorCode: "INVALID_PARAMS" });
      assert.deepEqual(await get(a), before, "invalid DNS write must not mutate settings");
    }
  });
  await scenario("null-reset-preserves-the-other-override", async () => {
    await set(a, { providerRetryMaxAttempts: null });
    expectRetry(await get(a), undefined, 1250);
    await set(a, { providerRetryInitialDelayMs: null });
    expectRetry(await get(a), undefined, undefined);
  });
  await scenario("zero-and-disabled-dns-survive-restart", async () => {
    const disabled = { ...dnsA, mode: "system" };
    await set(a, { providerRetryMaxAttempts: 0, providerRetryInitialDelayMs: 0, networkDns: disabled });
    await a.restart();
    const value = await get(a);
    expectRetry(value, 0, 0);
    assert.deepEqual(value.networkDns, disabled);
    await set(a, { networkDns: dnsA });
    await a.restart();
    assert.deepEqual((await get(a)).networkDns, dnsA);
  });
  await scenario("portable-overrides-require-choice-and-keep-device-local-dns", async () => {
    await set(a, { providerRetryMaxAttempts: 7, providerRetryInitialDelayMs: 2400 });
    await set(b, { networkDns: dnsB, theme: "dark" });
    store = await startS3Fixture(`pi-desktop-tests/native-network-${randomUUID()}`);
    assert.equal((await store.inventory()).length, 0);
    const categories = Object.fromEntries([
      "application", "providers", "credentials", "mcp", "skills", "subagents", "instructions", "plugins", "automation", "memory",
    ].map((name) => [name, name === "application"]));
    const settingsA = config(store.connection, "Native network A", { categories, includeSecrets: false });
    assert.deepEqual(await rpc(a, "configSync.test", settingsA), { ok: true, conditionalWrites: true });
    await rpc(a, "configSync.configure", settingsA);
    await sync(a);
    await rpc(b, "configSync.configure", config(store.connection, "Native network B", { categories, includeSecrets: false }));
    const pending = await rpc(b, "configSync.syncNow");
    assert.equal(pending.status, "conflict");
    expectRetry(await get(b), undefined, undefined);
    assert.deepEqual((await get(b)).networkDns, dnsB);
    assert.ok(pending.pendingApprovals.every((item) => item.domain === "application" && item.reason === "conflict"));
    const remote = pending.pendingApprovals.find((item) => item.entityId === "application:remote");
    assert.ok(remote, "The new device must explicitly choose the remote application preferences");
    await approveAll(b, await rpc(b, "configSync.approve", { approvalId: remote.id, digest: remote.digest }));
    for (const [index, host] of hosts.entries()) {
      const value = await get(host);
      expectRetry(value, 7, 2400);
      assert.deepEqual(value.networkDns, index === 0 ? dnsA : dnsB);
    }
  });
  await scenario("zero-propagates-back-without-dns-overlay", async () => {
    await set(b, { providerRetryMaxAttempts: 0, providerRetryInitialDelayMs: 0 });
    await sync(b);
    await sync(a);
    expectRetry(await get(a), 0, 0);
    assert.deepEqual((await get(a)).networkDns, dnsA);
  });
  await scenario("reset-propagates-and-survives-device-restarts", async () => {
    await set(b, { providerRetryMaxAttempts: null, providerRetryInitialDelayMs: null });
    await sync(b);
    await sync(a);
    for (const [index, host] of hosts.entries()) {
      await host.restart();
      const value = await get(host);
      expectRetry(value, undefined, undefined);
      assert.deepEqual(value.networkDns, index === 0 ? dnsA : dnsB);
      assert.equal((await rpc(host, "configSync.getState")).configured, true);
    }
  });
  await scenario("encrypted-storage-and-nondestructive-disconnect", async () => {
    remoteEvidence = await store.inspect([PASSWORD, store.connection.secretAccessKey, store.connection.sessionToken]);
    const inventory = await store.inventory();
    for (const host of hosts) assert.equal((await rpc(host, "configSync.disconnect")).configured, false);
    assert.deepEqual(await store.inventory(), inventory);
  });
} catch (error) {
  errors.push(error);
} finally {
  const stopped = await Promise.allSettled(hosts.map((host) => host.stop()));
  for (const result of stopped) if (result.status === "rejected") errors.push(result.reason);
  if (store) {
    try {
      assert.ok(stopped.every((result) => result.status === "fulfilled"), "A Host may still use the fixture");
      cleanup = await store.cleanup();
      assert.deepEqual(cleanup, { remaining: 0, versions: 0 });
    } catch (error) { errors.push(error); }
    try { await store.close(); } catch (error) { errors.push(error); }
  }
  if (stopped.every((result) => result.status === "fulfilled")) {
    try { await rm(dataRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
    catch (error) { errors.push(error); }
  }
}
if (errors.length) {
  console.error("NATIVE_NETWORK_HOST_FAILED " + JSON.stringify({ step: currentStep, completed, binarySha256, failures: errors.length }));
  for (const error of errors) console.error(error);
  process.exitCode = 1;
} else {
  console.log("NATIVE_NETWORK_HOST " + JSON.stringify({
    candidate, base, workingDiff, binary, binarySha256, platform: process.platform,
    mode: "local-s3", devices: hosts.length, scenarios: completed, ...remoteEvidence, cleanup, result: "passed",
  }));
}
