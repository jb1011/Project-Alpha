// `@x402/hedera` re-exports the SDK symbols it uses, but NOT `PublicKey`; that type comes
// from the SDK it pins. Never install `@hashgraph/sdk` beside it.
import type { PublicKey } from "@hiero-ledger/sdk";
/**
 * The custody boundary, and the only place this package touches a key.
 *
 * `RawSign` is 32 bytes in, 64 bytes out. A1/A2 adapters implement `RawSign` against
 * Turnkey raw-payload or a KMS; nothing else changes. `localRawSigner` is the B (customer
 * self-custody) adapter: the key is read from the process environment under `op run`,
 * stays in this process, and is never sent to the Novi Corpus server (design D1).
 *
 * Proven on Hedera testnet on 2026-09-09; see
 * `back/docs/research/2026-09-09-hedera-signer-spike-findings.md`, finding 1.
 */
import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";
import type { PaymentRequirements } from "@x402/core/types";
import {
  AccountId,
  Client,
  PrivateKey,
  TokenId,
  TransactionId,
  TransferTransaction,
} from "@x402/hedera";
import type { ClientHederaSigner } from "@x402/hedera";

/** Raw-digest signer: the only thing a key holder (KMS, Turnkey, customer runtime) must expose. */
export type RawSign = (digest32: Uint8Array) => Promise<Uint8Array>;

/**
 * The self-custody adapter: a local ECDSA key, hex-encoded.
 *
 * @param privHex - 32-byte secp256k1 private key, hex, with or without the `0x` prefix
 * @returns The public key and a `RawSign` bound to it
 */
export function localRawSigner(privHex: string): { pub: PublicKey; rawSign: RawSign } {
  const pk = PrivateKey.fromStringECDSA(privHex);
  const raw = pk.toBytesRaw();
  return {
    pub: pk.publicKey,
    rawSign: async (d) => secp256k1.sign(d, raw, { lowS: true }).toCompactRawBytes(),
  };
}

/**
 * Our `ClientHederaSigner`: the same transfer construction `@x402/hedera` does, but
 * `signWith` over a raw digest instead of `tx.sign(privateKey)`.
 *
 * @param accountId - The payer's Hedera account id (the float account)
 * @param pub - The public key whose signature the network will check
 * @param rawSign - The custody boundary: digest in, compact signature out
 * @returns A signer the x402 exact-Hedera client scheme can use
 */
export function custodyAgnosticSigner(
  accountId: string,
  pub: PublicKey,
  rawSign: RawSign,
): ClientHederaSigner {
  const payer = AccountId.fromString(accountId);
  return {
    accountId: payer.toString(),
    async createPartiallySignedTransferTransaction(req: PaymentRequirements) {
      const feePayer = req.extra?.feePayer;
      if (typeof feePayer !== "string") throw new Error("feePayer missing in requirements.extra");
      const amount = BigInt(req.amount);
      const payTo = AccountId.fromString(req.payTo);
      const tx = new TransferTransaction()
        .addTokenTransfer(TokenId.fromString(req.asset), payer, -amount)
        .addTokenTransfer(TokenId.fromString(req.asset), payTo, amount)
        .setTransactionId(TransactionId.generate(AccountId.fromString(feePayer)));
      const client = Client.forTestnet();
      try {
        tx.freezeWith(client);
        await tx.signWith(pub, async (bodyBytes) => rawSign(keccak_256(bodyBytes)));
        return Buffer.from(tx.toBytes()).toString("base64");
      } finally {
        client.close();
      }
    },
  };
}
