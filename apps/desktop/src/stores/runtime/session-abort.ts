import type { UiMessage } from "@pi-desktop/shared";
import { api } from "../../lib/api";
import type { StoreAccess } from "../slices/types";
import type { SessionRuntime, SubmittedComposerDraft } from "./session-runtime";

export type SessionAbortContext = {
  readonly turnId: string | undefined;
  readonly submittedDraft: SubmittedComposerDraft | undefined;
  messages: () => UiMessage[];
  isCurrent: () => boolean;
  abort: () => Promise<boolean>;
};

type PendingAbort = {
  context: SessionAbortContext;
  completion: Promise<void>;
};

// Both composer Stop and project-deletion Stop belong to the same store runtime.
// The weak key releases the coordinator with that store, not with a pane switch.
const pendingByRuntime = new WeakMap<SessionRuntime, Map<string, PendingAbort>>();

export function runSessionAbort(
  access: StoreAccess,
  runtime: SessionRuntime,
  sessionId: string,
  operation: (context: SessionAbortContext) => Promise<void>,
): Promise<void> {
  let pending = pendingByRuntime.get(runtime);
  if (!pending) {
    pending = new Map();
    pendingByRuntime.set(runtime, pending);
  }
  const active = pending.get(sessionId);
  if (active?.context.isCurrent()) return active.completion;

  const initial = access.get();
  const turnId = initial.agentStatuses?.[sessionId]?.currentTurnId;
  const submittedDraft = runtime.submittedComposerDrafts.get(sessionId);
  const previousResult = initial.latestTurnResults?.[sessionId];
  const existed = initial.sessions.some((session) => session.id === sessionId);
  const messages = () => {
    const state = access.get();
    return state.activeSessionId === sessionId ? state.messages
      : runtime.sessionTranscriptCache.get(sessionId) ?? state.retainedTranscripts[sessionId] ?? [];
  };
  const latestUserId = messages().findLast((message) => message.role === "user")?.id;
  const isCurrent = () => {
    const current = access.get();
    if (existed && !current.sessions.some((session) => session.id === sessionId)) return false;
    const currentTurnId = current.agentStatuses?.[sessionId]?.currentTurnId;
    if (turnId && currentTurnId && currentTurnId !== turnId) return false;
    const submission = runtime.submittedComposerDrafts.get(sessionId);
    if (submission && submission !== submittedDraft) return false;
    // Terminal events remove currentTurnId and the submission. The user row
    // still identifies a newer turn even when that turn has already completed.
    if (messages().findLast((message) => message.role === "user")?.id !== latestUserId) return false;
    const result = current.latestTurnResults?.[sessionId];
    return !(turnId && result && result !== previousResult && result.turnId !== turnId);
  };
  let acknowledged = false;
  const context: SessionAbortContext = {
    turnId, submittedDraft, messages, isCurrent,
    abort: async () => {
      if (!isCurrent()) return false;
      const result = await api.abort(sessionId, turnId);
      acknowledged = result?.ok !== false && result?.aborted !== false;
      return acknowledged;
    },
  };
  const completion = Promise.resolve().then(() => operation(context)).catch((error: unknown) => {
    // A failed cancellation must release sendPrompt's wait, but preserve its
    // snapshot so another Stop can retry. Never delete a replacement submission.
    submittedDraft?.resolveAbort?.(false);
    if (submittedDraft) {
      delete submittedDraft.abortResolution;
      delete submittedDraft.resolveAbort;
    }
    // A failed post-abort history read cannot undo the backend's acknowledgement.
    // It still must not settle a replacement turn that arrived during that read.
    if (acknowledged && isCurrent()) {
      access.set((state) => ({
        isRunning: state.activeSessionId === sessionId ? false : state.isRunning,
        runningSessions: { ...state.runningSessions, [sessionId]: false },
      }));
    }
    const message = error instanceof Error ? error.message : String(error);
    if (isCurrent() && access.get().activeSessionId === sessionId) {
      access.set({ error: message, errorCode: (error as { code?: string })?.code ?? null });
    } else {
      access.get().showToast(message, { variant: "error" });
    }
    throw error;
  });
  const entry = { context, completion };
  pending.set(sessionId, entry);
  const release = () => {
    if (pending.get(sessionId) === entry) pending.delete(sessionId);
  };
  // Use both handlers rather than an ignored rejecting finally() promise.
  void completion.then(release, release);
  return completion;
}
