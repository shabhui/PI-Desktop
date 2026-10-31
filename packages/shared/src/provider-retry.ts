/**
 * Shared automatic provider retry policy used by the runtime, Electron main,
 * the headless launcher, and renderer status.
 *
 * The defaults reproduce the released behaviour exactly: ten retries after the
 * initial provider attempt, 429 backoff starting at 2s capped at 30s, and the
 * non-429 transient backoff starting at 1s capped at 8s. `AppSettings` may
 * override the retry count and the first wait; every other rule — the two
 * separate budgets, `Retry-After` precedence, abortability, response-only
 * reset, and failed-request-only replay — stays as it was.
 */

/** Shared automatic provider retry budget used by runtime and renderer status. */
export const PROVIDER_RETRY_MAX_RETRIES = 10;

/**
 * Largest delay one `setTimeout` accepts. A longer value is clamped to zero by
 * the runtime and would fire immediately, so a planned wait is always split
 * into slices no larger than this before it is scheduled.
 */
export const PROVIDER_RETRY_MAX_TIMER_DELAY_MS = 2_147_483_647;

/**
 * The persisted retry knobs, as read from `AppSettings` or a launch payload.
 * Both values are `unknown` because every caller now normalizes settings it
 * did not validate itself.
 */
export type ProviderRetrySettingsInput = {
  infiniteProviderRetry?: unknown;
  providerRetryMaxAttempts?: unknown;
  providerRetryInitialDelayMs?: unknown;
};

/** The single resolved retry policy the runtime enforces for one launch. */
export type ProviderRetryPolicy = {
  /** No retry-count ceiling applies to admitted failures. */
  unlimited: boolean;
  /** Retries allowed after the initial request; `Infinity` when unlimited. */
  maxAttempts: number;
  /** Configured first wait, or `undefined` to keep the per-class defaults. */
  initialDelayMs?: number;
};

/** A nonnegative JS safe integer is the only accepted persisted shape. */
function isRetryInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Read the configured retry ceiling. Anything that is not a nonnegative JS
 * safe integer — a float, a negative value, a numeric string, `null`, or a
 * number past `Number.MAX_SAFE_INTEGER` — normalizes to absence so a bad
 * persisted or synced value keeps the released default.
 */
export function normalizeProviderRetryMaxAttempts(value: unknown): number | undefined {
  return isRetryInteger(value) ? value : undefined;
}

/**
 * Read the configured first wait in milliseconds. `0` is valid and means an
 * immediate retry; every other invalid shape normalizes to absence.
 */
export function normalizeProviderRetryInitialDelayMs(value: unknown): number | undefined {
  return isRetryInteger(value) ? value : undefined;
}

/**
 * Rejection message for an unusable retry write, or `undefined` when accepted.
 * An explicit `null` clears a stored override; omission leaves it unchanged.
 * Renderer, Electron main and host-core use the same write/reset semantics.
 */
export function providerRetrySettingsWriteError(
  value: ProviderRetrySettingsInput,
): string | undefined {
  if (
    Object.prototype.hasOwnProperty.call(value, "providerRetryMaxAttempts") &&
    value.providerRetryMaxAttempts !== null &&
    !isRetryInteger(value.providerRetryMaxAttempts)
  ) {
    return "providerRetryMaxAttempts is invalid";
  }
  if (
    Object.prototype.hasOwnProperty.call(value, "providerRetryInitialDelayMs") &&
    value.providerRetryInitialDelayMs !== null &&
    !isRetryInteger(value.providerRetryInitialDelayMs)
  ) {
    return "providerRetryInitialDelayMs is invalid";
  }
  return undefined;
}

/**
 * Resolve the effective ceiling and first wait for one launch.
 *
 * - `infiniteProviderRetry: true` wins outright and removes only the ceiling.
 * - `providerRetryMaxAttempts: 0` also means unlimited retries.
 * - An absent ceiling keeps the released ten-retry default.
 * - An absent first wait keeps each class's released schedule.
 */
export function resolveProviderRetryPolicy(
  input: ProviderRetrySettingsInput,
): ProviderRetryPolicy {
  const configuredMaxAttempts = normalizeProviderRetryMaxAttempts(input.providerRetryMaxAttempts);
  const initialDelayMs = normalizeProviderRetryInitialDelayMs(input.providerRetryInitialDelayMs);
  const unlimited =
    input.infiniteProviderRetry === true || configuredMaxAttempts === 0;
  return {
    unlimited,
    maxAttempts: unlimited
      ? Number.POSITIVE_INFINITY
      : (configuredMaxAttempts ?? PROVIDER_RETRY_MAX_RETRIES),
    ...(initialDelayMs === undefined ? {} : { initialDelayMs }),
  };
}

/**
 * A configured first wait must survive its own class ceiling, so the cap of an
 * overridden schedule is the larger of the released class cap and the
 * configured wait. `Retry-After` handling keeps the released class cap.
 */
export function providerRetryDelayCapMs(
  categoryCapMs: number,
  initialDelayMs: number | undefined,
): number {
  return Math.max(categoryCapMs, initialDelayMs ?? 0);
}

/**
 * Exponential schedule shared by both retry classes:
 * `initialDelayMs * 2 ** (attempt - 1)`, capped at `capMs`.
 *
 * The exponent is bounded and non-finite inputs collapse to a wait of zero, so
 * a long unlimited run can never produce `NaN` or `Infinity` — `setTimeout`
 * treats both as an immediate timer, which would turn a planned backoff into a
 * retry storm.
 */
export function providerRetryBackoffMs(
  initialDelayMs: number,
  attempt: number,
  capMs: number,
): number {
  if (!Number.isFinite(initialDelayMs) || initialDelayMs <= 0) return 0;
  const safeCap = Number.isFinite(capMs) && capMs > 0 ? capMs : initialDelayMs;
  const step = Number.isFinite(attempt) ? Math.max(1, Math.floor(attempt)) : 1;
  const exponent = Math.min(step - 1, 52);
  return Math.min(safeCap, Math.ceil(initialDelayMs * 2 ** exponent));
}

/**
 * Timer-safe slices of one planned wait, in order. A single `setTimeout` above
 * `PROVIDER_RETRY_MAX_TIMER_DELAY_MS` fires immediately instead of waiting, so
 * a configured multi-day backoff is walked in whole chunks of at most that
 * limit. A non-finite or non-positive total schedules nothing.
 */
export function retryWaitSlices(totalMs: number): number[] {
  if (!Number.isFinite(totalMs) || totalMs <= 0) return [];
  const slices: number[] = [];
  let remaining = Math.ceil(totalMs);
  while (remaining > 0) {
    const slice = Math.min(remaining, PROVIDER_RETRY_MAX_TIMER_DELAY_MS);
    slices.push(slice);
    remaining -= slice;
  }
  return slices;
}
