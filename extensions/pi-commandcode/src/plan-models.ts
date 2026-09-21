/** Public source for the reviewed GOAT plan model list. */
export const GOAT_SOURCE_URL = "https://commandcode.ai/docs/plans/goat";
export const GOAT_VERIFIED_ON = "2026-09-20";

/** Exact provider IDs named by the GOAT plan (not a pricing- or prefix-based guess). */
export const GOAT_MODEL_IDS = [
  "z-ai/glm-5.3-flashx",
  "Qwen/Qwen3.8-Omni-Flash",
  "deepseek/deepseek-v4.1-flash",
  "inclusionai/ling-3.0-flash-sante:free",
  "google/gemini-3.8-flash",
  "meta/muse-spark-1.3",
  "meta/muse-spark-1.3-contributor",
  "Qwen/Qwen3.8-Max-0902",
  "tencent/hy4-preview",
  "z-ai/glm-5.3-flash",
  "meituan/LongCat-2.0",
  "Qwen/Qwen3.8-Flash",
  "deepseek/deepseek-v4-flash-fast",
  "deepseek/deepseek-v4-flash-vision-exp",
  "zai-org/GLM-5.3",
  "Qwen/Qwen3.8-27B",
  "deepseek/deepseek-v4-pro",
  "google/gemini-3.7-flash",
  "xai/grok-4.6",
  "meta/muse-spark-1.2",
  "meta/muse-spark-1.2-contributor",
  "Qwen/Qwen3.8-Max",
  "deepseek/deepseek-v4-flash",
  "thinkingmachines/inkling-small",
  "Qwen/Qwen3.7-Flash",
  "poolside/laguna-s-2.1-free",
  "thinkingmachines/inkling",
  "moonshotai/Kimi-K3",
  "gpt-5.6-luna",
  "gpt-5.6-sol",
  "xai/grok-4.5",
  "tencent/hy3-paid",
  "zai-org/GLM-5.2-Fast",
  "zai-org/GLM-5.2",
  "moonshotai/Kimi-K2.7-Code-Highspeed",
  "moonshotai/Kimi-K2.7-Code",
  "nvidia/nemotron-3-ultra-550b-a55b",
  "MiniMaxAI/MiniMax-M3",
  "Qwen/Qwen3.7-Plus",
  "stepfun/Step-3.7-Flash",
  "xiaomi/mimo-v2.5",
  "xiaomi/mimo-v2.5-pro",
  "Qwen/Qwen3.7-Max",
  "stepfun/Step-3.5-Flash",
  "zai-org/GLM-5.1",
  "MiniMaxAI/MiniMax-M2.7",
  "Qwen/Qwen3.6-Max-Preview",
  "Qwen/Qwen3.6-Plus",
  "moonshotai/Kimi-K2.6",
  "zai-org/GLM-5",
  "moonshotai/Kimi-K2.5",
  "MiniMaxAI/MiniMax-M2.5",
] as const satisfies readonly string[];

/** The two models documented as free; free models are visible for every plan. */
export const FREE_MODEL_IDS = [
  "poolside/laguna-s-2.1-free",
  "inclusionai/ling-3.0-flash-sante:free",
] as const satisfies readonly string[];

const GOAT_IDS = new Set<string>(GOAT_MODEL_IDS);
const FREE_IDS = new Set<string>(FREE_MODEL_IDS);

function isVerifiedGoatPlan(plan: string | undefined): boolean {
  if (typeof plan !== "string") return false;
  const normalized = plan.trim().toLowerCase().replaceAll("_", "-").replaceAll(" ", "-");
  return /^(?:individual-goat|goat)(?:-(?:monthly|annual|yearly|month|year))?$/.test(normalized);
}

/**
 * Split a live catalog without changing its objects or order.
 * This controls presentation only: it is not a funding-source control and gives
 * no quota guarantee; entitlement and usage enforcement remain server-side.
 */
export function splitCommandCodeModels<T extends { id: string }>(
  models: readonly T[],
  plan: string | undefined,
): { planModels: T[]; apiModels: T[]; planVerified: boolean } {
  const planVerified = isVerifiedGoatPlan(plan);
  const planModels = models.filter((model) =>
    FREE_IDS.has(model.id) || (planVerified && GOAT_IDS.has(model.id)),
  );
  return { planModels, apiModels: [...models], planVerified };
}
