/**
 * Native DoH acceptance test.
 *
 * Runs one isolated Electron main process with its own `userData` directory,
 * a loopback RFC 8484 DoH server, a loopback HTTP target, and a per-process
 * SPKI pin for the repository's self-signed test certificate (no global
 * certificate verification bypass and no host-resolver rules). Inside that
 * process the fixture drives the real `app.configureHostResolver` and
 * `session.resolveHost` APIs through the real `createNetworkDnsController`,
 * the real authenticated system proxy relay, and the real
 * `applyNodeNetworkProxy` switch.
 *
 * Nothing about the native DNS path is mocked. The fixture only observes:
 *   - a `.invalid` hostname answered by the local DoH server,
 *   - an HTTP request through the authenticated relay with its Host header,
 *   - switching to a second local DoH resolver,
 *   - disabling secure DNS restoring the system lookup,
 *   - a strict (no-fallback) configuration with an unreachable DoH endpoint.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, X509Certificate } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { repositoryRoot, resolveElectronBinary } from "../../../scripts/e2e/boot.mjs";

const root = repositoryRoot();
const { build } = createRequire(join(root, "packages/agent-runtime/package.json"))("esbuild");
const fixturePath = join(root, "apps/desktop/test/fixtures/network-dns-native.fixture.ts");
const certificatePath = join(root, "scripts/e2e/fixtures/certificates/localhost-cert.pem");
const certificateKeyPath = join(root, "scripts/e2e/fixtures/certificates/localhost-key.pem");
const TARGET_HOST = "pi-doh-target.invalid";
const SENTINEL_SYSTEM_ADDRESS = "203.0.113.77";
const CHILD_TIMEOUT_MS = 120_000;

async function bundleFixture(outfile) {
  try {
    await build({
      entryPoints: [fixturePath],
      outfile,
      bundle: true,
      platform: "node",
      format: "cjs",
      target: "node20",
      external: ["electron"],
      absWorkingDir: root,
      logLevel: "silent",
    });
  } catch (error) {
    assert.fail(`native DNS fixture bundle failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function spawnElectron(electronBinary, bundlePath, env) {
  const child = spawn(electronBinary, [bundlePath], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let output = "";
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      if (output.length < 80_000) output += chunk;
    });
  }
  const exited = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  return { child, exited, output: () => output };
}

function endpointsOf(value) {
  assert.ok(value && Array.isArray(value.endpoints), `expected native endpoints, got ${JSON.stringify(value)}`);
  return value.endpoints;
}

function addressesOf(value) {
  assert.ok(value && Array.isArray(value.addresses), `expected controller addresses, got ${JSON.stringify(value)}`);
  return value.addresses;
}

test(
  "native DoH resolves a .invalid host and the authenticated relay preserves the Host header",
  {
    timeout: 180_000,
    skip: process.platform === "linux" && !process.env.DISPLAY ? "Electron requires a display" : false,
  },
  async (t) => {
    let electronBinary;
    try {
      electronBinary = resolveElectronBinary(root).electronBinary;
    } catch (error) {
      assert.fail(
        `Electron is required for the native DoH acceptance test but is unavailable: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    const [certificate, certificateKey] = await Promise.all([
      readFile(certificatePath, "utf8"),
      readFile(certificateKeyPath, "utf8"),
    ]);
    const parsedCertificate = new X509Certificate(certificate);
    const spki = createHash("sha256")
      .update(parsedCertificate.publicKey.export({ type: "spki", format: "der" }))
      .digest("base64");
    assert.ok(spki.length > 0 && certificateKey.length > 0, "test certificate fixture is unusable");

    const temp = await mkdtemp(join(process.env.PI_SCRATCH_DIR || tmpdir(), "pi-dns-native-"));
    const resultPath = join(temp, "result.json");
    const bundlePath = join(temp, "main.cjs");
    let running = null;
    t.after(async () => {
      if (running && running.child.exitCode === null && running.child.signalCode === null) {
        running.child.kill("SIGKILL");
        await running.exited.catch(() => {});
      }
      await rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    });

    await bundleFixture(bundlePath);

    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    Object.assign(env, {
      PI_DNS_NATIVE_RESULT: resultPath,
      PI_DNS_NATIVE_CERT: certificatePath,
      PI_DNS_NATIVE_KEY: certificateKeyPath,
      PI_DNS_NATIVE_USER_DATA: join(temp, "profile"),
      PI_DNS_NATIVE_SPKI: spki,
      ELECTRON_DISABLE_SECURITY_WARNINGS: "1",
    });

    running = spawnElectron(electronBinary, bundlePath, env);
    const timer = setTimeout(() => running.child.kill("SIGKILL"), CHILD_TIMEOUT_MS);
    let exit;
    try {
      exit = await running.exited;
    } finally {
      clearTimeout(timer);
    }
    const output = running.output();
    let result = null;
    try {
      result = JSON.parse(await readFile(resultPath, "utf8"));
    } catch {
      result = null;
    }
    assert.ok(result, `native DNS fixture produced no result\n${output.slice(-6000)}`);
    const detail = JSON.stringify(result.steps ?? {}, null, 2).slice(-8000);
    assert.equal(result.ok, true, `${result.error}\n${detail}\n${output.slice(-4000)}`);
    assert.equal(exit.code, 0, `Electron exited with ${exit.code}/${exit.signal}\n${output.slice(-4000)}`);

    const steps = result.steps;

    // The isolated process pinned exactly one certificate and faked no resolver.
    assert.deepEqual(steps.runtime.certificatePolicy, {
      spkiPinned: true,
      globalCertificateVerificationDisabled: false,
      hostResolverRulesOverridden: false,
    });
    assert.ok(steps.runtime.electron, "fixture did not run inside Electron");
    const targetHost = new URL(steps.runtime.targetUrl).host;
    assert.equal(steps.relay.expectedHost, targetHost);

    // The `.invalid` hostname only resolves through the local DoH server.
    assert.deepEqual(steps.firstApply.settings, {
      mode: "doh",
      serverUrl: steps.doh.first.url,
      allowSystemFallback: false,
    });
    assert.deepEqual(steps.firstApply.current, steps.firstApply.settings);
    const firstEndpoints = endpointsOf(steps.firstApply.native);
    assert.ok(
      firstEndpoints.some((entry) => entry.address === "127.0.0.1" && entry.family === "ipv4"),
      `native resolveHost did not answer from the local DoH server: ${JSON.stringify(firstEndpoints)}`,
    );
    assert.deepEqual(addressesOf(steps.firstApply.lookup), [{ address: "127.0.0.1", family: 4 }]);
    assert.equal(steps.firstApply.systemLookups, 0, "DoH mode consulted the system resolver");
    assert.ok(steps.doh.first.posts >= 1, "the local DoH server received no RFC 8484 POST");
    assert.ok(
      steps.doh.first.queries.some(
        (query) => query.name === TARGET_HOST && query.type === 1 && query.status === 200,
      ),
      `the local DoH server did not answer an A query: ${JSON.stringify(steps.doh.first.queries)}`,
    );

    // The authenticated relay used that native lookup and preserved Host.
    assert.equal(steps.relay.relayUrlLooksAuthenticated, true);
    assert.equal(steps.relay.route, "system-proxy");
    assert.equal(steps.relay.status, 200);
    assert.equal(steps.relay.body, "relay-ok");
    assert.ok(steps.relay.proxyResolutions >= 1, "the relay never consulted the session PAC resolver");
    assert.deepEqual(steps.relay.requestedHosts, [targetHost]);
    assert.deepEqual(steps.relay.paths, ["/probe"]);
    assert.equal(steps.relay.systemLookups, 0, "the relay fell back to the system resolver");

    // A custom proxy mode still routes through the authenticated relay.
    assert.equal(steps.customRelay.status, 200);
    assert.equal(steps.customRelay.body, "relay-ok");
    assert.equal(steps.customRelay.route, "socks5-proxy");
    assert.deepEqual(steps.customRelay.requestedHosts, [targetHost, targetHost]);
    assert.equal(steps.customRelay.systemLookups, 0);

    // Switching to a second local resolver is effective without a restart.
    assert.equal(steps.secondApply.current.serverUrl, steps.doh.second.url);
    const secondEndpoints = endpointsOf(steps.secondApply.native);
    assert.ok(
      secondEndpoints.some((entry) => entry.address === "127.0.0.2" && entry.family === "ipv4"),
      `the second DoH resolver was not used: ${JSON.stringify(secondEndpoints)}`,
    );
    assert.deepEqual(addressesOf(steps.secondApply.lookup), [{ address: "127.0.0.2", family: 4 }]);
    assert.ok(
      steps.doh.second.queries.some((query) => query.name === TARGET_HOST && query.type === 1),
      "the second DoH server was never queried",
    );

    // Disabling secure DNS restores the default configuration and system path.
    assert.deepEqual(steps.disabled.current, { mode: "system" });
    assert.deepEqual(addressesOf(steps.disabled.lookup), [{ address: SENTINEL_SYSTEM_ADDRESS, family: 4 }]);
    assert.equal(steps.disabled.systemLookups, 1, "system mode did not use the system resolver");
    if (steps.disabled.native && Array.isArray(steps.disabled.native.endpoints)) {
      const disabledAddresses = steps.disabled.native.endpoints.map((entry) => entry.address);
      assert.ok(
        !disabledAddresses.includes("127.0.0.1") && !disabledAddresses.includes("127.0.0.2"),
        `native resolution still used DoH after disabling it: ${JSON.stringify(steps.disabled.native)}`,
      );
    } else {
      assert.ok(
        steps.disabled.native && typeof steps.disabled.native.rejected === "string",
        `unexpected native result after disabling DoH: ${JSON.stringify(steps.disabled.native)}`,
      );
    }

    // Strict mode cannot silently fall back after an unreachable DoH endpoint.
    assert.equal(steps.strict.current.serverUrl, steps.strict.unreachableUrl);
    assert.equal(steps.strict.current.allowSystemFallback, false);
    assert.ok(
      steps.strict.native && typeof steps.strict.native.rejected === "string",
      `strict mode answered from an unreachable DoH endpoint: ${JSON.stringify(steps.strict.native)}`,
    );
    assert.match(steps.strict.native.rejected, /ERR_|refused|failed|resolv/i);
    assert.ok(
      steps.strict.lookup && typeof steps.strict.lookup.rejected === "string",
      `controller lookup succeeded with an unreachable DoH endpoint: ${JSON.stringify(steps.strict.lookup)}`,
    );
    assert.equal(
      steps.strict.systemLookups,
      steps.disabled.systemLookups,
      "strict mode silently fell back to the system resolver",
    );
    assert.ok(
      !JSON.stringify(steps.strict.lookup).includes(SENTINEL_SYSTEM_ADDRESS),
      "strict mode returned a system-resolved address",
    );
  },
);
