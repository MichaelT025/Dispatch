import { createAuthResolver } from './auth.mjs';
import { fetchProvider } from './adapter.mjs';
import { codexProvider } from './codex.mjs';
import { goProvider } from './go.mjs';
import { commandProvider } from './command.mjs';
import { createUsageService } from './service.mjs';
import { startUsagePolling } from './polling.mjs';
import { createUsageSidebar } from './sidebar.mjs';
import { formatUsageRows } from './format.mjs';

export function isUsageSession(ctx) {
  if (ctx.mode !== 'tui') return false;
  const file = ctx.sessionManager?.getSessionFile?.();
  return typeof file !== 'string' || !/(?:^|[\\/])piastra[\\/]runs[\\/]/i.test(file);
}

/** Register only: no I/O/timers until an interactive session starts. */
export function registerUsageExtension(pi, {
  authResolver = createAuthResolver,
  fetchOne = fetchProvider,
  serviceFactory = createUsageService,
  pollingFactory = startUsagePolling,
  sidebarFactory = createUsageSidebar,
  env = process.env,
} = {}) {
  let active;
  const stop = () => {
    const previous = active;
    active = undefined;
    if (!previous) return;
    previous.polling.dispose();
    previous.service.dispose();
    previous.sidebar.dispose();
  };
  pi.on('session_start', (_event, ctx) => {
    stop();
    if (!isUsageSession(ctx) || env.DISPATCH_USAGE_DISABLED === '1') return;
    const resolveAuth = authResolver(ctx.modelRegistry);
    const sidebar = sidebarFactory(pi.events);
    const service = serviceFactory({
      providers: [codexProvider, goProvider, commandProvider],
      fetchProvider: (provider, { signal }) => fetchOne(provider, { resolveAuth, signal }),
      onUpdate: snapshot => sidebar.update(snapshot),
    });
    const polling = pollingFactory(() => service.refresh());
    active = { service, sidebar, polling };
  });
  pi.on('session_shutdown', stop);
  pi.registerCommand('usage', {
    description: 'Subscription usage for Codex, OpenCode Go and Command Code; /usage refresh updates it',
    handler: async (args, ctx) => {
      if (!isUsageSession(ctx)) return;
      const command = args.trim().toLowerCase();
      if (command && command !== 'refresh') {
        ctx.ui.notify('Usage: /usage or /usage refresh. Enable dispatch:subscriptions in /atelier display.', 'info');
        return;
      }
      const current = active;
      if (!current) {
        ctx.ui.notify('Subscription usage is disabled. Unset DISPATCH_USAGE_DISABLED and reload to enable it.', 'info');
        return;
      }
      if (command === 'refresh') await current.service.refresh();
      // The command may finish after /new or /reload; never publish into that session.
      if (active !== current) return;
      const rows = formatUsageRows(current.service.getSnapshot(), { details: true });
      ctx.ui.notify(['Subscriptions (account-level)', ...rows.map(row => row.text),
        'Sidebar: enable dispatch:subscriptions in /atelier display.'].join('\n'), 'info');
    },
  });
  return { dispose: stop };
}
