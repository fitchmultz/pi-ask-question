/** pi extension entry: registers the ask_question tool and /grill-me mode. */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerGrillMe } from "./lib/grill-me.ts";
import { createQuestionObserver } from "./lib/question-observer.ts";
import { createAskQuestionTool } from "./lib/tool.ts";

export default function askQuestion(pi: ExtensionAPI): void {
  pi.registerTool(createAskQuestionTool(pi, createQuestionObserver(pi)));
  registerGrillMe(pi);
}
