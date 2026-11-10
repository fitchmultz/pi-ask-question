/** pi extension entry: registers the ask_question tool and /grill-me mode. */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerGrillMe } from "./lib/grill-me.ts";
import { createQuestionObserver } from "./lib/question-observer.ts";
import { createAskQuestionTool } from "./lib/tool.ts";

export default function askQuestion(pi: ExtensionAPI): void {
  const tool = createAskQuestionTool(pi, createQuestionObserver(pi));
  pi.registerTool(tool);
  // A session without a dialog UI cannot show a question: print mode, JSON mode, and SDK hosts that
  // bind no UI, such as subagent children. Pi cannot unregister a tool; a hidden one is not declared.
  pi.on("session_start", async (_event, ctx): Promise<void> => {
    if (!ctx.hasUI) {
      pi.registerTool({ ...tool, exposure: "hidden" });
    }
  });
  registerGrillMe(pi);
}
