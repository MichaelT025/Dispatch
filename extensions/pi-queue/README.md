# pi-queue (PiAstra fork)

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
  unchanged and adds the PiAstra entry points:
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

Not installed by default: add this directory's `index.ts` to the Pi
`settings.json` extensions list. The PiAstra installer vendors and registers it
when present. Upstream commands `/pause`, `/queue-drain` (with
`/piastra-queue-drain` kept as an alias) and all editing shortcuts keep their
upstream names and keybindings. The interop surface keeps its upstream contract:
the `queue-steer:state` event and `__tmustierPiQueueSteerState` mirror (the
`piastra:queue:state` / `__piastraPiQueueState` names remain as aliases).
