/**
 * The worker-side tool-call gate (issue #69; PLAN §7 "Execution policy";
 * threat model B4; ADR 0001 row 2 "tool-call hooks as policy gates").
 *
 * `src/security/execution-policy.ts` decides; this module *applies* the
 * decision at the two places a call can be stopped:
 *
 * - **Before a worker exists** — `assertRoutesClosed` proves, for a read-only
 *   role, that no entry in its `--tools` list reaches any mutation route. A
 *   role whose allowlist was widened to include `bash` fails here, at spawn
 *   time, rather than at the first command.
 * - **On every call** — `createToolGate` returns a `tool_call` handler in
 *   Pi's shape (`undefined` to allow, `{ block: true, reason }` to deny), so
 *   a tool the `--tools` allowlist did not remove (a custom tool, a tool
 *   contributed by an extension) is still refused.
 *
 * Every denial is recorded through an audit sink, because "the worker tried
 * to write and was stopped" is a fact the run needs to keep: a blocked call
 * that leaves no trace looks identical to a worker that never tried.
 */
import {
  decideToolCall,
  routeOf,
  type ExecutionContext,
  type ExecutionDecision,
  type MutationRoute,
  type ToolCallFacts,
} from "../security/execution-policy.ts";
import { isReadOnlyRole, roleTools, type RoleId } from "./roles.ts";

/** What a `tool_call` hook may return in Pi's API: nothing, or a block. */
export type ToolGateResult = undefined | { readonly block: true; readonly reason: string };

/** One recorded gate decision. Written for denials; allowed calls are not logged. */
export interface GateAuditEntry {
  readonly workerId: string;
  readonly role: RoleId;
  readonly toolName: string;
  readonly route: MutationRoute | "read";
  readonly rule: string;
  readonly reason: string;
  readonly paths: readonly string[];
  /** The shell command, when the call was a shell call. Never truncated here. */
  readonly command: string | null;
}

/** Sink for gate denials. Injected so the gate itself stays pure. */
export type GateAuditSink = (entry: GateAuditEntry) => void;

/** Everything the gate needs beyond one call. */
export interface ToolGateOptions extends ExecutionContext {
  readonly workerId: string;
  readonly audit?: GateAuditSink;
}

/** Raised by {@link assertRoutesClosed} when a role's allowlist opens a route. */
export class RouteOpenError extends Error {
  readonly role: RoleId;
  readonly openRoutes: readonly { readonly tool: string; readonly route: MutationRoute }[];
  constructor(role: RoleId, openRoutes: readonly { tool: string; route: MutationRoute }[]) {
    super(
      `read-only role '${role}' has open mutation route(s): ` +
        openRoutes.map((o) => `${o.tool} -> ${o.route}`).join(", "),
    );
    this.name = "RouteOpenError";
    this.role = role;
    this.openRoutes = openRoutes;
  }
}

/** Prove a read-only role's tool list reaches no mutation route. */
export function assertRoutesClosed(role: RoleId, tools: readonly string[] = roleTools(role)): void {
  if (!isReadOnlyRole(role)) return;
  const open: { tool: string; route: MutationRoute }[] = [];
  for (const tool of tools) {
    const route = routeOf(tool);
    if (route !== "read") open.push({ tool, route });
  }
  if (open.length > 0) throw new RouteOpenError(role, open);
}

/**
 * Evaluate one call: the policy decision plus the audit entry a denial
 * produces. Separated from {@link createToolGate} so a test can assert on the
 * audit entry without installing a hook, and so the gate has no logic of its
 * own beyond translating a decision into Pi's return shape.
 */
export function evaluateToolCall(
  call: ToolCallFacts,
  options: ToolGateOptions,
): { readonly decision: ExecutionDecision; readonly audit: GateAuditEntry | null } {
  const decision = decideToolCall(call, options);
  if (decision.allow) return { decision, audit: null };
  const command = typeof call.input["command"] === "string" ? (call.input["command"] as string) : null;
  return {
    decision,
    audit: {
      workerId: options.workerId,
      role: options.role,
      toolName: call.toolName,
      route: decision.route,
      rule: decision.rule,
      reason: decision.reason,
      paths: decision.paths,
      command,
    },
  };
}

/**
 * The gate: a `tool_call` handler bound to one worker.
 *
 * Returns `undefined` for a permitted call and `{ block: true, reason }` for
 * a refused one, which is what Pi's `tool_call` event expects
 * (`docs/extensions.md`; the reason is returned to the model as an error tool
 * result, so it is phrased for the model to act on).
 *
 * A throwing audit sink does **not** turn a denial into an allow: the entry
 * is lost, the block stands. Failing open because logging failed would make
 * the audit trail a bypass.
 */
export function createToolGate(options: ToolGateOptions): (call: ToolCallFacts) => ToolGateResult {
  return (call) => {
    const { decision, audit } = evaluateToolCall(call, options);
    if (decision.allow) return undefined;
    if (audit !== null && options.audit !== undefined) {
      try {
        options.audit(audit);
      } catch {
        // Deliberately swallowed: see the note above.
      }
    }
    return { block: true, reason: gateReason(decision, options.role) };
  };
}

/** Message handed back to the model. Names the route, not just the tool. */
export function gateReason(decision: ExecutionDecision, role: RoleId): string {
  const head = `Blocked by KorWF execution policy (${decision.rule}) for role '${role}'`;
  const tail =
    decision.route === "read"
      ? decision.reason
      : `${decision.reason}. Mutation route '${decision.route}' is closed for this worker; report what you found instead of working around it.`;
  return `${head}: ${tail}`;
}
