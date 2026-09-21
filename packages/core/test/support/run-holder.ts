import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

/** A second process, because the scripts under `test/` run on node while the
 * store is TypeScript: the flag is the transform, not the strip. */
const STORE = JSON.stringify(fileURLToPath(new URL("../../src/store.ts", import.meta.url)));

function holderScript(dbPath: string, first: string, last: string, hold: boolean): string {
  return `
(async () => {
  const { LcmStore } = await import(${STORE});
  const store = new LcmStore(${JSON.stringify(dbPath)});
  const run = store.openRun({ session: "holder" });
  const ids = store.uncoveredMessagesInSpan(${JSON.stringify(first)}, ${JSON.stringify(last)}).map((m) => m.id);
  store.forRun(run.token).insertSummary({
    kind: "leaf",
    text: "a row nobody will commit",
    tokens: 5,
    depth: 0,
    firstEntryId: ${JSON.stringify(first)},
    lastEntryId: ${JSON.stringify(last)},
    messageIds: ids,
  });
  process.stdout.write("ready\\n");
  ${hold ? "setInterval(() => {}, 1000);" : ""}
})();
`;
}

function holderArgs(script: string): string[] {
  return ["--experimental-transform-types", "-e", script];
}

export function leaveCrashedRun(dbPath: string, span: { first: string; last: string }): void {
  const result = spawnSync(
    process.execPath,
    holderArgs(holderScript(dbPath, span.first, span.last, false)),
    { encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error(`crashed-run holder exited ${result.status}: ${result.stderr}`);
  }
}

export function holdRun(
  dbPath: string,
  span: { first: string; last: string },
): Promise<{ stop: () => Promise<void> }> {
  const child = spawn(
    process.execPath,
    holderArgs(holderScript(dbPath, span.first, span.last, true)),
    {
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stderr = "";
  let settled = false;
  // Registered before any exit can fire, so `stop` never waits for an event that
  // has already happened when the holder dies between readiness and the call.
  const exited = once(child, "exit");
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += String(chunk);
  });
  return new Promise((resolve, reject) => {
    const fail = (message: string): void => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(new Error(`${message}: ${stderr}`));
    };
    child.on("exit", (code) => fail(`holder exited before it held a run (${code})`));
    // Buffered, because a chunk boundary can split the readiness line.
    let out = "";
    child.stdout.on("data", (chunk: Buffer) => {
      out += String(chunk);
      if (settled || !/^ready$/m.test(out)) return;
      settled = true;
      resolve({
        stop: async () => {
          child.kill("SIGKILL");
          await exited;
        },
      });
    });
  });
}
