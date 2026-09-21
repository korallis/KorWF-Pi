/**
 * Schema, defaults, validation, layered merge (KorWF-Pi module, see docs/adr/0002-source-layout.md).
 *
 * Issue #11 drafted the contract: `schema.json` (JSON Schema 2020-12),
 * `types.ts`, and docs/config-reference.md. Loading, layered merge and the
 * validator rules V1–V9 are issue #21.
 */
export * from "./types.ts";
