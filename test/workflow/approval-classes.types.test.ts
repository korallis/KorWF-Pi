/** #15: compile-time coverage — the data table, config types and schema vocabulary agree. */
import type { ApprovalClass, ConfigurableApprovalClass, HighRiskApprovalClass, NoAutoApprovalClass } from "../../src/config/types.ts";
import type { ApprovalClassId, ConfigurableClassId, HighRiskClassId, NoAutoClassId } from "../../src/workflow/approval-classes.ts";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Assert<T extends true> = T;
type _AllClasses = Assert<Equal<ApprovalClass, ApprovalClassId>>;
type _Configurable = Assert<Equal<ConfigurableApprovalClass, ConfigurableClassId>>;
type _NoAuto = Assert<Equal<NoAutoApprovalClass, NoAutoClassId>>;
type _HighRisk = Assert<Equal<HighRiskApprovalClass, HighRiskClassId>>;
