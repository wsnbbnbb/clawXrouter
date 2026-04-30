import { runAsWorker } from "synckit";
import { desensitizeWithLocalModel } from "./local-model.js";
import type { PrivacyConfig } from "./types.js";

runAsWorker(
  async (
    content: string,
    config: PrivacyConfig,
    sessionKey?: string,
  ): Promise<{ desensitized: string; wasModelUsed: boolean; failed?: boolean }> => {
    return await desensitizeWithLocalModel(content, config, sessionKey);
  },
);
