import { describe, expect, it, vi } from "vitest";
import plugin from "./index.js";

describe("ClawXRouter plugin entry", () => {
  it("skips non-full registration modes used by CLI metadata generation", () => {
    const registerProvider = vi.fn();
    const registerService = vi.fn();
    const registerHttpRoute = vi.fn();

    expect(() =>
      plugin.register({
        id: plugin.id,
        name: plugin.name,
        description: plugin.description,
        source: "/tmp/clawxrouter-test",
        registrationMode: "cli-metadata",
        config: {},
        pluginConfig: {},
        runtime: {} as never,
        logger: {
          info: () => undefined,
          warn: () => undefined,
          error: () => undefined,
          debug: () => undefined,
        },
        registerTool: vi.fn(),
        registerHook: vi.fn(),
        registerHttpRoute,
        registerChannel: vi.fn(),
        registerGatewayMethod: vi.fn(),
        registerCli: vi.fn(),
        registerCliBackend: vi.fn(),
        registerService,
        registerProvider,
        registerSpeechProvider: vi.fn(),
        registerMediaUnderstandingProvider: vi.fn(),
        registerImageGenerationProvider: vi.fn(),
        registerWebSearchProvider: vi.fn(),
        registerInteractiveHandler: vi.fn(),
        onConversationBindingResolved: vi.fn(),
        registerCommand: vi.fn(),
        registerContextEngine: vi.fn(),
        registerMemoryPromptSection: vi.fn(),
        registerMemoryFlushPlan: vi.fn(),
        registerMemoryRuntime: vi.fn(),
        registerMemoryEmbeddingProvider: vi.fn(),
        resolvePath: (value: string) => value,
        on: vi.fn(),
      }),
    ).not.toThrow();

    expect(registerProvider).not.toHaveBeenCalled();
    expect(registerService).not.toHaveBeenCalled();
    expect(registerHttpRoute).not.toHaveBeenCalled();
  });
});
