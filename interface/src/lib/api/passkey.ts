import { getWebAuthnAttestation } from "@turnkey/http";
import type { GuardianPasskey } from "./types";

function base64urlDecode(b64: string): Uint8Array {
  const pad = b64.length % 4 === 0 ? "" : "=".repeat(4 - (b64.length % 4));
  const base64 = b64.replace(/-/g, "+").replace(/_/g, "/") + pad;
  const binary = atob(base64);
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

/** Run the WebAuthn registration ceremony using a server-issued challenge. */
export async function createGuardianPasskey(
  challengeB64: string,
  rpId: string,
): Promise<GuardianPasskey> {
  const challenge = new Uint8Array(base64urlDecode(challengeB64));
  const userId = crypto.getRandomValues(new Uint8Array(16));

  const attestation = await getWebAuthnAttestation({
    publicKey: {
      rp: { id: rpId, name: "Novi Corpus Guardian" },
      challenge,
      pubKeyCredParams: [
        { type: "public-key", alg: -7 },
        { type: "public-key", alg: -257 },
      ],
      user: {
        id: userId,
        name: "guardian",
        displayName: "Guardian",
      },
      authenticatorSelection: {
        residentKey: "preferred",
        userVerification: "preferred",
      },
      timeout: 60_000,
    },
  });

  return {
    authenticatorName: "Guardian Passkey",
    challenge: challengeB64,
    attestation: {
      credentialId: attestation.credentialId,
      clientDataJson: attestation.clientDataJson,
      attestationObject: attestation.attestationObject,
      transports: attestation.transports,
    },
  };
}
