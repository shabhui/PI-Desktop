# ADR 0338: Let the user tune the automatic provider retry budget and first wait

- Status: Accepted
- Date: 2026-10-31
- Deciders: PI-Desktop maintainers
- Related: `docs/spec/03-runtime/02-agent-runtime.md`, ADR 0129 (idle watchdog),
  ADR 0300 (portable configuration sync), `packages/shared/src/provider-retry.ts`

## Context

The automatic provider retry policy is released behaviour with fixed numbers:

- `PROVIDER_RETRY_MAX_RETRIES = 10` retries after the initial request for each
  of the independent 429 and transient failure classes.
- 429 backoff starts at 2s, doubles with up to 25% positive jitter, and is capped at 30s.
- The non-429 transient backoff starts at 1s, doubles deterministically, and is
  capped at 8s.
- `Retry-After` (milliseconds, seconds, HTTP-date) wins over the schedule.
- `infiniteProviderRetry` removes the ten-retry ceiling for admitted failures
  and nothing else.

That covers the common case badly at both ends. A user behind a flaky VPN sees
ten failed attempts in under two minutes and then a dead turn, while a user on a
metered plan or a rate-limited plan has no way to make the client wait longer
than 30s between attempts. The single all-or-nothing toggle cannot express
"twelve attempts" or "wait a minute before the first retry".

These are preferences, not protocol: the number of replays and the length of a
wait change no wire contract, no persistence schema beyond two more settings,
and no ownership boundary. They are still enforced in several processes — the
renderer shows the status, Electron main builds the launch, host-core owns the
settings, and the agent runtime paces the retries — so the rule must exist once.

## Decision

### Two optional settings

`AppSettings.providerRetryMaxAttempts` and
`AppSettings.providerRetryInitialDelayMs`, both optional:

- `providerRetryMaxAttempts`: nonnegative JS safe integer. It counts retries
  **after** the initial request, independently for 429 and transient failures;
  setup and stream phases share their respective class budget. `0` means
  unlimited retries, the same ceiling behavior as the existing toggle.
- `providerRetryInitialDelayMs`: nonnegative JS safe integer milliseconds. It
  replaces the first wait of **both** exponential schedules. `0` retries
  immediately.
- `infiniteProviderRetry: true` still wins over a configured ceiling.
- Absent values keep the released numbers exactly, so an existing profile
  behaves as before with no migration. Explicit `null` writes restore absence.

### One shared policy module

`packages/shared/src/provider-retry.ts` owns the whole rule: normalization of a
persisted or launch value, the write-rejection test, the resolved policy
(`unlimited`, `maxAttempts`, optional `initialDelayMs`), the class cap rule, the
schedule, and the timer-safe slicing of a wait. The renderer row, the settings
API boundary, Electron main, the headless launcher, the sidecar and the agent
runtime call it. Rust host-core enforces the same JSON integer/reset contract
at its authoritative settings boundary, with matching contract tests.

### Delay semantics

A configured first wait replaces the class default and raises that class's cap
to at least itself (`max(classCap, configured)`). A user who asks for a 60s
first wait would otherwise get a 60s wait clipped to the 30s / 8s ceiling on the
very next attempt, which is not a policy anyone can reason about.

The rest of the schedule is untouched:

- `Retry-After` remains authoritative, including when it is shorter than the
  planned wait, and keeps using the released class ceiling.
- 429 keeps its jitter and its 30s cap (unless a configured wait is larger);
  the transient class keeps its deterministic doubling and 8s cap (same rule).
- Cancel/Stop, per-attempt `AbortController`, partial-response protection,
  failed-request-only replay, and unchanged roles/tools remain as released.

### Timer-safe waits

A `setTimeout` delay above `2^31-1` ms fires effectively immediately, so a
configured multi-day wait could become a retry storm. A planned wait is
therefore walked in slices of at most
`PROVIDER_RETRY_MAX_TIMER_DELAY_MS`, each one abortable. The total wait equals
the planned value, Stop stays responsive, and the schedule never degenerates
into an immediate retry. The schedule itself bounds its exponent, so a very long
unlimited run can never produce `NaN`/`Infinity` (which `setTimeout` also treats
as zero).

### Validation and normalization

- Renderer and Electron main reject invalid writes before IPC/Host mutation;
  host-core's `provider_retry_limit` is authoritative for JSON values. Numeric
  overrides must be nonnegative integers no larger than `9007199254740991`.
- Omission leaves an existing override unchanged. An explicit `null` clears it:
  host-core normalizes after merging the settings patch and removes that field.
  Reads and launches treat a reset as absence. Zero remains unlimited/immediate,
  and JavaScript boundaries reject an explicitly supplied `undefined`.
- Unusable persisted or synced reads (float, negative, numeric string, `NaN`,
  or past `MAX_SAFE_INTEGER`) also normalize to absence and keep the defaults.
- The two fields are in the config-sync portable application whitelist, so a
  user's ceiling follows their account to another machine.

### Application points

- The policy is read at `agent.start`. A reused sidecar runtime receives the new
  limits through its live setter, so a settings change applies to the next turn
  without restarting the agent process.
- The headless launch payload and the host-runtime launch resolver carry the two
  values beside `infiniteProviderRetry`, using the same normalizer.
- Builtin subagents inherit the main session's resolved policy; one-shot
  completions and compaction keep their own separately bounded policies.
- Settings are only read when a launch is prepared, so a running turn keeps the
  policy it started with.

### UI

Three rows in the AI settings section: the released toggle, the retry limit, and
the first wait. Each numeric row shows the stored value and stays **empty** when
nothing is stored, which is the only honest way to say "the runtime default
applies" — the first wait has two class defaults, so its description names both
instead of showing one misleading placeholder. Clearing a saved field writes
`null` to restore defaults; blurring an already-unset blank field writes nothing.
A whole number `>= 0` is saved on blur or Enter. Invalid numeric input, including
a browser-sanitized empty value with `validity.badInput`, is refused, reverted
to the stored value and explained with a localized error. A rejected save also
restores the stored display and reports the error.

The `retrying` activity carries the effective ceiling (`maxAttempts`) or
`infinite`, so the transcript states the real budget; older producers that omit
the field fall back to the released ten.

## Consequences

- Existing profiles are unaffected: absent fields resolve to the released
  numbers, and the released toggle keeps its meaning.
- `providerRetryMaxAttempts: 0` and `infiniteProviderRetry: true` can keep
  billing requests alive indefinitely; the UI description states both, and Stop
  still ends the turn.
- A very large first wait is accepted (any JS safe integer) and honoured in
  timer-safe slices; the practical ceiling is the user's patience, not the
  timer.
- The retry rule now lives in one shared module rather than in the runtime, so
  future retry knobs extend that module and every boundary at once.
- Two more portable preference fields travel through config sync; an older
  client that receives them drops them on read (they are not in its whitelist)
  and keeps its own defaults.

## Alternatives considered

- **Extend `infiniteProviderRetry` into an enum/preset list.** Presets cannot
  express "12 attempts" or "45s", and they would reinterpret a persisted
  boolean.
- **Read the settings only in the runtime.** Electron main and host-core would
  then accept values the runtime silently drops, and the settings write would
  appear to succeed while the launch ignored it.
- **Clamp the configured wait to the released cap.** A configured 60s wait would
  be cut to 30s/8s on the second attempt, contradicting the stored preference.
- **Pass a `setTimeout` for the whole wait.** Values above `2^31-1` fire
  immediately, which is a retry storm, not a backoff.
