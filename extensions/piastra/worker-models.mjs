// Worker model resolution.
//
// Workers run on their own ModelRuntime built from auth.json/models.json and
// load no extensions, so providers registered by extensions (Command Code's
// commandcode/commandcode-plan/commandcode-api, custom proxies) exist only on
// the parent session's runtime. Mirror them onto the worker runtime through the
// public ModelRegistry accessors so a role model the parent resolves also
// resolves for its workers, with the same transport and auth resolution.

// What each worker runtime last received, keyed by provider ID. Registrations
// are compared by identity: the parent runtime replaces the stored object on
// every re-registration, so an unchanged provider is not recomposed again.
const mirrored = new WeakMap();

/**
 * Copy the extension providers registered on `registry` (the parent session's
 * ModelRegistry) onto `runtime` (a worker ModelRuntime), and drop providers the
 * parent has since unregistered. Hosts without these accessors are left as-is.
 */
export function mirrorExtensionProviders(runtime, registry) {
  if (typeof registry?.getRegisteredProviderIds !== 'function') return;
  const previous = mirrored.get(runtime) ?? new Map();
  const next = new Map();
  for (const id of registry.getRegisteredProviderIds()) {
    const native = registry.getRegisteredNativeProvider?.(id);
    const config = native ? undefined : registry.getRegisteredProviderConfig?.(id);
    const source = native ?? config;
    if (!source) continue;
    next.set(id, source);
    if (previous.get(id) === source) continue;
    if (native) runtime.registerNativeProvider(native);
    else {
      // registerProvider merges over an earlier registration; the parent's
      // config is already the merged result, so start clean to match it.
      if (previous.has(id)) runtime.unregisterProvider(id);
      runtime.registerProvider(id, config);
    }
  }
  for (const id of previous.keys()) if (!next.has(id)) runtime.unregisterProvider(id);
  mirrored.set(runtime, next);
}

/** Resolve a `provider/model` selection on a worker runtime; model IDs may contain slashes. */
export function resolveWorkerModel(runtime, registry, selection) {
  mirrorExtensionProviders(runtime, registry);
  const slash = selection.indexOf('/');
  return slash > 0 ? runtime.getModel(selection.slice(0, slash), selection.slice(slash + 1)) : undefined;
}
