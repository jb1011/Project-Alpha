import { type ChildProcess, spawn } from "node:child_process";
import { connect } from "node:net";
import { resetSenderNonces } from "../../src/adapters/arc/senderLock";

export interface AnvilHandle {
  rpcUrl: string;
  stop: () => void;
}

/**
 * Does anything ACCEPT a TCP connection on this port?
 *
 * The question is deliberately not "does it answer JSON-RPC". A probe that asked that had two
 * holes, both measured: one transient non-200 from the squatter read as "nothing there" (and the
 * suite then ran against the squatter's chain), and a process that accepts the socket without
 * ever replying made the probe wait for ever. A completed TCP handshake is the whole answer —
 * anvil cannot bind a port somebody else is holding, whatever that somebody chooses to say.
 *
 * Bounded twice over: the socket's own timeout and a hard timer, so a half-open connection cannot
 * park this. Anything other than a completed connection counts as free.
 */
function portAccepts(port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ port, host: "127.0.0.1" });
    let settled = false;
    const done = (taken: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(taken);
    };
    const timer = setTimeout(() => done(false), timeoutMs);
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

/**
 * How long the WHOLE probe may take before it calls the port taken.
 *
 * `stop()` sends SIGTERM and returns immediately, and files like `helpers/anvilJob.ts` start one
 * chain per test on the same port — so a port we just stopped is routinely still accepting for a
 * few milliseconds. Waiting that out is all the grace anyone needs: a port that stops accepting
 * ends the wait on the spot, and one that never stops is refused here rather than hours later in
 * whichever test first reads state it did not write.
 */
const PROBE_TIMEOUT_MS = 2_000;

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
  const deadline = Date.now() + PROBE_TIMEOUT_MS;
  while (await portAccepts(port, 500)) {
    if (Date.now() >= deadline)
      throw new Error(
        `startAnvil: something is already listening on 127.0.0.1:${port}. Refusing to spawn: a second anvil cannot take the port, so these tests would silently run against a chain this suite did not start. Stop the leftover process (or free the port) and run again.`,
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
      // ⚠ OUR child, or somebody else's? If the process we spawned is already gone it failed to
      // bind, and whatever just answered on this port is not the chain we are handing back. The
      // probe above makes this nearly unreachable; it is here because "nearly" is what the
      // original hole was made of.
      if (proc.exitCode !== null || proc.signalCode !== null) {
        reject(
          new Error(
            `startAnvil: the anvil spawned for 127.0.0.1:${port} exited immediately — the port is held by something else`,
          ),
        );
        return;
      }
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
