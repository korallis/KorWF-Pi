/**
 * Subprocess lifecycle, contracts, role loading, handoff to workers (KorWF-Pi module, see docs/adr/0002-source-layout.md).
 *
 * Implemented so far:
 * - `truncation.ts` — `stopReason` capture and harness/quality classification (#124).
 * - `roles.ts` — shipped worker role contracts from `resources/roles/` (#124).
 */
export {
  HARNESS_FAILURE_KINDS,
  QUALITY_JUDGEMENT_PHRASES,
  TRUNCATION_FEEDBACK,
  TRUNCATION_STOP_REASON,
  classifyTurn,
  isHarnessFeedback,
  isHarnessFailure,
  isTruncated,
} from "./truncation.ts";
export type {
  AttemptFailureKind,
  FailureClass,
  TurnClassification,
  WorkerStopReason,
  WorkerTurnObservation,
} from "./truncation.ts";

export { ROLE_IDS, INCREMENTAL_WRITE_RULES, loadRole, loadAllRoles, roleContractPath } from "./roles.ts";
export type { RoleId, WorkerRoleContract } from "./roles.ts";
