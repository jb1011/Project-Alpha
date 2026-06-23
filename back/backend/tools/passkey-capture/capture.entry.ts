// backend/tools/passkey-capture/capture.entry.ts
// Browser entry — bundled by esbuild to capture.js. Not typechecked by tsc (outside tsconfig include).
import { getWebAuthnAttestation } from "@turnkey/http";

const statusEl = document.getElementById("status") as HTMLDivElement;
const btn = document.getElementById("create") as HTMLButtonElement;

function base64url(bytes: Uint8Array): string {
  let str = "";
  for (const b of bytes) str += String.fromCharCode(b);
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomBytes(n: number): Uint8Array {
  const a = new Uint8Array(n);
  crypto.getRandomValues(a);
  return a;
}

btn.addEventListener("click", async () => {
  btn.disabled = true;
  statusEl.className = "";
  statusEl.textContent = "Waiting for authenticator…";
  try {
    const challenge = randomBytes(32);
    const userId = randomBytes(16);
    const attestation = await getWebAuthnAttestation({
      publicKey: {
        rp: { id: "localhost", name: "Agent Vault Guardian" },
        challenge,
        pubKeyCredParams: [
          { type: "public-key", alg: -7 }, // ES256
          { type: "public-key", alg: -257 }, // RS256
        ],
        user: { id: userId, name: "guardian@local", displayName: "Guardian" },
        authenticatorSelection: { residentKey: "preferred", userVerification: "preferred" },
        timeout: 60000,
      },
    });

    const payload = { challenge: base64url(challenge), attestation };
    const res = await fetch("/capture", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error ?? `capture failed (${res.status})`);
    statusEl.className = "ok";
    statusEl.textContent = `Saved attestation to:\n${json.path}\n\nYou can close this tab and run the live test.`;
  } catch (e) {
    statusEl.className = "err";
    statusEl.textContent = `Error: ${e instanceof Error ? e.message : String(e)}`;
  } finally {
    btn.disabled = false;
  }
});
