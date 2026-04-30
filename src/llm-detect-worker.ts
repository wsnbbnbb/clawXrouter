import { runAsWorker } from "synckit";
import { detectByLocalModel } from "./local-model.js";
import type { DetectionContext, DetectionResult, PrivacyConfig } from "./types.js";

runAsWorker(async (context: DetectionContext, config: PrivacyConfig): Promise<DetectionResult> => {
  return await detectByLocalModel(context, config);
});
