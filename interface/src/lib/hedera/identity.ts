import type {
  AgentRegistration,
  HederaMetadataBlock,
  PublicMetadata,
  TransparencyHedera,
} from "@/lib/api/types";
import { hashscanContractUrl, hashscanTxUrl } from "@/lib/hedera/hashscan";

/** Hedera testnet CAIP-2. The ERC-8004 identity registry lives on chain 296. */
export const HEDERA_CAIP2 = "eip155:296";

/** ERC-8004 IdentityRegistry on Hedera testnet. Public, immutable, same address the backend publishes. */
export const HEDERA_IDENTITY_REGISTRY = "0x8004A818BFB912233c491871b3d84c89A494BD9e";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function nonempty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

/**
 * The entity's publicId, taken off `metadataURI` the same way the ENS name is: the last path
 * segment of an https URI. Strict on UUID shape so a `file://` legacy URI, or a trailing junk
 * segment, never becomes a `/metadata/` fetch.
 */
export function publicIdFromMetadataUri(uri: string | null | undefined): string | null {
  if (!uri || !/^https?:\/\//i.test(uri)) return null;
  const label = uri.split("/").filter(Boolean).pop();
  if (!label || !UUID.test(label)) return null;
  return label;
}

export function isHederaRegistry(agentRegistry: string | undefined): boolean {
  return Boolean(agentRegistry?.startsWith(`${HEDERA_CAIP2}:`));
}

export function hederaRegistrationOf(
  registrations: AgentRegistration[] | undefined,
): AgentRegistration | undefined {
  return registrations?.find((row) => isHederaRegistry(row.agentRegistry));
}

/** What the identity card and the transparency row may render. Every field is independently optional. */
export type HederaIdentityView = {
  uaid?: string;
  hederaAgentId?: string;
  registryAddress?: string;
  accountId?: string;
  profileUrl?: string;
  verifyUrl?: string;
  registerTx?: string;
  attestor?: string;
};

export type HederaIdentityChip = {
  label: string;
  title: string;
  href: string;
};

function registryAddressOf(agentRegistry: string | undefined): string | undefined {
  if (!agentRegistry) return undefined;
  const address = agentRegistry.slice(agentRegistry.lastIndexOf(":") + 1);
  return /^0x[0-9a-fA-F]{40}$/.test(address) ? address : undefined;
}

function hederaBlockOf(block: HederaMetadataBlock | undefined): HederaMetadataBlock | undefined {
  if (!block) return undefined;
  const accountId = nonempty(block.accountId);
  const verifyUrl = nonempty(block.verifyUrl);
  const profileUrl = nonempty(block.profileUrl);
  const registerTx = nonempty(block.registerTx);
  const attestor = nonempty(block.attestor);
  if (!accountId && !verifyUrl && !profileUrl && !registerTx && !attestor) return undefined;
  return { accountId, verifyUrl, profileUrl, registerTx, attestor };
}

/**
 * Pick the Hedera facts off a metadata document. `null` means render nothing: the entity has no
 * Hedera identity linked, or the document was missing. Each present field is shown on its own;
 * absence of one never hides another.
 */
export function hederaIdentityFromMetadata(
  meta: PublicMetadata | null | undefined,
): HederaIdentityView | null {
  if (!meta) return null;
  const uaid = nonempty(meta.uaid);
  const registration = hederaRegistrationOf(meta.registrations);
  const hederaAgentId = nonempty(registration?.agentId);
  const registryAddress = registryAddressOf(registration?.agentRegistry);
  const block = hederaBlockOf(meta.hedera);
  if (!uaid && !hederaAgentId && !block) return null;
  return {
    uaid,
    hederaAgentId,
    registryAddress,
    accountId: block?.accountId,
    profileUrl: block?.profileUrl,
    verifyUrl: block?.verifyUrl,
    registerTx: block?.registerTx,
    attestor: block?.attestor,
  };
}

/**
 * The chip beside AgentBook. Only when a Hedera ERC-8004 registration exists: that is the line
 * that resolves the agent's Hedera identity. Prefer the HashScan transaction; fall back to the
 * registry contract. No registration → no chip, even if a UAID or float account is present.
 */
export function hederaIdentityChip(view: HederaIdentityView | null | undefined): HederaIdentityChip | null {
  if (!view?.hederaAgentId) return null;
  const href = view.registerTx
    ? hashscanTxUrl(view.registerTx)
    : view.registryAddress
      ? hashscanContractUrl(view.registryAddress)
      : null;
  if (!href) return null;
  return {
    label: "Hedera identity ↗",
    title: `Registered on Hedera testnet as ERC-8004 agent ${view.hederaAgentId}.`,
    href,
  };
}

/**
 * Extra verify links for the public transparency row, built from the row ITSELF.
 *
 * Pure, and takes no dependency on `/metadata/:publicId`: GET /transparency publishes these facts
 * per row, so the page renders them with no request of its own. Never includes the paid `/verify`
 * url, which the backend does not publish here either.
 */
export function hederaTransparencyLinks(
  hedera: TransparencyHedera | null | undefined,
): { label: string; href: string }[] {
  if (!hedera) return [];
  const links: { label: string; href: string }[] = [];
  if (hedera.profileUrl) links.push({ label: "Profile", href: hedera.profileUrl });
  if (hedera.registerTx) {
    links.push({ label: "Hedera register", href: hashscanTxUrl(hedera.registerTx) });
  }
  return links;
}

/** Compact UAID for a facts row. The full string belongs on `title`, never as the visible value. */
export function shortUaid(uaid: string): string {
  const semi = uaid.indexOf(";");
  const aid = semi >= 0 ? uaid.slice(0, semi) : uaid;
  if (aid.length <= 24) return aid;
  return `${aid.slice(0, 18)}…`;
}
