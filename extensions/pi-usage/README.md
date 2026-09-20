# Pi usage

`pi-usage` is a standalone Pi extension for viewing account-level subscription
usage from three providers:

- **Codex**
- **OpenCode Go**
- **Command Code**

It does not depend on Usage-Dashboard, a dashboard process, or a web UI. The
extension requests provider usage directly, renders a details view for
`/usage`, and publishes an optional contributed Atelier sidebar panel.

## Enable it

Register `extensions/pi-usage/index.ts` in Pi's extension configuration (or
register the corresponding installed path), then restart Pi or run `/reload`.
The extension is intended for interactive TUI sessions. It does not poll
worker sessions.

After it is enabled:

```text
/usage
/usage refresh
```

`/usage` displays all configured providers and their windows, credits, plan
metadata, freshness, and errors. `/usage refresh` performs a refresh before
showing the same details. Provider requests are account-level; this is not a
per-session token or cost-history view.

## Atelier sidebar

The extension contributes a panel with the stable ID `dispatch:subscriptions`.
Atelier hides contributed panels by default. Open `/atelier display`, enable
**Subscriptions** (`dispatch:subscriptions`), and place it where desired.
Changing that visibility or position preserves the rest of the existing
sidebar layout; it does not replace the user's layout. The panel also works as
a presentation protocol without a direct Atelier dependency.

The sidebar initially shows `Loading subscriptions...`, omits providers that
are not configured, and displays safe provider rows. `/usage` remains the full
details view.

## Polling and lifecycle

- An interactive TUI session starts one immediate refresh, then refreshes every
  three minutes (180 seconds) after the previous refresh settles.
- Only one refresh runs at a time. Manual refreshes are deduplicated with an
  in-flight refresh.
- Polling is enabled only when `ctx.mode === 'tui'`; worker sessions are not
  polled, and the extension does not add assistant messages or model context.
- No usage history is persisted. Snapshots and freshness data live only in the
  current Pi process.
- Set `DISPATCH_USAGE_DISABLED=1` before starting Pi to disable registration,
  polling, and `/usage` data collection. Unset it and reload Pi to enable the
  extension again.

A successful provider result is retained in memory when a later request for
the same account fails with a non-authentication, non-configuration error.
The panel marks that result **stale** and shows a fixed error message. Auth,
configuration, and account changes clear the prior provider data. Rate-limit
responses trigger a cooldown: a `Retry-After` value is honored within bounded
limits, and a provider without one uses a default cooldown. Manual refreshes
also obey that cooldown.

## Authentication and provider caveats

### Codex and OpenCode Go

Codex and OpenCode Go use Dispatch/Pi's native provider authentication. The
normal native credential resolver and OAuth refresh path are used; the
extension does not ask for a second token or write credentials. Codex usage is
read from its ChatGPT backend usage endpoint, which is an implementation
endpoint and may change independently of Pi.

### Command Code

Command Code support uses the alpha API and should be treated as subject to
provider changes. Authentication precedence is:

1. The bundled native Dispatch/Pi `commandcode` provider, when registered (with `command-code` supported as an alias).
2. A non-empty `COMMAND_CODE_API_KEY` environment variable.
3. `COMMAND_CODE_AUTH_PATH`, or the default local file
   `~/.commandcode/auth.json`.

The local JSON file may contain `apiKey` or `api_key`. `COMMAND_CODE_AUTH_PATH`
selects a different file; it is not required when the default file is used.
A native provider takes precedence and an unsuccessful native refresh is not
silently replaced by an environment or local fallback.

Command Code balances are **credits, not dollars**. They are labeled as
credits in the display; dollar aliases are not treated as currency balances.

## Privacy and failure behavior

Only provider responses needed to render usage are retained in memory. Auth
values and opaque account fingerprints are not sent to the sidebar or exposed
in usage details. Network, HTTP, parse, authentication, entitlement, and
rate-limit failures are reduced to fixed display messages rather than raw
provider response bodies.

This extension reports provider data when its endpoints and credentials are
available. Provider backends and the Command Code alpha API can change, so
usage availability is not guaranteed.

## Attribution and license

The provider parsing work was adapted from **Usage-Dashboard**, upstream commit
[`e128b1aac3b63590241722c95bbb30951c13f6a3`](https://github.com/MichaelT025/Usage-Dashboard/commit/e128b1aac3b63590241722c95bbb30951c13f6a3),
under the Apache License 2.0. This extension makes substantial modifications:
it separates pure parsers from provider requests, adds standalone Pi lifecycle
and TUI/Atelier integration, uses native Dispatch/Pi authentication, adds
in-memory stale/error/cooldown handling, redacts account data, and supports
all three provider adapters without a dashboard dependency.

See [`LICENSE`](./LICENSE) for the complete Apache-2.0 text. Original Dispatch
integration code remains covered by the repository's MIT license; the Apache
license applies to the adapted Usage-Dashboard portions and is retained here
for the extension's attribution and redistribution requirements.
