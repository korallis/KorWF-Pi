/**
 * Provenance, summaries, compaction, handoff packets (KorWF-Pi module, see docs/adr/0002-source-layout.md).
 *
 * Implemented so far:
 * - `handoff-packet.ts` — `HandoffPacket` schema and builder: what was done,
 *   what remains, decisions and why, open questions, and where the evidence
 *   is, assembled from the Attempt/Evidence/progress-note records that
 *   already exist elsewhere (#64).
 *
 * **Re-export style: `export *`**, deliberately additive; see `src/workers/index.ts`
 * for the rationale.
 */
export * from "./handoff-packet.ts";
