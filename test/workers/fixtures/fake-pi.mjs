#!/usr/bin/env node
// A stand-in for `pi --mode rpc` (issue #68 tests). No model, no network, no key.
//
// It exists so the worker tests observe a *real* subprocess: the environment it
// actually received, the argv it was actually given, real LF-framed JSONL, a real
// detached grandchild for the process-tree sweep, and real signal behaviour.
// Mocking `child_process.spawn` would prove none of that.
//
// Protocol (subset of Pi's RPC surface used by src/workers/spawn.ts):
//   {"id":"x","type":"get_state"}   -> response with argv + env it received
//   {"id":"x","type":"spawn_child"} -> starts a detached `sleep`, answers with its pid
//   {"id":"x","type":"prompt","message":"..."} -> echoes the prompt back
//   {"id":"x","type":"abort"} / "abort_bash"    -> exits 0 (cooperative tier)
//   {"id":"x","type":"ignore_abort"}            -> stop honouring aborts (forces tier 2/3)
//   {"id":"x","type":"ignore_sigterm"}          -> also ignore SIGTERM (forces tier 3)
import { spawn } from "node:child_process";

let honourAbort = true;
const children = [];

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

send({ type: "ready", pid: process.pid });

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let nl;
  while ((nl = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, nl);
    buffer = buffer.slice(nl + 1);
    if (line.trim()) handle(JSON.parse(line));
  }
});

function handle(command) {
  switch (command.type) {
    case "get_state":
      send({
        type: "response",
        id: command.id,
        command: "get_state",
        success: true,
        data: { argv: process.argv.slice(2), env: process.env, cwd: process.cwd() },
      });
      return;
    case "prompt":
      send({
        type: "response",
        id: command.id,
        command: "prompt",
        success: true,
        data: { prompt: command.message, usage: { inputTokens: 7, outputTokens: 11, costUsd: 0 } },
      });
      return;
    case "spawn_child": {
      // detached: own process group, exactly like Pi's bash tool, so SIGKILL of
      // this process orphans it unless the supervisor swept its snapshot.
      const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 300000)"], {
        detached: true,
        stdio: "ignore",
      });
      child.unref();
      children.push(child.pid);
      send({ type: "response", id: command.id, command: "spawn_child", success: true, data: { pid: child.pid } });
      return;
    }
    case "ignore_abort":
      honourAbort = false;
      send({ type: "response", id: command.id, command: "ignore_abort", success: true });
      return;
    case "ignore_sigterm":
      process.on("SIGTERM", () => {});
      send({ type: "response", id: command.id, command: "ignore_sigterm", success: true });
      return;
    case "abort":
    case "abort_bash":
      if (honourAbort) {
        // Like Pi's own handler: reap tracked children, then exit.
        for (const pid of children) {
          try {
            process.kill(pid, "SIGKILL");
          } catch {
            /* gone */
          }
        }
        process.exit(0);
      }
      send({ type: "response", id: command.id, command: command.type, success: false, data: { cancelled: false } });
      return;
    default:
      send({ type: "response", id: command.id, command: command.type, success: false });
  }
}

process.on("SIGTERM", () => {
  for (const pid of children) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* gone */
    }
  }
  process.exit(143);
});
