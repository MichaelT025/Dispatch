import { classifyModelId, type ModelClass, type ModelClassification } from "./model-classification.ts";

export function isVerifiedGoatPlan(plan: string | undefined): boolean {
  if (typeof plan !== "string") return false;
  const normalized = plan.trim().toLowerCase().replaceAll("_", "-").replaceAll(" ", "-");
  return /^(?:individual-goat|goat)(?:-(?:monthly|annual|yearly|month|year))?$/.test(normalized);
}

/** Why a model sits in its selector; drives the label shown next to it. */
export type SelectorLabel = "free" | "plan" | "plan-unverified" | "api" | "unclassified";

export interface ClassifiedModel<T> {
  model: T;
  label: SelectorLabel;
}

/**
 * Split a live catalog by the user's classification without changing its
 * objects or order. Each live model lands in at most one selector:
 *
 * - `free` models, and `plan` models once a GOAT plan is verified, go to the
 *   plan-facing selector.
 * - `api` models, unclassified models and (while the plan is unverified)
 *   `plan` models go to the API-facing selector, each visibly labelled.
 * - `hidden` models appear in neither.
 *
 * This controls presentation only: it is not a funding-source control and gives
 * no quota guarantee; entitlement and usage enforcement remain server-side.
 */
export function splitCommandCodeModels<T extends { id: string }>(
  models: readonly T[],
  plan: string | undefined,
  classification: ModelClassification,
): { planModels: ClassifiedModel<T>[]; apiModels: ClassifiedModel<T>[]; planVerified: boolean } {
  const planVerified = isVerifiedGoatPlan(plan);
  const planModels: ClassifiedModel<T>[] = [];
  const apiModels: ClassifiedModel<T>[] = [];
  for (const model of models) {
    const modelClass: ModelClass | undefined = classifyModelId(classification, model.id);
    if (modelClass === "hidden") continue;
    if (modelClass === "free") planModels.push({ model, label: "free" });
    else if (modelClass === "plan" && planVerified) planModels.push({ model, label: "plan" });
    else if (modelClass === "plan") apiModels.push({ model, label: "plan-unverified" });
    else if (modelClass === "api") apiModels.push({ model, label: "api" });
    else apiModels.push({ model, label: "unclassified" });
  }
  return { planModels, apiModels, planVerified };
}
