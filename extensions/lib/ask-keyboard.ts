/** Keyboard-mode ask flow: full-screen form plus cooperative-bus wiring. */

import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { QuestionForm } from "./question-form.ts";
import type { QuestionObserver } from "./question-observer.ts";
import type { NormalizedQuestion, QuestionResult, QuestionTimeout } from "./types.ts";

/** Ask through the full-screen keyboard UI with cooperative-bus support. */
export async function askWithKeyboard(params: {
  questions: NormalizedQuestion[];
  ui: ExtensionContext["ui"];
  pi: ExtensionAPI;
  observer: QuestionObserver;
  timeout: QuestionTimeout;
  signal: AbortSignal | undefined;
}): Promise<QuestionResult> {
  const signal = params.signal;
  if (signal?.aborted === true) {
    return { answers: [], cancelled: true };
  }
  const promptId = randomUUID();
  let form: QuestionForm | undefined;
  return params.ui
    .custom<QuestionResult>(
      (tui, theme, keys, done) => {
        form = new QuestionForm(
          {
            questions: params.questions,
            promptId,
            ui: params.ui,
            pi: params.pi,
            observer: params.observer,
            timeout: params.timeout,
            signal,
            onDone: done,
          },
          tui,
          theme,
          keys,
        );
        return form;
      },
      {
        overlay: true,
        overlayOptions: { width: "100%", maxHeight: "100%", anchor: "bottom-center" },
        onHandle: (handle) => {
          form?.attachOverlay(handle);
        },
      },
    )
    .finally(() => {
      form?.release();
    });
}
