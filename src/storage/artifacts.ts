/**
 * Artifact directory (issue #23; ADR 0006 rule 8).
 *
 * Artifacts — command output, diffs, review notes — live beside the database
 * at `<store>/artifacts/<attemptId>/`, never inside the user's source tree.
 * Each attempt directory has a `manifest.json` listing every file with its
 * SHA-256, media type and size, so `evidence.artifact` can reference a file
 * by *relative* path and a reader can verify it has not changed.
 *
 * Retention (`storage.artifactRetentionDays`) may delete files; it never
 * deletes rows. Expiring an artifact marks it in the manifest, so an evidence
 * row still explains what was captured and why it is gone.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ArtifactRef, AttemptId, ContentHash, IsoTimestamp } from "./records.ts";

/** File name of the per-attempt manifest. */
export const MANIFEST_NAME = "manifest.json";

/** One entry in an attempt's artifact manifest. */
export interface ArtifactManifestEntry {
  /** Path relative to the attempt directory. */
  readonly relativePath: string;
  readonly contentHash: ContentHash;
  readonly mediaType: string;
  readonly sizeBytes: number;
  readonly writtenAt: IsoTimestamp;
  /** Set when retention removed the bytes; the entry itself stays. */
  readonly expiredAt: IsoTimestamp | null;
}

export interface ArtifactManifest {
  readonly version: 1;
  readonly attemptId: string;
  readonly entries: readonly ArtifactManifestEntry[];
}

export interface ArtifactStoreOptions {
  /** Injected clock so tests are deterministic. */
  readonly now?: () => IsoTimestamp;
}

/** Relative path of an artifact from the artifact *root* (what evidence stores). */
export function artifactRelativePath(attemptId: string, relativePath: string): string {
  return `${attemptId}/${relativePath}`;
}

export function sha256(data: Buffer | string): ContentHash {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * Filesystem-backed artifact directory rooted at `resolveArtifactDir(storageRoot)`.
 * Pure filesystem work: it holds no database connection.
 */
export class ArtifactStore {
  readonly root: string;
  readonly #now: () => IsoTimestamp;

  constructor(root: string, options: ArtifactStoreOptions = {}) {
    this.root = root;
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  /** Directory for one attempt; created on demand. */
  dirFor(attemptId: AttemptId | string): string {
    return join(this.root, String(attemptId));
  }

  manifestPath(attemptId: AttemptId | string): string {
    return join(this.dirFor(attemptId), MANIFEST_NAME);
  }

  /** Read the manifest, or an empty one if the attempt has no artifacts yet. */
  readManifest(attemptId: AttemptId | string): ArtifactManifest {
    const path = this.manifestPath(attemptId);
    if (!existsSync(path)) return { version: 1, attemptId: String(attemptId), entries: [] };
    const parsed = JSON.parse(readFileSync(path, "utf8")) as ArtifactManifest;
    return { version: 1, attemptId: String(attemptId), entries: parsed.entries ?? [] };
  }

  #writeManifest(attemptId: AttemptId | string, entries: readonly ArtifactManifestEntry[]): void {
    const manifest: ArtifactManifest = { version: 1, attemptId: String(attemptId), entries };
    writeFileSync(this.manifestPath(attemptId), `${JSON.stringify(manifest, null, 2)}\n`);
  }

  /**
   * Write one artifact and record it in the manifest. Returns the
   * `ArtifactRef` to store on an `Evidence` or `Attempt` row — its
   * `relativePath` is relative to the artifact root, never absolute.
   */
  write(
    attemptId: AttemptId | string,
    relativePath: string,
    data: Buffer | string,
    mediaType = "text/plain",
  ): ArtifactRef {
    if (relativePath.includes("..") || relativePath.startsWith("/")) {
      throw new Error(`Artifact path must stay inside the attempt directory: ${relativePath}`);
    }
    const dir = this.dirFor(attemptId);
    mkdirSync(dir, { recursive: true });
    const buffer = typeof data === "string" ? Buffer.from(data, "utf8") : data;
    const target = join(dir, relativePath);
    const parent = target.slice(0, target.lastIndexOf("/"));
    if (parent.length > 0 && parent !== dir) mkdirSync(parent, { recursive: true });
    writeFileSync(target, buffer);

    const entry: ArtifactManifestEntry = {
      relativePath,
      contentHash: sha256(buffer),
      mediaType,
      sizeBytes: buffer.byteLength,
      writtenAt: this.#now(),
      expiredAt: null,
    };
    const existing = this.readManifest(attemptId).entries.filter((e) => e.relativePath !== relativePath);
    this.#writeManifest(attemptId, [...existing, entry]);

    return {
      relativePath: artifactRelativePath(String(attemptId), relativePath),
      contentHash: entry.contentHash,
      mediaType: entry.mediaType,
      sizeBytes: entry.sizeBytes,
    };
  }

  /** Read an artifact back by its attempt-relative path. */
  read(attemptId: AttemptId | string, relativePath: string): Buffer {
    return readFileSync(join(this.dirFor(attemptId), relativePath));
  }

  /** Does the stored file still hash to what the manifest recorded? */
  verify(attemptId: AttemptId | string, relativePath: string): boolean {
    const entry = this.readManifest(attemptId).entries.find((e) => e.relativePath === relativePath);
    if (entry === undefined || entry.expiredAt !== null) return false;
    try {
      return sha256(this.read(attemptId, relativePath)) === entry.contentHash;
    } catch {
      return false;
    }
  }

  /**
   * Retention: delete the bytes of every artifact written before `cutoff`,
   * marking the manifest entry `expiredAt`. Rows are never touched.
   * Returns the relative paths whose bytes were removed.
   */
  expireOlderThan(attemptId: AttemptId | string, cutoff: IsoTimestamp): readonly string[] {
    const manifest = this.readManifest(attemptId);
    const expired: string[] = [];
    const at = this.#now();
    const entries = manifest.entries.map((entry) => {
      if (entry.expiredAt !== null || entry.writtenAt >= cutoff) return entry;
      rmSync(join(this.dirFor(attemptId), entry.relativePath), { force: true });
      expired.push(entry.relativePath);
      return { ...entry, expiredAt: at };
    });
    if (expired.length > 0) this.#writeManifest(attemptId, entries);
    return expired;
  }
}
