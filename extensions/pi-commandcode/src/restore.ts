import { API_PROVIDER_ID, LOGIN_PROVIDER_ID, PLAN_PROVIDER_ID } from "./provider-ids.ts"

interface ModelRef {
  provider: string
  id: string
}

interface BranchEntry {
  type: string
  provider?: unknown
  modelId?: unknown
}

export interface RestoreInput<TModel extends ModelRef> {
  /** Model Pi selected for the session (possibly a fallback). */
  current: ModelRef | undefined
  /** Current session branch; used to recover a choice Pi could not restore. */
  branch: readonly BranchEntry[]
  /**
   * Pi's effective default model: global settings.json merged with a trusted
   * project `.pi/settings.json`, as Pi itself resolves it.
   */
  defaultModel: ModelRef | undefined
  /** The session model was chosen explicitly (CLI `--model`), not by Pi's fallback. */
  explicitModel: boolean
  find(provider: string, id: string): TModel | undefined
}

export type RestoreDecision<TModel> =
  | { action: "switch"; model: TModel; reason: string }
  | { action: "notify"; model: TModel; reason: string }

const SELECTORS = [PLAN_PROVIDER_ID, API_PROVIDER_ID]

/**
 * Decides whether a session should be moved onto a Command Code selector.
 *
 * - A model under `commandcode-plan`/`commandcode-api` that the user's
 *   classification now places under the other selector is re-homed (same ID).
 * - A legacy `commandcode/<id>` choice (Dispatch ≤ 0.2.1) no longer resolves,
 *   so Pi falls back to another model. For a resumed session the saved choice
 *   is restored only when the current model is demonstrably that fallback:
 *   never over an explicit `--model`, and never over a model other than the
 *   default Pi would have fallen back to.
 * - A legacy default model on a new session only produces a notice: an
 *   in-process caller's explicit model (for example a Dispatch worker) is
 *   indistinguishable from Pi's fallback, so it must not be overridden.
 */
export function findCommandCodeModelToRestore<TModel extends ModelRef>(
  input: RestoreInput<TModel>,
): RestoreDecision<TModel> | undefined {
  const { current, branch, defaultModel } = input
  const locate = (id: string) => SELECTORS.map((provider) => input.find(provider, id)).find(Boolean)
  const isCurrent = (model: TModel) => current?.provider === model.provider && current.id === model.id

  if (current && (SELECTORS.includes(current.provider) || current.provider === LOGIN_PROVIDER_ID)) {
    const target = locate(current.id)
    if (!target || isCurrent(target)) return undefined
    return {
      action: "switch",
      model: target,
      reason: current.provider === LOGIN_PROVIDER_ID
        ? `Command Code model ${LOGIN_PROVIDER_ID}/${current.id} is now ${target.provider}/${target.id}.`
        : `${current.id} moved from ${current.provider} to ${target.provider} after a model classification change.`,
    }
  }

  const changes = branch.filter((entry) => entry.type === "model_change")
  const last = changes.at(-1)
  const isNewSession = changes.length <= 1 && !branch.some((entry) => entry.type === "message")

  // Pi does not record its fallback when resuming, so the last change is the saved choice.
  if (!isNewSession && last?.provider === LOGIN_PROVIDER_ID && typeof last.modelId === "string") {
    if (input.explicitModel) return undefined
    const resolvedDefault = defaultModel ? input.find(defaultModel.provider, defaultModel.id) : undefined
    // Pi's resume fallback is the default model whenever that resolves.
    if (resolvedDefault && !(current?.provider === resolvedDefault.provider && current.id === resolvedDefault.id)) {
      return undefined
    }
    const target = locate(last.modelId)
    if (!target || isCurrent(target)) return undefined
    return {
      action: "switch",
      model: target,
      reason: `Command Code model ${LOGIN_PROVIDER_ID}/${last.modelId} is now ${target.provider}/${target.id}.`,
    }
  }

  if (isNewSession && defaultModel?.provider === LOGIN_PROVIDER_ID) {
    const target = locate(defaultModel.id)
    if (!target || isCurrent(target)) return undefined
    return {
      action: "notify",
      model: target,
      reason: `Your default model ${LOGIN_PROVIDER_ID}/${defaultModel.id} is now ${target.provider}/${target.id}; select it with /model to make it the default again.`,
    }
  }
  return undefined
}

/** Pi's `--model` flag, as parsed by Pi's own CLI (`--model <value>`). */
export function hasExplicitModelArg(argv: readonly string[]): boolean {
  const index = argv.indexOf("--model")
  return index >= 0 && index + 1 < argv.length
}
