# pi-queue (Dispatch fork)

Project-owned fork of the actual `DeliveryQueue` from
[pi-queue-steer-factory](https://github.com/monotykamary/pi-queue-steer-factory)
v0.17.1 (MIT, © Thomas Mustier, attribution preserved in `LICENSE`).

The runtime `.ts` files are vendored verbatim from upstream 0.17.1 and adapted
in `index.ts` only:

- Vendored as-is: `queue-state.ts` (DeliveryQueue + edit sessions),
  `queue-policy.ts` (lane batching and holds), `queued-input.ts`
  (skill/template expansion), `queue-persistence.ts` (session snapshots),
  `timeline-render.ts` + `editor-render.ts` (execution outline and inline
  editing), `conversation-queue-bridge.ts`, `fabric-peers.ts`,
  `fabric-prewalk.ts` (Pi Fabric interop).
- Deliberately **not** vendored: upstream `dist/`, `headless.ts`, `protocol.ts`,
  `rpc-bridge.ts`, `control-bridge.ts` — none are imported by this runtime fork.
- Adapted: `index.ts` keeps the upstream main-queue machinery (shortcuts,
  editing, ordering, pause/resume, persistence, command rows, Fabric interop)
  unchanged and adds the Dispatch entry points:
  - `/q <prompt>` — appends a follow-up delivery row. While idle it parks the
    row paused, exactly like Alt+Enter on a stopped composer; during a run it
    queues for the run's tail like a native follow-up.
  - `/st <prompt>` — steers the current run's segment via the existing steer
    lane. While idle with no backlog it starts immediately; with a backlog it
    obeys the paused timeline and never overtakes the head.
  - Whitespace-only arguments to either command notify usage and change nothing.
  - `sidebar.mjs` — publishes the Atelier sidebar panel `piastra:queue` from
    the real queue snapshot (Queued/Steer labels, paused/blocked states), with
    discover/dedup/unregister lifecycle and the protocol's 24-row/160-char cap.
- Added (fork-owned, not vendored): `delivery.ts` — acknowledged delivery for
  Pi's fire-and-forget `sendUserMessage` (see below).

Not installed by default: add this directory's `index.ts` to the Pi
`settings.json` extensions list. The Dispatch installer vendors and registers it
when present. Upstream commands `/pause`, `/queue-drain` (with
`/piastra-queue-drain` kept as an alias) and all editing shortcuts keep their
upstream names and keybindings. The interop surface keeps its upstream contract:
the `queue-steer:state` event and `__tmustierPiQueueSteerState` mirror (the
`piastra:queue:state` / `__piastraPiQueueState` names remain as aliases).

## Acknowledged delivery

Pi's `ExtensionAPI.sendUserMessage` returns `void` and discards the underlying
`AgentSession.prompt()` promise, so a queued row cannot tell an accepted prompt
from one rejected during preflight — the old code assumed success and could drop
a row that never reached the agent.

`delivery.ts` exports `sendUserMessageWithAck(pi, content, options?)`, which
bridges that gap without touching Pi's package. It installs one
`AgentSession.prototype.prompt` wrapper per process (idempotent via a `Symbol.for`
marker) backed by a shared `AsyncLocalStorage`. Only the extension's own
`sendUserMessage` invocation runs inside the request scope; the wrapper claims
the request, injects a `preflightResult` callback alongside any existing one,
and returns Pi's original full-run promise untouched. The ALS scope is exited
before the original prompt runs, so nested or unrelated prompts cannot steal the
acknowledgement. The returned promise resolves on a real `preflightResult(true)`
and rejects on `false`, on a synchronous host error, or when the host never
routes through `AgentSession.prompt`; it never awaits the full run or falls back
to a timeout heuristic.

The queue keeps each row in the `DeliveryQueue` until that acknowledgement
arrives. Every send path (idle head, resume/follow-up, lane batches, merged
drain, immediate idle `/st`, internal `/new`) persists the row snapshot before
invoking the send and only removes the row by id once Pi accepts it. A rejection
retains the same ids, text, images and order, parks the queue, persists the
paused state, and notifies — so a crash or shutdown during preflight still
recovers the row. A serial in-flight guard stops repeat Enter/boundary/drain
triggers from double-sending, while newly enqueued rows are never overwritten by
a later restoration. Rows awaiting acknowledgement are excluded from editing and
removal, and late acknowledgements after teardown are ignored via a lifecycle
generation counter.
