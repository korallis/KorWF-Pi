# Stage 2 exit criterion (M2) — lifecycle tests

Issue #32. PLAN §8 Stage 2 **Exit**:

> loads in an isolated Pi session; offline tests pass; works with no Jev key;
> failures cannot hang Pi or leak credentials.

Each clause maps to named tests here. Run them with `npm test -- lifecycle`.

| Exit clause | Test file | Test name |
| --- | --- | --- |
| loads in an isolated Pi session | `isolated-session.test.ts` | `M2 exit: the package loads in an isolated Pi session > installs from the local path into the temporary config dir only` |
| loads in an isolated Pi session | `isolated-session.test.ts` | `… > runs /korwf version in the session and reports the package version` |
| loads in an isolated Pi session | `isolated-session.test.ts` | `… > exposes the whole /korwf namespace without an error notification` |
| offline tests pass (nothing written outside the temp dir) | `isolated-session.test.ts` | `… > writes nothing outside the temp dir: the package source tree is untouched` |
| offline tests pass | `isolated-session.test.ts` | `… > writes only under .korwf/ inside the isolated project` |
| works with no Jev key | `no-key-session.test.ts` | `M2 exit: the package works with no Jev key > builds a session environment with no credential variable at all` |
| works with no Jev key | `no-key-session.test.ts` | `… > loads and answers /korwf version with no key present` |
| works with no Jev key | `no-key-session.test.ts` | `… > reports Jev disabled with the documented message, not an error` |
| works with no Jev key | `no-key-session.test.ts` | `… > never throws: no stack trace or unhandled rejection reaches the session` |
| works with no Jev key | `no-key-session.test.ts` | `… > downgrades jev.enabled=true to optional mode instead of failing to load` |
| offline: no network attempt with no key | `no-key-session.test.ts` | `M2 exit: with no key, nothing goes outbound > createJev returns the disabled transport and never calls fetch` |
| lifecycle cleanup | `lifecycle-cleanup.test.ts` | `M2 exit: a normal session releases everything it took > removes the lockfile on close so the next session starts immediately` |
| lifecycle cleanup | `lifecycle-cleanup.test.ts` | `… > close() is idempotent and leaves no stray process behind` |
| lifecycle cleanup (SIGKILL recovery) | `lifecycle-cleanup.test.ts` | `M2 exit: a SIGKILLed session's lock is recovered with no corruption > takes over the stale lock, audits the takeover, and the store still reads` |
| lifecycle cleanup (restart) | `lifecycle-cleanup.test.ts` | `… > a second session starts immediately after the crashed one` |
| lifecycle cleanup (no stray state) | `lifecycle-cleanup.test.ts` | `M2 exit: consecutive Pi sessions clean up after themselves > releases the store lock when the /korwf command that opened it returns` |
| lifecycle cleanup (no stray process/temp dir) | `lifecycle-cleanup.test.ts` | `… > leaves no stray pi process and no temp dir behind after the session exits` |
| failures cannot hang Pi | `failure-degradation.test.ts` | `M2 exit: a broken transport degrades, it does not hang > a transport that never answers is bounded by the deadline` |
| failures cannot hang Pi | `failure-degradation.test.ts` | `… > a transport that throws on contact falls back without throwing` |
| failures cannot hang Pi | `failure-degradation.test.ts` | `… > a transport returning garbage falls back rather than propagating it` |
| failures cannot hang Pi | `failure-degradation.test.ts` | `… > an unroutable address fails fast instead of waiting on the network` |
| failures cannot hang Pi | `failure-degradation.test.ts` | `M2 exit: a failing command cannot hang the Pi session > a corrupted store is reported and the session still exits` |
| failures cannot hang Pi | `failure-degradation.test.ts` | `… > an unwritable storage root degrades to a message, not a hang` |
| failures cannot leak credentials | `failure-degradation.test.ts` | `… > the failure message carries no credential material` |
| failures cannot leak credentials | `no-credential-leak.test.ts` | `M2 exit: a key in the environment never reaches disk or output > /korwf jev reports the key's source and fingerprint, never the key` |
| failures cannot leak credentials | `no-credential-leak.test.ts` | `… > no file the session wrote under its temp root contains the key` |
| failures cannot leak credentials | `no-credential-leak.test.ts` | `… > the key is not written even when the session is asked to fail` |
| failures cannot leak credentials | `no-credential-leak.test.ts` | `M2 exit: a mock decision with a fake key writes no key to disk > stores the Decision, the trace and the raw payload without the key` |

## How the isolation works

`pi-session.ts` builds a throwaway Pi installation per test: its own
`PI_CODING_AGENT_DIR`, its own `HOME`, its own `TMPDIR` and its own project
directory, all under one temp root that is removed afterwards. The session
environment is **constructed**, not inherited, so no developer-specific value
can reach the session; `CREDENTIAL_ENV_VARS` is deleted from it before a
test's own additions are applied.

Pi is driven over RPC (`--mode rpc`, Pi `docs/rpc.md`): one JSON `prompt`
command per line, with `ctx.ui.notify()` surfacing as an
`extension_ui_request` event that the harness collects into a transcript.
Extension commands execute locally and never reach a model, so no key and no
network are needed. `PI_OFFLINE=1` disables Pi's own startup network
operations.

No test in this directory makes a live Jev or model call. Every transport is a
mock, a stub `fetch`, or an address on the loopback interface that refuses the
connection.

## Credentials used

Every "key" in these tests is generated at runtime from `randomBytes` with a
`korwffake-` prefix, or is a literal string that is obviously not a
credential. Nothing credential-shaped is committed, and
`scripts/check-secrets.sh` stays clean.
