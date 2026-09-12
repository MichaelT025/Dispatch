// Small English adapter for the vendored DSH diff renderer.
export function t(key: string, args: Record<string, unknown> = {}) {
  return ({ changesContext: 'Unchanged context', changesFoldUnavailable: 'Context unavailable', changesFoldLoading: 'Loading context…', changesFold: `${args.count} unchanged lines`, diffExpand: `Show ${args.count} more lines` } as Record<string, string>)[key] ?? key
}
