import { type Hex, keccak256, toHex } from "viem";
import type { AgentSpec } from "../policy/agentSpec";
import type { TranslateResult } from "../policy/translator";
import { formatUnitsUsd } from "../policy/units";

/**
 * Which anchoring scheme this document is rendered for.
 *
 * "legacy"   — the pre-manifest scheme: the whole document IS the anchor (its keccak256 goes on
 *              chain), so its bytes may NEVER change for an existing record. Default, so every
 *              pre-existing caller renders byte-identically.
 * "manifest" — the OA bundle manifest is the anchor (design §4) and this document is the TERMS
 *              doc it commits to. Legal FACTS (the EIN, the filing) live in the manifest's
 *              `legal` block instead, so the terms doc changes only when a TERM changes — which
 *              is what lets v2/v3 move exactly one hash.
 */
export type OaScheme = "legacy" | "manifest";

/**
 * Render a canonical operating-agreement document. MUST be deterministic: explicit field order,
 * no timestamps / random data, so computeOaHash is stable for identical inputs.
 */
export function renderOperatingAgreement(
  spec: AgentSpec,
  r: TranslateResult,
  opts: { scheme?: OaScheme } = {},
): string {
  const manifestScheme = opts.scheme === "manifest";
  const lines = [
    `# Operating Agreement — ${spec.name}`,
    "",
    `Jurisdiction: ${spec.jurisdiction}`,
    // The EIN and the formation date are legal FACTS, not terms. Under the manifest scheme both
    // are carried by the manifest's `legal` block (its only carrier), so leaving either here
    // would re-hash the terms doc when a filing completes — a version bump on a document whose
    // terms nobody changed, which is precisely what the terms/facts split exists to avoid.
    // (Under this scheme the on-chain `formationDate` is a 0 placeholder anyway: nothing is
    // filed at mint, and the real date lands in the manifest, not on the frozen struct.)
    ...(manifestScheme
      ? []
      : [`EIN: ${r.legal.ein}`, `Formation date (unix): ${r.legal.formationDate}`]),
    "",
    "## Roles",
    `- Manager (platform controller): ${r.manager}`,
    `- Guardian (human registrant; pause/veto/rescue): ${r.guardian}`,
    // The operator (the agent's hot spending key) is bound and rotated on-chain by the Guardian via
    // AgentTreasury.setOperator, and is NOT an input to the contract's operatingAgreementHash. It is
    // therefore deliberately excluded from this document — rendering the address would make the OA
    // hash change on a routine key rotation, even though no legal term changed. Render a fixed line.
    "- Operator (agent spending key): bound and rotatable on-chain by the Guardian via AgentTreasury.setOperator; intentionally not fixed by this agreement",
    "",
    "## Treasury policy",
    `- USDC token: ${r.treasury.usdc}`,
    `- Payout (safe sink) address: ${r.treasury.payoutAddress}`,
    `- Spending cap per window: ${formatUnitsUsd(r.treasury.cap)} USDC`,
    `- Window length (seconds): ${r.treasury.period}`,
    `- Allowlist enforced: ${r.treasury.allowlistEnabled}`,
    "",
    "## Governance",
    `- Amendment / dissolution timelock (seconds): ${r.amendmentDelay}`,
    "",
    "This agreement is enforced on-chain by the LegalManager + AgentTreasury contracts on Arc.",
    "",
  ];
  return lines.join("\n");
}

/**
 * The on-chain operatingAgreementHash: keccak256 over the document's canonical bytes. The canonical
 * form is fixed so any re-verifier recomputes the same value: Unicode NFC, LF newlines
 * (renderOperatingAgreement never emits CR), UTF-8 encoding, and the trailing newline included. NFC
 * matters because spec.name / spec.jurisdiction are user-supplied free text that could otherwise
 * arrive in a decomposed form and hash differently for a visually identical document.
 */
export function computeOaHash(doc: string): Hex {
  return keccak256(toHex(doc.normalize("NFC")));
}

/**
 * What `legalBody.oaHash` on the served metadata actually COMMITS to (design §4, M16).
 *
 * A verifier holding only the chain sees one 32-byte value and cannot tell whether it is the
 * keccak of an operating-agreement document (every legacy row) or of an OA bundle manifest that
 * in turn commits to the terms doc, the legal documents and the chain identity. Publishing the
 * scheme — and, for the manifest scheme, WHERE the two artifacts live — is what makes the anchor
 * checkable by someone who was not there when it was written.
 */
export type MetadataAnchor =
  | { scheme: "document" }
  | { scheme: "manifest"; version: number; manifestUri: string; termsUri: string };

export interface AgentMetadata {
  name: string;
  description: string;
  agent_type: string;
  capabilities: string[];
  version: string;
  legalBody: {
    jurisdiction: string;
    formationDate: number;
    oaHash: Hex;
  };
  /** How to interpret `legalBody.oaHash`. Legacy rows: `{ scheme: "document" }`. */
  anchor: MetadataAnchor;
}

/**
 * ERC-8004 metadata JSON (the metadataURI target in v1; stored locally). `name`/`description`/
 * `agent_type`/`capabilities`/`version` mirror the ERC-8004 example schema's snake_case field names;
 * `legalBody` is our camelCase extension carrying the on-chain legal binding. The metadata itself is
 * not hashed — the operating-agreement document is the canonical artifact; oaHash is embedded here
 * only as a convenience pointer.
 */
export function renderMetadata(
  spec: AgentSpec,
  r: TranslateResult,
  oaHash: Hex,
  /** Defaults to the LEGACY meaning, which is what every pre-manifest caller intends. */
  anchor: MetadataAnchor = { scheme: "document" },
): AgentMetadata {
  return {
    name: spec.name,
    description: spec.metadata.description,
    agent_type: spec.metadata.agentType,
    capabilities: spec.metadata.capabilities,
    version: spec.metadata.version,
    legalBody: {
      jurisdiction: spec.jurisdiction,
      formationDate: r.legal.formationDate,
      oaHash,
    },
    anchor,
  };
}
