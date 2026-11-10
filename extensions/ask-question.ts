/** pi extension entry: registers the ask_question tool and /grill-me mode. */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerGrillMe } from "./lib/grill-me.ts";
import { createQuestionObserver } from "./lib/question-observer.ts";
import { createAskQuestionTool } from "./lib/tool.ts";

export default function askQuestion(pi: ExtensionAPI): void {
  const tool = createAskQuestionTool(pi, createQuestionObserver(pi));
  pi.registerTool(tool);
  // A session without a dialog UI cannot show a question: print mode, JSON mode, and SDK hosts that
  // bind no UI, such as subagent children. Pi cannot unregister a tool; a hidden one is not declared.
  let withdrawn = false;
  const withdrawWithoutUi = (_event: unknown, ctx: ExtensionContext): void => {
    if (!ctx.hasUI && !withdrawn) {
      pi.registerTool({ ...tool, exposure: "hidden" });
      withdrawn = true;
    }
  };
  pi.on("session_start", withdrawWithoutUi);
  // Pi announces no session start to an SDK session that never binds extensions, and none after a
  // reload unless the host bound a UI, command actions, a shutdown handler or an error listener.
  // This event precedes the first request of every run.
  pi.on("before_agent_start", withdrawWithoutUi);
  registerGrillMe(pi);
}
