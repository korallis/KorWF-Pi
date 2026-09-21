/**
 * The question registry (issue #27; PLAN §6).
 *
 * Questions are looked up by `id@version`, never by id alone: an answer must
 * always be attributable to the exact wording that produced it, and two
 * versions of the same question can be live at once (one in shadow mode, one
 * in force).
 *
 * The registry also holds the **version pin**: each registration may declare
 * the content hash it was reviewed at. If the prompt, options, levels or
 * abstention policy are edited without bumping the version, the recomputed
 * hash no longer matches the pin and registration fails. That is the whole
 * mechanism behind "changing a question's prompt without bumping the version
 * fails a test" — the check lives in product code, so it also fails at
 * runtime, not only in CI.
 */
import { assertBoundaries, QuestionDefinitionError, type QuestionDefinition } from "./question.ts";

/** A definition plus the hash it was reviewed at (`null` = unpinned). */
export interface RegisteredQuestion {
  readonly definition: QuestionDefinition<never, unknown>;
  readonly pinnedHash: string | null;
}

export class QuestionRegistry {
  readonly #byKey = new Map<string, RegisteredQuestion>();

  /**
   * Register a definition. Throws `QuestionDefinitionError` when the key is
   * already taken, when a declared pin does not match the content hash, or
   * when a declared boundary example disagrees with the fallback.
   */
  register<TState, TResult>(
    definition: QuestionDefinition<TState, TResult>,
    options: { readonly pinnedHash?: string } = {},
  ): QuestionDefinition<TState, TResult> {
    if (this.#byKey.has(definition.key)) {
      throw new QuestionDefinitionError(
        `question ${definition.key} is already registered; bump the version instead of redefining it`,
      );
    }
    const pinnedHash = options.pinnedHash ?? null;
    if (pinnedHash !== null && pinnedHash !== definition.contentHash) {
      throw new QuestionDefinitionError(
        `question ${definition.key} content hash ${definition.contentHash} does not match its pinned ` +
          `hash ${pinnedHash}: the wording changed, so the version must be bumped (docs/questions.md §1)`,
      );
    }
    assertBoundaries(definition);
    this.#byKey.set(definition.key, {
      definition: definition as unknown as QuestionDefinition<never, unknown>,
      pinnedHash,
    });
    return definition;
  }

  /** Look up by `id@version`. `undefined` when absent; never throws. */
  get(key: string): QuestionDefinition<never, unknown> | undefined {
    return this.#byKey.get(key)?.definition;
  }

  /** Look up by `id@version` or throw with the list of known keys. */
  require(key: string): QuestionDefinition<never, unknown> {
    const found = this.get(key);
    if (found === undefined) {
      throw new QuestionDefinitionError(`no question registered as ${key}; known: ${this.keys().join(", ") || "(none)"}`);
    }
    return found;
  }

  has(key: string): boolean {
    return this.#byKey.has(key);
  }

  /** All registered keys, sorted — a stable manifest for docs and tests. */
  keys(): readonly string[] {
    return [...this.#byKey.keys()].sort();
  }

  /** Every version of one question id, newest version last. */
  versionsOf(id: string): readonly QuestionDefinition<never, unknown>[] {
    return this.keys()
      .filter((key) => key.startsWith(`${id}@`))
      .map((key) => this.#byKey.get(key))
      .filter((entry): entry is RegisteredQuestion => entry !== undefined)
      .map((entry) => entry.definition)
      .sort((a, b) => Number(a.version) - Number(b.version));
  }

  /** Highest registered version of `id`, or `undefined`. */
  latest(id: string): QuestionDefinition<never, unknown> | undefined {
    const all = this.versionsOf(id);
    return all.length === 0 ? undefined : all[all.length - 1];
  }

  /** `key → contentHash` for every registered question; the shipped manifest. */
  manifest(): Readonly<Record<string, string>> {
    const out: Record<string, string> = {};
    for (const key of this.keys()) {
      const entry = this.#byKey.get(key);
      if (entry !== undefined) out[key] = entry.definition.contentHash;
    }
    return out;
  }

  /**
   * Compare the live content hashes with a recorded manifest. Returns the
   * keys that drifted (text edited without a version bump) and the keys that
   * are new or missing. Used by the drift test and by `/korwf` diagnostics.
   */
  diffManifest(recorded: Readonly<Record<string, string>>): {
    readonly changed: readonly string[];
    readonly added: readonly string[];
    readonly removed: readonly string[];
  } {
    const live = this.manifest();
    const changed: string[] = [];
    const added: string[] = [];
    const removed: string[] = [];
    for (const [key, hash] of Object.entries(live)) {
      const before = recorded[key];
      if (before === undefined) added.push(key);
      else if (before !== hash) changed.push(key);
    }
    for (const key of Object.keys(recorded)) {
      if (!(key in live)) removed.push(key);
    }
    return { changed: changed.sort(), added: added.sort(), removed: removed.sort() };
  }

  /** Test-only: drop everything. Never called by product code. */
  clear(): void {
    this.#byKey.clear();
  }
}

/**
 * The registry shipped question families register into. Later stages add
 * their families here (#28, #29, #31); this issue ships only the example
 * question used by tests, registered separately so product code never sees
 * it.
 */
export const questionRegistry = new QuestionRegistry();
