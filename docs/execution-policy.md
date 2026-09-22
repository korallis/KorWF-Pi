# Execution policy: read-only roles across every mutation route

*Issue #69. Design authority: PLAN §7 "Execution policy", §3.E; threat model B4;
ADR 0001 row 2 (tool-call hooks as policy gates), ADR 0004 (worker interface),
ADR 0009 (worktree isolation).*

> All mutation routes tested (bash, custom tools); disabling `edit`/`write` alone is
> not read-only enforcement. — PLAN §7

A scout or reviewer with a shell can write a file. That sentence is why this
document exists: "read-only" is a property of *every route out*, not of the
absence of two tool names.

## 1. The routes

`MUTATION_ROUTES` in `src/security/execution-policy.ts` enumerates them. Each is
closed independently; none relies on another.

| Route | How a worker would use it | Where it is closed |
|---|---|---|
| `edit` | `edit`, `multiedit`, `apply_patch` | not in a read-only role's `--tools`; re-checked by route in the gate |
| `write` | `write`, `notebook_edit` | same |
| `shell` | `bash` with `>`, `>>`, `tee`, `sed -i`, `cp`, `mv`, `install`, `rm`, an interpreter, a here-doc, `xargs`, `find -exec` … | read-only roles get no shell tool at all; for roles that do, `src/security/bash-classifier.ts` classifies every segment |
| `custom_tool` | any tool an extension contributes, or a renamed built-in | **default-deny**: an unrecognised tool name is route `custom_tool` and is refused unless the role's allowlist names it |
| `git` | `git commit`, `git push`, `git reset`, a `git_*` tool | refused for every worker: `src/git/` is the only place that runs git (ADR 0002) |
| `store` | `sqlite3`, anything touching `.korwf/` | refused for every worker: the store is written through `src/storage/` only (ADR 0006 single writer) |

## 2. The four layers

Ordered strongest to weakest. A defect in one does not open a route, because the
next still holds — the adversarial tests are run with each layer disabled in turn.

1. **`--tools` on the worker command line** (#68, ADR 0004). A strict allowlist
   across built-in, extension and custom tools, so a tool that is absent is not
   discouraged, it is *unreachable*. This is the primary mechanism.
2. **The tool-call gate** (`src/workers/tool-gate.ts`), installed as a Pi
   `tool_call` hook. Catches whatever reached a tool the allowlist did not
   remove, and is the layer that inspects shell command *contents*.
3. **Path boundaries.** Applies to every role including the implementer: the
   worktree and this attempt's own `.korwf/artifacts/<attemptId>` directory, and
   nothing else. Deny globs (`.env`, key material, the SQLite store) apply inside
   the worktree too.
4. **A sandbox**, when the platform provides one. KorWF ships none (ADR 0001 row
   3); `detectSandbox()` records whether one is present so the residual risk is
   visible. **Nothing in the policy becomes laxer when a sandbox is detected.**

## 3. Permissions never come from confidence

PLAN §7, first bullet: *permissions come from user-approved rules and execution
isolation, not semantic confidence.* This is enforced structurally rather than by
convention — `decideToolCall(call, ctx)` has **no parameter** through which a Jev
score, a probability, or a worker's assurance could arrive. Two tests pin it:
one asserts no input field is named for a score, and one attaches
`jevScore: 0.99`, `confidence: 1` and `approved: true` to every adversarial call
and asserts not one verdict changes.

Jev's role in this area is the one ADR 0008 and `workflow/approval-classes.ts`
already define: it may *escalate* a disposition, never de-escalate one. There is
no path by which it grants a mutation.

## 4. Known residual risk

**R7 (threat model): a regex classifier for shell is bypassable in principle.**
This is a policy gate, not a sandbox, and it is written down rather than argued
away. The mitigations that make it acceptable:

- A read-only role never has a shell tool, so for the roles this issue is about,
  the classifier is the *second* line, not the first.
- The classifier is **default-deny**: a command must match an anchored allowlist
  entry, so an unknown command is refused rather than permitted. Bypassing it
  requires a command that is on the allowlist *and* mutates, not merely one the
  denylist forgot.
- The allowlist is applied **per segment** (`;`, `&&`, `||`, `|`, `&`, newlines),
  which closes the `ls && <anything>` hole in the upstream `plan-mode` classifier
  it is adapted from.
- Indirection is refused outright rather than inspected: interpreters, `eval`,
  `source`, `xargs`, `find -exec`, command and process substitution. A classifier
  cannot see what an interpreter will do, so it does not try.
- Path boundaries are independent of the classifier, so a bypass still lands
  inside the worktree.

**R8: an absolute path in a shell command is not stopped by cwd.** It is stopped
by the classifier (which refuses the writing command regardless of its argument)
and, for tool calls, by the path check. A sandbox would stop it at the kernel.

**R9: no shipped sandbox means no network isolation for `bash`.** `PI_OFFLINE=1`
is set for roles that need nothing beyond the model endpoint (ADR 0004), and the
classifier refuses `curl -o`, `wget`, `ssh`, `scp` and `nc`, but a determined
command in a role that legitimately has a shell can still reach the network.
Recorded, not solved; solving it requires the separately defined sandbox PLAN
§3.E names.

## 5. Auditing

Every denial produces a `GateAuditEntry`: worker, role, tool, route, rule,
reason, resolved paths, and the shell command when there was one. Allowed calls
are not logged — the interesting event is the attempt that was stopped, and "a
worker tried to write outside its worktree" must not be indistinguishable from
"a worker never tried". A throwing audit sink never turns a denial into an
allow; the entry is lost and the block stands.
