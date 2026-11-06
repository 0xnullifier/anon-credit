// Child processes of a run. The runner stops only the processes that it started.

import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";

export interface Children {
  // Start a process. Its output goes to <logDir>/<name>.log.
  readonly start: (name: string, command: string, args: readonly string[], options: { readonly cwd: string; readonly env: NodeJS.ProcessEnv }) => ChildProcess;
  // Stop all started processes: SIGTERM, then SIGKILL after 5 s.
  readonly stopAll: () => Promise<void>;
  readonly logPath: (name: string) => string;
}

export function children(logDir: string): Children {
  const started: { readonly name: string; readonly child: ChildProcess }[] = [];
  return {
    logPath: (name) => join(logDir, `${name}.log`),
    start: (name, command, args, options) => {
      const log = createWriteStream(join(logDir, `${name}.log`));
      const child = spawn(command, [...args], { cwd: options.cwd, env: options.env, stdio: ["ignore", "pipe", "pipe"] });
      child.stdout?.pipe(log);
      child.stderr?.pipe(log);
      started.push({ name, child });
      return child;
    },
    stopAll: async () => {
      const running = started.filter((entry) => entry.child.exitCode === null && entry.child.signalCode === null);
      await Promise.all(
        running.map(
          (entry) =>
            new Promise<void>((resolve) => {
              const timer = setTimeout(() => {
                entry.child.kill("SIGKILL");
                resolve();
              }, 5000);
              entry.child.once("exit", () => {
                clearTimeout(timer);
                resolve();
              });
              entry.child.kill("SIGTERM");
            }),
        ),
      );
    },
  };
}

// A free TCP port on 127.0.0.1.
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

// Wait until `probe` returns true. Throw after `timeoutMs`.
export async function waitFor(what: string, timeoutMs: number, probe: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      if (await probe()) return;
    } catch {
      // Not ready yet.
    }
    if (Date.now() > deadline) throw new Error(`${what} did not become ready in ${timeoutMs} ms`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

// Run a command to completion. Throw with the log path if it fails.
export function runCommand(
  name: string,
  command: string,
  args: readonly string[],
  options: { readonly cwd: string; readonly env: NodeJS.ProcessEnv; readonly logDir: string },
): Promise<void> {
  return new Promise((resolve, reject) => {
    const log = createWriteStream(join(options.logDir, `${name}.log`));
    const child = spawn(command, [...args], { cwd: options.cwd, env: options.env, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.pipe(log);
    child.stderr.pipe(log);
    child.once("error", reject);
    child.once("exit", (code) => {
      switch (code) {
        case 0:
          resolve();
          return;
        default:
          reject(new Error(`${name} failed with exit code ${String(code)}; see ${join(options.logDir, `${name}.log`)}`));
      }
    });
  });
}
