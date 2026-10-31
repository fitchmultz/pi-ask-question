import { createHash, randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

type Target = {
  promptId: string;
  questionId: string;
  revision: number;
  deadline: number;
};

type Waiting = Target & {
  status: "waiting";
  timeoutActive: boolean;
  question: string;
  options: string[];
  multiSelect: boolean;
};

function record(data: unknown): Record<string, unknown> | undefined {
  return data !== null && typeof data === "object" ? data as Record<string, unknown> : undefined;
}

function validId(value: unknown): value is string {
  return typeof value === "string" && Boolean(value.trim()) && value.length <= 128;
}

// Runtime-local receipts attest application only. They are not a durable answer queue.
export function createQuestionObserver(pi: ExtensionAPI) {
  const ownerGeneration = randomUUID();
  const protocolVersion = 1;
  const accepted = new Map<string, Target & { requestId: string; answerFingerprint: string }>();
  let nativeRoot: string | undefined;
  let mode: ExtensionContext["mode"] | undefined;
  let current: (() => Waiting | undefined) | undefined;

  const identity = () => ({ protocolVersion, ownerGeneration, nativeRoot });
  const identify = (ctx: ExtensionContext) => {
    nativeRoot = ctx.sessionManager.getSessionId();
    mode = ctx.mode;
  };
  const unsubscribeQuery = pi.events.on("pi-ask-question:query", (data) => {
    const query = record(data);
    if (!query || !validId(query.queryId)) return;
    const waiting = query.protocolVersion === protocolVersion && mode === "tui" ? current?.() : undefined;
    pi.events.emit("pi-ask-question:snapshot", {
      queryId: query.queryId, ...identity(), mode,
      status: query.protocolVersion !== protocolVersion || mode !== "tui" ? "unsupported" : "idle",
      ...waiting,
    });
  });
  const unsubscribeLookup = pi.events.on("pi-ask-question:lookup", (data) => {
    const query = record(data);
    if (!query || !validId(query.queryId) || !validId(query.requestId) || typeof query.promptId !== "string") return;
    const status = query.protocolVersion !== protocolVersion || mode !== "tui" ? "unsupported"
      : query.ownerGeneration !== ownerGeneration || query.nativeRoot !== nativeRoot ? "stale" : undefined;
    const receipt = status ? undefined : accepted.get(JSON.stringify([query.promptId, query.requestId]));
    pi.events.emit("pi-ask-question:lookup-result", {
      queryId: query.queryId, ...identity(), promptId: query.promptId, requestId: query.requestId,
      status: status ?? (receipt ? "answered" : "unknown"), ...receipt,
    });
  });
  pi.on("session_start", (_event, ctx) => { identify(ctx); });
  pi.on("session_shutdown", () => {
    current = undefined;
    accepted.clear();
    unsubscribeQuery();
    unsubscribeLookup();
  });

  return {
    identify,
    identity,
    watch(getState: () => Waiting | undefined) {
      current = getState;
      return () => { if (current === getState) current = undefined; };
    },
    matches(request: Record<string, unknown>, deadline: number) {
      // Existing unversioned clients keep their original prompt/revision contract.
      return request.protocolVersion === undefined ||
        (request.protocolVersion === protocolVersion && request.ownerGeneration === ownerGeneration &&
          request.nativeRoot === nativeRoot && request.deadline === deadline);
    },
    accept(target: Target, requestId: string, answer: string | string[]) {
      const answerFingerprint = createHash("sha256")
        .update(JSON.stringify([protocolVersion, ownerGeneration, nativeRoot, target.promptId,
          target.questionId, target.revision, target.deadline, answer]))
        .digest("hex");
      accepted.set(JSON.stringify([target.promptId, requestId]), { ...target, requestId, answerFingerprint });
      if (accepted.size > 1024) accepted.delete(accepted.keys().next().value!);
    },
  };
}

export type QuestionObserver = ReturnType<typeof createQuestionObserver>;
