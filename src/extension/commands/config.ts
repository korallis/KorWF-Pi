/**
 * `/korwf config` and `/korwf disclosure` message builders (issue #21).
 *
 * Pure string builders so they can be tested without a Pi session; the
 * extension entry point passes `ctx.cwd` and the UI helpers in.
 */
import { formatIssue, loadConfig, type ConfigLoadResult } from "../../config/index.ts";
import { buildDisclosure, disclosureStatus, type DisclosureStore } from "../disclosure.ts";
import type { KorwfConfig } from "../../config/types.ts";

/** Human-readable summary of a load result, valid or not. */
export function configMessage(result: ConfigLoadResult): string {
  if (!result.ok) {
    return [
      result.message,
      "",
      "KorWF-Pi will not start a workflow with an invalid configuration.",
      "Every key, default and rule is documented in docs/config-reference.md.",
    ].join("\n");
  }
  const { config, layers, warnings } = result;
  const lines = [
    `KorWF-Pi configuration (schema v${config.configVersion})`,
    `  mode: ${config.mode}`,
    `  jev: ${config.jev.enabled ? `enabled (${config.jev.model} via ${config.jev.baseUrl})` : "disabled — deterministic workflow only"}`,
    `  workflow spend cap: ${config.budgets.workflow.maxSpendUsd === null ? "none" : `$${config.budgets.workflow.maxSpendUsd}`}`,
    `  allowlist: ${config.models.allowlist.providers.length === 0 && config.models.allowlist.models.length === 0 ? "every model Pi has configured" : [...config.models.allowlist.providers, ...config.models.allowlist.models].join(", ")}`,
    `  static fallback order: ${config.fallback.staticOrder.length === 0 ? "Pi registry order, filtered by the allowlist" : config.fallback.staticOrder.join(" → ")}`,
    `  privacy: ${config.privacy.denyPaths.length} deny globs, ${config.privacy.denyPatterns.length} deny patterns, raw logging ${config.privacy.rawLogging.enabled ? "on" : "off"}`,
    "  layers:",
    ...layers.map((l) => `    ${l.present ? "✓" : "·"} ${l.layer}${l.path === null ? "" : ` (${l.path})`}`),
  ];
  if (warnings.length > 0) {
    lines.push("  warnings:", ...warnings.map((w) => `    ! ${formatIssue(w)}`));
  }
  return lines.join("\n");
}

/** Disclosure text plus this project's acceptance state. */
export function disclosureMessage(
  config: KorwfConfig,
  projectRoot: string,
  store: DisclosureStore,
): string {
  const status = disclosureStatus(config, projectRoot, store);
  const state =
    status.reason === "accepted"
      ? `Accepted on ${status.acceptance.disclosureAcceptedAt} (disclosure v${status.acceptance.disclosureVersion}, package ${status.acceptance.packageVersion}).`
      : status.reason === "disabled_by_config"
        ? "The first-use prompt is turned off in this config (privacy.firstUseDisclosure: false); the filters below still apply."
        : status.reason === "version_changed"
          ? `The disclosure changed since it was accepted (v${status.acceptedVersion}); it must be accepted again before any outbound request.`
          : "Not yet accepted in this project; no outbound request can be made until it is.";
  return [...buildDisclosure(config).lines, "", state].join("\n");
}

/** Load the config for a project, for use by a command handler. */
export function loadForProject(projectRoot: string): ConfigLoadResult {
  return loadConfig(projectRoot);
}
