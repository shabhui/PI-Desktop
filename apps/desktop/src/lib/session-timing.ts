import type { UiMessage } from "@pi-desktop/shared";

export type SessionTimingMessage = Pick<
  UiMessage,
  | "role"
  | "responseDurationMs"
  | "providerWaitMs"
  | "modelStreamDurationMs"
  | "toolDurationMs"
  | "toolCompletedAt"
  | "toolStatus"
  | "parentToolCallId"
  | "nestedParentToolCallId"
  | "status"
  | "createdAt"
>;

export type SessionTimingPage = {
  messages?: SessionTimingMessage[];
  messageStart?: number;
  hasMoreBefore?: boolean;
};

export type SessionTiming = {
  elapsedMs: number;
  modelResponseMs: number;
  modelResponsePercent?: number;
};

export type SessionTimingTotals = {
  providerWaitMs: number;
  hasProviderWait: boolean;
  modelResponseMs: number;
  hasModelResponse: boolean;
  toolMessageCount: number;
  toolTimingCount: number;
  toolIntervals: Array<{ start: number; end: number }>;
  unplacedToolDurationMs: number;
};

export type SessionTimingBreakdown = {
  networkRequestMs?: number;
  networkRequestPercent?: number;
  modelResponseMs?: number;
  modelResponsePercent?: number;
  toolCallMs?: number;
  toolCallPercent?: number;
};

const SESSION_TIMING_PAGE_SIZE = 1_000;
const SESSION_TIMING_CONTENT_LIMIT = 256;

/** Sum completed top-level model responses. Delegate calls can overlap. */
export function sumModelResponseDuration(
  messages: readonly SessionTimingMessage[],
): number {
  return messages.reduce((total, message) => {
    if (
      message.role !== "assistant" ||
      message.parentToolCallId ||
      message.nestedParentToolCallId
    ) {
      return total;
    }
    const duration = message.responseDurationMs;
    return typeof duration === "number" && Number.isFinite(duration) && duration > 0
      ? total + duration
      : total;
  }, 0);
}

function finiteDuration(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function emptySessionTimingTotals(): SessionTimingTotals {
  return {
    providerWaitMs: 0,
    hasProviderWait: false,
    modelResponseMs: 0,
    hasModelResponse: false,
    toolMessageCount: 0,
    toolTimingCount: 0,
    toolIntervals: [],
    unplacedToolDurationMs: 0,
  };
}

function addSessionTimingTotals(
  target: SessionTimingTotals,
  source: SessionTimingTotals,
): SessionTimingTotals {
  target.providerWaitMs += source.providerWaitMs;
  target.hasProviderWait ||= source.hasProviderWait;
  target.modelResponseMs += source.modelResponseMs;
  target.hasModelResponse ||= source.hasModelResponse;
  target.toolMessageCount += source.toolMessageCount;
  target.toolTimingCount += source.toolTimingCount;
  for (const interval of source.toolIntervals) target.toolIntervals.push(interval);
  target.unplacedToolDurationMs += source.unplacedToolDurationMs;
  return target;
}

export function combineSessionTimingTotals(
  left: SessionTimingTotals,
  right: SessionTimingTotals,
): SessionTimingTotals {
  return addSessionTimingTotals(
    { ...left, toolIntervals: [...left.toolIntervals] },
    right,
  );
}

/** Cache immutable renderer rows, never live durations or a session's history. */
export function createSessionTimingSnapshotCache() {
  const completed = new WeakMap<SessionTimingMessage, {
    modelResponseMs: number;
    totals: SessionTimingTotals;
  }>();
  return (messages: readonly SessionTimingMessage[]) => {
    const liveMessages: SessionTimingMessage[] = [];
    const completedTotals = emptySessionTimingTotals();
    let completedModelResponseMs = 0;
    for (const message of messages) {
      if (
        message.status === "streaming" ||
        (message.role === "tool" && message.toolStatus === "running")
      ) {
        liveMessages.push(message);
        continue;
      }
      let cached = completed.get(message);
      if (!cached) {
        cached = {
          modelResponseMs: sumModelResponseDuration([message]),
          totals: sumSessionTiming([message], 0),
        };
        completed.set(message, cached);
      }
      completedModelResponseMs += cached.modelResponseMs;
      addSessionTimingTotals(completedTotals, cached.totals);
    }
    return { liveMessages, completedTotals, completedModelResponseMs };
  };
}

/** Sum persisted timing signals without double-counting nested delegate work. */
export function sumSessionTiming(
  messages: readonly SessionTimingMessage[],
  now = Date.now(),
): SessionTimingTotals {
  const totals = emptySessionTimingTotals();

  for (const message of messages) {
    const isNested =
      Boolean(message.parentToolCallId) || Boolean(message.nestedParentToolCallId);
    if (isNested) continue;

    if (message.role === "assistant") {
      const providerWaitMs = finiteDuration(message.providerWaitMs);
      if (providerWaitMs !== undefined) {
        totals.providerWaitMs += providerWaitMs;
        totals.hasProviderWait = true;
      }

      const modelResponseMs =
        finiteDuration(message.modelStreamDurationMs) ??
        finiteDuration(message.responseDurationMs);
      if (modelResponseMs !== undefined) {
        totals.modelResponseMs += modelResponseMs;
        totals.hasModelResponse = true;
      }

      if (message.status === "streaming") {
        const startedAt = Date.parse(message.createdAt);
        if (Number.isFinite(startedAt)) {
          totals.modelResponseMs += Math.max(0, now - startedAt);
          totals.hasModelResponse = true;
        }
      }
      continue;
    }

    if (message.role !== "tool") continue;
    totals.toolMessageCount += 1;
    const storedDurationMs = finiteDuration(message.toolDurationMs);
    const startedAt = Date.parse(message.createdAt);
    const isRunning = message.toolStatus === "running" || message.status === "streaming";
    const durationMs =
      isRunning && Number.isFinite(startedAt)
        ? Math.max(storedDurationMs ?? 0, now - startedAt)
        : storedDurationMs;
    if (durationMs === undefined) continue;

    totals.toolTimingCount += 1;
    if (Number.isFinite(startedAt)) {
      const completedAt = message.toolCompletedAt
        ? Date.parse(message.toolCompletedAt)
        : Number.NaN;
      totals.toolIntervals.push({
        start: startedAt,
        end:
          Number.isFinite(completedAt) && completedAt >= startedAt
            ? completedAt
            : startedAt + durationMs,
      });
    } else {
      totals.unplacedToolDurationMs += durationMs;
    }
  }

  return totals;
}

function unionDurationMs(intervals: readonly { start: number; end: number }[]): number {
  const sorted = intervals
    .filter((interval) => Number.isFinite(interval.start) && interval.end > interval.start)
    .slice()
    .sort((left, right) => left.start - right.start);
  if (sorted.length === 0) return 0;

  let total = 0;
  let start = sorted[0].start;
  let end = sorted[0].end;
  for (const interval of sorted.slice(1)) {
    if (interval.start <= end) {
      end = Math.max(end, interval.end);
    } else {
      total += end - start;
      start = interval.start;
      end = interval.end;
    }
  }
  return total + end - start;
}

export function calculateSessionTimingBreakdown({
  elapsedMs,
  messages,
  now,
  earlierTotals = emptySessionTimingTotals(),
  activeNetworkRequestStartedAt,
}: {
  elapsedMs: number;
  messages: readonly SessionTimingMessage[];
  now: number;
  earlierTotals?: SessionTimingTotals;
  activeNetworkRequestStartedAt?: number;
}): SessionTimingBreakdown {
  const totals = combineSessionTimingTotals(
    earlierTotals,
    sumSessionTiming(messages, now),
  );
  const activeNetworkWaitMs =
    typeof activeNetworkRequestStartedAt === "number" &&
    Number.isFinite(activeNetworkRequestStartedAt)
      ? Math.max(0, now - activeNetworkRequestStartedAt)
      : 0;
  const networkRequestMs = totals.providerWaitMs + activeNetworkWaitMs;
  const hasNetworkRequest = totals.hasProviderWait || activeNetworkWaitMs > 0;
  const toolCallMs =
    totals.toolMessageCount === 0 ||
    totals.toolTimingCount === totals.toolMessageCount
      ? unionDurationMs(totals.toolIntervals) + totals.unplacedToolDurationMs
      : undefined;
  const percent = (durationMs: number | undefined) =>
    durationMs !== undefined && elapsedMs > 0
      ? Math.round((durationMs / elapsedMs) * 100)
      : undefined;

  return {
    ...(hasNetworkRequest
      ? {
          networkRequestMs,
          networkRequestPercent: percent(networkRequestMs),
        }
      : {}),
    ...(totals.hasModelResponse
      ? {
          modelResponseMs: totals.modelResponseMs,
          modelResponsePercent: percent(totals.modelResponseMs),
        }
      : {}),
    ...(toolCallMs !== undefined
      ? {
          toolCallMs,
          toolCallPercent: percent(toolCallMs),
        }
      : {}),
  };
}

/**
 * Read earlier transcript pages for the response durations omitted from the
 * renderer's bounded transcript window. The callback keeps this helper
 * independent of the IPC transport and easy to test.
 */
export async function loadEarlierModelResponseDuration(
  messageBefore: number,
  readPage: (options: {
    messageBefore: number;
    messageLimit: number;
    contentLimit: number;
  }) => Promise<SessionTimingPage | null>,
  signal?: AbortSignal,
): Promise<number> {
  let before = messageBefore;
  let total = 0;

  while (before > 0) {
    if (signal?.aborted) return total;
    const page = await readPage({
      messageBefore: before,
      messageLimit: SESSION_TIMING_PAGE_SIZE,
      contentLimit: SESSION_TIMING_CONTENT_LIMIT,
    });
    if (signal?.aborted) return total;
    if (!page) throw new Error("Session timing history is unavailable");

    total += sumModelResponseDuration(page.messages ?? []);
    if (page.hasMoreBefore !== true) return total;

    const nextBefore = page.messageStart;
    if (
      typeof nextBefore !== "number" ||
      !Number.isInteger(nextBefore) ||
      nextBefore < 0 ||
      nextBefore >= before
    ) {
      throw new Error("Session timing history did not advance");
    }
    before = nextBefore;
  }

  return total;
}

export async function loadEarlierSessionTiming(
  messageBefore: number,
  readPage: (options: {
    messageBefore: number;
    messageLimit: number;
    contentLimit: number;
  }) => Promise<SessionTimingPage | null>,
  signal?: AbortSignal,
): Promise<SessionTimingTotals> {
  let before = messageBefore;
  let totals = emptySessionTimingTotals();

  while (before > 0) {
    if (signal?.aborted) return totals;
    const page = await readPage({
      messageBefore: before,
      messageLimit: SESSION_TIMING_PAGE_SIZE,
      contentLimit: SESSION_TIMING_CONTENT_LIMIT,
    });
    if (signal?.aborted) return totals;
    if (!page) throw new Error("Session timing history is unavailable");

    totals = combineSessionTimingTotals(
      totals,
      sumSessionTiming(page.messages ?? []),
    );
    if (page.hasMoreBefore !== true) return totals;

    const nextBefore = page.messageStart;
    if (
      typeof nextBefore !== "number" ||
      !Number.isInteger(nextBefore) ||
      nextBefore < 0 ||
      nextBefore >= before
    ) {
      throw new Error("Session timing history did not advance");
    }
    before = nextBefore;
  }

  return totals;
}

export function calculateSessionTiming({
  createdAt,
  updatedAt,
  isRunning,
  messages,
  now,
  earlierModelResponseMs = 0,
  activeModelRequestStartedAt,
}: {
  createdAt: string;
  updatedAt: string;
  isRunning: boolean;
  messages: readonly SessionTimingMessage[];
  now: number;
  earlierModelResponseMs?: number;
  activeModelRequestStartedAt?: number;
}): SessionTiming | undefined {
  const startedAt = Date.parse(createdAt);
  if (!Number.isFinite(startedAt)) return undefined;

  const updatedAtMs = Date.parse(updatedAt);
  const endedAt = isRunning || !Number.isFinite(updatedAtMs) ? now : updatedAtMs;
  const elapsedMs = Math.max(0, endedAt - startedAt);
  const streamingMessageStartedAt = [...messages]
    .reverse()
    .find(
      (message) =>
        message.role === "assistant" &&
        !message.parentToolCallId &&
        !message.nestedParentToolCallId &&
        message.status === "streaming",
    )?.createdAt;
  const streamingStartedAt = streamingMessageStartedAt
    ? Date.parse(streamingMessageStartedAt)
    : Number.NaN;
  const activeStartedAt = Number.isFinite(activeModelRequestStartedAt)
    ? activeModelRequestStartedAt
    : streamingStartedAt;
  const activeModelResponseMs =
    isRunning &&
    typeof activeStartedAt === "number" &&
    Number.isFinite(activeStartedAt)
      ? Math.max(0, now - activeStartedAt)
      : 0;
  const modelResponseMs =
    Math.max(0, earlierModelResponseMs) +
    sumModelResponseDuration(messages) +
    activeModelResponseMs;

  return {
    elapsedMs,
    modelResponseMs,
    modelResponsePercent:
      elapsedMs > 0 ? Math.round((modelResponseMs / elapsedMs) * 100) : undefined,
  };
}
