import { join, resolve } from 'node:path';

/**
 * Dispatch user-env compatibility helper.
 *
 * Preferred DISPATCH_* names take precedence over legacy PIASTRA_* aliases
 * with identical defaults. Empty string counts as unset for both names so
 * `VAR=` never overrides a set legacy alias or default. An explicitly set
 * (non-empty) preferred value is authoritative: when it is invalid the caller
 * throws for the preferred name and must NOT silently fall back to legacy.
 */

export function isEnvSet(value) {
  return value !== undefined && value !== '';
}

/** Raw selection: { value, name } or undefined when neither name is set. */
export function selectEnvRaw(env, preferred, legacy) {
  if (isEnvSet(env[preferred])) return { value: env[preferred], name: preferred };
  if (isEnvSet(env[legacy])) return { value: env[legacy], name: legacy };
  return undefined;
}

export function parsePortEnv(env, preferred, legacy, defaultPort) {
  const selected = selectEnvRaw(env, preferred, legacy);
  if (!selected) return defaultPort;
  const port = Number(selected.value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid ${selected.name}.`);
  }
  return port;
}

export const DEFAULT_PORT = 8787;
export const DEFAULT_FORK_PORT = 8790;
export const DEFAULT_TRIAL_PORT = 30141;
export const DEFAULT_TAU_PORT = 3001;
/** Default Dispatch Web sibling checkout. */
export const DEFAULT_FORK_SIBLING = join('..', 'DispatchWeb');

export function parseMainPort(env = process.env) {
  return parsePortEnv(env, 'DISPATCH_PORT', 'PIASTRA_PORT', DEFAULT_PORT);
}

export function parseForkPortEnv(env = process.env) {
  return parsePortEnv(env, 'DISPATCH_FORK_PORT', 'PIASTRA_FORK_PORT', DEFAULT_FORK_PORT);
}

export function parseTrialPort(env = process.env) {
  return parsePortEnv(env, 'DISPATCH_TRIAL_PORT', 'PIASTRA_TRIAL_PORT', DEFAULT_TRIAL_PORT);
}

export function parseTauPort(env = process.env) {
  return parsePortEnv(env, 'DISPATCH_TAU_PORT', 'PIASTRA_TAU_PORT', DEFAULT_TAU_PORT);
}

/** Preferred DISPATCH_FORK_DIR first, legacy PIASTRA_FORK_DIR fallback, then the default sibling. */
export function selectForkDirRaw(env = process.env) {
  return selectEnvRaw(env, 'DISPATCH_FORK_DIR', 'PIASTRA_FORK_DIR');
}

export function resolveForkDir(root, env = process.env) {
  const selected = selectForkDirRaw(env);
  return selected ? resolve(selected.value) : resolve(root, DEFAULT_FORK_SIBLING);
}
