/**
 * The redaction boundary between KorWF-Pi and Pi itself (issue #22).
 *
 * `src/security/redact.ts` can only keep a credential out of the user's
 * transcript if *everything* KorWF-Pi says goes through it. This module is
 * that choke point: the extension wraps `ctx.ui` once, at the top of every
 * command handler, and nothing inside the package holds a raw notifier.
 *
 * It also owns the error boundary. An uncaught error inside a command becomes
 * a Pi-level message, and errors are the likeliest leak path (an HTTP client
 * putting the `Authorization` header it sent into the message it throws), so
 * every handler runs inside `guardHandler`, which redacts before surfacing and
 * never lets a KorWF failure take the session down with it.
 */
import {
  createLogger,
  formatError,
  redactError,
  redactString,
  type Logger,
} from "../security/index.ts";

/** The slice of Pi's `ctx.ui` this package uses. Declared structurally (ADR 0002). */
export interface NotifyUI {
  readonly notify: (
    message: string,
    level?: "info" | "warning" | "error",
  ) => void;
}

/** Wrap a UI so every message is redacted on the way out. */
export function redactedUi<U extends NotifyUI>(ui: U): NotifyUI {
  return {
    notify: (message, level) => {
      ui.notify(redactString(String(message)), level);
    },
  };
}

/** A logger whose sink is Pi's notifier, already redacting. */
export function uiLogger(ui: NotifyUI): Logger {
  const safe = redactedUi(ui);
  return createLogger({
    write: (level, message, fields) => {
      const suffix = fields === undefined ? "" : ` ${JSON.stringify(fields)}`;
      safe.notify(
        `${message}${suffix}`,
        level === "error" ? "error" : level === "warn" ? "warning" : "info",
      );
    },
  });
}

/**
 * Run a command handler inside the redaction and error boundary.
 *
 * A thrown error is redacted in place (so its class and properties survive for
 * any caller that inspects it), reported as one redacted line, and swallowed:
 * a failed `/korwf` subcommand must not break the user's Pi session
 * (Stage 2 exit criterion: "failures cannot hang Pi or leak credentials").
 */
export async function guardHandler<T>(
  ui: NotifyUI,
  what: string,
  run: () => T | Promise<T>,
): Promise<T | undefined> {
  try {
    return await run();
  } catch (error) {
    redactError(error);
    redactedUi(ui).notify(
      `KorWF-Pi could not complete ${what}: ${formatError(error)}`,
      "error",
    );
    return undefined;
  }
}
