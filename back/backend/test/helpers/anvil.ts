import { type ChildProcess, spawn } from "node:child_process";
import { resetSenderNonces } from "../../src/adapters/arc/senderLock";

export interface AnvilHandle {
  rpcUrl: string;
  stop: () => void;
}

/**
 * Does something on this port already answer JSON-RPC?
 *
 * One `eth_chainId`, the cheapest question a node will answer. A refused connection (nothing
 * there) is the answer we want, so a throw is `false` — this asks "is the port TAKEN", and the
 * only way to say yes is to have been answered.
 */
async function portAnswers(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * How long a port may go on answering after we stopped the chain that was on it.
 *
 * `stop()` sends SIGTERM and returns immediately, and files like `helpers/anvilJob.ts` start one
 * chain per test on the same port — so the port is routinely still answering for a few
 * milliseconds when the next `startAnvil` asks. This grace is for that, and only that: a chain
 * nobody stopped never goes quiet, so it still hits the refusal below.
 */
const PORT_RELEASE_TIMEOUT_MS = 5_000;

/**
 * REFUSE A PORT SOMEBODY ELSE IS ON.
 *
 * A second anvil cannot bind a taken port, and the readiness poll below cannot tell the chain it
 * asked for from the one that was already there — so without this check a stale process left by
 * another session silently became every later test's chain, complete with its old contracts,
 * balances and nonces. Green tests about state nobody wrote is the one outcome worse than a
 * failing suite, so this is loud and it happens BEFORE anything is spawned.
 */
async function requireFreePort(port: number): Promise<void> {
  const deadline = Date.now() + PORT_RELEASE_TIMEOUT_MS;
  while (await portAnswers(port)) {
    if (Date.now() > deadline)
      throw new Error(
        `startAnvil: something is already listening on 127.0.0.1:${port} and answering eth_chainId. Refusing to spawn: a second anvil cannot take the port, so these tests would silently run against a chain this suite did not start. Stop the leftover process (or free the port) and run again.`,
      );
    await new Promise((r) => setTimeout(r, 100));
  }
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
export async function startAnvil(port = 8545): Promise<AnvilHandle> {
  await requireFreePort(port);
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
