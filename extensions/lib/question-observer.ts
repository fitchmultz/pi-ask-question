/** Runtime-local observer for the cooperative answer-bus protocol. */

import { hash, randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isRecord, validId } from "./validate.ts";

/** A prompt target: which prompt, question, and revision an answer applies to. */
export type Target = {
  promptId: string;
  questionId: string;
  revision: number;
  deadline: number;
};

/** The waiting state an owner publishes while a prompt is accepting answers. */
export type Waiting = Target & {
  status: "waiting";
  timeoutActive: boolean;
  question: string;
  options: string[];
  multiSelect: boolean;
};

/** Identity fields shared by every protocol message from one owner. */
export type ObserverIdentity = {
  protocolVersion: number;
  ownerGeneration: string;
  nativeRoot: string | undefined;
};

/** A recorded answer receipt: target plus request identity and fingerprint. */
type Receipt = Target & { requestId: string; answerFingerprint: string };

/** The observer surface consumed by the ask UI. */
export type QuestionObserver = {
  identify: (ctx: ExtensionContext) => void;
  identity: () => ObserverIdentity;
  watch: (getState: () => Waiting | undefined) => () => void;
  matches: (request: Record<string, unknown>, deadline: number) => boolean;
  accept: (target: Target, requestId: string, answer: string | string[]) => void;
};

/**
 * Track the owning extension instance on the cooperative answer bus.
 * Runtime-local receipts attest application only. They are not a durable answer queue.
 */
class RuntimeObserver implements QuestionObserver {
  private readonly pi: ExtensionAPI;
  private readonly ownerGeneration = randomUUID();
  private readonly protocolVersion = 1;
  private readonly accepted = new Map<string, Receipt>();
  private readonly unsubscribeQuery: () => void;
  private readonly unsubscribeLookup: () => void;
  private nativeRoot: string | undefined;
  private mode: ExtensionContext["mode"] | undefined;
  private current: (() => Waiting | undefined) | undefined;

  constructor(pi: ExtensionAPI) {
    this.pi = pi;
    this.unsubscribeQuery = pi.events.on("pi-ask-question:query", (data) => {
      if (!isRecord(data)) {
        return;
      }
      this.emitSnapshot(data);
    });
    this.unsubscribeLookup = pi.events.on("pi-ask-question:lookup", (data) => {
      if (!isRecord(data)) {
        return;
      }
      this.emitLookupResult(data);
    });
    pi.on("session_start", (_event, ctx) => {
      this.identify(ctx);
    });
    pi.on("session_shutdown", () => {
      this.current = undefined;
      this.accepted.clear();
      this.unsubscribeQuery();
      this.unsubscribeLookup();
    });
  }

  identify(ctx: ExtensionContext): void {
    this.nativeRoot = ctx.sessionManager.getSessionId();
    this.mode = ctx.mode;
  }

  identity(): ObserverIdentity {
    return {
      protocolVersion: this.protocolVersion,
      ownerGeneration: this.ownerGeneration,
      nativeRoot: this.nativeRoot,
    };
  }

  watch(getState: () => Waiting | undefined): () => void {
    this.current = getState;
    return () => {
      if (this.current === getState) {
        this.current = undefined;
      }
    };
  }

  matches(request: Record<string, unknown>, deadline: number): boolean {
    // Existing unversioned clients keep their original prompt/revision contract.
    return (
      request.protocolVersion === undefined ||
      (request.protocolVersion === this.protocolVersion &&
        request.ownerGeneration === this.ownerGeneration &&
        request.nativeRoot === this.nativeRoot &&
        request.deadline === deadline)
    );
  }

  accept(target: Target, requestId: string, answer: string | string[]): void {
    const fingerprint = hash(
      "sha256",
      JSON.stringify([
        this.protocolVersion,
        this.ownerGeneration,
        this.nativeRoot,
        target.promptId,
        target.questionId,
        target.revision,
        target.deadline,
        answer,
      ]),
      "hex",
    );
    this.accepted.set(JSON.stringify([target.promptId, requestId]), {
      ...target,
      requestId,
      answerFingerprint: fingerprint,
    });
    if (this.accepted.size > 1024) {
      const oldest = this.accepted.keys().next().value;
      if (oldest !== undefined) {
        this.accepted.delete(oldest);
      }
    }
  }

  private emitSnapshot(query: Record<string, unknown>): void {
    if (!validId(query.queryId)) {
      return;
    }
    const waiting =
      query.protocolVersion === this.protocolVersion && this.mode === "tui"
        ? this.current?.()
        : undefined;
    this.pi.events.emit("pi-ask-question:snapshot", {
      queryId: query.queryId,
      ...this.identity(),
      mode: this.mode,
      status: this.snapshotStatus(query),
      ...waiting,
    });
  }

  private snapshotStatus(query: Record<string, unknown>): "unsupported" | "idle" {
    if (query.protocolVersion !== this.protocolVersion || this.mode !== "tui") {
      return "unsupported";
    }
    return "idle";
  }

  private emitLookupResult(query: Record<string, unknown>): void {
    if (
      !validId(query.queryId) ||
      !validId(query.requestId) ||
      typeof query.promptId !== "string"
    ) {
      return;
    }
    const status = lookupStatus(query, this.owner());
    const receipt =
      status === undefined
        ? this.accepted.get(JSON.stringify([query.promptId, query.requestId]))
        : undefined;
    this.pi.events.emit("pi-ask-question:lookup-result", {
      queryId: query.queryId,
      ...this.identity(),
      promptId: query.promptId,
      requestId: query.requestId,
      status: status ?? (receipt !== undefined ? "answered" : "unknown"),
      ...receipt,
    });
  }

  private owner(): ObserverIdentity & { mode: ExtensionContext["mode"] | undefined } {
    return { ...this.identity(), mode: this.mode };
  }
}

export function createQuestionObserver(pi: ExtensionAPI): QuestionObserver {
  return new RuntimeObserver(pi);
}

function lookupStatus(
  query: Record<string, unknown>,
  owner: ObserverIdentity & { mode: ExtensionContext["mode"] | undefined },
): "unsupported" | "stale" | undefined {
  if (query.protocolVersion !== owner.protocolVersion || owner.mode !== "tui") {
    return "unsupported";
  }
  if (query.ownerGeneration !== owner.ownerGeneration || query.nativeRoot !== owner.nativeRoot) {
    return "stale";
  }
  return undefined;
}
