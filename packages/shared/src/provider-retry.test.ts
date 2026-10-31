import { describe, expect, it } from "vitest";
import {
  PROVIDER_RETRY_MAX_RETRIES,
  PROVIDER_RETRY_MAX_TIMER_DELAY_MS,
  normalizeProviderRetryInitialDelayMs,
  normalizeProviderRetryMaxAttempts,
  providerRetryBackoffMs,
  providerRetryDelayCapMs,
  providerRetrySettingsWriteError,
  resolveProviderRetryPolicy,
  retryWaitSlices,
} from "./provider-retry.js";

describe("provider retry settings normalization", () => {
  it("accepts only nonnegative JS safe integers", () => {
    for (const value of [0, 1, 7, 9_007_199_254_740_991]) {
      expect(normalizeProviderRetryMaxAttempts(value)).toBe(value);
      expect(normalizeProviderRetryInitialDelayMs(value)).toBe(value);
    }
    for (const value of [-1, 1.5, NaN, Infinity, -Infinity, "3", true, null, undefined, {}, []]) {
      expect(normalizeProviderRetryMaxAttempts(value)).toBeUndefined();
      expect(normalizeProviderRetryInitialDelayMs(value)).toBeUndefined();
    }
    expect(normalizeProviderRetryMaxAttempts(9_007_199_254_740_992)).toBeUndefined();
  });

  it("rejects a present-but-unusable write and allows absence", () => {
    expect(providerRetrySettingsWriteError({})).toBeUndefined();
    expect(
      providerRetrySettingsWriteError({
        providerRetryMaxAttempts: 0,
        providerRetryInitialDelayMs: 0,
      }),
    ).toBeUndefined();
    expect(providerRetrySettingsWriteError({ providerRetryMaxAttempts: -1 })).toBe(
      "providerRetryMaxAttempts is invalid",
    );
    expect(providerRetrySettingsWriteError({ providerRetryInitialDelayMs: 1.5 })).toBe(
      "providerRetryInitialDelayMs is invalid",
    );
    // Absence is not a write of `undefined`: only an own property is judged.
    expect(
      providerRetrySettingsWriteError({ providerRetryMaxAttempts: undefined }),
    ).toBe("providerRetryMaxAttempts is invalid");
  });

  it("accepts explicit null resets without treating zero as an unset value", () => {
    const reset = { providerRetryMaxAttempts: null, providerRetryInitialDelayMs: null };
    expect(providerRetrySettingsWriteError(reset)).toBeUndefined();
    expect(resolveProviderRetryPolicy(reset)).toEqual({ unlimited: false, maxAttempts: 10 });
    expect(resolveProviderRetryPolicy({ ...reset, infiniteProviderRetry: true })).toEqual({
      unlimited: true, maxAttempts: Infinity,
    });
    expect(resolveProviderRetryPolicy({ providerRetryMaxAttempts: 0, providerRetryInitialDelayMs: 0 }))
      .toEqual({ unlimited: true, maxAttempts: Infinity, initialDelayMs: 0 });
  });
});

describe("provider retry policy", () => {
  it("keeps the released defaults when nothing is configured", () => {
    expect(resolveProviderRetryPolicy({})).toEqual({
      unlimited: false,
      maxAttempts: PROVIDER_RETRY_MAX_RETRIES,
    });
    expect(
      resolveProviderRetryPolicy({ infiniteProviderRetry: false }),
    ).toEqual({ unlimited: false, maxAttempts: PROVIDER_RETRY_MAX_RETRIES });
  });

  it("honours the configured ceiling and gives infiniteProviderRetry precedence", () => {
    expect(
      resolveProviderRetryPolicy({ providerRetryMaxAttempts: 3 }),
    ).toEqual({ unlimited: false, maxAttempts: 3 });
    expect(
      resolveProviderRetryPolicy({
        providerRetryMaxAttempts: 3,
        providerRetryInitialDelayMs: 500,
      }),
    ).toEqual({ unlimited: false, maxAttempts: 3, initialDelayMs: 500 });
    expect(
      resolveProviderRetryPolicy({ providerRetryMaxAttempts: 0 }),
    ).toEqual({ unlimited: true, maxAttempts: Number.POSITIVE_INFINITY });
    expect(
      resolveProviderRetryPolicy({
        infiniteProviderRetry: true,
        providerRetryMaxAttempts: 3,
      }),
    ).toEqual({ unlimited: true, maxAttempts: Number.POSITIVE_INFINITY });
  });

  it("ignores unusable configured values instead of failing a launch", () => {
    expect(
      resolveProviderRetryPolicy({
        providerRetryMaxAttempts: "unlimited",
        providerRetryInitialDelayMs: -5,
      }),
    ).toEqual({ unlimited: false, maxAttempts: PROVIDER_RETRY_MAX_RETRIES });
  });
});

describe("provider retry backoff", () => {
  it("reproduces the released ten-retry 429 schedule", () => {
    const cap = providerRetryDelayCapMs(30_000, undefined);
    expect(cap).toBe(30_000);
    expect([1, 2, 3, 4, 5].map((attempt) => providerRetryBackoffMs(2_000, attempt, cap))).toEqual([
      2_000, 4_000, 8_000, 16_000, 30_000,
    ]);
  });

  it("reproduces the released transient schedule", () => {
    const cap = providerRetryDelayCapMs(8_000, undefined);
    expect([1, 2, 3, 4, 5, 10].map((attempt) => providerRetryBackoffMs(1_000, attempt, cap))).toEqual([
      1_000, 2_000, 4_000, 8_000, 8_000, 8_000,
    ]);
  });

  it("raises the ceiling to a configured first wait instead of clipping it", () => {
    expect(providerRetryDelayCapMs(8_000, 60_000)).toBe(60_000);
    const cap = providerRetryDelayCapMs(8_000, 60_000);
    expect(providerRetryBackoffMs(60_000, 1, cap)).toBe(60_000);
    expect(providerRetryBackoffMs(60_000, 2, cap)).toBe(60_000);
    // A configured wait below the released ceiling keeps the released ceiling.
    expect(providerRetryDelayCapMs(30_000, 500)).toBe(30_000);
    expect(providerRetryBackoffMs(500, 9, 30_000)).toBe(30_000);
  });

  it("never produces NaN or Infinity for a long unlimited run", () => {
    for (const attempt of [1, 2, 52, 53, 1_000, 1e9]) {
      const delay = providerRetryBackoffMs(2_000, attempt, 30_000);
      expect(Number.isFinite(delay)).toBe(true);
      expect(delay).toBeLessThanOrEqual(30_000);
      expect(delay).toBeGreaterThan(0);
    }
    expect(providerRetryBackoffMs(0, 4, 30_000)).toBe(0);
    expect(providerRetryBackoffMs(2_000, Number.NaN, 30_000)).toBe(2_000);
  });
});

describe("timer-safe retry waits", () => {
  it("returns no slice for a wait that needs no timer", () => {
    expect(retryWaitSlices(0)).toEqual([]);
    expect(retryWaitSlices(-5)).toEqual([]);
    expect(retryWaitSlices(Number.NaN)).toEqual([]);
    expect(retryWaitSlices(Number.POSITIVE_INFINITY)).toEqual([]);
  });

  it("keeps an ordinary wait as a single timer", () => {
    expect(retryWaitSlices(2_500)).toEqual([2_500]);
    expect(retryWaitSlices(0.4)).toEqual([1]);
    expect(retryWaitSlices(PROVIDER_RETRY_MAX_TIMER_DELAY_MS)).toEqual([
      PROVIDER_RETRY_MAX_TIMER_DELAY_MS,
    ]);
  });

  it("splits a wait past the 32-bit timer limit without losing time", () => {
    const total = PROVIDER_RETRY_MAX_TIMER_DELAY_MS * 2 + 500;
    const slices = retryWaitSlices(total);
    expect(slices).toHaveLength(3);
    expect(slices.every((slice) => slice <= PROVIDER_RETRY_MAX_TIMER_DELAY_MS)).toBe(true);
    expect(slices.reduce((sum, slice) => sum + slice, 0)).toBe(total);
  });
});
