import { type Hex, keccak256, toHex } from "viem";
import type { AgentSpec } from "../policy/agentSpec";
import type { TranslateResult } from "../policy/translator";
import { formatUnitsUsd } from "../policy/units";

/**
 * Render a canonical operating-agreement document. MUST be deterministic: explicit field order,
 * no timestamps / random data, so computeOaHash is stable for identical inputs.
 */
export function renderOperatingAgreement(spec: AgentSpec, r: TranslateResult): string {
  const lines = [
    `# Operating Agreement — ${spec.name}`,
    "",
    `Jurisdiction: ${spec.jurisdiction}`,
    `EIN: ${r.legal.ein}`,
    `Formation date (unix): ${r.legal.formationDate}`,
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

export interface AgentMetadata {
  name: string;
  description: string;
  agent_type: string;
  capabilities: string[];
  version: string;
  legalBody: {
    jurisdiction: string;
    ein: string;
    formationDate: number;
    oaHash: Hex;
  };
}

/**
 * ERC-8004 metadata JSON (the metadataURI target in v1; stored locally). `name`/`description`/
 * `agent_type`/`capabilities`/`version` mirror the ERC-8004 example schema's snake_case field names;
 * `legalBody` is our camelCase extension carrying the on-chain legal binding. The metadata itself is
 * not hashed — the operating-agreement document is the canonical artifact; oaHash is embedded here
 * only as a convenience pointer.
 */
export function renderMetadata(spec: AgentSpec, r: TranslateResult, oaHash: Hex): AgentMetadata {
  return {
    name: spec.name,
    description: spec.metadata.description,
    agent_type: spec.metadata.agentType,
    capabilities: spec.metadata.capabilities,
    version: spec.metadata.version,
    legalBody: {
      jurisdiction: spec.jurisdiction,
      ein: r.legal.ein,
      formationDate: r.legal.formationDate,
      oaHash,
    },
  };
}
