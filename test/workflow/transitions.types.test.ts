/** #13 AC3/AC4: compile-time coverage against #12's complete storage unions. */
import type { ApprovalInvalidation, PhaseGateStatus, TaskStatus } from "../../src/storage/records.ts";
import { APPROVAL_INVALIDATION_EVENTS, PHASE_STORAGE_STATES, TASK_STATES } from "../../src/workflow/transitions.ts";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Assert<T extends true> = T;
type _AC3TaskVocabulary = Assert<Equal<TaskStatus, (typeof TASK_STATES)[number]>>;
type _AC3PhaseStorageVocabulary = Assert<Equal<
  PhaseGateStatus,
  (typeof PHASE_STORAGE_STATES)[keyof typeof PHASE_STORAGE_STATES][number]
>>;
type _AC4InvalidationVocabulary = Assert<Equal<
  ApprovalInvalidation["reason"],
  (typeof APPROVAL_INVALIDATION_EVENTS)[number]["event"]
>>;
