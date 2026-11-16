/** The data-only YAML surface used by the skill install gate. */
declare module 'js-yaml' {
  export const FAILSAFE_SCHEMA: object
  export function load(text: string, options: { schema: object }): unknown
}
