import { type ChildProcess, spawn } from "node:child_process";

export interface AnvilHandle {
  rpcUrl: string;
  stop: () => void;
}

/** Spawn a local anvil and resolve once it is listening. Caller must stop() in afterAll. */
export function startAnvil(port = 8545): Promise<AnvilHandle> {
  return new Promise((resolvePromise, reject) => {
    const proc: ChildProcess = spawn("anvil", ["--port", String(port), "--silent"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const rpcUrl = `http://127.0.0.1:${port}`;
    let settled = false;

    const onData = (buf: Buffer) => {
      if (!settled && buf.toString().includes("Listening on")) {
        settled = true;
        resolvePromise({ rpcUrl, stop: () => proc.kill("SIGTERM") });
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
          resolvePromise({ rpcUrl, stop: () => proc.kill("SIGTERM") });
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
