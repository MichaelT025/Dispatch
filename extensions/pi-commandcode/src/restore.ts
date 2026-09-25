import { API_PROVIDER_ID, LOGIN_PROVIDER_ID, PLAN_PROVIDER_ID } from "./catalog.ts"

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
  /** Pi's saved default model from settings.json. */
  defaultModel: ModelRef | undefined
  find(provider: string, id: string): TModel | undefined
}

const SELECTORS = [PLAN_PROVIDER_ID, API_PROVIDER_ID]

/**
 * Decides whether a session should be moved onto a Command Code selector.
 *
 * - A model under `commandcode-plan`/`commandcode-api` that the user's
 *   classification now places under the other selector is re-homed.
 * - A legacy `commandcode/<id>` choice (Dispatch ≤ 0.2.1) no longer resolves,
 *   so Pi falls back to another model. It is recovered from the resumed
 *   session's last model change, or from a legacy default model on a new
 *   session, and mapped to whichever selector now lists the ID.
 *
 * Returns undefined when nothing should change or the ID is no longer listed.
 */
export function findCommandCodeModelToRestore<TModel extends ModelRef>(
  input: RestoreInput<TModel>,
): { model: TModel; reason: string } | undefined {
  const saved = savedCommandCodeChoice(input)
  if (!saved) return undefined
  const target = SELECTORS.map((provider) => input.find(provider, saved.id)).find(Boolean)
  if (!target) return undefined
  if (input.current?.provider === target.provider && input.current.id === target.id) return undefined
  const reason = saved.provider === LOGIN_PROVIDER_ID
    ? `Command Code model ${LOGIN_PROVIDER_ID}/${saved.id} is now ${target.provider}/${target.id}.`
    : `${saved.id} moved from ${saved.provider} to ${target.provider} after a model classification change.`
  return { model: target, reason }
}

function savedCommandCodeChoice(input: RestoreInput<ModelRef>): ModelRef | undefined {
  const { current, branch, defaultModel } = input
  if (current && (SELECTORS.includes(current.provider) || current.provider === LOGIN_PROVIDER_ID)) {
    return current
  }
  const changes = branch.filter((entry) => entry.type === "model_change")
  const last = changes.at(-1)
  // Pi does not record its fallback when resuming, so the last change is the saved choice.
  if (last?.provider === LOGIN_PROVIDER_ID && typeof last.modelId === "string") {
    return { provider: LOGIN_PROVIDER_ID, id: last.modelId }
  }
  // A new session records only Pi's fallback; a legacy default explains it.
  const isNewSession = changes.length <= 1 && !branch.some((entry) => entry.type === "message")
  if (isNewSession && defaultModel?.provider === LOGIN_PROVIDER_ID) return defaultModel
  return undefined
}
