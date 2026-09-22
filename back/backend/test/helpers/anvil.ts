import { type ChildProcess, spawn } from "node:child_process";
import { resetSenderNonces } from "../../src/adapters/arc/senderLock";

export interface AnvilHandle {
  rpcUrl: string;
  stop: () => void;
}

/**
 * Spawn a local anvil and resolve once it is listening. Caller must stop() in afterAll.
 *
 * A FRESH CHAIN FORGETS EVERY NONCE, SO THIS PROCESS HAS TO FORGET ITS FLOORS. The send lock keeps
 * a floor per signer address for the life of the process (`senderLock.ts`), and these helpers hand
 * every chain the same deterministic anvil accounts — so a file that starts one anvil per test
 * leaves the next chain's first send numbered behind a floor from the previous one, and the node
 * queues it behind nonces that will never arrive until the receipt wait times out.
 *
 * A restarted chain is the one case where a node BEHIND our floor is not a lagging replica: the
 * transactions that raised it no longer exist anywhere, so the floor is not a claim on anything and
 * the node is the only authority. Resetting here covers every anvil-based file at once, which is
 * why it lives in the spawner rather than in each `beforeAll`.
 */
export function startAnvil(port = 8545): Promise<AnvilHandle> {
  return new Promise((resolvePromise, reject) => {
    const proc: ChildProcess = spawn("anvil", ["--port", String(port), "--silent"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const rpcUrl = `http://127.0.0.1:${port}`;
    let settled = false;
    /** Ready, and the floors from any previous chain dropped before a caller can send. */
    const ready = () => {
      resetSenderNonces();
      resolvePromise({ rpcUrl, stop: () => proc.kill("SIGTERM") });
    };

    const onData = (buf: Buffer) => {
      if (!settled && buf.toString().includes("Listening on")) {
        settled = true;
        ready();
      }
    };
    proc.stdout?.on("data", onData);
    // --silent suppresses stdout; fall back to a readiness poll via a short timer.
    const pollStart = Date.now();
    const poll = setInterval(async () => {
      if (settled) return clearInterval(poll);
      try {
        const res = await fetch(rpcUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
        });
        if (res.ok) {
          settled = true;
          clearInterval(poll);
          ready();
        }
      } catch {
        if (Date.now() - pollStart > 20_000) {
          clearInterval(poll);
          proc.kill("SIGTERM"); // don't orphan the child if it never became ready
          reject(new Error("anvil did not become ready in 20s"));
        }
      }
    }, 200);
    proc.on("error", (e) => !settled && reject(e));
  });
}
