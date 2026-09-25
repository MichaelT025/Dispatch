import { createProvider, type AuthCheck, type AuthResult, type Provider } from '@earendil-works/pi-ai'
import type { ProviderConfig } from '@earendil-works/pi-coding-agent'
import type { ModelClassification } from './model-classification.ts'
import { splitCommandCodeModels, type SelectorLabel } from './plan-models.ts'

/** Canonical login: owns `/login`, stored credentials and the auth.json key. Lists no models. */
export const LOGIN_PROVIDER_ID = 'commandcode'
/** Selector for `free` models and, once a GOAT plan is verified, `plan` models. */
export const PLAN_PROVIDER_ID = 'commandcode-plan'
/** Selector for `api` and unclassified models, plus `plan` models while the plan is unverified. */
export const API_PROVIDER_ID = 'commandcode-api'
export const COMMAND_CODE_PROVIDER_IDS: readonly string[] = [LOGIN_PROVIDER_ID, PLAN_PROVIDER_ID, API_PROVIDER_ID]
export const BILLING_NOTICE = 'Catalog groups describe plan coverage, not payment routing. Command Code chooses the balance; plan models can consume extra credits after limits. API prices are estimates, not additional charges guaranteed by this picker.'

const LABELS: Record<SelectorLabel, string> = {
  free: 'Free',
  plan: 'GOAT',
  'plan-unverified': 'Plan unverified',
  api: 'API / extra credits',
  unclassified: 'Unclassified',
}

export interface SharedCommandCodeAuth {
  resolve(): Promise<AuthResult | undefined>
  check(): Promise<AuthCheck | undefined>
}

export interface CommandCodeCatalogSummary {
  planVerified: boolean
  planCount: number
  apiCount: number
}

/**
 * Registers the canonical login plus the plan- and API-facing selectors. Every
 * selector keeps the same upstream IDs and transport; no billing selector is sent.
 */
export function registerCommandCodeCatalog(
  pi: { registerProvider: { (id: string, config: ProviderConfig): void; (provider: Provider): void } },
  config: ProviderConfig,
  plan: string | undefined,
  auth: SharedCommandCodeAuth,
  classification: ModelClassification,
): CommandCodeCatalogSummary {
  const groups = splitCommandCodeModels(config.models ?? [], plan, classification)
  const label = (name: string, suffix: SelectorLabel) => `${name.replace(/ \(CC\)$/, '')} (${LABELS[suffix]})`
  pi.registerProvider(LOGIN_PROVIDER_ID, { ...config, name: 'Command Code', models: [] })
  const stream = config.streamSimple!
  const alias = (id: string, name: string, entries: typeof groups.planModels) => createProvider({
    id,
    name,
    baseUrl: config.baseUrl,
    headers: config.headers,
    // Ambient alias: no second login or duplicate stored credential. Resolve
    // through the canonical provider so refresh, logout and key changes apply.
    auth: { apiKey: {
      name: 'Shared Command Code login',
      // Pi config overlays fabricate a key-prompt login if this is omitted.
      // Reject before prompting/storing anything: the alias has no credentials.
      login: async () => { throw new Error(`Sign in to Command Code (${LOGIN_PROVIDER_ID}); ${name} shares that login.`) },
      resolve: () => auth.resolve(),
      check: () => auth.check(),
    } },
    models: entries.map(({ model, label: suffix }) => ({
      ...model,
      provider: id,
      api: model.api ?? config.api!,
      baseUrl: model.baseUrl ?? config.baseUrl!,
      name: label(model.name, suffix),
    })),
    api: { stream, streamSimple: stream },
  })
  pi.registerProvider(alias(PLAN_PROVIDER_ID, groups.planVerified ? 'Command Code (Plan: GOAT)' : 'Command Code (Plan unverified)', groups.planModels))
  pi.registerProvider(alias(API_PROVIDER_ID, 'Command Code (API / Extra credits)', groups.apiModels))
  return { planVerified: groups.planVerified, planCount: groups.planModels.length, apiCount: groups.apiModels.length }
}
