/**
 * The data-only YAML surface used by the skill install gate.
 *
 * Intentionally narrow: the gate needs exactly `FAILSAFE_SCHEMA` and the
 * two-argument `load` — nothing else of js-yaml is imported anywhere in the
 * app. `@types/js-yaml` would widen the module's shape far beyond this (and a
 * new dependency would churn the lock file again), so this hand-rolled shim
 * keeps the surface to what is actually called.
 */
declare module 'js-yaml' {
  export const FAILSAFE_SCHEMA: object
  export function load(text: string, options: { schema: object }): unknown
}
