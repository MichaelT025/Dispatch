# Implementation contract

Reference: Usage-Dashboard e128b1aac3b63590241722c95bbb30951c13f6a3, Apache-2.0.
Runtime modules use .mjs, pure types in types.ts. Tests colocated *.test.mjs using node:test and assert. Run `node --experimental-strip-types --test extensions/pi-usage/<name>.test.mjs`.

Parsers accept unknown JSON and return ParsedUsage-compatible data or null on malformed/no meaningful usage. Never throw for arbitrary JSON. Percent is finite 0–100 (clamp legitimate over-quota values, reject negative values). Dates must be representable ISO strings; no fabricated zero allowance. Pure parsers do not read auth, fetch, or import UI code. Copied/adapted code must have a header identifying Usage-Dashboard, upstream commit, Apache-2.0, and modifications; license will be included centrally.

- codex-parser.mjs: export parseCodexUsage(value) -> ParsedUsage|null.
- go-parser.mjs: export parseGoUsage(value) -> ParsedUsage|null.
- command-quota.mjs: export parseCommandCodeWindows(value) -> QuotaWindow[]|null; parseCommandCodeTimestamp(value) -> string|null. Rolling/weekly only (monthly handled by billing).
- command-billing.mjs: export parseCommandCodePlan(whoami, subscriptions, credits) -> string|undefined; parseCommandCodeMonthly(credits,subscriptions,usage) -> QuotaWindow|null; parseCommandCodeCredits(credits,subscriptions,usage) -> CreditBalance[]|undefined. Import timestamp from command-quota.mjs, no other shared mutable helper. Credits are credits, NOT dollars; separate included/purchased/free pools, no alias double-counting. Do not expose identity/email as plan.

Provider request definitions export {id,displayName,load({token,signal,fetch})}. load returns ParsedUsage or throws UsageRequestError(code, retryAfterMs?). Shared http.mjs (orchestrator-owned) exports requestJson(url,{token,signal,fetch,headers?}) and UsageRequestError. requestJson sets bearer/Accept, rejects redirects, never exposes raw error bodies/messages, classifies HTTP/JSON failures. Overall timeout/auth/account identity and result creation live in adapter.mjs, not provider definitions. Provider modules only use fixed official hosts.

Adapter wrapper fetchProvider(definition,{resolveAuth,fetch,signal,now,timeoutMs}) resolves {apiKey} or undefined each fetch; no secrets in normalized output. Auth identity is hashed internally as accountKey; UI never publishes it. UsageData contract in types.ts. Failed results have windows:[], fetchedAt:null, checkedAt timestamp. Polling retains last success only for matching accountKey and not AUTH/NOT_CONFIGURED failures.

UI protocol: contributed id dispatch:subscriptions, source pi-usage, channel pi-atelier:sidebar-panels version 1. Poll only ctx.mode === 'tui'. No assistant messages/model-context injection. No direct Atelier imports. Default interval 180000ms, manual refresh deduplicated and obeys rate-limit cooldown.
