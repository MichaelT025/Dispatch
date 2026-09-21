import { createProvider, type AuthCheck, type AuthResult, type Provider } from '@earendil-works/pi-ai'
import type { ProviderConfig } from '@earendil-works/pi-coding-agent'
import { FREE_MODEL_IDS, splitCommandCodeModels } from './plan-models.ts'

const freeIds = new Set<string>(FREE_MODEL_IDS)

export const PLAN_PROVIDER_ID = 'commandcode'
export const API_PROVIDER_ID = 'commandcode-api'
export const BILLING_NOTICE = 'Catalog groups describe plan coverage, not payment routing. Command Code chooses the balance; GOAT models can consume extra credits after limits. API prices are estimates, not additional charges guaranteed by this picker.'

export interface SharedCommandCodeAuth {
  resolve(): Promise<AuthResult | undefined>
  check(): Promise<AuthCheck | undefined>
}

/** Both catalogs keep the same upstream IDs and transport. No billing selector is sent. */
export function registerCommandCodeCatalog(
  pi: { registerProvider: { (id: string, config: ProviderConfig): void; (provider: Provider): void } },
  config: ProviderConfig,
  plan: string | undefined,
  auth: SharedCommandCodeAuth,
) {
  const groups = splitCommandCodeModels(config.models ?? [], plan)
  const planName = groups.planVerified ? 'Command Code (GOAT)' : 'Command Code (Plan unverified)'
  const label = (name: string, suffix: string) => `${name.replace(/ \(CC\)$/, '')} (${suffix})`
  pi.registerProvider(PLAN_PROVIDER_ID, {
    ...config,
    name: planName,
    models: groups.planModels.map(model => ({ ...model, name: label(model.name, freeIds.has(model.id) ? 'Free' : groups.planVerified ? 'GOAT' : 'Plan unverified') })),
  })
  const stream = config.streamSimple!
  pi.registerProvider(createProvider({
    id: API_PROVIDER_ID,
    name: 'Command Code (API / Extra credits)',
    baseUrl: config.baseUrl,
    headers: config.headers,
    // Ambient alias: no second login or duplicate stored credential. Resolve
    // through the canonical provider so refresh, logout and key changes apply.
    auth: { apiKey: {
      name: 'Shared Command Code login',
      // Pi config overlays fabricate a key-prompt login if this is omitted.
      // Reject before prompting/storing anything: the alias has no credentials.
      login: async () => { throw new Error('Sign in to Command Code (commandcode); the API / Extra credits catalog shares that login.') },
      resolve: () => auth.resolve(),
      check: () => auth.check(),
    } },
    models: groups.apiModels.map(model => ({
      ...model,
      provider: API_PROVIDER_ID,
      api: model.api ?? config.api!,
      baseUrl: model.baseUrl ?? config.baseUrl!,
      name: label(model.name, freeIds.has(model.id) ? 'Free' : 'API / extra credits'),
    })),
    api: { stream, streamSimple: stream },
  }))
  return { planVerified: groups.planVerified, planCount: groups.planModels.length, apiCount: groups.apiModels.length }
}
