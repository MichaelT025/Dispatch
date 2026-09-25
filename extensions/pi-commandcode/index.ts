/**
 * Command Code provider for pi.
 *
 * Uses Command Code's documented Provider API:
 * https://api.commandcode.ai/provider/v1
 */

import * as piAi from "@earendil-works/pi-ai"
import { AssistantMessageEventStream } from "@earendil-works/pi-ai"
import * as piAiCompat from "@earendil-works/pi-ai/compat"
import { streamSimple as streamNativeProvider } from "@earendil-works/pi-ai/compat"
import * as piCodingAgent from "@earendil-works/pi-coding-agent"
import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ProviderConfig,
} from "@earendil-works/pi-coding-agent"
import { join } from "node:path"
import { homedir } from "node:os"
import {
  API_PROVIDER_ID,
  BILLING_NOTICE,
  LOGIN_PROVIDER_ID,
  PLAN_PROVIDER_ID,
  registerCommandCodeCatalog,
  type CommandCodeCatalogSummary,
} from "./src/catalog.ts"
import {
  describeClassificationReport,
  loadModelClassification,
  MODEL_CLASSES,
  MODEL_CLASSIFICATION_FILE_NAME,
  MODEL_CLASSIFICATION_VERSION,
  reconcileModelClassification,
  type ClassificationReport,
  type LoadedModelClassification,
  type ModelClassification,
} from "./src/model-classification.ts"
import { findCommandCodeModelToRestore, hasExplicitModelArg } from "./src/restore.ts"
import { fetchCommandCodePlan } from "./src/plan.ts"

import { getConfiguredApiKey } from "./src/api-key.ts"
import { pickCommandCodeApiKey, withResolvedCommandCodeApiKey } from "./src/converters.ts"
import { createStreamCommandCode } from "./src/core.ts"
import { calculateCommandCodeCost } from "./src/cost.ts"
import {
  apiForModelId,
  baseUrlForModel,
  DEFAULT_MODELS_URL,
  DEFAULT_PROVIDER_API_BASE,
  getModelsTimeoutMs,
  inputModalitiesForModel,
  loadCachedCommandCodeModels,
  loadCommandCodeModels,
  MODEL_EFFORTS,
  thinkingMetadataForModel,
  type CommandCodeModel,
} from "./src/models.ts"
import { getApiKey as getOAuthApiKey, login, refreshToken } from "./src/oauth.ts"
import { normalizeCommandCodeMessage } from "./src/overflow.ts"
import { MODEL_COSTS, ZERO_MODEL_COST } from "./src/pricing.ts"
import { registerCommandCodeQuota } from "./src/quota-command.ts"
import { createCommandCodeRuntime } from "./src/runtime.ts"
import { createCommandCodeTransportRouter } from "./src/transport.ts"
import type { TranscriptHelpers } from "./src/types.ts"

const COMMAND_CODE_API = "commandcode-custom"
const COMPAT_SOURCE_ID = "pi-commandcode-provider"

type CompatStreamFunction = (
  model: Parameters<typeof streamNativeProvider>[0],
  context: Parameters<typeof streamNativeProvider>[1],
  options?: Parameters<typeof streamNativeProvider>[2],
) => AssistantMessageEventStream

/**
 * pi's compat entrypoint exposes `registerApiProvider`; Oh My Pi maps
 * `@earendil-works/pi-ai/compat` onto its own pi-ai, which lacks that export
 * and registers custom APIs itself inside `registerProvider`. Resolve the
 * function at runtime so the extension loads on both hosts.
 */
function compatApiProviderRegistrar(): ((...args: unknown[]) => unknown) | undefined {
  const register = (piAiCompat as { registerApiProvider?: unknown }).registerApiProvider
  return typeof register === "function" ? (register as (...args: unknown[]) => unknown) : undefined
}

function registerCompatApiProvider(stream: CompatStreamFunction): void {
  compatApiProviderRegistrar()?.(
    { api: COMMAND_CODE_API, stream, streamSimple: stream },
    COMPAT_SOURCE_ID,
  )
}

/** Pi >= 0.86 transcript replay helpers; absent on older pi-ai and OMP. */
function transcriptHelpers(): TranscriptHelpers | undefined {
  const { getCurrentSystemPrompt, getCurrentTools } = piAi as Partial<TranscriptHelpers>
  return typeof getCurrentSystemPrompt === "function" && typeof getCurrentTools === "function"
    ? { getCurrentSystemPrompt, getCurrentTools }
    : undefined
}

/**
 * The `apiKey` handed to `registerProvider` means different things per host.
 *
 * pi parses `$COMMAND_CODE_API_KEY` as an env template: unresolved means
 * "not configured", so `/login` credentials and `--api-key` take over, and
 * the entry keeps the API-key auth method registered next to OAuth. Without
 * it pi composes an OAuth-only provider and drops stored `api_key`
 * credentials and `--api-key`.
 *
 * Oh My Pi has no template notion: an unresolved value stays a literal config
 * override that shadows its `/login` credential store and is sent verbatim as
 * `Authorization: Bearer $COMMAND_CODE_API_KEY`. There, omit `apiKey` unless
 * a real key is configured; OMP then reads env keys and stored credentials
 * itself.
 *
 * Hosts are told apart by the same `registerApiProvider` probe used for the
 * compat registry: pi exports it, OMP does not.
 */
function configuredApiKey(): string | undefined {
  return getConfiguredApiKey({ authPaths: [
    join(getAgentDir(), "auth.json"),
    process.env.COMMAND_CODE_AUTH_PATH || join(homedir(), ".commandcode", "auth.json"),
    join(homedir(), ".pi", "agent", "auth.json"),
    join(homedir(), ".omp", "agent", "auth.json"),
  ] })
}

function providerApiKey(): string | undefined {
  // Do not capture Dispatch's stored login as a literal fallback: logout and
  // credential rotation must remain owned by the host's auth resolver.
  const configured = pickCommandCodeApiKey(getConfiguredApiKey(), undefined)
  if (configured) return configured
  return compatApiProviderRegistrar() ? "$COMMAND_CODE_API_KEY" : undefined
}

function commandCodeHeaders(): Record<string, string> | undefined {
  if (process.env.CMD_ZDR === "1" || process.env.COMMANDCODE_ZDR === "1") {
    return { "x-cmd-zdr": "1" }
  }
  return undefined
}

function createProviderConfig(
  models: readonly CommandCodeModel[],
  apiBase: string,
  streamCommandCode: ProviderConfig["streamSimple"],
): ProviderConfig {
  const headers = commandCodeHeaders()
  return {
    name: "Command Code",
    baseUrl: apiBase,
    apiKey: providerApiKey(),
    api: COMMAND_CODE_API,
    streamSimple: streamCommandCode,
    headers,
    oauth: {
      name: "Command Code",
      login,
      refreshToken,
      getApiKey: getOAuthApiKey,
    },
    models: models.map((model) => ({
      id: model.id,
      name: model.name,
      api: COMMAND_CODE_API,
      baseUrl: baseUrlForModel(apiBase, model.api),
      reasoning: model.reasoning,
      ...(thinkingMetadataForModel(model.id) ?? {}),
      input: [...inputModalitiesForModel(model.id)],
      cost: MODEL_COSTS[model.id] ?? ZERO_MODEL_COST,
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
      headers,
      compat:
        model.api === "openai-completions"
          ? {
              supportsStore: false,
              supportsDeveloperRole: false,
              supportsReasoningEffort: MODEL_EFFORTS[model.id] !== undefined,
              maxTokensField: "max_tokens",
            }
          : {
              supportsEagerToolInputStreaming: false,
              supportsLongCacheRetention: false,
              supportsCacheControlOnTools: false,
              supportsToolReferences: false,
              ...(model.reasoning ? { forceAdaptiveThinking: true } : {}),
            },
    })),
  }
}

/**
 * Pi's effective default model, resolved by Pi's own settings manager so a
 * trusted project `.pi/settings.json` overrides the global one exactly as it
 * does for Pi. Read-only; only consulted to carry a legacy default forward.
 */
function readDefaultModel(cwd: string | undefined, projectTrusted: boolean): { provider: string; id: string } | undefined {
  // Oh My Pi's substitute package may not export SettingsManager.
  const { SettingsManager } = piCodingAgent as Partial<typeof piCodingAgent>
  if (typeof SettingsManager?.create !== "function") return undefined
  try {
    const settings = SettingsManager.create(cwd ?? process.cwd(), getAgentDir(), { projectTrusted })
    const provider = settings.getDefaultProvider()
    const id = settings.getDefaultModel()
    return provider && id ? { provider, id } : undefined
  } catch {
    return undefined
  }
}

function describeClassificationStatus(
  loaded: LoadedModelClassification | undefined,
  report: ClassificationReport | undefined,
): string[] {
  if (!loaded) return ["Model classification: not loaded yet"]
  const { classification } = loaded
  const source = {
    user: "user file",
    seeded: "user file (just created from packaged defaults)",
    "last-good": "last valid copy of the user file (current file is invalid)",
    packaged: "packaged defaults (user file not used)",
  }[loaded.source]
  return [
    `Model classification: ${loaded.path} — ${source}${classification.reviewedOn ? `, reviewed ${classification.reviewedOn}` : ""}`,
    `Classified IDs: ${MODEL_CLASSES.map((name) => `${name} ${classification[name].length}`).join(", ")}`,
    `Unclassified live IDs: ${report?.unclassified.length ? report.unclassified.join(", ") : "none"}`,
    `Stale classified IDs: ${report?.stale.length ? report.stale.join(", ") : "none"}`,
    ...loaded.warnings,
    ...loaded.notes,
  ]
}

function legacyApiBase(providerApiBase: string): string {
  return providerApiBase.replace(/\/provider\/v1\/?$/, "")
}

export default async function (pi: ExtensionAPI) {
  let registry: ExtensionCommandContext["modelRegistry"] | undefined
  let plan: string | undefined
  let planCredential: string | undefined
  let catalog: CommandCodeCatalogSummary = { planVerified: false, planCount: 0, apiCount: 0 }
  const classificationPath =
    process.env.COMMANDCODE_MODEL_CLASSIFICATION ?? join(getAgentDir(), MODEL_CLASSIFICATION_FILE_NAME)
  let classification: LoadedModelClassification | undefined
  let lastGoodClassification: ModelClassification | undefined
  let classificationReport: ClassificationReport | undefined
  // Reread on every catalog load so edits apply on /commandcode-refresh or a new session.
  const reloadClassification = async () => {
    try {
      classification = await loadModelClassification({ path: classificationPath, lastGood: lastGoodClassification })
    } catch (error) {
      // Packaged defaults unreadable: classify nothing rather than guess.
      classification = {
        classification: { version: MODEL_CLASSIFICATION_VERSION, plan: [], free: [], api: [], hidden: [] },
        source: "packaged",
        path: classificationPath,
        warnings: [`Could not load any Command Code model classification (${error instanceof Error ? error.message : String(error)}); every model is shown as unclassified.`],
        notes: [],
      }
    }
    if (classification.source === "user" || classification.source === "seeded") {
      lastGoodClassification = classification.classification
    }
    return classification
  }
  const sharedAuth = {
    resolve: async () => {
      if (registry) return registry.getProviderAuth(LOGIN_PROVIDER_ID)
      const apiKey = pickCommandCodeApiKey(configuredApiKey(), undefined)
      return apiKey ? { auth: { apiKey }, source: "Command Code" } : undefined
    },
    check: async () => {
      const configured = registry
        ? registry.getProviderAuthStatus(LOGIN_PROVIDER_ID).configured
        : Boolean(pickCommandCodeApiKey(configuredApiKey(), undefined))
      return configured ? { type: "api_key" as const, source: "Shared Command Code login" } : undefined
    },
  }
  pi.on("session_start", async (_event, ctx) => {
    registry = ctx.modelRegistry
    // Resolve runtime/CLI credentials too; do not keep a plan inferred from a
    // different ambient credential used before the session was bound.
    await runtime.refresh()
    // A cache-first background refresh may have begun before session binding.
    // If it used another key, reclassify instead of presenting that account's plan.
    try {
      if ((await sharedAuth.resolve())?.auth.apiKey !== planCredential) await runtime.refresh()
    } catch {
      await runtime.refresh()
    }
    const restore = findCommandCodeModelToRestore({
      current: ctx.model,
      branch: ctx.sessionManager?.getBranch?.() ?? [],
      defaultModel: readDefaultModel(ctx.cwd, ctx.isProjectTrusted?.() ?? false),
      // Dispatch runs Pi in-process with Pi's own arguments in process.argv.
      explicitModel: hasExplicitModelArg(process.argv.slice(2)),
      find: (provider, id) => ctx.modelRegistry.find(provider, id),
    })
    if (!restore) return
    if (restore.action === "switch") await pi.setModel(restore.model)
    if (ctx.hasUI) ctx.ui.notify(`${restore.reason} ${BILLING_NOTICE}`, "info")
  })
  const apiBase = process.env.COMMANDCODE_API_BASE ?? DEFAULT_PROVIDER_API_BASE
  const modelsUrl = process.env.COMMANDCODE_MODELS_URL ?? DEFAULT_MODELS_URL
  const modelsTimeoutMs = getModelsTimeoutMs()
  const modelsCachePath =
    process.env.COMMANDCODE_MODELS_CACHE ?? join(getAgentDir(), "commandcode-models.json")
  const streamGenerate = createStreamCommandCode({
    createStream: () => new AssistantMessageEventStream(),
    calculateCost: calculateCommandCodeCost,
    apiBase: legacyApiBase(apiBase),
    transcript: transcriptHelpers(),
  })
  const resolveStreamOptions = (options?: Parameters<typeof streamNativeProvider>[2]) =>
    withResolvedCommandCodeApiKey(options, configuredApiKey())
  const transport = createCommandCodeTransportRouter({
    createStream: () => new AssistantMessageEventStream(),
    streamProvider: (model, context, options) =>
      streamNativeProvider(
        { ...model, api: apiForModelId(model.id), compat: model.compatConfig ?? model.compat },
        context,
        resolveStreamOptions(options),
      ),
    streamGenerate: (model, context, options) =>
      streamGenerate(model, context, resolveStreamOptions(options)),
  })

  // pi dispatches the main chat through the registered provider, but sibling
  // extensions that call `streamSimple` from `@earendil-works/pi-ai/compat`
  // with a Command Code model resolve `model.api` through the compat
  // api-registry, which knows nothing about extension providers. Register the
  // custom api there so those calls reach the same transport. The registry
  // resolves no credentials for extension providers, so fall back to the
  // configured key when the caller passes none or a placeholder.
  const compatStream: CompatStreamFunction = (model, context, options) =>
    transport.stream(model, context, resolveStreamOptions(options)) as AssistantMessageEventStream
  registerCompatApiProvider(compatStream)

  pi.on("message_end", async (event, ctx) => {
    if (event.message.role !== "assistant") return
    const normalized = normalizeCommandCodeMessage(event.message, ctx.model?.provider)
    return normalized ? { message: normalized.message } : undefined
  })

  registerCommandCodeQuota(pi, {
    apiBase: legacyApiBase(apiBase),
    headers: commandCodeHeaders(),
  })

  const runtimeApi = {
    registerCommand: pi.registerCommand.bind(pi),
    registerProvider: (_id: string, config: ProviderConfig) => {
      catalog = registerCommandCodeCatalog(
        pi,
        config,
        plan,
        sharedAuth,
        classification?.classification ?? { version: MODEL_CLASSIFICATION_VERSION, plan: [], free: [], api: [], hidden: [] },
      )
    },
  }
  const runtime = createCommandCodeRuntime<ProviderConfig, ExtensionCommandContext>(runtimeApi, {
    endpoint: modelsUrl,
    cachePath: modelsCachePath,
    loadModels: async (signal) => {
      const planPromise = (async () => {
        try {
          const resolved = await sharedAuth.resolve()
          const apiKey = resolved?.auth.apiKey
          const detectedPlan = await fetchCommandCodePlan({ apiKey, baseUrl: legacyApiBase(apiBase), signal })
          return { detectedPlan, apiKey }
        } catch { return { detectedPlan: undefined, apiKey: undefined } }
      })()
      const [loaded, detected, loadedClassification] = await Promise.all([
        loadCommandCodeModels({ url: modelsUrl, cachePath: modelsCachePath, timeoutMs: modelsTimeoutMs, signal }),
        planPromise,
        reloadClassification(),
      ])
      plan = detected.detectedPlan
      planCredential = detected.apiKey
      if (loaded.models.length === 0) return loaded
      classificationReport = reconcileModelClassification(
        loadedClassification.classification,
        loaded.models.map((model) => model.id),
      )
      const warnings = [
        loaded.warning,
        ...loadedClassification.warnings,
        ...describeClassificationReport(classificationReport, classificationPath),
      ].filter(Boolean)
      return warnings.length > 0 ? { ...loaded, warning: warnings.join("\n") } : loaded
    },
    loadCachedModels: async () => {
      await reloadClassification()
      return loadCachedCommandCodeModels(modelsCachePath)
    },
    createProviderConfig: (models) => createProviderConfig(models, apiBase, transport.stream),
    getTransport: transport.getTransport,
    reregisterCachedModels: true,
    awaitInitialRefresh: true,
    describeCatalog: () => [
      `Plan: ${catalog.planVerified ? "GOAT (verified)" : `unverified; ${PLAN_PROVIDER_ID} lists only free models and plan models are shown under ${API_PROVIDER_ID}`}`,
      `${PLAN_PROVIDER_ID} models: ${catalog.planCount}; ${API_PROVIDER_ID} models: ${catalog.apiCount}`,
      ...describeClassificationStatus(classification, classificationReport),
      BILLING_NOTICE,
    ].join("\n"),
  })

  pi.on("session_shutdown", () => {
    runtime.dispose()
  })

  await runtime.initialize()
}
