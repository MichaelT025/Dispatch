/** Subscription usage is account-level, independent of session token/cost metrics. */
export type ProviderId = 'openai-codex' | 'opencode-go' | 'command-code';
export interface QuotaWindow {
  label: string;
  windowSeconds: number;
  usedPercent: number;
  /** null means an inactive window, not an unknown fabricated reset. */
  resetsAt: string | null;
}
export interface CreditBalance {
  label: string;
  remaining: number;
  unit: 'credits' | 'USD';
}
export interface ParsedUsage {
  windows: QuotaWindow[];
  plan?: string;
  credits?: CreditBalance[];
}
export type UsageErrorCode = 'AUTH' | 'NOT_CONFIGURED' | 'NOT_ENTITLED' | 'RATE_LIMITED' | 'NETWORK' | 'PARSE' | 'HTTP';
export interface UsageData extends ParsedUsage {
  providerId: ProviderId;
  displayName: string;
  state: 'ok' | 'unavailable' | 'unconfigured';
  fetchedAt: string | null;
  checkedAt: string;
  error?: UsageErrorCode;
  /** Effective rate-limit deadline, including the service's cooldown clamp. */
  retryAt?: string;
  /** Raw provider retry duration retained for backward compatibility. */
  retryAfterMs?: number;
  stale?: boolean;
  /** Internal opaque identity; never publish this field to UI/events/logs. */
  accountKey?: string;
}
export interface ProviderDefinition {
  id: ProviderId;
  displayName: string;
  load(context: { token: string; signal: AbortSignal; fetch: typeof fetch }): Promise<ParsedUsage>;
}
