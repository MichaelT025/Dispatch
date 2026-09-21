# Notifications

Dispatch uses the same notification categories in its CLI and Dispatch Web: a completed run, a request for input, or a final run failure. Individual tool and worker failures are not desktop alerts. Completion waits for the orchestrator to settle, including retries and pending workers; stopping a run does not count as completion.

## CLI

Native notifications are controlled by the existing **Completion notifications** preference in the Atelier menu. They are available only in interactive TUI sessions, not RPC/web sessions or delegated worker processes.

Delivery is best effort: Windows uses a native toast, macOS uses `osascript`, and Linux uses `notify-send` when installed. OS notification permissions and do-not-disturb settings still apply. Native notifications appear on the machine running the CLI; SSH does not forward them to your local desktop.

## Dispatch Web

Enable **Desktop notifications** in the web settings and accept the browser permission prompt. This preference belongs to the browser, independently of the CLI preference. HTTPS or localhost and a browser supporting desktop notifications are required.

Alerts are delivered only if `document.visibilityState === "hidden"` or `document.hasFocus()` is false. A focused, visible page gets neither a desktop notification nor a notification toast, even after prolonged inactivity. If a browser incorrectly reports a minimized window as focused and visible, the strict rule suppresses the alert.

The test button waits five seconds: switch to another tab or application before the timer expires. Remaining focused skips the test. Denied permissions do not produce an in-app toast fallback.

Only live events trigger alerts. Reconnecting, loading history, and switching conversations do not replay old alerts. Event IDs coordinate duplicate delivery across open tabs; keyed delivery is skipped if safe cross-tab coordination is unavailable. Clicking an alert focuses Dispatch Web and selects its conversation when still available.

Keep a tab open. There are no push subscriptions or server delivery after the page closes. The existing service worker may display a notification requested by an open page; this is not closed-tab Web Push.

Notification text contains only project/session labels and operational status, never prompts, code, raw questions, or error output. Labels themselves may be sensitive: disable notifications if they should not appear on your desktop.

## Development checkouts

CLI implementation lives in `extensions/pi-atelier/`. The web implementation lives in the separate `Dispatch-WebUI` checkout; changes to one checkout do not automatically update the other runtime. Build/restart the web checkout and reload/reinstall the CLI extension to exercise local changes.
