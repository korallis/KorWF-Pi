/**
 * Data boundaries, privacy defaults, execution policy, secrets (KorWF-Pi module, see docs/adr/0002-source-layout.md).
 *
 * Public surface of the security module. Credential resolution and the global
 * redactor land here in issue #22; later issues add the data-boundary filters
 * and execution policy alongside them.
 *
 * Import from this index rather than the files directly: the redactor is only
 * effective if every log sink and every error passes through it, and keeping
 * one entry point makes that reviewable.
 */
export {
  REDACTED,
  MIN_REGISTERED_SECRET_LENGTH,
  SECRET_PATTERNS,
  registerSecretValue,
  redactedValues,
  clearRegisteredSecrets,
  redactString,
  containsSecret,
  assertRedacted,
  redactValue,
  redactedStringify,
  redactError,
  formatError,
  redactingSink,
  consoleSink,
  memorySink,
  createLogger,
} from "./redact.ts";
export type { LogLevel, LogSink, Logger } from "./redact.ts";

export {
  DEFAULT_KEY_ENV_VAR,
  FALLBACK_KEY_ENV_VARS,
  Secret,
  resolveJevKey,
  applyKeyResolution,
  keyDiagnostics,
  authorizationHeader,
} from "./secrets.ts";
export type {
  SecretOrigin,
  SecretsPort,
  ResolveOptions,
  KeyResolution,
  KeyResolutionStatus,
  KeyDiagnostics,
} from "./secrets.ts";
