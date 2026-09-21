/**
 * Schema, defaults, validation, layered merge (KorWF-Pi module, see docs/adr/0002-source-layout.md).
 *
 * Issue #11 drafted the contract: `schema.json` (JSON Schema 2020-12),
 * `types.ts`, and docs/config-reference.md. Loading, layered merge and the
 * validator rules V1–V12 are issue #21 (V10–V12 have a pure implementation in `src/workflow/approval-classes.ts`).
 */
export * from "./types.ts";
export {
  CONFIG_SCHEMA,
  SCHEMA_PATH,
  SHIPPED_DENY_PATHS,
  SHIPPED_DENY_PATTERNS,
  PROJECT_CONFIG_RELATIVE_PATH,
  USER_CONFIG_RELATIVE_PATH,
  shippedDefaults,
  materialiseDefaults,
} from "./defaults.ts";
export type { SchemaNode } from "./defaults.ts";
export { checkAgainstSchema } from "./schema-check.ts";
export type { SchemaIssue } from "./schema-check.ts";
export { validateConfig, formatIssue, effectiveAllowlist, globToRegExp } from "./validate.ts";
export type { ConfigIssue, ConfigRuleId, ValidateOptions, ValidationResult } from "./validate.ts";
export {
  loadConfig,
  defaultConfig,
  deepFreeze,
  mergeLayer,
  envOverrides,
  defaultUserConfigDir,
  ENV_OVERRIDES,
} from "./load.ts";
export type {
  ConfigLoadResult,
  LoadedConfig,
  FailedConfigLoad,
  LoadOptions,
  ConfigLayerName,
  ConfigLayerInfo,
} from "./load.ts";
