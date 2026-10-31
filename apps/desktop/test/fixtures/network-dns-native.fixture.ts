/**
 * Isolated Electron main-process fixture for the native DNS acceptance test.
 *
 * The test drives the real `app.configureHostResolver` / `session.resolveHost`
 * APIs, the real `createNetworkDnsController`, the real authenticated system
 * proxy relay, and the real `applyNodeNetworkProxy` transport switch. Nothing
 * about native DNS is mocked: the only test-owned pieces are a loopback
 * RFC 8484 DoH server, a loopback HTTP target, and a per-process SPKI pin for
 * the repository's existing self-signed test certificate.
 */
import { app, session } from "electron";
import { createHash, X509Certificate } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server as HttpServer,
} from "node:http";
import { createServer as createHttpsServer, type Server as HttpsServer } from "node:https";
import { createServer as createNetServer } from "node:net";

import { createNetworkDnsController } from "../../electron/main/network-dns";
import {
  activeNodeTransportRoute,
  applyNodeNetworkProxy,
} from "../../../../packages/agent-runtime/src/node-proxy";
import { startSystemProxyRelay } from "../../../../packages/agent-runtime/src/system-proxy-relay";

const TARGET_HOST = "pi-doh-target.invalid";
const SENTINEL_SYSTEM_ADDRESS = "203.0.113.77";
const WATCHDOG_MS = 90_000;
const DOH_TIMEOUT_MS = 20_000;

const RESULT_PATH = process.env.PI_DNS_NATIVE_RESULT ?? "";
const CERT_PATH = process.env.PI_DNS_NATIVE_CERT ?? "";
const KEY_PATH = process.env.PI_DNS_NATIVE_KEY ?? "";
const PROFILE_PATH = process.env.PI_DNS_NATIVE_USER_DATA ?? "";

type QueryRecord = { name: string; type: number; method: string; status: number };
type DohServer = {
  url: string;
  queries: QueryRecord[];
  posts: number;
  close: () => Promise<void>;
};
type Evidence = Record<string, unknown>;

app.commandLine.appendSwitch("ignore-certificate-errors-spki-list", process.env.PI_DNS_NATIVE_SPKI ?? "");
if (PROFILE_PATH) app.setPath("userData", PROFILE_PATH);

let finished = false;
function finish(evidence: Evidence, exitCode: number): void {
  if (finished) return;
  finished = true;
  clearTimeout(watchdog);
  const payload = { ok: exitCode === 0, ...evidence };
  try {
    if (RESULT_PATH) writeFileSync(RESULT_PATH, JSON.stringify(payload));
  } catch (error) {
    console.error("failed to write fixture result", error);
  }
  console.log("PI_DNS_NATIVE_RESULT " + JSON.stringify(payload));
  app.exit(exitCode);
}

const watchdog = setTimeout(() => {
  finish({ error: "native DNS fixture watchdog expired", steps: {} }, 2);
}, WATCHDOG_MS);
watchdog.unref?.();

/** Parse the first question of an RFC 1035 message; QNAMEs are never compressed here. */
function parseQuestion(message: Buffer): { name: string; type: number; end: number } {
  let offset = 12;
  const labels: string[] = [];
  while (offset < message.length) {
    const length = message[offset];
    if (length === 0) {
      offset += 1;
      break;
    }
    if ((length & 0xc0) !== 0) throw new Error("compressed DNS question name");
    labels.push(message.subarray(offset + 1, offset + 1 + length).toString("ascii"));
    offset += length + 1;
  }
  if (offset + 4 > message.length) throw new Error("truncated DNS question");
  return { name: labels.join("."), type: message.readUInt16BE(offset), end: offset + 4 };
}

/** Answer A for the fixture host only; everything else is an empty NOERROR. */
function buildDnsResponse(message: Buffer, address: string): { body: Buffer; type: number; name: string } {
  const question = parseQuestion(message);
  const name = question.name.replace(/\.$/, "").toLowerCase();
  const answer = name === TARGET_HOST && question.type === 1;
  const header = Buffer.alloc(12);
  message.copy(header, 0, 0, 2);
  header.writeUInt16BE(0x8180, 2); // QR, RD, RA
  header.writeUInt16BE(1, 4);
  header.writeUInt16BE(answer ? 1 : 0, 6);
  const questionBytes = message.subarray(12, question.end);
  if (!answer) return { body: Buffer.concat([header, questionBytes]), type: question.type, name };
  const record = Buffer.alloc(16);
  record.writeUInt16BE(0xc00c, 0); // pointer to the question name
  record.writeUInt16BE(1, 2); // A
  record.writeUInt16BE(1, 4); // IN
  record.writeUInt32BE(30, 6);
  record.writeUInt16BE(4, 10);
  for (const [index, part] of address.split(".").entries()) {
    record.writeUInt8(Number(part), 12 + index);
  }
  return { body: Buffer.concat([header, questionBytes, record]), type: question.type, name };
}

function readRequestBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

function decodeGetQuery(url: string | undefined): Buffer {
  const query = new URL(url ?? "/", "https://doh.local").searchParams.get("dns");
  if (!query) throw new Error("DoH GET request without a dns parameter");
  return Buffer.from(query.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

async function startDohServer(certificate: string, key: string, address: string): Promise<DohServer> {
  const queries: QueryRecord[] = [];
  let posts = 0;
  const server: HttpsServer = createHttpsServer({ cert: certificate, key }, (request, response) => {
    void (async () => {
      try {
        const method = (request.method ?? "GET").toUpperCase();
        const message = method === "POST" ? await readRequestBody(request) : decodeGetQuery(request.url);
        const answer = buildDnsResponse(message, address);
        queries.push({ name: answer.name, type: answer.type, method, status: 200 });
        if (method === "POST") posts += 1;
        response.writeHead(200, {
          "content-type": "application/dns-message",
          "content-length": answer.body.length,
        });
        response.end(answer.body);
      } catch (error) {
        queries.push({ name: "", type: -1, method: request.method ?? "?", status: 400 });
        response.writeHead(400, { "content-type": "text/plain" });
        response.end(error instanceof Error ? error.message : "invalid DNS message");
      }
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  return {
    url: `https://localhost:${port}/dns-query`,
    queries,
    get posts() {
      return posts;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function startTargetServer(): Promise<HttpServer & { requests: Array<{ host?: string; url?: string }> }> {
  const requests: Array<{ host?: string; url?: string }> = [];
  const server = createHttpServer((request, response) => {
    requests.push({ host: request.headers.host, url: request.url });
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("relay-ok");
  }) as HttpServer & { requests: Array<{ host?: string; url?: string }> };
  server.requests = requests;
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

/** A loopback port with nothing listening: the strict DoH endpoint is unreachable. */
function closedPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createNetServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}

async function resolveHost(host: string): Promise<{ endpoints: unknown[] } | { rejected: string }> {
  try {
    return await session.defaultSession.resolveHost(host, { secureDnsPolicy: "allow" });
  } catch (error) {
    return { rejected: error instanceof Error ? error.message : String(error) };
  }
}

async function lookupAll(
  controller: ReturnType<typeof createNetworkDnsController>,
  host: string,
): Promise<{ addresses: unknown[] } | { rejected: string }> {
  try {
    return { addresses: await controller.lookupAll(host, { signal: AbortSignal.timeout(DOH_TIMEOUT_MS) }) };
  } catch (error) {
    return { rejected: error instanceof Error ? error.message : String(error) };
  }
}

const steps: Evidence = {};

async function run(): Promise<void> {
  const certificate = readFileSync(CERT_PATH, "utf8");
  const key = readFileSync(KEY_PATH, "utf8");
  const spki = createHash("sha256")
    .update(new X509Certificate(certificate).publicKey.export({ type: "spki", format: "der" }))
    .digest("base64");

  const first = await startDohServer(certificate, key, "127.0.0.1");
  const second = await startDohServer(certificate, key, "127.0.0.2");
  const target = await startTargetServer();
  const targetPort = (target.address() as { port: number }).port;
  const unreachablePort = await closedPort();

  let systemLookups = 0;
  let proxyResolutions = 0;
  const controller = createNetworkDnsController({
    platform: process.platform,
    configureHostResolver: (config) => app.configureHostResolver(config),
    clearHostResolverCache: () => session.defaultSession.clearHostResolverCache(),
    resolveHost: (host, options) => session.defaultSession.resolveHost(host, options),
    // An instrumented system path is the observable "silent fallback" signal:
    // DoH mode must never reach it.
    systemLookup: async () => {
      systemLookups += 1;
      return [{ address: SENTINEL_SYSTEM_ADDRESS, family: 4 }];
    },
  });

  steps.runtime = {
    electron: process.versions.electron,
    platform: process.platform,
    certificatePolicy: {
      spkiPinned: app.commandLine.getSwitchValue("ignore-certificate-errors-spki-list") === spki,
      globalCertificateVerificationDisabled: app.commandLine.hasSwitch("ignore-certificate-errors"),
      hostResolverRulesOverridden: app.commandLine.hasSwitch("host-resolver-rules"),
    },
    targetUrl: `http://${TARGET_HOST}:${targetPort}/probe`,
  };

  let relay: Awaited<ReturnType<typeof startSystemProxyRelay>> | null = null;
  try {
    // Keep PAC resolution deterministic: no OS proxy participates in this test.
    await session.defaultSession.setProxy({ mode: "direct" });

    const enabledFirst = await controller.apply({
      mode: "doh",
      serverUrl: first.url,
      allowSystemFallback: false,
    });
    steps.firstApply = {
      settings: enabledFirst,
      current: controller.current(),
      native: await resolveHost(TARGET_HOST),
      lookup: await lookupAll(controller, TARGET_HOST),
      systemLookups,
    };

    relay = await startSystemProxyRelay(
      (url) => {
        proxyResolutions += 1;
        return session.defaultSession.resolveProxy(url);
      },
      { lookup: controller.lookup },
    );
    applyNodeNetworkProxy({ mode: "system" }, process.env, relay.url, true);
    const relayResponse = await fetch(`http://${TARGET_HOST}:${targetPort}/probe`, {
      signal: AbortSignal.timeout(DOH_TIMEOUT_MS),
    });
    const relayBody = await relayResponse.text();
    steps.relay = {
      route: activeNodeTransportRoute(),
      status: relayResponse.status,
      body: relayBody,
      expectedHost: `${TARGET_HOST}:${targetPort}`,
      requestedHosts: target.requests.map((entry) => entry.host),
      paths: target.requests.map((entry) => entry.url),
      proxyResolutions,
      systemLookups,
      relayUrlLooksAuthenticated: /^socks5:\/\/system-auto:[0-9a-f]{64}@127\.0\.0\.1:\d+$/.test(relay.url),
    };

    applyNodeNetworkProxy({ mode: "custom", url: relay.url }, process.env, relay.url, true);
    const customResponse = await fetch(`http://${TARGET_HOST}:${targetPort}/custom`, {
      signal: AbortSignal.timeout(DOH_TIMEOUT_MS),
    });
    steps.customRelay = {
      route: activeNodeTransportRoute(),
      status: customResponse.status,
      body: await customResponse.text(),
      requestedHosts: target.requests.map((entry) => entry.host),
      systemLookups,
    };

    const enabledSecond = await controller.apply({
      mode: "doh",
      serverUrl: second.url,
      allowSystemFallback: false,
    });
    steps.secondApply = {
      settings: enabledSecond,
      current: controller.current(),
      native: await resolveHost(TARGET_HOST),
      lookup: await lookupAll(controller, TARGET_HOST),
      systemLookups,
    };

    const disabled = await controller.apply({ mode: "system" });
    steps.disabled = {
      settings: disabled,
      current: controller.current(),
      native: await resolveHost(TARGET_HOST),
      lookup: await lookupAll(controller, TARGET_HOST),
      systemLookups,
    };

    const unreachableUrl = `https://localhost:${unreachablePort}/dns-query`;
    const strict = await controller.apply({
      mode: "doh",
      serverUrl: unreachableUrl,
      allowSystemFallback: false,
    });
    steps.strict = {
      settings: strict,
      current: controller.current(),
      unreachableUrl,
      native: await resolveHost(TARGET_HOST),
      lookup: await lookupAll(controller, TARGET_HOST),
      systemLookups,
    };

    steps.doh = {
      first: { url: first.url, queries: first.queries, posts: first.posts },
      second: { url: second.url, queries: second.queries, posts: second.posts },
    };

    finish({ steps }, 0);
  } finally {
    controller.dispose();
    applyNodeNetworkProxy({ mode: "system" }, process.env);
    await relay?.close();
    await Promise.all([first.close(), second.close(), new Promise<void>((resolve) => target.close(() => resolve()))]);
  }
}

app
  .whenReady()
  .then(run)
  .catch((error: unknown) => {
    finish({
      error: error instanceof Error ? error.stack ?? error.message : String(error),
      steps,
    }, 1);
  });
