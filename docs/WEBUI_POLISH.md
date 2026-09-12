# Web UI polish milestone

Source checkout: `C:\Users\micha\Documents\Projects\Personal\PiAstra-web-ui`, branch `piastra-redesign`.
Starting commit: `fe859057f991861780c87b051113f2a6766b7e1e`. Current milestone: `503c3a4`.
Original visual targets remain `reference/codex.png` and `reference/codex_empty_sidebar.png`.

## Changes (separate commits, not squashed)

- `c7c1538`: neutral theme and project groups with nested chat rows.
- `043f5de`: Windows interactive terminals prefer PowerShell; AI Bash remains Bash.
- `cd4a16d`: agent picker and confirmed-role composer attributes.
- `7a8c1c8`: require both extension-sourced agent commands before enabling selection.
- `b5a2b47`: scope extension status to its conversation.
- `63733d2`: saved history for each project without switching the active chat.
- `9bec194`: styled segmented agent controls.
- `a0110d9`: clear stale status on runtime binding/reconnect; retain histories beyond 200 entries.
- `3e699b1`: fetch initially expanded histories and refresh after reconnect.
- `503c3a4`: browser regression for nested history and agent presentation.

Composer accents: orchestrator teal, general blue, fast amber, review violet. Pressed button labels convey the selection without relying on color. The status comes from the extension, not a model-name guess.

## Terminal behavior

The previous upstream default preferred Git Bash to match its agent Bash tool. Interactive PowerShell and AI Bash now use separate selection paths, both streamed through the existing PTY/WebSocket bridge. On this machine, Windows PowerShell 5.1 was exercised successfully; PowerShell 7 is preferred when installed. `PI_WEB_SHELL` explicitly overrides the interactive shell. Existing terminals keep their running shell: close/create a terminal after restarting to get the new default.

This streams terminals started by the application. It does not attach to arbitrary already-running external terminal windows.

## Checks

- Full typecheck: passed.
- Unit tests: 74 files, 693 tests passed.
- Web and server builds: passed (existing large-chunk warnings).
- Shell browser checks: passed, including chooser navigation and terminal open/close without duplicate tabs.
- Per-project saved-chat WebSocket checks: 10 passed; scoped listing leaves active cwd/conversation unchanged.
- Agent/sidebar browser checks: passed for four confirmed role states and separate nested histories. These use synthetic saved transcripts and a test-only extension that exercises command/status transport; they do **not** prove provider availability or actual tool/model changes in the browser. Parent SDK integration separately tests real role switching without model requests.
- Live PowerShell and AI Bash PTY smoke: both streamed output successfully.
- No provider/model requests made. User's CLI branch and model configuration unchanged.

Generated `reference/astra-polish-*.png` images show test projects and agent presentation, not real model conversations. Existing `astra-*.png` shell captures were refreshed.

Run from PiAstra: `npm run start:fork`, then open http://127.0.0.1:8790. Restart an already-running fork server and refresh its browser tab after this update (protocol version 16).

## Remaining validation

- Real subscription-backed conversation with the user's chosen models.
- Narrow-window visual review and additional typography/spacing feedback.
- Parent and sibling commits are local only; nothing pushed. The sibling's three pre-existing generated vendor line-ending changes remain excluded.
