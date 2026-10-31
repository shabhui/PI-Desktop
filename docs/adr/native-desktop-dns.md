# ADR: Native Desktop DNS over HTTPS

- Status: Accepted for implementation
- Date: 2026-10-31
- Related: ADR 0177, ADR 0272, ADR 0321, provider-system-certificates

## Context

Desktop has separate Chromium, Node provider and Host marketplace transports.
Changing only Chromium's DNS settings leaves provider calls on the system
resolver. Injecting a replacement `dns.lookup` into installed sidecar files is
not a native, upgrade-safe solution and creates another cache/lifecycle owner.

## Decision

1. Add optional, device-local `AppSettings.networkDns`: `mode` is `system`
   (the default) or `doh`; `serverUrl` is an HTTPS RFC 8484 POST endpoint;
   `allowSystemFallback` is false unless explicitly enabled. Retain endpoint
   and fallback preferences while disabled. Validate writes in the renderer,
   Electron and authoritative Host; invalid saved values read as system mode.
   Existing settings storage remains the extension point, without a schema bump.
2. Use Electron's `app.configureHostResolver` rather than implementing another
   DNS protocol/cache. Enabled mode uses the built-in resolver with `secure`
   DNS, or `automatic` only for explicit fallback. The default endpoint is
   `https://1.1.1.1/dns-query`, so bootstrapping it does not need a hostname
   lookup. Custom hostname endpoints may need system bootstrap resolution;
   their certificate chain and hostname are always verified. No credentials,
   fragments or URI templates are accepted in the endpoint field.
3. With no opt-in, do not configure Chromium at startup. Disabling an active
   override restores Chromium's platform defaults (`automatic`, no custom
   servers; built-in resolver on macOS only). Never modify OS DNS, trust stores,
   interface configuration or a user's proxy/VPN.
4. The existing authenticated loopback system/PAC relay accepts a socket lookup
   dependency. Desktop supplies its resolver when DoH is active, including for
   proxy endpoint connections. Local provider and Host marketplace traffic use
   that relay in all proxy modes while DoH is enabled. The relay still follows
   the configured proxy and bypass policy. Proxied destination names stay with
   the proxy: this setting cannot override the proxy's own DNS or TUN routing.
   A missing required relay fails closed rather than leaking to direct/system
   resolution. No new unauthenticated local service is introduced.
5. Settings application is ordered and uses Host-returned merged settings, not
   a partial patch. `bootBackends` alone restores the startup network state;
   later UI bootstrap must not replay an old settings snapshot. Publish a
   sidecar only after successful configuration against the same Host and current
   network snapshot, catching up changes during configuration and disposing
   failed/stale candidates. Only effective DNS changes invalidate Chromium
   caches. Old-generation lookup results cannot create new connections; timeout,
   cancellation and disposal ignore late completion. A failed native apply
   blocks controller lookups until successful recovery. Existing connected
   requests are not aborted merely to clear an idle pool.
6. Public-fetch address checks use the same Desktop resolver while retaining
   their route, redirect, address-class and pinned-address protections. This
   setting does not weaken TLS, plugin permissions or SSRF checks.
7. This is a Desktop-local setting, not a portable remote-host preference.
   Workspace Bash, the external OS browser, independently running headless or
   remote hosts, and transports that already own a separate pinned-DNS policy
   are not reconfigured. No installed plugin settings are silently imported.

## Alternatives

- Sidecar monkey-patching: rejected; it relies on installed-file mutation and
  duplicates native lifecycle, DNS framing, caching and compatibility work.
- Chromium only: rejected; the main provider path would remain unchanged.
- Change system DNS: rejected; application preferences must not affect unrelated
  programs or require administrator access.
- One custom DNS implementation per process: rejected; the authenticated relay
  and Chromium resolver already provide the needed local ownership boundary.

## Consequences

- Chromium remains the only new DNS protocol/cache owner; no injected sidecar
  files, OS settings or installation-time patches are needed.
- Strict resolver outages block new app-owned connections instead of silently
  changing DNS policy. Fallback is an explicit user choice, not error recovery.
- Provider and Host routes now rely on authenticated Desktop relay availability
  in every proxy mode while enabled. The optional runtime-only
  `desktopDnsEnabled` flag defaults false for legacy/headless callers and is
  validated as boolean when present. Host curl uses `socks5h` with an empty
  `--noproxy` value so environment bypasses cannot skip native DNS ownership.
- Settings persist before runtime application. An apply error can leave the
  preference saved; later retry/disabling is supported, not transactional
  rollback. Native DNS remains excluded from portable config sync.

## Validation

Cover disabled defaults, endpoint validation, explicit fallback, platform-default
restoration, repeated settings writes, stale lookup completion, bounded lookup
failure, DIRECT and proxied relay connections, relay authentication, missing
relay failure, Host curl arguments, settings persistence and UI interaction.
Use isolated local provider fixtures; do not test against a user's running
Desktop or a paid provider. Native Chromium DoH behavior is a separate process
acceptance check, not proven by configuration-only unit tests.

The native process fixture uses production Electron resolver APIs, two loopback
RFC 8484 HTTPS servers and the real authenticated relay/provider dispatcher.
Only the fixture certificate's SPKI is trusted in that test process; global TLS
bypass and hostname resolver rules are forbidden. UI fixtures use real settings
components with mocked IPC/persistence. Startup and settings-IPC tests use real
orchestration with fake Host/process boundaries; the sidecar RPC test uses a
real built sidecar but starts no provider turn. These prove different boundaries
and do not replace rebuilt Rust Host persistence/restart or packaged acceptance.
