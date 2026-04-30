import * as fs from "node:fs";
import * as path from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";
import {
  buildMainSessionPlaceholder,
  getGuardAgentConfig,
  isGuardSessionKey,
} from "./guard-agent.js";
import { getLiveConfig } from "./live-config.js";
import { desensitizeWithLocalModel } from "./local-model.js";
import {
  getDefaultMemoryManager,
  GUARD_SECTION_BEGIN,
  GUARD_SECTION_END,
} from "./memory-isolation.js";
import { CLAWXROUTER_S2_OPEN, CLAWXROUTER_S2_CLOSE } from "./privacy-proxy.js";
import { loadPrompt } from "./prompt-loader.js";
import { ensureModelMirrored, resolveOriginalProvider } from "./provider.js";
import { getGlobalPipeline } from "./router-pipeline.js";
import { detectByRules } from "./rules.js";
import {
  DualSessionManager,
  getDefaultSessionManager,
  type SessionMessage,
} from "./session-manager.js";
import {
  markSessionAsPrivate,
  trackSessionLevel,
  recordDetection,
  notifyDetectionStart,
  notifyGenerating,
  notifyLlmComplete,
  notifyInputEstimate,
  isSessionMarkedPrivate,
  stashDetection,
  getPendingDetection,
  consumeDetection,
  setActiveLocalRouting,
  clearActiveLocalRouting,
  clearSessionState,
  isActiveLocalRouting,
  resetTurnLevel,
  setSessionRouteLevel,
  getSessionRouteLevel,
  startNewLoop,
  getCurrentLoopId,
  stashDesensitizedToolResult,
  setLoopRouting,
} from "./session-state.js";
import { syncDesensitizeWithLocalModel } from "./sync-desensitize.js";
import { syncDetectByLocalModel } from "./sync-detect.js";
import { getGlobalCollector, lookupPricing } from "./token-stats.js";
import type { PrivacyConfig } from "./types.js";
import { isProtectedMemoryPath, redactSensitiveInfo, extractPathsFromParams } from "./utils.js";

function getPipelineConfig(): Record<string, unknown> {
  return { privacy: getLiveConfig() };
}

/**
 * Should this session read from the full (unredacted) memory track?
 *
 * Only sessions whose data stays entirely local may access MEMORY-FULL.md:
 *   - S3 active local routing (Guard Agent turn)
 *   - Guard sub-sessions (always local)
 *   - S2 with s2Policy === "local"
 *
 * S2-proxy sessions send data to cloud after desensitisation, so they MUST
 * read from the clean (already-redacted) MEMORY.md to avoid leaking PII
 * that regex-based tool_result_persist redaction might miss.
 */
function shouldUseFullMemoryTrack(sessionKey: string): boolean {
  if (isActiveLocalRouting(sessionKey)) return true;
  if (isGuardSessionKey(sessionKey)) return true;
  if (isSessionMarkedPrivate(sessionKey)) {
    const policy = getLiveConfig().s2Policy ?? "proxy";
    return policy === "local";
  }
  return false;
}

const DEFAULT_GUARD_AGENT_SYSTEM_PROMPT = `You are a privacy-aware analyst. Analyze the data the user provides. Do your job.

RULES:
1. Analyze the data directly. Do NOT write code. Do NOT generate programming examples or tutorials.
2. NEVER echo raw sensitive values (exact salary, SSN, bank account, password). Use generic references like "your base salary", "the SSN on file", etc.
3. You MAY discuss percentages, ratios, whether deductions are correct, anomalies, and recommendations.
4. Reply ONCE, then stop. No [message_id:] tags. No multi-turn simulation.
5. **Language rule: Reply in the SAME language the user writes in.** If the user writes in Chinese, reply entirely in Chinese. If the user writes in English, reply entirely in English.
6. Be concise and professional.

语言规则：必须使用与用户相同的语言回复。如果用户用中文提问，你必须用中文回答。`;

function getGuardAgentSystemPrompt(): string {
  return loadPrompt("guard-agent-system", DEFAULT_GUARD_AGENT_SYSTEM_PROMPT);
}

/**
 * Check if a tool is exempt from privacy pipeline detection and PII redaction.
 * Reads from the live config `toolAllowlist` (default: empty = no exemptions).
 */
function isToolAllowlisted(toolName: string): boolean {
  const allowlist = getLiveConfig().toolAllowlist;
  if (!allowlist || allowlist.length === 0) return false;
  return allowlist.includes(toolName);
}

/**
 * Resolve a usable session key from the hook context.
 *
 * OpenClaw passes `ctx.sessionKey` when the session was resolved from a
 * channel sender (--to / Telegram / Discord …).  But when the caller only
 * supplies `--session-id` (e.g. the `openclaw agent` CLI), sessionKey can
 * be `undefined`.  Fall back to `sessionId` so ClawXrouter detection still
 * runs in that scenario.
 */
function resolveHookSessionKey(ctx: { sessionKey?: string; sessionId?: string }): string {
  return ctx.sessionKey || ctx.sessionId || "";
}

// Workspace dir cache — set from first hook that has PluginHookAgentContext
let _cachedWorkspaceDir: string | undefined;

export function registerHooks(api: OpenClawPluginApi): void {
  const privacyCfgInit = getLiveConfig();
  const sessionBaseDir = privacyCfgInit.session?.baseDir;

  const memoryManager = getDefaultMemoryManager();
  memoryManager.initializeDirectories().catch((err) => {
    api.logger.error(`[ClawXrouter] Failed to initialize memory directories: ${String(err)}`);
  });

  getDefaultSessionManager(sessionBaseDir);

  api.on("before_model_resolve", async (event, ctx) => {
    try {
      const { prompt } = event;
      const sessionKey = resolveHookSessionKey(ctx);
      if (!sessionKey || !prompt) return;

      clearActiveLocalRouting(sessionKey);
      resetTurnLevel(sessionKey);
      consumeDetection(sessionKey);
      const loopId = startNewLoop(sessionKey, String(prompt));
      notifyDetectionStart(sessionKey, "onUserMessage", loopId);

      const privacyConfig = getLiveConfig();
      if (!privacyConfig.enabled) return;

      if (isGuardSessionKey(sessionKey)) {
        const guardCfg = getGuardAgentConfig(privacyConfig);
        if (guardCfg) {
          return { providerOverride: guardCfg.provider, modelOverride: guardCfg.modelName };
        }
        return;
      }

      if (ctx.workspaceDir) _cachedWorkspaceDir = ctx.workspaceDir;

      const rawMsg = String(prompt);
      if (shouldSkipMessage(rawMsg)) return;
      const msgStr = stripTimestampPrefix(rawMsg);

      // ── S3 fast path: rule-based pre-check ──────────────────────────
      // Rules are synchronous and deterministic. When they detect S3 we
      // can route to the local model immediately — no need to run the
      // full pipeline (LLM detector, token-saver, custom routers, etc.)
      // which would waste compute and needlessly expose sensitive content.
      const rulePreCheck = detectByRules(
        { checkpoint: "onUserMessage", message: msgStr, sessionKey },
        privacyConfig,
      );

      if (rulePreCheck.level === "S3") {
        recordDetection(sessionKey, "S3", "onUserMessage", rulePreCheck.reason);
        trackSessionLevel(sessionKey, "S3");
        setActiveLocalRouting(sessionKey);
        stashDetection(sessionKey, {
          level: "S3",
          reason: rulePreCheck.reason,
          originalPrompt: msgStr,
          timestamp: Date.now(),
        });

        const guardCfg = getGuardAgentConfig(privacyConfig);
        const defaultProvider = privacyConfig.localModel?.provider ?? "ollama";
        const provider = guardCfg?.provider ?? defaultProvider;
        const model =
          guardCfg?.modelName ?? privacyConfig.localModel?.model ?? "openbmb/minicpm4.1";
        api.logger.info(`[ClawXrouter] S3 (rule fast-path) — routing to ${provider}/${model}`);
        return { providerOverride: provider, modelOverride: model };
      }

      // ── Normal path: run the full router pipeline ──────────────────
      const pipeline = getGlobalPipeline();
      if (!pipeline) {
        api.logger.warn("[ClawXrouter] Router pipeline not initialized");
        return;
      }

      const defaults = api.config.agents?.defaults as Record<string, unknown> | undefined;
      const primaryModel =
        ((defaults?.model as Record<string, unknown> | undefined)?.primary as string) ?? "";
      const defaultProvider =
        (defaults?.provider as string) || primaryModel.split("/")[0] || "openai";

      const decision = await pipeline.run(
        "onUserMessage",
        {
          checkpoint: "onUserMessage",
          message: msgStr,
          sessionKey,
          agentId: ctx.agentId,
        },
        getPipelineConfig(),
      );

      recordDetection(
        sessionKey,
        decision.level,
        "onUserMessage",
        decision.reason,
        decision.routerId,
        decision.action,
        decision.target ? `${decision.target.provider}/${decision.target.model}` : undefined,
      );
      setSessionRouteLevel(sessionKey, decision.level);

      if (decision.routerId === "token-saver" && decision.reason?.startsWith("tier=")) {
        const tier = decision.reason.split("=")[1];
        setLoopRouting(
          sessionKey,
          tier,
          decision.target ? `${decision.target.provider}/${decision.target.model}` : undefined,
          decision.action ?? "passthrough",
        );
      }
      api.logger.info(
        `[ClawXrouter] ROUTE: session=${sessionKey} level=${decision.level} action=${decision.action} target=${JSON.stringify(decision.target)} reason=${decision.reason}`,
      );

      if (decision.action !== "block") {
        notifyGenerating(
          sessionKey,
          "onUserMessage",
          decision.level,
          decision.routerId,
          decision.action,
          decision.target ? `${decision.target.provider}/${decision.target.model}` : undefined,
          decision.reason,
        );
      }

      // S1: ALL S1 traffic routes through proxy for defense-in-depth
      // (schema cleaning, regex PII scan). Token-saver may redirect to a
      // different model — we honour the model choice but still proxy.
      if (decision.level === "S1") {
        const targetModel = decision.target?.model;
        const targetOriginalProvider =
          decision.target?.provider !== "clawxrouter-privacy"
            ? decision.target?.provider
            : undefined;
        const originalProv =
          targetOriginalProvider ??
          (targetModel
            ? resolveOriginalProvider(
                api.config as Record<string, unknown>,
                targetModel,
                defaultProvider,
              )
            : defaultProvider);
        if (targetModel) {
          ensureModelMirrored(
            api.config as Record<string, unknown>,
            targetModel,
            originalProv,
            () => {
              try {
                return api.runtime.config.loadConfig();
              } catch {
                return undefined;
              }
            },
          );
        }
        return {
          providerOverride: "clawxrouter-privacy",
          ...(targetModel ? { modelOverride: targetModel } : {}),
        };
      }

      // S3 from LLM detector (rules didn't catch it above): route to local
      if (decision.level === "S3") {
        trackSessionLevel(sessionKey, "S3");
        setActiveLocalRouting(sessionKey);
        stashDetection(sessionKey, {
          level: "S3",
          reason: decision.reason,
          originalPrompt: msgStr,
          timestamp: Date.now(),
        });
        if (decision.target) {
          api.logger.info(
            `[ClawXrouter] S3 — routing to ${decision.target.provider}/${decision.target.model} [${decision.routerId}]`,
          );
          return {
            providerOverride: decision.target.provider,
            ...(decision.target.model ? { modelOverride: decision.target.model } : {}),
          };
        }
        const guardCfg = getGuardAgentConfig(privacyConfig);
        const defaultProvider = privacyConfig.localModel?.provider ?? "ollama";
        api.logger.info(
          `[ClawXrouter] S3 — routing to ${guardCfg?.provider ?? defaultProvider}/${guardCfg?.modelName ?? privacyConfig.localModel?.model ?? "openbmb/minicpm4.1"} [${decision.routerId}]`,
        );
        return {
          providerOverride: guardCfg?.provider ?? defaultProvider,
          modelOverride:
            guardCfg?.modelName ?? privacyConfig.localModel?.model ?? "openbmb/minicpm4.1",
        };
      }

      // Desensitize for S2 (needed for both proxy markers and local prompt).
      // If desensitization fails (local model down), escalate to S3 so the
      // message stays entirely local — never send raw PII to cloud.
      let desensitized: string | undefined;
      if (decision.level === "S2") {
        const result = await desensitizeWithLocalModel(msgStr, privacyConfig, sessionKey);
        if (result.failed) {
          api.logger.warn(
            "[ClawXrouter] S2 desensitization failed — escalating to S3 (local-only) to prevent PII leak",
          );
          trackSessionLevel(sessionKey, "S3");
          setActiveLocalRouting(sessionKey);
          stashDetection(sessionKey, {
            level: "S3",
            reason: `${decision.reason}; desensitization failed — escalated to S3`,
            originalPrompt: msgStr,
            timestamp: Date.now(),
          });
          const guardCfg = getGuardAgentConfig(privacyConfig);
          const fallbackProvider = privacyConfig.localModel?.provider ?? "ollama";
          return {
            providerOverride: guardCfg?.provider ?? fallbackProvider,
            modelOverride:
              guardCfg?.modelName ?? privacyConfig.localModel?.model ?? "openbmb/minicpm4.1",
          };
        }
        desensitized = result.desensitized;
      }

      // Stash decision for before_prompt_build / before_message_write
      stashDetection(sessionKey, {
        level: decision.level,
        reason: decision.reason,
        desensitized,
        originalPrompt: msgStr,
        timestamp: Date.now(),
      });

      // S2-local: route to edge model
      if (
        decision.level === "S2" &&
        decision.action === "redirect" &&
        decision.target?.provider !== "clawxrouter-privacy"
      ) {
        markSessionAsPrivate(sessionKey, decision.level);
        if (decision.target) {
          api.logger.info(
            `[ClawXrouter] S2 — routing to ${decision.target.provider}/${decision.target.model} [${decision.routerId}]`,
          );
          return {
            providerOverride: decision.target.provider,
            ...(decision.target.model ? { modelOverride: decision.target.model } : {}),
          };
        }
      }

      // S2-proxy: route through privacy proxy (model-keyed map handles upstream)
      if (decision.level === "S2" && decision.target?.provider === "clawxrouter-privacy") {
        markSessionAsPrivate(sessionKey, "S2");
        const targetModel = decision.target.model;
        const actualProvider =
          decision.target.originalProvider ??
          (targetModel
            ? resolveOriginalProvider(
                api.config as Record<string, unknown>,
                targetModel,
                defaultProvider,
              )
            : defaultProvider);
        if (targetModel) {
          ensureModelMirrored(
            api.config as Record<string, unknown>,
            targetModel,
            actualProvider,
            () => {
              try {
                return api.runtime.config.loadConfig();
              } catch {
                return undefined;
              }
            },
          );
        }
        api.logger.info(
          `[ClawXrouter] S2 — routing through privacy proxy${targetModel ? ` (model=${targetModel})` : ""} [${decision.routerId}]`,
        );
        return {
          providerOverride: "clawxrouter-privacy",
          ...(targetModel ? { modelOverride: targetModel } : {}),
        };
      }

      // Non-privacy routers may return redirect with a custom target
      if (decision.action === "redirect" && decision.target) {
        api.logger.info(
          `[ClawXrouter] ${decision.level} — custom route to ${decision.target.provider}/${decision.target.model} [${decision.routerId}]`,
        );
        return {
          providerOverride: decision.target.provider,
          ...(decision.target.model ? { modelOverride: decision.target.model } : {}),
        };
      }

      // Block action at model resolve level → route to edge model as safeguard
      if (decision.action === "block") {
        if (decision.level === "S3") {
          trackSessionLevel(sessionKey, "S3");
          setActiveLocalRouting(sessionKey);
        } else {
          markSessionAsPrivate(sessionKey, decision.level);
        }
        const guardCfg = getGuardAgentConfig(privacyConfig);
        const defaultProvider = privacyConfig.localModel?.provider ?? "ollama";
        api.logger.warn(
          `[ClawXrouter] ${decision.level} BLOCK — redirecting to edge model [${decision.routerId}]`,
        );
        return {
          providerOverride: guardCfg?.provider ?? defaultProvider,
          modelOverride:
            guardCfg?.modelName ?? privacyConfig.localModel?.model ?? "openbmb/minicpm4.1",
        };
      }

      // Transform action: the router rewrote the prompt content.
      // For S2/S3 we must still route safely — use the transformed content
      // as the desensitized payload and route through the appropriate path.
      if (decision.action === "transform") {
        if (decision.level === "S3") {
          trackSessionLevel(sessionKey, "S3");
          setActiveLocalRouting(sessionKey);
          stashDetection(sessionKey, {
            level: "S3",
            reason: decision.reason,
            originalPrompt: msgStr,
            timestamp: Date.now(),
          });
          const guardCfg = getGuardAgentConfig(privacyConfig);
          const defaultProvider = privacyConfig.localModel?.provider ?? "ollama";
          api.logger.info(
            `[ClawXrouter] S3 TRANSFORM — routing to edge model [${decision.routerId}]`,
          );
          return {
            providerOverride: guardCfg?.provider ?? defaultProvider,
            modelOverride:
              guardCfg?.modelName ?? privacyConfig.localModel?.model ?? "openbmb/minicpm4.1",
          };
        }

        if (decision.level === "S2") {
          const transformedText = decision.transformedContent ?? desensitized ?? msgStr;
          stashDetection(sessionKey, {
            level: "S2",
            reason: decision.reason,
            desensitized: transformedText,
            originalPrompt: msgStr,
            timestamp: Date.now(),
          });
          markSessionAsPrivate(sessionKey, "S2");

          const s2Policy = privacyConfig.s2Policy ?? "proxy";
          if (s2Policy === "local") {
            const guardCfg = getGuardAgentConfig(privacyConfig);
            const defaultProvider = privacyConfig.localModel?.provider ?? "ollama";
            api.logger.info(
              `[ClawXrouter] S2 TRANSFORM — routing to local ${guardCfg?.provider ?? defaultProvider} [${decision.routerId}]`,
            );
            return {
              providerOverride: guardCfg?.provider ?? defaultProvider,
              modelOverride:
                guardCfg?.modelName ?? privacyConfig.localModel?.model ?? "openbmb/minicpm4.1",
            };
          }

          const transformModel = decision.target?.model;
          const transformActualProvider =
            decision.target?.originalProvider ??
            (transformModel
              ? resolveOriginalProvider(
                  api.config as Record<string, unknown>,
                  transformModel,
                  defaultProvider,
                )
              : defaultProvider);
          if (transformModel) {
            ensureModelMirrored(
              api.config as Record<string, unknown>,
              transformModel,
              transformActualProvider,
              () => {
                try {
                  return api.runtime.config.loadConfig();
                } catch {
                  return undefined;
                }
              },
            );
          }
          const transformModelInfo = transformModel ? ` (model=${transformModel})` : "";
          api.logger.info(
            `[ClawXrouter] S2 TRANSFORM — routing through privacy proxy${transformModelInfo} [${decision.routerId}]`,
          );
          return {
            providerOverride: "clawxrouter-privacy",
            ...(transformModel ? { modelOverride: transformModel } : {}),
          };
        }

        // S1 + transform: route through proxy for defense-in-depth
        return { providerOverride: "clawxrouter-privacy" };
      }

      // Default: route through proxy for defense-in-depth
      return { providerOverride: "clawxrouter-privacy" };
    } catch (err) {
      api.logger.error(`[ClawXrouter] Error in before_model_resolve hook: ${String(err)}`);
    }
  });

  api.on("before_prompt_build", async (_event, ctx) => {
    try {
      const sessionKey = resolveHookSessionKey(ctx);
      if (!sessionKey) return;

      const pending = getPendingDetection(sessionKey);
      if (!pending || pending.level === "S1") return;

      const privacyConfig = getLiveConfig();
      const sessionCfg = privacyConfig.session ?? {};
      const shouldInject =
        sessionCfg.injectDualHistory !== false && sessionCfg.isolateGuardHistory !== false;
      const historyLimit = sessionCfg.historyLimit ?? 20;

      // S3: data processed entirely locally. Inject full-track history
      // so the local model sees previous S3 interactions that were replaced
      // by "🔒 [Private content]" placeholders in the main transcript.
      if (pending.level === "S3") {
        if (shouldInject) {
          const context = await loadDualTrackContext(sessionKey, ctx.agentId, historyLimit);
          if (context) {
            api.logger.info(`[ClawXrouter] Injected dual-track history context for S3 turn`);
            return { prependContext: context };
          }
        }
        return;
      }

      const s2Policy = privacyConfig.s2Policy ?? "proxy";

      // S2-local: data stays on-device — inject full-track history for richer context.
      if (pending.level === "S2" && s2Policy === "local") {
        if (shouldInject) {
          const context = await loadDualTrackContext(sessionKey, ctx.agentId, historyLimit);
          if (context) {
            api.logger.info(`[ClawXrouter] Injected dual-track history context for S2-local turn`);
            return { prependContext: context };
          }
        }
        return;
      }

      // S2-proxy: inject desensitized content wrapped in markers for privacy-proxy to strip.
      //
      // SAFETY CONTRACT: OpenClaw's before_prompt_build `prependContext` prepends
      // text directly to the user prompt string (see plugin.md §Prompt build order).
      // The resulting message content becomes:
      //   "<clawxrouter-s2>\n{desensitized}\n</clawxrouter-s2>\n\n{original PII}"
      // The proxy's stripPiiMarkers() replaces the ENTIRE content with only the text
      // between markers, effectively discarding the original PII that follows.
      // If OpenClaw ever changes prependContext semantics (e.g. to a separate message),
      // the proxy's fallback regex redaction provides defense-in-depth.
      if (pending.level === "S2" && pending.desensitized) {
        return {
          prependContext: `${CLAWXROUTER_S2_OPEN}\n${pending.desensitized}\n${CLAWXROUTER_S2_CLOSE}`,
        };
      }
    } catch (err) {
      api.logger.error(`[ClawXrouter] Error in before_prompt_build hook: ${String(err)}`);
    }
  });

  api.on("before_tool_call", async (event, ctx) => {
    try {
      const { toolName, params } = event;
      const sessionKey = resolveHookSessionKey(ctx);
      if (!toolName) return;

      const typedParams = params as Record<string, unknown>;
      const privacyConfig = getLiveConfig();
      if (!privacyConfig.enabled || !privacyConfig.routers?.privacy?.enabled) {
        recordDetection(sessionKey, "S1", "onToolCallProposed", `tool: ${toolName}`);
        return;
      }
      const baseDir = privacyConfig.session?.baseDir ?? resolveStateDir(process.env);

      // File-access guard for cloud models only — local models (Guard Agent
      // sessions and S3 active routing) are trusted to read full history.
      if (!isGuardSessionKey(sessionKey) && !isActiveLocalRouting(sessionKey)) {
        const pathValues = extractPathsFromParams(typedParams);
        for (const p of pathValues) {
          if (isProtectedMemoryPath(p, baseDir)) {
            api.logger.warn(
              `[ClawXrouter] BLOCKED: cloud model tried to access protected path: ${p}`,
            );
            return {
              block: true,
              blockReason: `ClawXrouter: access to full history/memory is restricted for cloud models (${p})`,
            };
          }
        }
      }

      // Memory read routing: only fully-local sessions read from MEMORY-FULL.md.
      // S2-proxy sessions stay on the clean track to avoid leaking PII to cloud.
      if (toolName === "memory_get" && shouldUseFullMemoryTrack(sessionKey)) {
        const p = String(typedParams.path ?? "");
        if (p === "MEMORY.md" || p === "memory.md") {
          return { params: { ...typedParams, path: "MEMORY-FULL.md" } };
        }
        if (p.startsWith("memory/")) {
          return { params: { ...typedParams, path: p.replace(/^memory\//, "memory-full/") } };
        }
      }

      // Subagent / A2A guard (rule-based only — no LLM detector overhead)
      const isSpawn = toolName === "sessions_spawn";
      const isSend = toolName === "sessions_send";
      if (isSpawn || isSend) {
        const contentField = isSpawn
          ? String(typedParams?.task ?? "")
          : String(typedParams?.message ?? "");
        if (contentField.trim()) {
          const ruleResult = detectByRules(
            {
              checkpoint: "onToolCallProposed",
              message: contentField,
              toolName,
              toolParams: typedParams,
              sessionKey,
            },
            privacyConfig,
          );
          recordDetection(sessionKey, ruleResult.level, "onToolCallProposed", ruleResult.reason);

          if (ruleResult.level === "S3") {
            trackSessionLevel(sessionKey, "S3");
            return {
              block: true,
              blockReason: `ClawXrouter: ${isSpawn ? "subagent task" : "A2A message"} blocked — S3 (${ruleResult.reason ?? "sensitive"})`,
            };
          }
          if (ruleResult.level === "S2") {
            markSessionAsPrivate(sessionKey, "S2");
          }
        }
      }

      // General tool call detection.
      // S3 local routing: the model is already local — re-running detection
      // would block the very tool calls the local model needs.
      // Internal infrastructure tools are also exempt from detection.
      //
      // Detection method is config-driven: when onToolCallProposed includes
      // "localModelDetector" the full pipeline runs (LLM + rules); otherwise
      // only fast rule-based detection is used (default).
      if (!isActiveLocalRouting(sessionKey) && !isToolAllowlisted(toolName)) {
        const detectors = privacyConfig.checkpoints?.onToolCallProposed ?? ["ruleDetector"];
        const usePipeline = detectors.includes("localModelDetector");
        let level: "S1" | "S2" | "S3" = "S1";
        let reason: string | undefined;

        if (usePipeline) {
          const pipeline = getGlobalPipeline();
          if (pipeline) {
            const decision = await pipeline.run(
              "onToolCallProposed",
              { checkpoint: "onToolCallProposed", toolName, toolParams: typedParams, sessionKey },
              getPipelineConfig(),
            );
            level = decision.level;
            reason = decision.reason;
          }
        } else {
          const ruleResult = detectByRules(
            { checkpoint: "onToolCallProposed", toolName, toolParams: typedParams, sessionKey },
            privacyConfig,
          );
          level = ruleResult.level;
          reason = ruleResult.reason;
        }

        recordDetection(sessionKey, level, "onToolCallProposed", reason);

        if (level === "S3") {
          trackSessionLevel(sessionKey, "S3");
          return {
            block: true,
            blockReason: `ClawXrouter: tool "${toolName}" blocked — S3 (${reason ?? "sensitive"})`,
          };
        }
        if (level === "S2") {
          markSessionAsPrivate(sessionKey, "S2");
        }
      }
    } catch (err) {
      api.logger.error(`[ClawXrouter] Error in before_tool_call hook: ${String(err)}`);
    }
  });

  api.on("tool_result_persist", (event, ctx) => {
    try {
      const sessionKey = resolveHookSessionKey(ctx) || `anon-${Date.now()}`;
      const msg = event.message;
      if (!msg) return;

      // ── Memory dual-write sync ──
      // When Agent writes to memory files, sync the other track.
      if (ctx.toolName === "write" || ctx.toolName === "write_file") {
        const writePath = String(
          ((event as Record<string, unknown>).params as Record<string, unknown> | undefined)
            ?.path ?? "",
        );
        if (writePath && isMemoryWritePath(writePath)) {
          const workspaceDir = _cachedWorkspaceDir ?? process.cwd();
          const privacyConfig = getLiveConfig();
          syncMemoryWrite(
            writePath,
            workspaceDir,
            privacyConfig,
            api.logger,
            isGuardSessionKey(sessionKey),
          ).catch((err) => {
            api.logger.warn(`[ClawXrouter] Memory dual-write sync failed: ${String(err)}`);
          });
        }
      }

      // ── memory_search result filtering ──
      // QMD indexes both MEMORY.md and MEMORY-FULL.md (via extraPaths).
      // Filter out the wrong track so each session type only sees its own.
      if (ctx.toolName === "memory_search") {
        const filtered = filterMemorySearchResults(msg, shouldUseFullMemoryTrack(sessionKey));
        if (filtered) return { message: filtered };
        return;
      }

      // ── S3 local routing: dual-track split ──
      // The local model sees full content (via dual-track history injection),
      // but the main transcript must be redacted so future S1 turns don't
      // leak S3 tool results to cloud models.
      if (isActiveLocalRouting(sessionKey)) {
        const textContent = extractMessageText(msg);
        if (textContent && textContent.length >= 10) {
          const sessionManager = getDefaultSessionManager();
          sessionManager
            .writeToFull(sessionKey, {
              role: "tool",
              content: textContent,
              timestamp: Date.now(),
              sessionKey,
            })
            .catch(() => {});
          const redacted = redactSensitiveInfo(textContent, getLiveConfig().redaction);
          if (redacted !== textContent) {
            api.logger.info(
              `[ClawXrouter] S3 tool result PII-redacted for transcript (tool=${ctx.toolName ?? "unknown"})`,
            );
            sessionManager
              .writeToClean(sessionKey, {
                role: "tool",
                content: redacted,
                timestamp: Date.now(),
                sessionKey,
              })
              .catch(() => {});
            const modified = replaceMessageText(msg, redacted);
            if (modified) return { message: modified };
          } else {
            sessionManager
              .writeToClean(sessionKey, {
                role: "tool",
                content: textContent,
                timestamp: Date.now(),
                sessionKey,
              })
              .catch(() => {});
          }
        }
        return;
      }

      // Internal infrastructure tools (gateway, web_fetch, etc.) naturally contain
      // auth headers/tokens that must NOT be redacted or the tool breaks.
      if (ctx.toolName && isToolAllowlisted(ctx.toolName)) return;

      const textContent = extractMessageText(msg);
      if (!textContent || textContent.length < 10) return;

      // ── Detection + PII redaction + state tracking + dual-track writing ──
      // This sync hook is the single handler for tool result privacy:
      // it is the only hook that can modify the persisted transcript.
      const privacyConfig = getLiveConfig();
      if (!privacyConfig.enabled || !privacyConfig.routers?.privacy?.enabled) {
        recordDetection(
          sessionKey,
          "S1",
          "onToolCallExecuted",
          `result: ${ctx.toolName ?? "unknown"}`,
        );
        return;
      }

      // Snapshot the turn-level privacy state BEFORE detection runs.
      // markSessionAsPrivate() updates currentTurnLevel immediately, so
      // checking isSessionMarkedPrivate() later would always be true
      // after any S2/S3 detection — causing the LLM dual-write fallback
      // (below) to incorrectly skip.
      const wasPrivateBefore = isSessionMarkedPrivate(sessionKey);

      const ruleCheck = detectByRules(
        {
          checkpoint: "onToolCallExecuted",
          toolName: ctx.toolName,
          toolResult: textContent,
          sessionKey,
        },
        privacyConfig,
      );

      const detectedSensitive = ruleCheck.level === "S3" || ruleCheck.level === "S2";

      // S3 detected at tool_result_persist is TOO LATE for local routing:
      // the cloud model is already processing this turn and has seen prior
      // context. Setting activeLocalRouting here would be misleading.
      // Instead, degrade to S2 behaviour: record S3 for audit, but apply
      // S2-level treatment (PII redaction) since that is the strongest
      // mitigation still available at this stage.
      const effectiveLevel = ruleCheck.level === "S3" ? ("S2" as const) : ruleCheck.level;

      if (detectedSensitive) {
        trackSessionLevel(sessionKey, ruleCheck.level); // audit: record true S3
        markSessionAsPrivate(sessionKey, effectiveLevel);
        recordDetection(sessionKey, ruleCheck.level, "onToolCallExecuted", ruleCheck.reason);
        if (ruleCheck.level === "S3") {
          api.logger.warn(
            `[ClawXrouter] S3 detected in tool result AFTER cloud model already active — ` +
              `degrading to S2 (PII redaction). tool=${ctx.toolName ?? "unknown"}, reason=${ruleCheck.reason ?? "rule-match"}`,
          );
        }
      }

      let redacted = redactSensitiveInfo(textContent, getLiveConfig().redaction);
      let wasRedacted = redacted !== textContent;

      // S2 detected by rules but regex missed PII → fall back to LLM
      // semantic desensitization (sync Worker, same as syncDetect pattern).
      if (
        detectedSensitive &&
        !wasRedacted &&
        effectiveLevel === "S2" &&
        privacyConfig.localModel?.enabled
      ) {
        const desenResult = syncDesensitizeWithLocalModel(textContent, privacyConfig, sessionKey);
        if (
          desenResult.wasModelUsed &&
          !desenResult.failed &&
          desenResult.desensitized !== textContent
        ) {
          redacted = desenResult.desensitized;
          wasRedacted = true;
          api.logger.info(
            `[ClawXrouter] S2 tool result LLM-desensitized (regex missed, tool=${ctx.toolName ?? "unknown"})`,
          );
        }
      }

      // Session already S2-private but rules didn't flag this specific result:
      // the conversation is known to involve sensitive data, so tool results
      // (e.g. reading the same file that triggered S2) very likely contain PII.
      // Proactively desensitize to prevent leaking through the proxy / clean track.
      if (
        !detectedSensitive &&
        !wasRedacted &&
        wasPrivateBefore &&
        privacyConfig.localModel?.enabled
      ) {
        const desenResult = syncDesensitizeWithLocalModel(textContent, privacyConfig, sessionKey);
        if (
          desenResult.wasModelUsed &&
          !desenResult.failed &&
          desenResult.desensitized !== textContent
        ) {
          redacted = desenResult.desensitized;
          wasRedacted = true;
          api.logger.info(
            `[ClawXrouter] Proactive tool result desensitized for S2-private session (tool=${ctx.toolName ?? "unknown"})`,
          );
        }
      }

      if (detectedSensitive || wasRedacted || wasPrivateBefore) {
        const sessionManager = getDefaultSessionManager();
        sessionManager
          .writeToFull(sessionKey, {
            role: "tool",
            content: textContent,
            timestamp: Date.now(),
            sessionKey,
          })
          .catch(() => {});
        sessionManager
          .writeToClean(sessionKey, {
            role: "tool",
            content: wasRedacted ? redacted : textContent,
            timestamp: Date.now(),
            sessionKey,
          })
          .catch(() => {});
      }

      if (wasRedacted) {
        if (!detectedSensitive) markSessionAsPrivate(sessionKey, "S2");
        stashDesensitizedToolResult(textContent, redacted);
        const modified = replaceMessageText(msg, redacted);
        if (modified) return { message: modified };
      }

      // ── Sync LLM detection via worker thread ──
      if (privacyConfig.localModel?.enabled && ruleCheck.level !== "S3") {
        const llmResult = syncDetectByLocalModel(
          {
            checkpoint: "onToolCallExecuted",
            toolName: ctx.toolName,
            toolResult: textContent,
            sessionKey,
          },
          privacyConfig,
        );

        if (llmResult.level !== "S1" && llmResult.levelNumeric > ruleCheck.levelNumeric) {
          // LLM-detected S3: PII redaction below will prevent the raw content
          // from reaching the cloud model (sync hook blocks). Model routing
          // cannot change mid-turn, so session marking stays at S2.
          const llmEffective = llmResult.level === "S3" ? ("S2" as const) : llmResult.level;
          trackSessionLevel(sessionKey, llmResult.level); // audit: true level
          if (!detectedSensitive) {
            markSessionAsPrivate(sessionKey, llmEffective);
          }
          recordDetection(sessionKey, llmResult.level, "onToolCallExecuted", llmResult.reason);
          if (llmResult.level === "S3") {
            api.logger.warn(
              `[ClawXrouter] LLM elevated tool result to S3 — PII redacted before reaching cloud model. ` +
                `tool=${ctx.toolName ?? "unknown"}, reason=${llmResult.reason ?? "semantic"}`,
            );
          } else {
            api.logger.info(
              `[ClawXrouter] LLM elevated tool result to ${llmResult.level} (tool=${ctx.toolName ?? "unknown"}, reason=${llmResult.reason ?? "semantic"})`,
            );
          }

          // LLM-elevated S2: desensitize before dual-write / transcript so
          // the clean track and persisted message contain redacted content.
          let llmDesensitized: string | undefined;
          if (llmResult.level === "S2" && !wasRedacted && privacyConfig.localModel?.enabled) {
            const desenResult = syncDesensitizeWithLocalModel(
              textContent,
              privacyConfig,
              sessionKey,
            );
            if (
              desenResult.wasModelUsed &&
              !desenResult.failed &&
              desenResult.desensitized !== textContent
            ) {
              llmDesensitized = desenResult.desensitized;
              api.logger.info(
                `[ClawXrouter] LLM-elevated S2 tool result desensitized (tool=${ctx.toolName ?? "unknown"})`,
              );
            }
          }

          // Dual-write: ensure both full and clean tracks reflect the LLM's
          // finding. When the earlier dual-write block already fired (because
          // wasPrivateBefore was true), it wrote *unredacted* content to the
          // clean track — overwrite it now with the desensitized version.
          if (!detectedSensitive && !wasRedacted) {
            const sessionManager = getDefaultSessionManager();
            const ts = Date.now();
            if (!wasPrivateBefore) {
              sessionManager
                .writeToFull(sessionKey, {
                  role: "tool",
                  content: textContent,
                  timestamp: ts,
                  sessionKey,
                })
                .catch(() => {});
            }
            sessionManager
              .writeToClean(sessionKey, {
                role: "tool",
                content: llmDesensitized ?? redacted,
                timestamp: ts,
                sessionKey,
              })
              .catch(() => {});
          }

          // S3 at persist time: redact before the result enters the model
          // context and the persisted transcript.
          if (llmResult.level === "S3") {
            const s3Redacted = wasRedacted
              ? redacted
              : redactSensitiveInfo(textContent, getLiveConfig().redaction);
            stashDesensitizedToolResult(textContent, s3Redacted);
            const modified = replaceMessageText(msg, s3Redacted);
            if (modified) return { message: modified };
          }

          const s2Content =
            llmDesensitized ?? redactSensitiveInfo(textContent, getLiveConfig().redaction);
          if (s2Content !== textContent) {
            stashDesensitizedToolResult(textContent, s2Content);
            const modified = replaceMessageText(msg, s2Content);
            if (modified) return { message: modified };
          }
        }
      }
    } catch (err) {
      api.logger.error(`[ClawXrouter] Error in tool_result_persist hook: ${String(err)}`);
    }
  });

  api.on("before_message_write", (event, ctx) => {
    try {
      const sessionKey = resolveHookSessionKey(ctx);
      if (!sessionKey) return;

      const msg = event.message;
      if (!msg) return;

      const role = (msg as { role?: string }).role ?? "";
      const pending = getPendingDetection(sessionKey);

      // ── Dual session history persistence ──
      // Persist every message (user, assistant, system) to full/clean tracks
      // when the session is private.  Tool messages are handled separately
      // in tool_result_persist (Hook 5) to avoid double-writes.
      //
      // Also persist when pending detection is S3: Guard Agent is physically
      // isolated so the main session isn't marked private, but we still want
      // the S3 user message recorded (original → full, placeholder → clean)
      // for audit purposes.
      const needsDualHistory =
        isSessionMarkedPrivate(sessionKey) ||
        pending?.level === "S3" ||
        isActiveLocalRouting(sessionKey);
      if (needsDualHistory && role !== "tool") {
        const sessionManager = getDefaultSessionManager();
        const msgText = extractMessageText(msg);
        const ts = Date.now();

        if (role === "user" && pending && pending.level !== "S1") {
          // S2/S3 user message: original content → full, sanitized → clean
          const original = pending.originalPrompt ?? msgText;
          sessionManager
            .writeToFull(sessionKey, {
              role: "user",
              content: original,
              timestamp: ts,
              sessionKey,
            })
            .catch((err) => {
              console.error("[ClawXrouter] Failed to persist user message to full history:", err);
            });
          const cleanContent =
            pending.level === "S3"
              ? buildMainSessionPlaceholder("S3")
              : (pending.desensitized ?? msgText);
          sessionManager
            .writeToClean(sessionKey, {
              role: "user",
              content: cleanContent,
              timestamp: ts,
              sessionKey,
            })
            .catch((err) => {
              console.error("[ClawXrouter] Failed to persist user message to clean history:", err);
            });
        } else if (msgText) {
          if (role === "assistant" && isActiveLocalRouting(sessionKey)) {
            // Local model response may contain echoed PII — write original
            // to full track, PII-redacted version to clean track.
            const redacted = redactSensitiveInfo(msgText, getLiveConfig().redaction);
            sessionManager
              .writeToFull(sessionKey, {
                role: "assistant",
                content: msgText,
                timestamp: ts,
                sessionKey,
              })
              .catch((err) => {
                console.error(
                  "[ClawXrouter] Failed to persist assistant message to full history:",
                  err,
                );
              });
            sessionManager
              .writeToClean(sessionKey, {
                role: "assistant",
                content: redacted,
                timestamp: ts,
                sessionKey,
              })
              .catch((err) => {
                console.error(
                  "[ClawXrouter] Failed to persist assistant message to clean history:",
                  err,
                );
              });
          } else {
            // System / S1-user / non-local-routing assistant messages:
            // persistMessage handles guard-agent filtering (guard → full only, others → both).
            sessionManager
              .persistMessage(sessionKey, {
                role: (role as SessionMessage["role"]) || "assistant",
                content: msgText,
                timestamp: ts,
                sessionKey,
              })
              .catch((err) => {
                console.error("[ClawXrouter] Failed to persist message to dual history:", err);
              });
          }
        }
      }

      // ── PII-redact assistant responses from local model ──
      // When S3 data is processed locally the model may echo back PII
      // (e.g. "Your ID 310101... is valid"). Redact before entering the
      // main transcript so subsequent cloud turns don't see raw PII.
      if (role === "assistant" && isActiveLocalRouting(sessionKey)) {
        const assistantText = extractMessageText(msg);
        if (assistantText && assistantText.length >= 10) {
          const redacted = redactSensitiveInfo(assistantText, getLiveConfig().redaction);
          if (redacted !== assistantText) {
            api.logger.info(
              "[ClawXrouter] PII-redacted local model response before transcript write",
            );
            return {
              message: {
                ...(msg as Record<string, unknown>),
                content: [{ type: "text", text: redacted }],
              },
            };
          }
        }
      }

      // ── Sanitize user messages for session transcript ──
      if (role !== "user") return;
      if (!pending || pending.level === "S1") return;

      if (pending.level === "S3") {
        consumeDetection(sessionKey);
        return {
          message: { ...msg, content: [{ type: "text", text: buildMainSessionPlaceholder("S3") }] },
        };
      }
      if (pending.level === "S2" && pending.desensitized) {
        consumeDetection(sessionKey);
        return { message: { ...msg, content: [{ type: "text", text: pending.desensitized }] } };
      }
    } catch (err) {
      api.logger.error(`[ClawXrouter] Error in before_message_write hook: ${String(err)}`);
    }
  });

  api.on("session_end", async (event, ctx) => {
    try {
      const sessionKey = event.sessionKey ?? resolveHookSessionKey(ctx);
      if (!sessionKey) return;

      const wasPrivate = isSessionMarkedPrivate(sessionKey);
      api.logger.info(
        `[ClawXrouter] ${wasPrivate ? "private" : "cloud"} session ${sessionKey} ended. Syncing memory…`,
      );

      const memMgr = getDefaultMemoryManager();
      const privacyConfig = getLiveConfig();
      await memMgr.syncAllMemoryToClean(privacyConfig);

      clearSessionState(sessionKey);

      const collector = getGlobalCollector();
      if (collector) await collector.flush();
    } catch (err) {
      api.logger.error(`[ClawXrouter] Error in session_end hook: ${String(err)}`);
    }
  });

  api.on("after_compaction", async (_event, ctx) => {
    try {
      if (ctx.workspaceDir) _cachedWorkspaceDir = ctx.workspaceDir;
      const memMgr = getDefaultMemoryManager();
      const privacyConfig = getLiveConfig();
      await memMgr.syncAllMemoryToClean(privacyConfig);
      api.logger.info("[ClawXrouter] Memory synced after compaction");
    } catch (err) {
      api.logger.error(`[ClawXrouter] Error in after_compaction hook: ${String(err)}`);
    }
  });

  api.on("llm_output", async (event, ctx) => {
    try {
      const sessionKey = resolveHookSessionKey(ctx) || event.sessionId || "";
      api.logger.info(
        `[ClawXrouter] llm_output fired: session=${sessionKey} model=${event.model} usage=${JSON.stringify(event.usage)}`,
      );
      const collector = getGlobalCollector();
      if (!collector) return;
      collector.record({
        sessionKey,
        provider: event.provider ?? "unknown",
        model: event.model ?? "unknown",
        source: "task",
        usage: event.usage,
        loopId: getCurrentLoopId(sessionKey),
      });
      if (sessionKey) {
        const u = event.usage ?? {};
        const inputTok = u.inputTokens ?? u.prompt_tokens ?? 0;
        const outputTok = u.outputTokens ?? u.completion_tokens ?? 0;
        const cacheTok = u.cacheReadTokens ?? u.cache_read_input_tokens ?? 0;
        const summary =
          `${event.model ?? "unknown"} — in:${inputTok} out:${outputTok}` +
          (cacheTok ? ` cache:${cacheTok}` : "");
        recordDetection(sessionKey, "S1", "onLlmOutput" as any, summary);
        notifyLlmComplete(sessionKey, "onUserMessage");
      }
    } catch (err) {
      api.logger.error(`[ClawXrouter] Error in llm_output hook: ${String(err)}`);
    }
  });

  api.on("llm_input", async (event, ctx) => {
    try {
      const sessionKey = resolveHookSessionKey(ctx) || event.sessionId || "";
      const routeLevel = getSessionRouteLevel(sessionKey);

      if (routeLevel === "S3") return;

      const estimateTokens = (s: string | undefined) => Math.ceil((s?.length ?? 0) / 4);
      let inputTokens = estimateTokens(event.systemPrompt) + estimateTokens(event.prompt);
      if (Array.isArray(event.historyMessages)) {
        for (const m of event.historyMessages) {
          inputTokens += estimateTokens(typeof m === "string" ? m : JSON.stringify(m));
        }
      }

      const pricing = lookupPricing(event.model);
      const estimatedCost = (inputTokens * pricing.inputPer1M) / 1_000_000;

      notifyInputEstimate(sessionKey, {
        estimatedInputTokens: inputTokens,
        estimatedCost,
        model: event.model,
        provider: event.provider,
      });
    } catch (err) {
      api.logger.error(`[ClawXrouter] Error in llm_input hook: ${String(err)}`);
    }
  });

  api.on("before_reset", async (_event, ctx) => {
    try {
      if (ctx.workspaceDir) _cachedWorkspaceDir = ctx.workspaceDir;
      const memMgr = getDefaultMemoryManager();
      const privacyConfig = getLiveConfig();
      await memMgr.syncAllMemoryToClean(privacyConfig);
      api.logger.info("[ClawXrouter] Memory synced before reset");
    } catch (err) {
      api.logger.error(`[ClawXrouter] Error in before_reset hook: ${String(err)}`);
    }
  });

  api.on("message_sending", async (event, ctx) => {
    try {
      const { content } = event;
      if (!content?.trim()) return;

      const privacyConfig = getLiveConfig();
      if (!privacyConfig.enabled) return;

      const pipeline = getGlobalPipeline();
      if (!pipeline) return;

      const sessionKey = resolveHookSessionKey(ctx);
      const decision = await pipeline.run(
        "onUserMessage",
        { checkpoint: "onUserMessage", message: content, sessionKey },
        getPipelineConfig(),
      );

      if (decision.level === "S3" || decision.action === "block") {
        api.logger.warn("[ClawXrouter] BLOCKED outbound message: S3/block detected");
        return { cancel: true };
      }
      if (decision.level === "S2") {
        const desenResult = await desensitizeWithLocalModel(
          content,
          privacyConfig,
          resolveHookSessionKey(ctx) || undefined,
        );
        if (desenResult.failed) {
          api.logger.warn(
            "[ClawXrouter] S2 desensitization failed — cancelling outbound message to prevent PII leak",
          );
          return { cancel: true };
        }
        return { content: desenResult.desensitized };
      }
    } catch (err) {
      api.logger.error(`[ClawXrouter] Error in message_sending hook: ${String(err)}`);
    }
  });

  api.on("before_agent_start", async (event, ctx) => {
    try {
      const { prompt } = event;
      const sessionKey = resolveHookSessionKey(ctx);
      if (!sessionKey.includes(":subagent:") || !prompt?.trim()) return;

      const privacyConfig = getLiveConfig();
      if (!privacyConfig.enabled) return;

      const pipeline = getGlobalPipeline();
      if (!pipeline) return;

      const decision = await pipeline.run(
        "onUserMessage",
        { checkpoint: "onUserMessage", message: prompt, sessionKey, agentId: ctx.agentId },
        getPipelineConfig(),
      );

      // S3 / block: route the subagent to a local model instead of
      // modifying the system prompt.  The cloud model has already seen the
      // prompt text, so altering system instructions is not a reliable
      // security control.  Routing to a local model keeps the data local.
      if (decision.level === "S3" || decision.action === "block") {
        const guardCfg = getGuardAgentConfig(privacyConfig);
        const defaultProvider = privacyConfig.localModel?.provider ?? "ollama";
        const provider = guardCfg?.provider ?? defaultProvider;
        const model =
          guardCfg?.modelName ?? privacyConfig.localModel?.model ?? "openbmb/minicpm4.1";
        api.logger.info(
          `[ClawXrouter] Subagent ${decision.level} — routing to ${provider}/${model}`,
        );
        return {
          providerOverride: provider,
          modelOverride: model,
        };
      }
      if (decision.level === "S2") {
        const privacyCfg = getLiveConfig();
        const desenResult = await desensitizeWithLocalModel(prompt, privacyCfg, sessionKey);
        if (desenResult.failed) {
          const guardCfg = getGuardAgentConfig(privacyCfg);
          const fallbackProvider = privacyCfg.localModel?.provider ?? "ollama";
          const provider = guardCfg?.provider ?? fallbackProvider;
          const model = guardCfg?.modelName ?? privacyCfg.localModel?.model ?? "openbmb/minicpm4.1";
          api.logger.warn(
            `[ClawXrouter] Subagent S2 desensitization failed — routing to local ${provider}/${model}`,
          );
          return { providerOverride: provider, modelOverride: model };
        }

        markSessionAsPrivate(sessionKey, "S2");
        const s2Policy = privacyCfg.s2Policy ?? "proxy";

        if (s2Policy === "local") {
          const guardCfg = getGuardAgentConfig(privacyCfg);
          const defaultProvider = privacyCfg.localModel?.provider ?? "ollama";
          api.logger.info(
            `[ClawXrouter] Subagent S2 — routing to local ${guardCfg?.provider ?? defaultProvider}`,
          );
          return {
            providerOverride: guardCfg?.provider ?? defaultProvider,
            modelOverride:
              guardCfg?.modelName ?? privacyCfg.localModel?.model ?? "openbmb/minicpm4.1",
          };
        }

        const subTargetModel = decision.target?.model;
        if (subTargetModel) {
          const subDefaults = api.config.agents?.defaults as Record<string, unknown> | undefined;
          const subPrimaryModel =
            ((subDefaults?.model as Record<string, unknown> | undefined)?.primary as string) ?? "";
          const subDefaultProvider =
            (subDefaults?.provider as string) || subPrimaryModel.split("/")[0] || "openai";
          const subActualProvider =
            decision.target?.originalProvider ??
            resolveOriginalProvider(
              api.config as Record<string, unknown>,
              subTargetModel,
              subDefaultProvider,
            );
          ensureModelMirrored(
            api.config as Record<string, unknown>,
            subTargetModel,
            subActualProvider,
            () => {
              try {
                return api.runtime.config.loadConfig();
              } catch {
                return undefined;
              }
            },
          );
        }

        api.logger.info("[ClawXrouter] Subagent S2 — routing through privacy proxy");
        return {
          prependContext: `${CLAWXROUTER_S2_OPEN}\n${desenResult.desensitized}\n${CLAWXROUTER_S2_CLOSE}`,
          providerOverride: "clawxrouter-privacy",
        };
      }
    } catch (err) {
      api.logger.error(`[ClawXrouter] Error in before_agent_start hook: ${String(err)}`);
    }
  });

  api.on("message_received", async (event, _ctx) => {
    try {
      const privacyConfig = getLiveConfig();
      if (!privacyConfig.enabled) return;
      api.logger.info?.(`[ClawXrouter] Message received from ${event.from ?? "unknown"}`);
    } catch {
      /* observational only */
    }
  });

  api.logger.info("[ClawXrouter] All hooks registered (13 hooks, pipeline-driven)");
}

// ==========================================================================
// Helpers
// ==========================================================================

function shouldSkipMessage(msg: string): boolean {
  if (msg.includes("[REDACTED:") || msg.startsWith("[SYSTEM]")) return true;
  // OpenClaw prepends timestamps like "[Thu 2026-03-19 20:19 GMT+8] ..." to user
  // messages. Only skip if the ENTIRE message is a bare timestamp (no real content).
  const stripped = msg.replace(
    /^\[(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}[^\]]*\]\s*/,
    "",
  );
  if (stripped.length === 0) return true;
  return false;
}

/** Strip OpenClaw's timestamp prefix from a user message, if present. */
function stripTimestampPrefix(msg: string): string {
  return msg.replace(
    /^\[(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}[^\]]*\]\s*/,
    "",
  );
}

/**
 * Extract text from an AgentMessage (supports string content and content arrays).
 */
function extractMessageText(msg: unknown): string {
  if (typeof msg === "string") return msg;
  if (!msg || typeof msg !== "object") return "";
  const m = msg as Record<string, unknown>;

  if (typeof m.content === "string") return m.content;

  if (Array.isArray(m.content)) {
    return m.content
      .map((part: unknown) => {
        if (typeof part === "string") return part;
        if (
          part &&
          typeof part === "object" &&
          typeof (part as Record<string, unknown>).text === "string"
        ) {
          return (part as Record<string, unknown>).text as string;
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }

  return "";
}

/**
 * Replace text content in an AgentMessage, preserving the message structure.
 * For content arrays, replaces the FIRST text part in-place and removes
 * subsequent text parts, preserving the original ordering of non-text parts
 * (images, file references, etc.).
 */
function replaceMessageText(msg: unknown, newText: string): unknown | null {
  if (typeof msg === "string") return newText;
  if (!msg || typeof msg !== "object") return null;
  const m = { ...(msg as Record<string, unknown>) };

  if (typeof m.content === "string") {
    return { ...m, content: newText };
  }

  if (Array.isArray(m.content)) {
    let textReplaced = false;
    const newContent: Array<Record<string, unknown>> = [];
    for (const part of m.content as Array<Record<string, unknown>>) {
      if (part && typeof part === "object" && part.type === "text") {
        if (!textReplaced) {
          newContent.push({ type: "text", text: newText });
          textReplaced = true;
        }
      } else {
        newContent.push(part);
      }
    }
    if (!textReplaced) {
      newContent.unshift({ type: "text", text: newText });
    }
    return { ...m, content: newContent };
  }

  return null;
}

// ── Dual-track history injection helper ───────────────────────────────────

/**
 * Load the "delta" between full and clean session histories and format it
 * as conversation context.  Returns null if there is nothing meaningful
 * to inject (e.g. no prior sensitive turns, or dual history is empty).
 */
async function loadDualTrackContext(
  sessionKey: string,
  agentId?: string,
  limit?: number,
): Promise<string | null> {
  try {
    const mgr = getDefaultSessionManager();
    const delta = await mgr.loadHistoryDelta(sessionKey, agentId ?? "main", limit);
    if (delta.length === 0) return null;
    return DualSessionManager.formatAsContext(delta);
  } catch {
    return null;
  }
}

// ── Memory dual-write helpers ─────────────────────────────────────────────

const MEMORY_WRITE_PATTERNS = [/^MEMORY\.md$/, /^memory\.md$/, /^memory\//];

function isMemoryWritePath(writePath: string): boolean {
  const rel = writePath.replace(/^\.\//, "");
  return MEMORY_WRITE_PATTERNS.some((p) => p.test(rel));
}

/**
 * After Agent writes to a memory file, dual-write to the other track:
 *   MEMORY.md written → read content → write full to MEMORY-FULL.md, redact to MEMORY.md
 *   memory/X.md written → read → write full to memory-full/X.md, redact to memory/X.md
 */
async function syncMemoryWrite(
  writePath: string,
  workspaceDir: string,
  privacyConfig: PrivacyConfig,
  logger: { info: (msg: string) => void; warn: (msg: string) => void },
  isGuardSession: boolean = false,
): Promise<void> {
  const rel = writePath.replace(/^\.\//, "");
  const absPath = path.isAbsolute(writePath) ? writePath : path.resolve(workspaceDir, rel);

  let content: string;
  try {
    content = await fs.promises.readFile(absPath, "utf-8");
  } catch {
    return;
  }

  if (!content.trim()) return;

  // Determine the counterpart path
  let fullRelPath: string;
  if (rel === "MEMORY.md" || rel === "memory.md") {
    fullRelPath = "MEMORY-FULL.md";
  } else if (rel.startsWith("memory/")) {
    fullRelPath = rel.replace(/^memory\//, "memory-full/");
  } else {
    return;
  }

  const fullAbsPath = path.resolve(workspaceDir, fullRelPath);

  // Ensure directory exists for daily memory files
  await fs.promises.mkdir(path.dirname(fullAbsPath), { recursive: true });

  // Wrap guard agent content with explicit markers so filterGuardContent
  // can reliably strip it when syncing FULL → CLEAN.
  const fullContent = isGuardSession
    ? `${GUARD_SECTION_BEGIN}\n${content}\n${GUARD_SECTION_END}`
    : content;
  await fs.promises.writeFile(fullAbsPath, fullContent, "utf-8");

  // Redact PII and overwrite the clean version
  const memMgr = getDefaultMemoryManager();
  const redacted = await memMgr.redactContentPublic(content, privacyConfig);
  if (redacted !== content) {
    await fs.promises.writeFile(absPath, redacted, "utf-8");
    logger.info(`[ClawXrouter] Memory dual-write: ${rel} → ${fullRelPath} (redacted clean copy)`);
  } else {
    logger.info(`[ClawXrouter] Memory dual-write: ${rel} → ${fullRelPath} (no PII found)`);
  }
}

/**
 * Filter memory_search results: strip results from the wrong memory track.
 * Cloud-bound sessions should not see MEMORY-FULL.md / memory-full/ results.
 * Fully-local sessions should not see MEMORY.md / memory/ results (prefer full).
 */
function filterMemorySearchResults(msg: unknown, useFullTrack: boolean): unknown | null {
  if (!msg || typeof msg !== "object") return null;
  const m = msg as Record<string, unknown>;

  const textContent = extractMessageText(msg);
  if (!textContent) return null;

  try {
    const parsed = JSON.parse(textContent);
    if (!parsed || typeof parsed !== "object") return null;

    const results = (parsed as Record<string, unknown>).results;
    if (!Array.isArray(results)) return null;

    const filtered = results.filter((r: unknown) => {
      if (!r || typeof r !== "object") return true;
      const rPath = String((r as Record<string, unknown>).path ?? "");
      if (useFullTrack) {
        // Fully-local session: exclude clean-track results (prefer full)
        if (rPath === "MEMORY.md" || rPath === "memory.md" || rPath.startsWith("memory/")) {
          return false;
        }
      } else {
        // Cloud-bound session: exclude full-track results
        if (rPath === "MEMORY-FULL.md" || rPath.startsWith("memory-full/")) {
          return false;
        }
      }
      return true;
    });

    if (filtered.length === results.length) return null;

    const newParsed = { ...(parsed as Record<string, unknown>), results: filtered };
    const newText = JSON.stringify(newParsed);
    return replaceMessageText(msg, newText);
  } catch {
    return null;
  }
}
