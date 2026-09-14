# Pi CLI appearance and sidebar

The CLI installer includes an independent `extensions/pi-ui/index.ts` extension. It syntax-highlights successful edit diffs using Pi's existing highlighter, while retaining colored addition/deletion gutters. The actual edits, matching rules, cancellation, and diff/patch results remain Pi's built-in implementation. Errors remain visible. New-file write previews already use Pi's built-in highlighting.

The same renderer is used for edit results inside `/workers`. Collapsed main-chat diffs show 14 lines; Ctrl+O expands up to 500 lines. Syntax highlighting is limited to 30,000 characters per side. Unknown languages remain readable as plain code. No language server, additional npm dependency, or background process is required for highlighting.

## Optional sidebar and task planner

The personal setup tested on Windows with Pi 0.85.1 uses:

```powershell
pi install npm:pi-atelier@0.10.1
pi install npm:@juicesharp/rpiv-todo@2.9.0
npm run install:cli
```

PiAstra publishes the `piastra:workers` panel through Atelier's public sidebar event protocol. It shows active workers first and recent completed workers, with their task, model, and activity. It reuses delegation updates, emits only changed panel data, and introduces no polling timer. Without Atelier, the ordinary `/workers` viewer still works.

Atelier hides contributed panels until enabled. In `/atelier display`, enable `piastra:workers` and position it near TODOs. Alternatively, merge the following into `~/.pi/agent/pi-atelier.json`:

```json
{
  "preset": "minimal",
  "showSidebarOnStartup": true,
  "showSidebarToolNames": false,
  "completionNotifications": false,
  "sidebarPanelLayout": [
    { "id": "agent", "visible": true },
    { "id": "piastra:workers", "visible": true },
    { "id": "todos", "visible": true },
    { "id": "activity", "visible": true },
    { "id": "context", "visible": true },
    { "id": "workspace", "visible": true },
    { "id": "usage", "visible": true },
    { "id": "alerts", "visible": true },
    { "id": "tools", "visible": true }
  ]
}
```

Restart Pi or run `/reload` after installing. Use `/atelier` or Alt+A for controls, `/atelier sidebar` to toggle the sidebar, and Ctrl+Shift+R to resize it. The sidebar automatically hides in narrow terminals. Pi fullscreen mode (`pi --tui-mode fullscreen`) keeps transcript selection separate from sidebar text; ordinary terminal selection in regular mode can include sidebar columns.

Ask the agent to “Track this task with todos,” and use `/todos` to inspect the planner. The optional `todo` tool remains available after PiAstra role switches. Other plugins' tools are not automatically admitted into role allowlists. Delegated workers retain their isolated tool sets; the parent owns the task plan.

## PiAstra-maintained Atelier fork (opt-in)

`extensions/pi-atelier/` is based on the published **pi-atelier 0.10.1**
release with its MIT license and recorded npm integrity hashes. The fork now
adds editor cooperation so PiAstra shortcuts and Atelier's frame work together. See
[the fork notes](../extensions/pi-atelier/FORK.md) and
[provenance](../extensions/pi-atelier/UPSTREAM.md). This is an in-repository fork,
not a separately published package or remote GitHub fork.

To switch to the managed copy:

```powershell
npm run install:cli -- --atelier
```

The installer backs up settings, copies the fork into the standalone PiAstra
installation, and disables the upstream `npm:pi-atelier` extension while keeping
its package and your `pi-atelier.json`. Restart Pi or run `/reload`. Subsequent
`npm run install:cli` runs update the managed fork without needing the flag again.
Without an initial opt-in, the installer leaves upstream Atelier alone.
If you installed Atelier from Git or a separate extension path instead of npm,
disable that registration yourself before enabling the fork to avoid duplicates.

`/atelier`, sidebar panel IDs and configuration remain compatible. PiAstra owns
the input editor while Atelier supplies its rounded frame; both startup orders
work. `/atelier disable` removes the frame without disabling PiAstra shortcuts,
and `/atelier enable` restores it without nesting editors. Unknown custom
editors are left untouched. See [shortcut cooperation](shortcuts.md).

Sidebar scrolling still needs reproduction and fixing, including determining
whether it originates in Pi's terminal renderer. Automated editor/lifecycle
checks do not constitute live terminal or scrolling verification.

The existing `patch-atelier-agent-label.mjs` script only patches the upstream npm
copy. That personal patch is deliberately absent from this clean baseline; a
managed-fork install restores the upstream activity label until we port it.

To return to upstream, remove the managed `pi-atelier/extensions/index.ts` entry
from `settings.json`, then use `pi config` to re-enable the upstream package's
extension (or remove its `extensions: []` filter). Restart or `/reload` afterward.
Your sidebar configuration is preserved.

## Performance and limits

On this Windows setup, three offline RPC startup checks before installation took 1.005–1.081 seconds (median 1.067). The final setup took 1.635–1.801 seconds (median 1.658). These measure process startup through `get_state`, without model calls; they are not TUI rendering, RAM, or inference-speed benchmarks. Wide and narrow fullscreen terminal layouts were checked separately using synthetic saved history.

Atelier uses terminal layout integration that can require maintenance when Pi changes. It also consumes chat width and performs local Git inspection for workspace information. Only one custom editor/footer can be visible at a time.

The Shiki-based `@pi-archimedes/diff` 2.6.3 plugin was trialed and removed: the Pi 0.85.1 saved-session check showed its edit summary without the code preview. The native renderer above passed replay and actual edit execution tests without its additional dependencies.

An LSP is optional code intelligence, not a syntax-highlighting requirement. Language servers add initialization/indexing work, RAM use, and potentially more tool-result context. Lazy startup reduces idle overhead but does not remove that cost once used. None is installed by this setup. Add one later for specific languages if diagnostics, references, and symbol navigation justify it; avoid starting one per delegated worker by default.

Settings are backed up before installation. Atelier and TODOs can be removed independently with `pi remove npm:pi-atelier@0.10.1` and `pi remove npm:@juicesharp/rpiv-todo@2.9.0`, then `/reload`. To disable the independent edit renderer, remove only its `extensions/pi-ui/index.ts` entry from Pi settings; keep the installed file because the worker viewer also imports its rendering helper.

Sources: [Pi Atelier](https://github.com/michaelmjhhhh/pi-atelier), [rpiv-todo](https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-todo), [Pi's diff highlighting issue](https://github.com/earendil-works/pi/issues/4064), [example lazy LSP extension](https://github.com/samfoy/pi-lsp-extension).
`node scripts/patch-atelier-agent-label.mjs` replaces Atelier's activity text with the current PiAstra role while preserving activity colors and working animation. It backs up the plugin renderer and can be reapplied after an Atelier update. Run `/reload` after applying it.
