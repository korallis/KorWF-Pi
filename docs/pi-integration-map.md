# Pi integration-surface map (Pi 0.86.0)

Governing plan: [PLAN.md §4 "Pi integration surfaces to validate"](../PLAN.md) and §12 References.
Issue: #7. Pi docs root: `<pi-install>/` (the local install of `@earendil-works/pi-coding-agent` 0.86.0;
on the author's machine this resolves per AGENTS.md §9). All `docs/...` and `examples/...` paths
below are relative to that root.

The goal of this document is that a second agent can implement any PLAN §4 surface — in
particular a `tool_call` policy gate and a `/korwf` command — **without opening the Pi docs**.
Section 5 contains complete, copy-pasteable worked examples for those two cases.

## 0. Doc files read completely

Every file below was read in full (all lines), including every `.md` cross-reference reachable
from the files named in issue #7.

| File | Lines | Why it matters here |
|------|-------|---------------------|
| `README.md` | — | Top-level orientation, links to all docs |
| `docs/index.md` | 84 | Index of all docs (used to enumerate cross-references) |
| `docs/extensions.md` | 3037 | Primary API: events, `ExtensionAPI`, `ExtensionContext`, tools, commands, UI |
| `docs/packages.md` | 228 | Packaging an extension (`pi.extensions` in `package.json`) |
| `docs/sdk.md` | 1226 | `createAgentSession`, `ModelRuntime`, `customTools`, embedding |
| `docs/rpc.md` | 1618 | `pi --mode rpc` command/event protocol, extension UI over RPC |
| `docs/tui.md` | 961 | `Component` interface, `SelectList`, `BorderedLoader`, widgets |
| `docs/session-format.md` | 480 | JSONL v3 entry types, `SessionManager` API |
| `docs/compaction.md` | 444 | Threshold/manual/overflow compaction, branch summaries, hooks |
| `docs/environment-variables.md` | 100 | `PI_SESSION_ID`, `PI_MODEL`, `AI_AGENT`, `PI_OFFLINE` etc. |
| `docs/models.md` | 605 | `models.json` schema, `thinkingLevelMap`, `modelOverrides` |
| `docs/custom-provider.md` | 786 | `pi.registerProvider`, `ProviderModelConfig` field reference |
| `docs/skills.md` | 232 | Skill locations, `/skill:name`, `resources_discover` |
| `docs/settings.md` | 428 | `enabledModels`, `defaultTools`, `compaction.*`, `sessionDir`, trust |
| `docs/sessions.md` | 172 | `/tree`, `/fork`, `/clone`, `/resume`, labels, bug reports |
| `docs/security.md` | 59 | Project trust is not a sandbox; extensions run as the user |
| `docs/json.md` | 98 | `--mode json` event stream (`AgentEvent` union) |
| `docs/prompt-templates.md` | 96 | `/template` expansion, precedence vs. extension commands |
| `docs/providers.md` | 317 | Credential resolution order, `auth.json`, env-var keys |
| `docs/keybindings.md` | 239 | `pi.registerShortcut` key format, namespaced ids |
| `docs/usage.md` | 312 | Built-in slash commands, CLI flags (`--tools`, `-e`, `--models`) |
| `docs/themes.md` | 322 | Theme tokens used by `theme.fg(...)` in renderers |
| `examples/extensions/permission-gate.ts` | — | Canonical `tool_call` gate |
| `examples/extensions/commands.ts` | — | Canonical `registerCommand` + `getCommands` |

Docs deliberately **not** read (platform/terminal notes with no API surface): `windows.md`,
`termux.md`, `tmux.md`, `terminal-setup.md`, `shell-aliases.md`, `containerization.md`,
`llama-cpp.md`, `quickstart.md`, `development.md`.

## 1. How an extension is loaded (needed by every surface)

| Aspect | Concrete API / location | Doc reference |
|--------|--------------------------|---------------|
| Module shape | `export default function (pi: ExtensionAPI) { ... }` — may be `async` | extensions.md "Writing an Extension", "Async factory functions" |
| Import package | `@earendil-works/pi-coding-agent` (types, `isToolCallEventType`, `SessionManager`, `CONFIG_DIR_NAME`); `@earendil-works/pi-tui` (components); `@earendil-works/pi-ai` (`StringEnum`, `createProvider`); `typebox` (`Type`) | extensions.md "Available Imports" |
| Discovery locations | `~/.pi/agent/extensions/*.ts` or `<dir>/index.ts` (global); `.pi/extensions/` (project, trusted only); `extensions` array in settings; `pi.extensions` in a package's `package.json`; CLI `-e <path\|npm\|git>` | extensions.md "Extension Locations"; packages.md; settings.md "Resources" |
| Project trust gate | Project-local extensions load only after trust; `ctx.isProjectTrusted()`; `defaultProjectTrust` setting; `--approve`/`--no-approve`; `project_trust` event (user/global + CLI extensions only) | security.md; settings.md "Project Trust"; extensions.md `project_trust` |
| Reload | `/reload` or `ctx.reload()` (command ctx only) → `session_shutdown{reason:"reload"}` → new extension instance → `session_start{reason:"reload"}` → `resources_discover{reason:"reload"}` | extensions.md `ctx.reload()`, "Lifecycle Overview" |
| Unload | No per-extension unload API. Whole runtime is torn down on reload/switch/fork/quit via `session_shutdown`; `pi.on()` returns an unsubscribe fn for single handlers; `pi.unregisterProvider(name)` for providers | extensions.md `pi.on`, `session_shutdown`, `pi.unregisterProvider` |
| Handler ordering | Extension load order, then registration order within an extension | extensions.md `pi.on(event, handler)` |
| Mode awareness | `ctx.mode` ∈ `"tui" \| "rpc" \| "json" \| "print"`; `ctx.hasUI` true in tui+rpc | extensions.md `ctx.mode`, `ctx.hasUI`; rpc.md "Extension UI protocol" |
| Project-local config path | `join(ctx.cwd, CONFIG_DIR_NAME, "korwf.json")` — never hardcode `.pi` | extensions.md `ctx.cwd` |

## 2. PLAN §4 surface table

One row per PLAN §4 surface (plus the model-registry / storage items named in issue #7).
"API" is the exact identifier; "Doc" is the section to consult if more detail is ever needed.

| # | PLAN §4 surface | Concrete API name(s) | Key facts | Doc reference |
|---|-----------------|----------------------|-----------|---------------|
| S1 | Commands | `pi.registerCommand(name, { description, getArgumentCompletions?, handler(args: string, ctx: ExtensionCommandContext) })` | Namespace as `/korwf …` with subcommand parsed from `args`. Duplicate names get `:1`/`:2` suffixes. Command ctx additionally has `waitForIdle`, `newSession`, `fork`, `navigateTree`, `switchSession`, `reload`, `getSystemPromptOptions`. Extension commands are dispatched **before** the `input` event, skills, and prompt templates. `pi.getCommands()` lists commands with `source` and `sourceInfo{path,source,scope,origin}` provenance. Built-in `/model`, `/settings` etc. are not extension commands and are not in `getCommands()`. | extensions.md `pi.registerCommand`, `pi.getCommands`, "ExtensionCommandContext"; examples/extensions/commands.ts |
| S2 | Custom tools | `pi.registerTool({ name, label, description, promptSnippet?, promptGuidelines?, parameters: Type.Object(...), prepareArguments?, execute(toolCallId, params, signal, onUpdate, ctx), renderCall?, renderResult? })` | Callable at load time or later (no reload needed). Return `{ content: [{type:"text",text}], details? }`; store reconstructable state in `details`. `pi.getActiveTools()/getAllTools()/setActiveTools(names)`. File-mutating tools must wrap the read-modify-write in `withFileMutationQueue(absPath, fn)`. `promptGuidelines` bullets must name the tool. Override built-ins by registering the same name. | extensions.md `pi.registerTool`, "Custom Tools", "State Management", "Overriding Built-in Tools" |
| S3 | Input / pre-agent hooks | `pi.on("input", (event{text,images,source:"interactive"\|"rpc"\|"extension",streamingBehavior?}) => { action: "continue"\|"transform"\|"handled", text? })`; `pi.on("before_agent_start", (event{prompt,images,systemPrompt,systemPromptOptions}) => { message?: {customType,content,display}, systemPrompt? })` | `input` sees raw text before skill/template expansion; first `handled` wins; transforms chain. `before_agent_start` can inject a persistent custom message and edit `systemPromptOptions.sections/selectedTools/promptGuidelines` (preferred; Pi diffs and patches) or replace `systemPrompt` (cache miss). `ctx.getSystemPrompt()` reflects chained value inside this handler. | extensions.md `input`, `before_agent_start`, `ctx.getSystemPrompt()` |
| S4 | Tool-call hooks as policy gates | `pi.on("tool_call", (event{toolName,toolCallId,input}, ctx) => undefined \| { block: true, reason?: string, terminate?: boolean })`; `isToolCallEventType("bash", event)` narrows `event.input` | Fires after `tool_execution_start`, before execution. `event.input` is mutable in place (no re-validation). `ctx.sessionManager` is synced through the current assistant message but **not** sibling tool results (parallel mode). `terminate` only applies when blocking and stops the agent only if every finalized result in the batch terminates. `ctx.signal` is defined here. Blocking returns the reason to the model as an error tool result. Not a sandbox (security.md). Non-UI modes: block by default rather than prompting (`ctx.hasUI`). | extensions.md `tool_call`, "Typing custom tool input"; examples/extensions/permission-gate.ts, protected-paths.ts |
| S5 | Tool-result events (evidence) | `pi.on("tool_result", (event{toolName,toolCallId,input,content,details,isError,usage}, ctx) => partial { content?, details?, isError?, usage? })`; `isBashToolResult(event)` narrows `details` to `BashToolDetails` | Middleware-style chain in load order; partial patches merge. Fires before `tool_execution_end`. Use `ctx.signal` for nested async. Non-mutating observers: `tool_execution_start/update/end` (`toolCallId,toolName,args,partialResult,result,isError`). | extensions.md `tool_result`, `tool_execution_*` |
| S6 | Turn events (stall detection) | `pi.on("turn_start", ({turnIndex,timestamp}))`, `pi.on("turn_end", ({turnIndex,message,toolResults}))`; `message_start/message_update/message_end` (`message_end` may return `{message}` replacement, same role) | One turn = one LLM response + its tool calls. For stall/timeout detection combine `turn_start` timestamps with `tool_execution_update` and `ctx.isIdle()`. Per-request HTTP hooks: `before_provider_headers` (mutate `event.headers`), `before_provider_request` (return replacement payload), `after_provider_response` (`status`, `headers` — e.g. 429 detection for ModelAvailability). | extensions.md `turn_start/turn_end`, `message_*`, `before_provider_*`, `after_provider_response` |
| S7 | Settled lifecycle events | `pi.on("agent_start")`, `pi.on("agent_end", ({messages}))`, `pi.on("agent_settled")`; `ctx.isIdle()`, `ctx.hasPendingMessages()`, `ctx.abort()`; command-only `await ctx.waitForIdle()` | `agent_end` may be followed by auto-retry, auto-compaction retry, or queued follow-ups; `agent_settled` is the only "nothing more will run automatically" signal. `ui_prompt_start/ui_prompt_end` (`kind`, `title`) report "waiting for user" spans around `ctx.ui.select/confirm/input/editor/custom`. | extensions.md `agent_start / agent_end / agent_settled`, `ui_prompt_start / ui_prompt_end`, `ctx.isIdle()`, `ctx.waitForIdle()` |
| S8 | Session start / resume / new | `pi.on("session_start", ({reason:"startup"\|"reload"\|"new"\|"resume"\|"fork", previousSessionFile?}))`; `pi.on("session_before_switch", ({reason:"new"\|"resume", targetSessionFile?}) => {cancel?:true})`; `pi.on("session_shutdown", ({reason:"quit"\|"reload"\|"new"\|"resume"\|"fork", targetSessionFile?}))`; `pi.on("session_info_changed", ({name}))` | Rebuild in-memory state in `session_start` by scanning `ctx.sessionManager.getEntries()`/`getBranch()`; release resources in `session_shutdown`. `resources_discover({cwd,reason}) => {skillPaths,promptPaths,themePaths}` follows every `session_start`. Session switching from a command: `ctx.newSession({parentSession?, setup(sm), withSession(ctx)})`, `ctx.switchSession(path, {withSession})`; discover with `SessionManager.list(cwd)` / `listAll()`. Inside `withSession` use **only** the passed ctx (old `pi`/ctx objects throw). | extensions.md "Lifecycle Overview", `session_start`, `session_before_switch`, `session_shutdown`, `ctx.newSession`, `ctx.switchSession`, "Session replacement lifecycle and footguns" |
| S9 | Tree / fork events | `pi.on("session_before_fork", ({entryId, position:"before"\|"at"}) => {cancel?:true})`; `pi.on("session_before_tree", ({preparation, signal}) => {cancel?:true} \| {summary:{summary,usage?,details}})`; `pi.on("session_tree", ({newLeafId, oldLeafId, summaryEntry, fromExtension}))`; command-only `ctx.fork(entryId, {position?, withSession?})`, `ctx.navigateTree(targetId, {summarize?, customInstructions?, replaceInstructions?, label?})`; `pi.setLabel(entryId, label\|undefined)`, `ctx.sessionManager.getLabel(id)` | Fork/clone create a new file and go through `session_shutdown` → `session_start{reason:"fork"}`. `/tree` stays in the same file and moves the leaf. `navigateTree` **rejects** (not `{cancelled}`) while an agent run, compaction, or another navigation is active — `await ctx.waitForIdle()` first. PLAN §5 rule: branching never undoes Git/external effects; reconcile in `session_start`/`session_tree`. | extensions.md `session_before_fork`, `session_before_tree / session_tree`, `ctx.fork`, `ctx.navigateTree`, `pi.setLabel`; sessions.md "/tree, /fork, and /clone" |
| S10 | Reload events | `session_shutdown{reason:"reload"}` → `session_start{reason:"reload"}` → `resources_discover{reason:"reload"}`; trigger via `/reload` or `ctx.reload()` (command ctx); tools cannot reload directly — queue `pi.sendUserMessage("/korwf-reload", {deliverAs:"followUp"})` | Code after `await ctx.reload()` runs in the **old** instance; treat as terminal. Keybindings are also reloaded. | extensions.md `ctx.reload()`, `session_start`; examples/extensions/reload-runtime.ts |
| S11 | Compaction events | `pi.on("session_before_compact", ({preparation{firstKeptEntryId,tokensBefore,...}, branchEntries, customInstructions, reason:"manual"\|"threshold"\|"overflow", willRetry, signal}) => {cancel:true} \| {compaction:{summary, firstKeptEntryId, tokensBefore, usage?}})`; `pi.on("session_compact", ({compactionEntry, fromExtension, reason, willRetry}))`; `pi.on("session_compact_failed", ({reason, errorMessage?, aborted, willRetry, fromExtension}))`; `ctx.compact({customInstructions?, onComplete?, onError?})`; `ctx.getContextUsage()` → `{tokens,...}` | Settings: `compaction.enabled/reserveTokens/keepRecentTokens/modelOverrides`. Branch summaries (`/tree`) share the same structured summary format. Custom summaries let KorWF inject handoff packets (PLAN memory/) at compaction time. | extensions.md `session_before_compact…`, `ctx.compact()`, `ctx.getContextUsage()`; compaction.md; settings.md "Compaction"; examples/extensions/custom-compaction.ts |
| S12 | Model-selection APIs at safe boundaries | `ctx.model` (active `Model`), `ctx.thinkingLevel`, `ctx.scopedModels: {model, thinkingLevel?}[]`, `ctx.modelRegistry.find(provider, id)`, `ctx.modelRegistry.getAvailable()`, `ctx.modelRegistry.getProvider(id)`, `ctx.modelRegistry.getProviderAuth(id)`, `ctx.modelRegistry.streamSimple(model, context, options)` / `.stream()`; `await pi.setModel(model) → boolean`; `pi.getThinkingLevel()` / `pi.setThinkingLevel(level)`; events `model_select({model, previousModel?, source:"set"\|"cycle"\|"restore"})`, `thinking_level_select({level, previousLevel})` | `setModel` returns `false` when no auth; recorded in session (`ModelChangeEntry`) and restored on resume, does not alter `defaultModel`. `scopedModels` = `--models` ∪ `enabledModels` setting matched by minimatch on `provider/modelId` or bare id, optionally pinned `:level`; empty means "all available". Safe boundary = when `ctx.isIdle()` / in `agent_settled` or a command after `waitForIdle()`. Model fields per `ProviderModelConfig`: `id, name, api?, baseUrl?, reasoning, thinkingLevelMap?, input[], cost{input,output,cacheRead,cacheWrite}, promptCache?, contextWindow, maxTokens, headers?, compat?` (runtime `Model` also carries `provider`). Use `streamSimple` (not pi-ai/compat) so extension-registered providers are visible. | extensions.md `ctx.modelRegistry / ctx.model / ctx.thinkingLevel / ctx.scopedModels`, "Streaming model calls", `pi.setModel`, `model_select`; custom-provider.md "Model Definition Reference"; settings.md "Model Cycling"; sdk.md (`modelRuntime.getAvailable()`) |
| S13 | Session entries for session-linked summaries | `pi.appendEntry(customType, data?)` → `CustomEntry {type:"custom", customType, data}` (never in LLM context); `pi.sendMessage({customType, content, display, details?}, {deliverAs:"steer"\|"followUp"\|"nextTurn", triggerTurn?})` → `CustomMessageEntry` (in LLM context); `pi.registerEntryRenderer(customType, (entry,{expanded},theme) => Component)`; `pi.registerMessageRenderer(customType, renderer)`; read back via `ctx.sessionManager.getEntries()` filtered on `entry.type === "custom" && entry.customType === "korwf/…"` | Entries are tree nodes (`id`, `parentId`) so they follow branches. `SessionManager` also exposes `appendCustomEntry`, `appendCustomMessageEntry`, `appendMessage`, `buildContextEntries()`, `getLeafId()`, `getSessionId()`, `getSessionFile()`, `getCwd()`, `branch(entryId)`. Static: `SessionManager.create/open/continueRecent/inMemory/forkFrom`. | extensions.md `pi.appendEntry`, `pi.sendMessage`, `pi.registerEntryRenderer`; session-format.md "Entry Types", "SessionManager API" |
| S14 | Project storage for cross-worker state | No Pi-provided KV store. Use `join(ctx.cwd, CONFIG_DIR_NAME, "korwf/…")` for project-local files (respect `ctx.isProjectTrusted()`), or a path outside `.pi`; `sessionDir` setting / `--session-dir` / `PI_CODING_AGENT_SESSION_DIR` control session file location; `pi.events.on/emit` is an in-process bus between extensions only | PLAN §5 SQLite store lives under the project dir; Pi only supplies `ctx.cwd`, `CONFIG_DIR_NAME`, and process env (`PI_SESSION_ID`, `PI_SESSION_FILE`) for correlation. Worker subprocesses (`pi --mode rpc`) get the same env markers. | extensions.md `ctx.cwd`, `pi.events`; settings.md "Sessions"; environment-variables.md |
| S15 | Extension UI (for approvals / boards) | `ctx.ui.select(title, options, {timeout?, signal?})`, `confirm(title, msg, opts)`, `input(title, placeholder, opts)`, `editor(title, prefill)`, `notify(msg, "info"\|"warning"\|"error")`, `setStatus(key, text\|undefined)`, `setWidget(key, lines\|factory\|undefined, {placement?})`, `setFooter(factory\|undefined)`, `setWorkingMessage`, `setTitle`, `setEditorText`, `custom(factory)` (tui only), `addAutocompleteProvider`, `ctx.ui.theme.fg(token, text)` | Timed dialogs return `undefined`/`false` on timeout. In RPC mode dialogs become `extension_ui_request`/`extension_ui_response` JSONL; in print/json mode `ctx.hasUI === false`. Shortcuts: `pi.registerShortcut("ctrl+shift+k", {description, handler(ctx)})`. CLI flags: `pi.registerFlag(name,{type,default,description})` + `pi.getFlag(name)`. | extensions.md "Custom UI", `pi.registerShortcut`, `pi.registerFlag`; tui.md; rpc.md "Extension UI protocol"; keybindings.md "Key Format" |
| S16 | Worker subprocess surfaces | `pi --mode rpc [--provider p --model m --no-session --session-dir d --name n -e ext --tools list]`; JSONL commands `prompt{message,images?,streamingBehavior?}`, `steer`, `follow_up`, `abort`, `new_session`, `get_state`, `set_model{provider,modelId}`, `cycle_model`, `get_available_models`, `set_thinking_level`, `compact`, `switch_session`, `fork{entryId}`, `get_commands`; events `agent_start/agent_end/agent_settled`, `tool_execution_*`, `message_*`, `compaction_start/end`, `queue_update`, `bash_execution_update`, `extension_ui_request`; or SDK `createAgentSession({ sessionManager: SessionManager.inMemory(), modelRuntime, model, thinkingLevel, scopedModels, customTools, resourceLoader })` + `session.prompt()` / `session.subscribe()` / `pi.exec(cmd, args, {signal, timeout})` for plain processes | LF-only framing; Node `readline` is not compliant (see rpc.md). `--mode json` gives read-only event stream. `ctx.shutdown()` is deferred until idle in tui/rpc. `PI_OFFLINE=1` disables startup network. | rpc.md; sdk.md; json.md; environment-variables.md; usage.md "CLI Reference" |
| S17 | Credentials / provider (for Jev transport & mac-mini dev policy) | Resolution order: `--api-key` → `auth.json` → env var → `models.json` custom provider keys; `key` supports `"$ENV"`, `"!command"`; `pi.registerProvider(name, {baseUrl, apiKey:"$VAR", api, models, oauth?, refreshModels?})` / `createProvider(...)` from `@earendil-works/pi-ai`; `ctx.modelRegistry.getProviderAuth(id)` | KorWF must never hardcode provider names/paths (AGENTS §4). Dev-time `mac-mini` allowlisting goes through the product allowlist config, which maps onto `enabledModels`/`--models` patterns. | providers.md "Resolution Order", "Key Resolution"; custom-provider.md; extensions.md `pi.registerProvider` |

## 3. Event lifecycle cheat-sheet (verbatim ordering from extensions.md)

```
startup:  project_trust → session_start{startup} → resources_discover{startup}
prompt:   [extension command? → handler, stop] → input → skill/template expansion →
          before_agent_start → agent_start → message_* →
          per turn: turn_start → context → before_provider_headers → before_provider_request →
                    after_provider_response → (tool_execution_start → tool_call → tool_execution_update →
                    tool_result → tool_execution_end)* → turn_end
          → agent_end → agent_settled
/new,/resume: session_before_switch → session_shutdown → session_start{new|resume} → resources_discover
/fork,/clone: session_before_fork → session_shutdown → session_start{fork} → resources_discover
/compact:     session_before_compact → session_compact | session_compact_failed
/tree:        session_before_tree → session_tree
/model:       thinking_level_select? → model_select
exit:         session_shutdown{quit}
```

`ctx.signal` is defined during turn events (`tool_call`, `tool_result`, `message_update`, `turn_end`)
and normally `undefined` in session events, commands, and shortcuts.

## 4. Behaviour that constrains KorWF design

| Concern | Fact | Consequence for KorWF |
|---------|------|-----------------------|
| Reload | Whole extension runtime is recreated; only session entries and files survive | All coordinator state must be reconstructable from `appendEntry` records + project storage in `session_start` |
| Fork / resume | New process-level extension instance, `reason` tells which; Pi does not undo Git or external effects | `session_start{fork|resume}` must reconcile worktrees, invalidate approvals (PLAN §5) |
| Compaction | Summary replaces older entries in context; custom entries persist; `session_before_compact` can supply the summary | Inject handoff packet as the compaction summary; keep evidence in `details`/custom entries, not in prose |
| Parallel tools | `tool_call` for siblings runs sequentially, execution concurrently; sessionManager lacks sibling results | Gate decisions cannot depend on sibling outcomes; file writes must use `withFileMutationQueue` |
| Non-UI modes | `ctx.hasUI` false in `-p`/`--mode json`; dialogs unavailable | Policy gate must block-by-default when it would otherwise ask (matches "never weaken policy") |
| Trust | Project extensions and `.pi/settings.json` load only when trusted; not a sandbox | Ship KorWF as a package or user-level extension; treat `ctx.isProjectTrusted()` as required before reading project config |
| `setModel` | Returns `false` on missing auth; emits `model_select` | Fallback logic (PLAN models/) checks the boolean and listens for `model_select{source:"restore"}` on resume |
| `navigateTree` | Rejects while busy | Always `await ctx.waitForIdle()` in command handlers before tree/session operations |

## 5. Worked examples (self-contained)

### 5.1 Tool-call hook as a policy gate

```typescript
// src/extension/gate.ts  (loaded via package `pi.extensions` or `-e`)
import { isToolCallEventType, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", async (event, ctx) => {
    // event.toolName: string; event.toolCallId: string; event.input: mutable args
    if (isToolCallEventType("bash", event)) {
      // event.input is { command: string; timeout?: number }
      if (/\bgit\s+push\b/.test(event.input.command)) {
        // High-risk action (AGENTS §4): require explicit approval regardless of mode.
        if (!ctx.hasUI) {
          return { block: true, reason: "git push requires approval; no UI available" };
        }
        const ok = await ctx.ui.confirm("Approve remote push?", event.input.command, { timeout: 60_000 });
        if (!ok) return { block: true, reason: "Push not approved" };
      }
    }
    if (isToolCallEventType("write", event) || isToolCallEventType("edit", event)) {
      // event.input.path for both built-ins
      if (event.input.path.startsWith(".env")) {
        return { block: true, reason: "Secrets files are protected", terminate: true };
      }
    }
    return undefined; // allow
  });

  // Evidence capture (PLAN verification/): observe results without changing them.
  pi.on("tool_result", async (event, ctx) => {
    if (event.toolName === "bash") {
      pi.appendEntry("korwf/evidence", {
        toolCallId: event.toolCallId,
        command: (event.input as { command: string }).command,
        isError: event.isError,
        sessionId: ctx.sessionManager.getSessionId(),
      });
    }
    return undefined; // no patch
  });
}
```

Notes: `block` produces an error tool result containing `reason` that the model sees; mutate
`event.input` in place to rewrite arguments; `terminate: true` only matters when blocking.

### 5.2 A namespaced command

```typescript
// src/extension/commands.ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const SUBCOMMANDS = ["plan", "run", "status", "pause", "resume", "cancel", "models"];

export default function (pi: ExtensionAPI) {
  pi.registerCommand("korwf", {
    description: "KorWF workflow commands: /korwf <plan|run|status|...>",
    getArgumentCompletions: (prefix) => {
      const items = SUBCOMMANDS.filter((s) => s.startsWith(prefix)).map((s) => ({ value: s, label: s }));
      return items.length ? items : null;
    },
    handler: async (args, ctx) => {
      const [sub, ...rest] = args.trim().split(/\s+/);
      switch (sub) {
        case "status": {
          const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "none";
          const scoped = ctx.scopedModels.map((s) => `${s.model.provider}/${s.model.id}`);
          ctx.ui.notify(`model=${model} idle=${ctx.isIdle()} scoped=${scoped.length}`, "info");
          return;
        }
        case "models": {
          const available = await ctx.modelRegistry.getAvailable();
          const pick = await ctx.ui.select("Switch model", available.map((m) => `${m.provider}/${m.id}`));
          if (!pick) return;
          const [provider, ...idParts] = pick.split("/");
          const model = ctx.modelRegistry.find(provider, idParts.join("/"));
          if (model && !(await pi.setModel(model))) ctx.ui.notify("No credentials for that model", "error");
          return;
        }
        case "plan": {
          await ctx.waitForIdle(); // safe boundary before session mutation
          pi.appendEntry("korwf/workflow", { goal: rest.join(" "), createdAt: Date.now() });
          pi.sendUserMessage(`Investigate and produce a phased plan for: ${rest.join(" ")}`);
          return;
        }
        default:
          ctx.ui.notify(`Unknown subcommand. Use: ${SUBCOMMANDS.join(", ")}`, "warning");
      }
    },
  });

  // Rebuild state after startup / reload / resume / fork.
  pi.on("session_start", async (event, ctx) => {
    const workflows = ctx.sessionManager
      .getEntries()
      .filter((e) => e.type === "custom" && e.customType === "korwf/workflow");
    ctx.ui.setStatus("korwf", `korwf: ${workflows.length} workflow(s) (${event.reason})`);
  });
}
```

Packaging: put both files in `src/extension/`, list them in `package.json` under
`"pi": { "extensions": ["src/extension/gate.ts", "src/extension/commands.ts"] }` (packages.md),
or load during development with `pi -e ./src/extension/gate.ts -e ./src/extension/commands.ts`.

## Gaps

Items the docs do not settle and which must be verified at runtime (tracked as separate TODO §1
items where noted):

1. **Exact `Model` runtime field set** from `ctx.modelRegistry.getAvailable()` / `ctx.scopedModels`
   is documented only via `ProviderModelConfig` (custom-provider.md) plus `provider`; whether every
   entry carries `thinkingLevelMap` and `promptCache` at runtime must be confirmed (TODO §1 item
   "Confirm `ctx.modelRegistry.getAvailable()` / `ctx.scopedModels` field set").
2. **`getAvailable()` sync vs. async in `ctx.modelRegistry`**: sdk.md shows `await modelRuntime.getAvailable()`;
   extensions.md does not state whether `ctx.modelRegistry.getAvailable()` returns a promise.
   Example 5.2 awaits it, which is safe either way.
3. **No documented per-extension unload** — only whole-runtime reload (S10). If KorWF needs to
   disable itself (`/korwf off`) it must gate its own handlers with an internal flag.
4. **No documented persistent project KV/storage API** (S14); PLAN §5 SQLite is the intended fill.
5. **`tool_call` event does not expose the assistant message id** that issued the call; correlate
   via `ctx.sessionManager.getLeafId()` at hook time if attempt-level attribution is needed.
6. **Documentation typo**: `docs/extensions.md` lifecycle diagram lists `before_provider_headers`
   with a `|` instead of `│`; harmless. Otherwise no contradictions between docs were found.
