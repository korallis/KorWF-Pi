/**
 * Shell mutation classifier (issue #69; PLAN §7 "All mutation routes tested
 * (bash, custom tools); disabling `edit`/`write` alone is not read-only
 * enforcement"; ADR 0001 row 2).
 *
 * Adapted from pi 0.86.1 examples/extensions/plan-mode/utils.ts — MIT, © Mario Zechner / earendil-works
 *
 * What is adapted: the shape of the decision (an anchored allowlist of
 * read-only commands, plus a denylist that overrides it) and many of the
 * individual patterns. What is different, and why this file exists rather
 * than an import:
 *
 * 1. **The upstream classifier tests the whole command string against an
 *    allowlist anchored at `^`.** `ls; python -c "open('f','w')"` therefore
 *    passes: `^\s*ls` matches and no destructive pattern fires. Here the
 *    command is split into segments at `;`, `&&`, `||`, `|`, newlines and
 *    command substitutions, and *every* segment must pass on its own.
 * 2. `curl`/`wget`/`awk` are not unconditionally safe: `curl -o`, `wget`
 *    without `-O-` and `awk 'print > "f"'` all write files.
 * 3. Indirection — `eval`, `xargs`, `find -exec`, interpreters, here-docs,
 *    process substitution — is refused rather than inspected: a classifier
 *    cannot see what an interpreter will do.
 * 4. The verdict names the rule that produced it, so a block can be audited.
 *
 * **This is a policy gate, not a sandbox** (threat model R7). A regex over a
 * shell command is bypassable in principle; it is one of several independent
 * layers, and for read-only roles it is the *second* line — the first is that
 * `--tools` never gives them a shell at all (`src/workers/roles.ts`).
 */

/** One named denylist rule. The id is what an audit row records. */
export interface ShellRule {
  readonly id: string;
  readonly re: RegExp;
  /** Short explanation shown to the model when the call is blocked. */
  readonly why: string;
}

/** Result of classifying one shell command. */
export interface ShellVerdict {
  /** True only when every segment is on the read-only allowlist. */
  readonly safe: boolean;
  /** Id of the denylist rule that fired, `"not-allowlisted"`, or `null` when safe. */
  readonly rule: string | null;
  /** The offending segment, or the whole command when no segment could be isolated. */
  readonly segment: string | null;
  readonly reason: string;
}

/** Commands that mutate, escalate, or hand execution to something unclassifiable. */
export const DESTRUCTIVE_RULES: readonly ShellRule[] = [
  // --- writing to the filesystem -------------------------------------------
  { id: "redirect", re: /(^|[^0-9<>&|])>(?!>)/, why: "output redirection writes a file" },
  { id: "redirect-append", re: />>/, why: "appending redirection writes a file" },
  { id: "redirect-fd", re: /\d+>/, why: "file-descriptor redirection writes a file" },
  { id: "heredoc", re: /<<-?\s*['"]?[A-Za-z_]/, why: "here-documents are normally paired with a write" },
  { id: "tee", re: /\btee\b/i, why: "tee writes its input to a file" },
  { id: "rm", re: /\brm\b/i, why: "rm deletes files" },
  { id: "rmdir", re: /\brmdir\b/i, why: "rmdir deletes directories" },
  { id: "mv", re: /\bmv\b/i, why: "mv moves or renames files" },
  { id: "cp", re: /\bcp\b/i, why: "cp creates files" },
  { id: "install", re: /\binstall\b/i, why: "install(1) copies files into place" },
  { id: "rsync", re: /\brsync\b/i, why: "rsync copies files" },
  { id: "mkdir", re: /\bmkdir\b/i, why: "mkdir creates directories" },
  { id: "touch", re: /\btouch\b/i, why: "touch creates files" },
  { id: "chmod", re: /\bchmod\b/i, why: "chmod changes file metadata" },
  { id: "chown", re: /\bchown\b/i, why: "chown changes file ownership" },
  { id: "chgrp", re: /\bchgrp\b/i, why: "chgrp changes file ownership" },
  { id: "chflags", re: /\bchflags\b/i, why: "chflags changes file metadata" },
  { id: "ln", re: /\bln\b/i, why: "ln creates links" },
  { id: "truncate", re: /\btruncate\b/i, why: "truncate rewrites a file" },
  { id: "dd", re: /\bdd\b/i, why: "dd writes blocks" },
  { id: "shred", re: /\bshred\b/i, why: "shred destroys files" },
  { id: "mktemp", re: /\bmktemp\b/i, why: "mktemp creates files" },
  { id: "tar-extract", re: /\b(tar|unzip|gunzip|bsdtar|7z)\b/i, why: "archive tools write files" },
  { id: "patch", re: /\bpatch\b/i, why: "patch edits files in place" },
  // In-place editors. `sed -n` is allowlisted below; `sed -i` is not, and the
  // denylist wins, so no ordering of flags can smuggle it through.
  { id: "sed-in-place", re: /\bsed\b[^|;]*\s-[A-Za-z]*i/i, why: "sed -i edits files in place" },
  { id: "perl-in-place", re: /\bperl\b[^|;]*\s-[A-Za-z]*i/i, why: "perl -i edits files in place" },
  { id: "editor", re: /\b(vim?|nano|emacs|ed|pico|code|subl)\b/i, why: "interactive editors mutate files" },
  // --- indirection: unclassifiable by construction --------------------------
  { id: "eval", re: /\b(eval|source|exec)\b/i, why: "eval/source/exec run text this gate cannot classify" },
  // Anchored: only a segment that *starts* with `.` is the sourcing builtin.
  // `find . -name x` and `jq . f.json` pass a literal dot as an argument.
  { id: "dot-source", re: /^\.\s+\S/, why: "`. file` sources a script this gate cannot classify" },
  { id: "interpreter", re: /\b(ba|z|k|c|da|fi)?sh\b|\b(python3?|node|deno|bun|ruby|perl|php|lua|Rscript|osascript|pwsh)\b/i, why: "an interpreter can write files; its program is not classifiable here" },
  { id: "xargs", re: /\bxargs\b/i, why: "xargs runs a command built at runtime" },
  { id: "find-exec", re: /\bfind\b[^|;]*-(exec|execdir|delete|ok|okdir|fprint|fls)\b/i, why: "find -exec/-delete runs or deletes" },
  { id: "process-substitution", re: /[<>]\(/, why: "process substitution runs a nested command" },
  { id: "command-substitution", re: /\$\(|`/, why: "command substitution runs a nested command" },
  // --- package managers and system state ------------------------------------
  { id: "npm-mutate", re: /\bnpm\s+(install|i|uninstall|remove|rm|update|ci|link|publish|run|exec|init|pack|version)\b/i, why: "npm can install or run arbitrary code" },
  { id: "npx", re: /\b(npx|pnpx|bunx)\b/i, why: "npx downloads and runs arbitrary code" },
  { id: "yarn-mutate", re: /\byarn\s+(add|remove|install|publish|run)\b/i, why: "yarn can install or run arbitrary code" },
  { id: "pnpm-mutate", re: /\bpnpm\s+(add|remove|install|publish|run|exec)\b/i, why: "pnpm can install or run arbitrary code" },
  { id: "pip", re: /\bpip3?\s+(install|uninstall)\b/i, why: "pip installs packages" },
  { id: "system-package", re: /\b(apt|apt-get|dnf|yum|pacman|apk|zypper)\b/i, why: "system package managers change the machine" },
  { id: "brew", re: /\bbrew\s+(install|uninstall|upgrade|link|tap)\b/i, why: "brew changes the machine" },
  { id: "cargo-go", re: /\b(cargo|go)\s+(install|build|get|run|test)\b/i, why: "build tools write artefacts" },
  { id: "make", re: /\b(make|cmake|ninja|gradle|mvn)\b/i, why: "build tools write artefacts and run scripts" },
  { id: "docker", re: /\b(docker|podman|kubectl|helm|terraform)\b/i, why: "container and infrastructure tools mutate external state" },
  { id: "privilege", re: /\b(sudo|doas|su)\b/i, why: "privilege escalation is never permitted" },
  { id: "signal", re: /\b(kill|pkill|killall)\b/i, why: "signalling processes mutates system state" },
  { id: "power", re: /\b(reboot|shutdown|halt|poweroff)\b/i, why: "power commands mutate system state" },
  { id: "service", re: /\b(systemctl|launchctl|service)\b/i, why: "service control mutates system state" },
  { id: "crontab", re: /\b(crontab|at)\b/i, why: "scheduling runs code later" },
  // --- git: every mutating porcelain and plumbing verb -----------------------
  {
    id: "git-mutate",
    re: /\bgit\b[\s\S]*\b(add|am|apply|commit|push|pull|fetch|merge|rebase|reset|restore|revert|checkout|switch|stash|cherry-pick|clean|rm|mv|tag|init|clone|worktree|submodule|gc|prune|notes|update-ref|update-index|write-tree|commit-tree|hash-object|symbolic-ref|filter-branch|replace|repack|remote|config|daemon|send-email|format-patch|bisect)\b/i,
    why: "git can rewrite the repository; all git goes through src/git/",
  },
  { id: "gh-mutate", re: /\b(gh|glab|hub)\b/i, why: "forge CLIs mutate remote state" },
  // --- network egress that can also write ------------------------------------
  { id: "curl-output", re: /\bcurl\b[^|;]*\s-(o|O|-output|O-remote-name)\b/i, why: "curl -o writes a file" },
  { id: "wget-output", re: /\bwget\b(?![^|;]*\s-O\s*-)/i, why: "wget writes a file unless it is -O-" },
  { id: "awk-redirect", re: /\bawk\b[^|;]*>/i, why: "awk can redirect to a file" },
  { id: "nc", re: /\b(nc|ncat|netcat|socat|ssh|scp|sftp|rsh|telnet)\b/i, why: "remote execution and transfer tools mutate elsewhere" },
  // --- the store itself -------------------------------------------------------
  { id: "sqlite", re: /\bsqlite3?\b/i, why: "direct database access bypasses the store's invariants" },
  { id: "korwf-store", re: /\.korwf\b/i, why: "the KorWF store is written only through src/storage" },
  { id: "env-file", re: /(^|[\s"'/=])\.env(\.|\b)/i, why: "credential files are denied outright" },
];

/**
 * Anchored allowlist of read-only commands. A segment must match one of
 * these *and* trip no denylist rule. Anything not listed is denied: the
 * default is refusal, so a command nobody thought about is blocked rather
 * than permitted.
 */
export const SAFE_PATTERNS: readonly RegExp[] = [
  /^cat\b/,
  /^head\b/,
  /^tail\b/,
  /^less\b/,
  /^more\b/,
  /^grep\b/,
  /^egrep\b/,
  /^fgrep\b/,
  /^rg\b/,
  /^ag\b/,
  /^find\b/,
  /^fd\b/,
  /^ls\b/,
  /^eza\b/,
  /^tree\b/,
  /^pwd\b/,
  /^echo\b/,
  /^printf\b/,
  /^wc\b/,
  /^sort\b/,
  /^uniq\b/,
  /^cut\b/,
  /^tr\b/,
  /^column\b/,
  /^diff\b/,
  /^cmp\b/,
  /^file\b/,
  /^stat\b/,
  /^du\b/,
  /^df\b/,
  /^which\b/,
  /^whereis\b/,
  /^type\b/,
  /^env$/,
  /^printenv\b/,
  /^uname\b/,
  /^whoami\b/,
  /^id\b/,
  /^date\b/,
  /^cal\b/,
  /^uptime\b/,
  /^ps\b/,
  /^free\b/,
  /^jq\b/,
  /^yq\b/,
  /^bat\b/,
  /^md5sum\b/,
  /^sha\d+sum\b/,
  /^basename\b/,
  /^dirname\b/,
  /^realpath\b/,
  /^readlink\b/,
  /^true$/,
  /^false$/,
  // Read-only git porcelain. The `git-mutate` denylist rule still applies and
  // wins, so `git log && git commit` cannot pass by matching here.
  /^git\s+(status|log|diff|show|blame|describe|branch\s*$|branch\s+--list|branch\s+-v|shortlog|rev-parse|rev-list|cat-file|ls-files|ls-tree|ls-remote|grep|for-each-ref|merge-base|name-rev|count-objects|verify-commit|whatchanged|reflog\s*$|reflog\s+show)\b/,
  /^npm\s+(list|ls|view|info|search|outdated|audit|why|explain|--version|-v)\b/,
  /^node\s+--version$/,
  /^python3?\s+--version$/,
  /^tsc\s+--version$/,
  // `sed -n` prints; `sed -i` is caught by the denylist regardless of order.
  /^sed\s+-n\b/,
  /^awk\b/,
  /^cd\b/,
];

/**
 * Split a command line into independently-classified segments.
 *
 * The upstream classifier anchors its allowlist at the start of the *whole*
 * string, so `ls && rm -rf .` matches `^ls` and only the denylist stands
 * between it and a deletion. Splitting first means every segment must earn
 * its own place on the allowlist, and `ls && <anything unlisted>` is denied
 * even if no denylist rule names it.
 *
 * Separators: `;`, `&&`, `||`, `|`, `&`, and newlines. Quoting is *not*
 * honoured — a separator inside a string still splits. That can only make
 * the verdict stricter (more segments to justify), never laxer, which is the
 * correct direction for a gate to be wrong in.
 */
export function splitSegments(command: string): readonly string[] {
  return command
    .split(/(?:\|\||&&|[;\n|&])+/)
    .map((s) => s.trim())
    .filter((s) => s !== "");
}

/** Strip leading `VAR=value` assignments and `command`/`builtin` prefixes. */
function stripPrefixes(segment: string): string {
  let s = segment.trim();
  // `FOO=bar cmd` — the assignment itself mutates only the environment.
  while (/^[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|[^\s]*)\s+\S/.test(s)) {
    s = s.replace(/^[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|[^\s]*)\s+/, "");
  }
  s = s.replace(/^(?:command|builtin|nohup|time|env\s+(?=\S+=|\S))\s+/, "");
  // Shell grouping/subshell punctuation: unwrap so the inner command is seen.
  s = s.replace(/^[({\s]+/, "").replace(/[)}\s]+$/, "");
  return s.trim();
}

/**
 * Classify one shell command line.
 *
 * Order matters: the denylist is evaluated against the *whole* command first,
 * because rules like redirection and command substitution are properties of
 * the line rather than of any one segment. Then each segment must match the
 * allowlist. A command that is neither denied nor allowlisted is denied.
 */
export function classifyCommand(command: string): ShellVerdict {
  const trimmed = command.trim();
  if (trimmed === "") {
    return { safe: false, rule: "empty", segment: null, reason: "empty command" };
  }
  for (const rule of DESTRUCTIVE_RULES) {
    if (rule.re.test(trimmed)) {
      return { safe: false, rule: rule.id, segment: trimmed, reason: rule.why };
    }
  }
  const segments = splitSegments(trimmed);
  if (segments.length === 0) {
    return { safe: false, rule: "empty", segment: null, reason: "empty command" };
  }
  for (const raw of segments) {
    const segment = stripPrefixes(raw);
    if (segment === "") continue;
    for (const rule of DESTRUCTIVE_RULES) {
      if (rule.re.test(segment)) {
        return { safe: false, rule: rule.id, segment, reason: rule.why };
      }
    }
    if (!SAFE_PATTERNS.some((p) => p.test(segment))) {
      return {
        safe: false,
        rule: "not-allowlisted",
        segment,
        reason: `'${segment.split(/\s+/)[0] ?? segment}' is not on the read-only command allowlist`,
      };
    }
  }
  return { safe: true, rule: null, segment: null, reason: "every segment is on the read-only allowlist" };
}

/** Upstream-compatible boolean form. */
export function isSafeCommand(command: string): boolean {
  return classifyCommand(command).safe;
}
