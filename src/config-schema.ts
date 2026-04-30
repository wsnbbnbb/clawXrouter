import { join } from "node:path";
import { Type } from "@sinclair/typebox";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";

export const clawXrouterConfigSchema = Type.Object({
  privacy: Type.Optional(
    Type.Object({
      enabled: Type.Optional(Type.Boolean()),
      s2Policy: Type.Optional(Type.Union([Type.Literal("proxy"), Type.Literal("local")])),
      proxyPort: Type.Optional(Type.Number()),
      checkpoints: Type.Optional(
        Type.Object({
          onUserMessage: Type.Optional(
            Type.Array(
              Type.Union([Type.Literal("ruleDetector"), Type.Literal("localModelDetector")]),
            ),
          ),
          onToolCallProposed: Type.Optional(
            Type.Array(
              Type.Union([Type.Literal("ruleDetector"), Type.Literal("localModelDetector")]),
            ),
          ),
          onToolCallExecuted: Type.Optional(
            Type.Array(
              Type.Union([Type.Literal("ruleDetector"), Type.Literal("localModelDetector")]),
            ),
          ),
        }),
      ),
      rules: Type.Optional(
        Type.Object({
          keywords: Type.Optional(
            Type.Object({
              S2: Type.Optional(Type.Array(Type.String())),
              S3: Type.Optional(Type.Array(Type.String())),
            }),
          ),
          patterns: Type.Optional(
            Type.Object({
              S2: Type.Optional(Type.Array(Type.String())),
              S3: Type.Optional(Type.Array(Type.String())),
            }),
          ),
          tools: Type.Optional(
            Type.Object({
              S2: Type.Optional(
                Type.Object({
                  tools: Type.Optional(Type.Array(Type.String())),
                  paths: Type.Optional(Type.Array(Type.String())),
                }),
              ),
              S3: Type.Optional(
                Type.Object({
                  tools: Type.Optional(Type.Array(Type.String())),
                  paths: Type.Optional(Type.Array(Type.String())),
                }),
              ),
            }),
          ),
        }),
      ),
      localModel: Type.Optional(
        Type.Object({
          enabled: Type.Optional(Type.Boolean()),
          type: Type.Optional(
            Type.Union([
              Type.Literal("openai-compatible"),
              Type.Literal("ollama-native"),
              Type.Literal("custom"),
            ]),
          ),
          provider: Type.Optional(Type.String()),
          model: Type.Optional(Type.String()),
          endpoint: Type.Optional(Type.String()),
          apiKey: Type.Optional(Type.String()),
          module: Type.Optional(Type.String()),
        }),
      ),
      guardAgent: Type.Optional(
        Type.Object({
          id: Type.Optional(Type.String()),
          workspace: Type.Optional(Type.String()),
          model: Type.Optional(Type.String()),
        }),
      ),
      localProviders: Type.Optional(Type.Array(Type.String())),
      toolAllowlist: Type.Optional(Type.Array(Type.String())),
      modelPricing: Type.Optional(
        Type.Record(
          Type.String(),
          Type.Object({
            inputPer1M: Type.Optional(Type.Number()),
            outputPer1M: Type.Optional(Type.Number()),
          }),
        ),
      ),
      session: Type.Optional(
        Type.Object({
          isolateGuardHistory: Type.Optional(Type.Boolean()),
          baseDir: Type.Optional(Type.String()),
          injectDualHistory: Type.Optional(Type.Boolean()),
          historyLimit: Type.Optional(Type.Number()),
        }),
      ),
      routers: Type.Optional(
        Type.Record(
          Type.String(),
          Type.Object({
            enabled: Type.Optional(Type.Boolean()),
            type: Type.Optional(
              Type.Union([
                Type.Literal("builtin"),
                Type.Literal("custom"),
                Type.Literal("configurable"),
              ]),
            ),
            module: Type.Optional(Type.String()),
            weight: Type.Optional(Type.Number()),
            options: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
          }),
        ),
      ),
      pipeline: Type.Optional(
        Type.Object({
          onUserMessage: Type.Optional(Type.Array(Type.String())),
          onToolCallProposed: Type.Optional(Type.Array(Type.String())),
          onToolCallExecuted: Type.Optional(Type.Array(Type.String())),
        }),
      ),
      redaction: Type.Optional(
        Type.Object({
          internalIp: Type.Optional(Type.Boolean()),
          email: Type.Optional(Type.Boolean()),
          envVar: Type.Optional(Type.Boolean()),
          creditCard: Type.Optional(Type.Boolean()),
          chinesePhone: Type.Optional(Type.Boolean()),
          chineseId: Type.Optional(Type.Boolean()),
          chineseAddress: Type.Optional(Type.Boolean()),
          pin: Type.Optional(Type.Boolean()),
        }),
      ),
    }),
  ),
});

export const defaultPrivacyConfig = {
  enabled: true,
  s2Policy: "proxy" as "proxy" | "local",
  proxyPort: 8403,
  checkpoints: {
    onUserMessage: ["ruleDetector" as const, "localModelDetector" as const],
    onToolCallProposed: ["ruleDetector" as const],
    onToolCallExecuted: ["ruleDetector" as const],
  },
  rules: {
    keywords: {
      S2: [] as string[],
      S3: [] as string[],
    },
    patterns: {
      S2: [] as string[],
      S3: [] as string[],
    },
    tools: {
      S2: { tools: [] as string[], paths: [] as string[] },
      S3: { tools: [] as string[], paths: [] as string[] },
    },
  },
  localModel: {
    enabled: true,
    type: "openai-compatible" as const,
    model: "openbmb/minicpm4.1",
    endpoint: "http://localhost:11434",
  },
  guardAgent: {
    id: "guard",
    workspace: join(resolveStateDir(process.env), "workspace-guard"),
    model: "ollama/openbmb/minicpm4.1",
  },
  localProviders: [] as string[],
  toolAllowlist: [] as string[],
  modelPricing: {
    "claude-sonnet-4.6": { inputPer1M: 3, outputPer1M: 15 },
    "claude-3.5-sonnet": { inputPer1M: 3, outputPer1M: 15 },
    "claude-3.5-haiku": { inputPer1M: 0.8, outputPer1M: 4 },
    "gpt-4o": { inputPer1M: 2.5, outputPer1M: 10 },
    "gpt-4o-mini": { inputPer1M: 0.15, outputPer1M: 0.6 },
    "o4-mini": { inputPer1M: 1.1, outputPer1M: 4.4 },
    "gemini-2.0-flash": { inputPer1M: 0.1, outputPer1M: 0.4 },
    "deepseek-chat": { inputPer1M: 0.27, outputPer1M: 1.1 },
  } as Record<string, { inputPer1M?: number; outputPer1M?: number }>,
  redaction: {
    internalIp: false,
    email: false,
    envVar: false,
    creditCard: false,
    chinesePhone: false,
    chineseId: false,
    chineseAddress: false,
    pin: false,
  },
  session: {
    isolateGuardHistory: true,
    baseDir: resolveStateDir(process.env),
    injectDualHistory: true,
    historyLimit: 20,
  },
  routers: {
    privacy: { enabled: true, type: "builtin" as const },
  } as Record<
    string,
    {
      enabled?: boolean;
      type?: "builtin" | "custom" | "configurable";
      module?: string;
      weight?: number;
      options?: Record<string, unknown>;
    }
  >,
  pipeline: {
    onUserMessage: ["privacy"],
    onToolCallProposed: ["privacy"],
    onToolCallExecuted: ["privacy"],
  },
};
