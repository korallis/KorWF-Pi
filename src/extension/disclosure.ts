/**
 * First-use data disclosure (issue #21; PLAN §7 data policy, threat model §4).
 *
 * Before *any* outbound request — to TypeSafe, to a model provider, or to a
 * notification channel — the user must have been shown which data classes
 * leave the machine and under what conditions. The disclosure is shown once
 * per project per disclosure *version*: when the text changes, the version
 * changes and the disclosure is shown again.
 *
 * This module is pure with respect to I/O: acceptance state is read and
 * written through a small `DisclosureStore` port so the extension can back it
 * with the SQLite store (`src/storage/`) while tests use an in-memory stub.
 * The gate itself is deterministic and cannot be waived by Jev, by a worker,
 * or by a config flag other than the documented `privacy.firstUseDisclosure`.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { resolveStorageRoot } from "../storage/paths.ts";
import type { KorwfConfig } from "../config/types.ts";

/**
 * Version of the disclosure text below. Bump whenever the wording or the set
 * of data classes changes; a bump re-shows the disclosure in every project.
 */
export const DISCLOSURE_VERSION = 1 as const;

/** Outbound edges named in the threat model §4, in the order they are listed. */
export type OutboundEdge = "typesafe" | "model_provider" | "notification";

/** Record of a user accepting the disclosure for one project. */
export interface DisclosureAcceptance {
  /** ISO-8601 timestamp of acceptance. */
  readonly disclosureAcceptedAt: string;
  /** Disclosure text version the user accepted. */
  readonly disclosureVersion: number;
  /** Package version at acceptance time, for the audit trail. */
  readonly packageVersion: string;
}

/** Storage port. The extension backs this with the KorWF store. */
export interface DisclosureStore {
  readonly get: (projectRoot: string) => DisclosureAcceptance | null;
  readonly set: (projectRoot: string, acceptance: DisclosureAcceptance) => void;
}

/** One data class as presented to the user. */
export interface DisclosureDataClass {
  readonly edge: OutboundEdge;
  readonly what: string;
  readonly when: string;
}

/**
 * The disclosure content, derived from the *effective* config so the user is
 * told what their configuration actually does, not what the defaults do.
 */
export interface DisclosureText {
  readonly version: number;
  readonly title: string;
  readonly dataClasses: readonly DisclosureDataClass[];
  readonly neverLeaves: readonly string[];
  readonly lines: readonly string[];
}

const onOff = (on: boolean): string => (on ? "enabled" : "disabled");

/** Build the disclosure text for a resolved config (threat model §4.1–§4.2). */
export function buildDisclosure(config: KorwfConfig): DisclosureText {
  const jevOn = config.jev.enabled;
  const channels = config.notifications.channels;
  const anyChannel = channels.desktop.enabled || channels.command.enabled || channels.webhook.enabled;

  const dataClasses: DisclosureDataClass[] = [
    {
      edge: "typesafe",
      what: "Decision questions plus minimal state snippets: file excerpts, project-relative paths, task and phase summaries. Never credentials, never deny-path content, never absolute paths.",
      when: jevOn
        ? `Jev assistance is ${onOff(jevOn)}: requests go to ${config.jev.baseUrl} using the key named by jev.keySource (${config.jev.keySource.kind}:${config.jev.keySource.name}); the key is sent as a header and never stored or logged.`
        : "Jev assistance is disabled — nothing is sent to TypeSafe at all, and every Jev-assisted decision takes its deterministic fallback.",
    },
    {
      edge: "model_provider",
      what: "Whatever a worker's turn contains: instructions, selected file excerpts and tool output, after the same redaction filters.",
      when:
        config.models.allowlist.providers.length === 0 && config.models.allowlist.models.length === 0
          ? "Any provider your Pi already has configured may be used. KorWF-Pi adds no providers and no endpoints of its own."
          : `Only the allowlisted providers/models in your config may be used (${[...config.models.allowlist.providers, ...config.models.allowlist.models].join(", ")}).`,
    },
    {
      edge: "notification",
      what: "Redacted event JSON: event name, approval class, mode, workflow/phase/task ids and a summary.",
      when: anyChannel
        ? `Enabled channels: ${[channels.desktop.enabled ? "desktop" : null, channels.command.enabled ? "command" : null, channels.webhook.enabled ? `webhook (${config.notifications.channels.webhook.url ?? "no URL set"})` : null].filter((c) => c !== null).join(", ")}.`
        : "All off-machine notification channels are disabled; notifications stay inside Pi.",
    },
  ];

  const neverLeaves = [
    `Files matching any of the ${config.privacy.denyPaths.length} deny globs (.env*, key material, credential stores, build output) are never read into outbound context or logs.`,
    `Lines matching any of the ${config.privacy.denyPatterns.length} deny patterns are redacted before any request or log write.`,
    "API keys — yours and TypeSafe's — are read only by the secret resolver and never placed in a body, trace, cache key or log.",
    "Absolute filesystem paths are stripped regardless of settings.",
    config.privacy.outbound.sendRepoIdentity
      ? "Repository identity is sent because privacy.outbound.sendRepoIdentity is true."
      : "Repository identity leaves only as a hash.",
    config.privacy.rawLogging.enabled
      ? `Raw request/response bodies are logged locally (redacted first) and deleted after ${config.privacy.rawLogging.retentionDays} day(s).`
      : "Raw request/response bodies are not written anywhere.",
    "All workflow state stays in the local KorWF store; git operations are local and pushes to refs the workflow does not own always stop for approval.",
  ];

  const lines = [
    "KorWF-Pi — what leaves this machine",
    "",
    ...dataClasses.flatMap((d) => [`• ${d.edge}: ${d.what}`, `  ${d.when}`, ""]),
    "Never leaves this machine:",
    ...neverLeaves.map((n) => `• ${n}`),
    "",
    `Current mode: ${config.mode}. Workflow spend cap: ${config.budgets.workflow.maxSpendUsd === null ? "none" : `$${config.budgets.workflow.maxSpendUsd}`}.`,
    "Full detail: docs/config-reference.md and docs/threat-model.md §4.",
  ];

  return { version: DISCLOSURE_VERSION, title: "KorWF-Pi — what leaves this machine", dataClasses, neverLeaves, lines };
}

/** In-memory store, used by tests and by sessions with no project state yet. */
export function createMemoryDisclosureStore(
  seed: Readonly<Record<string, DisclosureAcceptance>> = {},
): DisclosureStore {
  const map = new Map<string, DisclosureAcceptance>(Object.entries(seed));
  return {
    get: (projectRoot) => map.get(projectRoot) ?? null,
    set: (projectRoot, acceptance) => {
      map.set(projectRoot, acceptance);
    },
  };
}

/** File name of the disclosure record inside the storage root. */
export const DISCLOSURE_RECORD_FILE = "disclosure.json";

/** Absolute path of the disclosure record for a project under its storage root. */
export function disclosureRecordPath(projectRoot: string, config: KorwfConfig): string {
  return join(resolveStorageRoot(projectRoot, config.storage.path ?? undefined), DISCLOSURE_RECORD_FILE);
}

/**
 * Disclosure state persisted in the project's own storage root
 * (`<project>/.korwf/disclosure.json` by default), so acceptance survives
 * restarts and is visible to the user alongside the rest of the workflow
 * state. A malformed or unreadable record is treated as "not accepted" —
 * the safe direction, since it only ever re-shows the disclosure.
 */
export function createFileDisclosureStore(config: KorwfConfig): DisclosureStore {
  return {
    get: (projectRoot) => {
      try {
        const parsed: unknown = JSON.parse(readFileSync(disclosureRecordPath(projectRoot, config), "utf8"));
        if (typeof parsed !== "object" || parsed === null) return null;
        const r = parsed as Partial<DisclosureAcceptance>;
        if (typeof r.disclosureAcceptedAt !== "string" || typeof r.disclosureVersion !== "number") return null;
        return {
          disclosureAcceptedAt: r.disclosureAcceptedAt,
          disclosureVersion: r.disclosureVersion,
          packageVersion: typeof r.packageVersion === "string" ? r.packageVersion : "unknown",
        };
      } catch {
        return null;
      }
    },
    set: (projectRoot, acceptance) => {
      const file = disclosureRecordPath(projectRoot, config);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, `${JSON.stringify(acceptance, null, 2)}\n`, "utf8");
    },
  };
}

/** Why an outbound request is or is not permitted. */
export type DisclosureStatus =
  | { readonly required: false; readonly reason: "accepted"; readonly acceptance: DisclosureAcceptance }
  | { readonly required: false; readonly reason: "disabled_by_config" }
  | { readonly required: true; readonly reason: "never_shown" }
  | { readonly required: true; readonly reason: "version_changed"; readonly acceptedVersion: number };

/**
 * Does this project still owe the user a disclosure?
 *
 * `privacy.firstUseDisclosure: false` is the user explicitly opting out of the
 * prompt (threat model §4.2: "shown, or explicitly disabled"); it is a display
 * choice and changes no filter.
 */
export function disclosureStatus(
  config: KorwfConfig,
  projectRoot: string,
  store: DisclosureStore,
): DisclosureStatus {
  if (!config.privacy.firstUseDisclosure) return { required: false, reason: "disabled_by_config" };
  const acceptance = store.get(projectRoot);
  if (acceptance === null) return { required: true, reason: "never_shown" };
  if (acceptance.disclosureVersion !== DISCLOSURE_VERSION)
    return { required: true, reason: "version_changed", acceptedVersion: acceptance.disclosureVersion };
  return { required: false, reason: "accepted", acceptance };
}

/** Record acceptance for a project. Returns the stored record. */
export function acceptDisclosure(
  projectRoot: string,
  store: DisclosureStore,
  options: { readonly packageVersion: string; readonly now?: () => Date },
): DisclosureAcceptance {
  const acceptance: DisclosureAcceptance = {
    disclosureAcceptedAt: (options.now?.() ?? new Date()).toISOString(),
    disclosureVersion: DISCLOSURE_VERSION,
    packageVersion: options.packageVersion,
  };
  store.set(projectRoot, acceptance);
  return acceptance;
}

/** Raised when an outbound request is attempted before disclosure. */
export class DisclosureRequiredError extends Error {
  readonly edge: OutboundEdge;
  readonly reason: "never_shown" | "version_changed";
  constructor(edge: OutboundEdge, reason: "never_shown" | "version_changed") {
    super(
      reason === "never_shown"
        ? `KorWF-Pi has not yet shown this project what data leaves the machine; no ${edge} request may be made until the first-use disclosure is accepted.`
        : `The KorWF-Pi data disclosure changed (version ${DISCLOSURE_VERSION}); no ${edge} request may be made until it is accepted again.`,
    );
    this.name = "DisclosureRequiredError";
    this.edge = edge;
    this.reason = reason;
  }
}

/**
 * The gate every outbound edge must pass through. Deterministic, no I/O beyond
 * the store, and it throws rather than returning a falsy value so a caller
 * cannot forget to check the result.
 */
export function assertOutboundAllowed(
  config: KorwfConfig,
  projectRoot: string,
  store: DisclosureStore,
  edge: OutboundEdge,
): void {
  const status = disclosureStatus(config, projectRoot, store);
  if (status.required) throw new DisclosureRequiredError(edge, status.reason);
}

/**
 * The slice of Pi's `ctx.ui` this module needs. Declared structurally so the
 * module stays independent of the Pi API surface and is testable without it.
 */
export interface DisclosurePrompt {
  readonly confirm: (title: string, body: string) => Promise<boolean> | boolean;
  readonly notify?: (message: string, level?: string) => void;
  /** False in print/RPC mode: there is no one to show a disclosure to. */
  readonly hasUI?: boolean;
}

export type DisclosureOutcome =
  | { readonly shown: false; readonly accepted: true; readonly reason: "accepted" | "disabled_by_config" }
  | { readonly shown: true; readonly accepted: true; readonly reason: "never_shown" | "version_changed" }
  | { readonly shown: true; readonly accepted: false; readonly reason: "declined" }
  | { readonly shown: false; readonly accepted: false; readonly reason: "no_ui" };

/**
 * Show the disclosure if this project still owes one, and record acceptance.
 *
 * Declining is honoured: nothing is recorded and the outbound gate stays shut,
 * so the deterministic workflow keeps running with no outbound calls. With no
 * UI (print/RPC mode) the disclosure cannot be shown, so the gate also stays
 * shut rather than being implicitly accepted on the user's behalf.
 */
export async function ensureDisclosureAccepted(
  config: KorwfConfig,
  projectRoot: string,
  store: DisclosureStore,
  ui: DisclosurePrompt,
  options: { readonly packageVersion: string; readonly now?: () => Date },
): Promise<DisclosureOutcome> {
  const status = disclosureStatus(config, projectRoot, store);
  if (!status.required) return { shown: false, accepted: true, reason: status.reason };
  if (ui.hasUI === false) return { shown: false, accepted: false, reason: "no_ui" };

  const text = buildDisclosure(config);
  const accepted = await ui.confirm(text.title, text.lines.join("\n"));
  if (!accepted) {
    ui.notify?.(
      "KorWF-Pi will run with no outbound requests until the data disclosure is accepted (/korwf disclosure).",
      "warning",
    );
    return { shown: true, accepted: false, reason: "declined" };
  }
  acceptDisclosure(projectRoot, store, options);
  return { shown: true, accepted: true, reason: status.reason };
}

/**
 * Wrap any outbound transport so it cannot run before disclosure is accepted.
 * The wrapped function is never invoked when the gate is closed, which is what
 * the stub-transport test asserts.
 */
export function guardOutbound<Args extends readonly unknown[], R>(
  config: KorwfConfig,
  projectRoot: string,
  store: DisclosureStore,
  edge: OutboundEdge,
  send: (...args: Args) => R,
): (...args: Args) => R {
  return (...args: Args): R => {
    assertOutboundAllowed(config, projectRoot, store, edge);
    return send(...args);
  };
}
