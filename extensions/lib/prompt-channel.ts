/** Publishes prompt state and processes cooperative remote answers on the shared bus. */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { QuestionObserver, Target } from "./question-observer.ts";
import {
  parseRemoteAnswerRequest,
  validateRemoteAnswer,
  type RemoteAnswerRequest,
  type ValidatedRemoteAnswer,
  type WaitingPromptState,
} from "./remote-answers.ts";
import { MAX_REMOTE_REQUESTS, type NormalizedQuestion, type QuestionTimeout } from "./types.ts";

/** The form surface the channel reads and drives. */
export type ChannelHost = {
  readonly finished: boolean;
  readonly editing: boolean;
  current: () => NormalizedQuestion | undefined;
  allAnswered: () => boolean;
  applyRemoteAnswer: (question: NormalizedQuestion, validated: ValidatedRemoteAnswer) => void;
  abort: () => void;
  finish: (cancelled: boolean) => void;
};

/** Wiring the channel needs from the registering ask flow. */
export type PromptChannelDeps = {
  pi: ExtensionAPI;
  observer: QuestionObserver;
  timeout: QuestionTimeout;
  signal: AbortSignal | undefined;
  promptId: string;
};

/** Bus channel for one prompt: state publication and remote answer handling. */
export class PromptChannel {
  private readonly deps: PromptChannelDeps;
  private readonly host: ChannelHost;
  private readonly unwatch: () => void;
  private readonly unsubscribeAnswer: () => void;
  private readonly acceptedRequests = new Set<string>();
  private revision = 0;
  private publishQueued = false;
  private closed = false;
  private announced = false;

  constructor(deps: PromptChannelDeps, host: ChannelHost) {
    this.deps = deps;
    this.host = host;
    this.unwatch = deps.observer.watch(() => this.waitingState());
    this.unsubscribeAnswer = deps.pi.events.on("pi-ask-question:answer", (data) => {
      this.handleRemoteAnswer(data);
    });
  }

  /** Advertise only after the native host has installed the form component. */
  announce(): void {
    this.announced = true;
    if (this.deps.signal?.aborted === true) {
      this.host.abort();
    } else {
      this.publishState();
    }
  }

  /** Stop watching and emit the closed state once. */
  release(): void {
    this.unwatch();
    this.unsubscribeAnswer();
    this.publishState();
  }

  stateChanged(): void {
    this.revision += 1;
    if (this.publishQueued) {
      return;
    }
    this.publishQueued = true;
    queueMicrotask(() => {
      this.publishQueued = false;
      this.publishState();
    });
  }

  publishState(): void {
    const waiting = this.waitingState();
    if (waiting === undefined) {
      if (!this.closed) {
        this.deps.pi.events.emit("pi-ask-question:state", {
          status: "closed",
          promptId: this.deps.promptId,
        });
      }
      this.closed = true;
      return;
    }
    this.closed = false;
    this.deps.pi.events.emit("pi-ask-question:state", waiting);
  }

  /** The prompt cannot accept or expose an answer right now. */
  private promptBusy(): boolean {
    return (
      this.host.finished ||
      this.deps.signal?.aborted === true ||
      this.host.editing ||
      (this.deps.timeout.active && Date.now() >= this.deps.timeout.deadline)
    );
  }

  private waitingState(): WaitingPromptState | undefined {
    const question = this.host.current();
    if (question === undefined || !this.announced || this.promptBusy()) {
      return undefined;
    }
    return {
      status: "waiting",
      ...this.deps.observer.identity(),
      promptId: this.deps.promptId,
      questionId: question.id,
      revision: this.revision,
      deadline: this.deps.timeout.deadline,
      timeoutActive: this.deps.timeout.active,
      question: question.question,
      options: [...question.options],
      multiSelect: question.multiSelect,
    };
  }

  private handleRemoteAnswer(data: unknown): void {
    const request = parseRemoteAnswerRequest(data);
    if (request === undefined) {
      return;
    }
    // Other live owners on the shared bus must not acknowledge this prompt.
    if (request.promptId !== this.deps.promptId) {
      return;
    }
    const receipt = (status: "answered" | "stale" | "invalid") =>
      this.deps.pi.events.emit("pi-ask-question:result", {
        requestId: request.requestId,
        promptId: this.deps.promptId,
        status,
      });
    const question = this.host.current();
    if (question === undefined || this.promptBusy()) {
      receipt("stale");
      return;
    }
    if (!this.targetsCurrentPrompt(request, question)) {
      receipt("stale");
      return;
    }
    const validated = validateRemoteAnswer(request.answer, question);
    if (validated === undefined || this.acceptedRequests.size >= MAX_REMOTE_REQUESTS) {
      receipt("invalid");
      return;
    }
    this.acceptRemoteAnswer(request, question, validated);
    receipt("answered");
  }

  private targetsCurrentPrompt(
    request: RemoteAnswerRequest,
    question: NormalizedQuestion,
  ): boolean {
    return (
      request.questionId === question.id &&
      request.revision === this.revision &&
      !this.acceptedRequests.has(request.requestId) &&
      this.deps.observer.matches(request, this.deps.timeout.deadline)
    );
  }

  private acceptRemoteAnswer(
    request: RemoteAnswerRequest,
    question: NormalizedQuestion,
    validated: ValidatedRemoteAnswer,
  ): void {
    const target: Target = {
      promptId: this.deps.promptId,
      questionId: question.id,
      revision: this.revision,
      deadline: this.deps.timeout.deadline,
    };
    this.acceptedRequests.add(request.requestId);
    this.deps.timeout.stop();
    this.host.applyRemoteAnswer(question, validated);
    if (this.host.allAnswered()) {
      this.host.finish(false);
    }
    this.forwardAccepted(target, request.requestId, validated);
  }

  private forwardAccepted(
    target: Target,
    requestId: string,
    validated: ValidatedRemoteAnswer,
  ): void {
    if (validated.kind === "text") {
      this.deps.observer.accept(target, requestId, validated.text);
    } else {
      this.deps.observer.accept(target, requestId, validated.options);
    }
  }
}
