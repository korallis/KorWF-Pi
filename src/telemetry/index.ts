/**
 * Decision traces, accounting, metrics (KorWF-Pi module, see docs/adr/0002-source-layout.md).
 *
 * Issue #30 added usage accounting and atomic budget reservations
 * (`ledger.ts`). Issue #31 added decision traces (`trace.ts`) and the
 * opt-in raw-payload logging path with retention (`retention.ts`) beside
 * it, sharing the same store rather than forming a parallel system.
 */
export {
  Ledger,
  openLedger,
  reconcileAbandonedReservations,
  BudgetExceededError,
  BudgetExceeded,
  UsageIntegrityError,
  classifyCost,
  hasUsablePrice,
  unknownUsage,
  noUsage,
  assertHonestUsage,
  UNKNOWN_COST,
  SCOPE_ORDER,
  LEDGER_ABANDONED_REASON,
} from "./ledger.ts";
export type {
  AbandonedReservation,
  CapStatus,
  ChargeScope,
  LedgerOptions,
  LedgerReconcileOptions,
  LedgerReconciliationReport,
  LedgerStatus,
  PriceMetadata,
  Reservation,
  ScopeStatus,
  TokenCounts,
} from "./ledger.ts";

export {
  MemoryTraceSink,
  TraceRecorder,
  TraceVersionError,
  REQUIRED_TRACE_VERSIONS,
  assertTraceVersions,
  explainDecision,
  missingTraceVersions,
  requestHashOf,
  schemaVersionString,
  summariseRequest,
} from "./trace.ts";
export type {
  DecisionTrace,
  Explanation,
  ExplanationLine,
  RawPayloadSink,
  TraceDraft,
  TraceOutcome,
  TraceOutcomeDetail,
  TraceQuestion,
  TraceRawPayloadRef,
  TraceRecorderOptions,
  TraceRequestSummary,
  TraceSink,
  TraceVersions,
} from "./trace.ts";

export {
  ArtifactRawPayloadSink,
  RawPayloadRefusedError,
  RAW_LOG_ATTEMPT_DIR,
  createRawPayloadSink,
  expiryOf,
  purgeExpiredRawPayloads,
  purgeRawPayloadsNow,
  retentionSummary,
  runRetentionSweep,
} from "./retention.ts";
export type { RawPayloadSinkOptions, RetentionOptions, RetentionReport } from "./retention.ts";
