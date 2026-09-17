import type {
  AgentRegistration,
  HederaMetadataBlock,
  PublicMetadata,
  TransparencyHedera,
} from "@/lib/api/types";
import { type HederaNetwork, hashscanTxUrl, hederaNetworkOfChainId } from "@/lib/hedera/hashscan";

/** Hedera testnet's chain id: the one chain the backend registers companies on today (its
 *  `registrationsFor` publishes `eip155:296:<registry>`). A transparency row carries no CAIP
 *  string of its own, so its links resolve their network from here. */
export const HEDERA_TESTNET_CHAIN_ID = "296";

/** The network a transparency row's links live on. DERIVED from the chain id above rather than
 *  written out a second time, so there is one place to change when a row can be a mainnet one. */
const ROW_NETWORK = hederaNetworkOfChainId(HEDERA_TESTNET_CHAIN_ID);

/** ERC-8004 IdentityRegistry on Hedera testnet. Public, immutable, same address the backend publishes. */
export const HEDERA_IDENTITY_REGISTRY = "0x8004A818BFB912233c491871b3d84c89A494BD9e";

/** CAIP-10, case-insensitive on both halves: a registry may be published `EIP155:296:0xABC…` and
 *  it is the same registry. Anything that is not a complete `eip155:<chainId>:<address>` is not
 *  parsed at all, so a truncated string never becomes a link. */
const CAIP10 = /^eip155:(\d+):(0x[0-9a-fA-F]{40})$/i;

/** The chain id and registry address inside a CAIP-10 `agentRegistry`, or null. */
export function parseAgentRegistry(
  agentRegistry: string | null | undefined,
): { chainId: string; address: string } | null {
  const m = agentRegistry?.match(CAIP10);
  return m ? { chainId: m[1], address: m[2] } : null;
}

/**
 * A url the page may put in an `href`, or undefined.
 *
 * `https:` only, and by prefix rather than by parsing: the profile url arrives as a string in a
 * public document, and `javascript:`, `data:` or a protocol-relative `//host` is not a document
 * link at all. Plain http is refused too, since every url we publish is https.
 */
export function httpsUrl(value: string | null | undefined): string | undefined {
  return value && /^https:\/\//.test(value) ? value : undefined;
}

/** "Hedera testnet" / "Hedera mainnet", or plain "Hedera" where the chain is unknown: copy must
 *  not name a network that no link could be built for. */
export function hederaNetworkLabel(network: HederaNetwork | null | undefined): string {
  return network ? `Hedera ${network}` : "Hedera";
}

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

/** A registration is Hedera's when its CAIP-10 chain id is one of Hedera's, whichever it is:
 *  mainnet registrations are the same fact on a different chain, not a foreign one. */
export function isHederaRegistry(agentRegistry: string | undefined): boolean {
  const parsed = parseAgentRegistry(agentRegistry);
  return Boolean(parsed && hederaNetworkOfChainId(parsed.chainId));
}

export function hederaRegistrationOf(
  registrations: AgentRegistration[] | undefined,
): AgentRegistration | undefined {
  return registrations?.find((row) => isHederaRegistry(row.agentRegistry));
}

/** What the identity card may render. Every field is independently optional. */
export type HederaIdentityView = {
  /** The network the registration names, and so the only network any HashScan link here may be
   *  built on. Undefined where nothing told us: no registration, or a chain that is not Hedera's. */
  network?: HederaNetwork;
  uaid?: string;
  hederaAgentId?: string;
  accountId?: string;
  profileUrl?: string;
  verifyUrl?: string;
  registerTx?: string;
  attestor?: string;
};

export type HederaIdentityChip = {
  label: string;
  title: string;
  /** Absent when nothing can be linked. The chip still states the registration; it just does not
   *  offer a click that would not show it. */
  href?: string;
};

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
  const parsed = parseAgentRegistry(registration?.agentRegistry);
  const hederaAgentId = nonempty(registration?.agentId);
  // WHICH Hedera network this company is registered on, read off the registration itself. Every
  // HashScan link below is built on it, and on nothing else.
  const network = hederaNetworkOfChainId(parsed?.chainId) ?? undefined;
  const block = hederaBlockOf(meta.hedera);
  if (!uaid && !hederaAgentId && !block) return null;
  return {
    network,
    uaid,
    hederaAgentId,
    accountId: block?.accountId,
    profileUrl: block?.profileUrl,
    verifyUrl: block?.verifyUrl,
    registerTx: block?.registerTx,
    attestor: block?.attestor,
  };
}

/**
 * The chip beside AgentBook. Only when a Hedera ERC-8004 registration exists: that is the line
 * that resolves the agent's Hedera identity. No registration → no chip, even if a UAID or a
 * linked account is present.
 *
 * THE LINK IS THE REGISTRATION TRANSACTION OR NOTHING. It used to fall back to the registry
 * CONTRACT, a page every registered company shares, while the title said "Registered … as agent
 * N": a click showed the reader something that verified none of that. With no transaction
 * recorded the chip still states the registration, without an href and without the arrow that
 * promises one.
 */
export function hederaIdentityChip(
  view: HederaIdentityView | null | undefined,
): HederaIdentityChip | null {
  if (!view?.hederaAgentId) return null;
  const href = hashscanTxUrl(view.network, view.registerTx);
  return {
    label: href ? "Hedera identity ↗" : "Hedera identity",
    title: `Registered on ${hederaNetworkLabel(view.network)} as ERC-8004 agent ${view.hederaAgentId}.`,
    ...(href ? { href } : {}),
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
): { label: string; href: string; title: string }[] {
  if (!hedera) return [];
  // The SAME sentence the dashboard chip carries, so the two surfaces name the same chain in the
  // same words. A link labeled "Profile" beside three Arcscan links must say where it goes.
  const registered = `Registered on ${hederaNetworkLabel(ROW_NETWORK)} as ERC-8004 agent ${hedera.agentId}.`;
  const links: { label: string; href: string; title: string }[] = [];
  const profileHref = httpsUrl(hedera.profileUrl);
  if (profileHref)
    links.push({
      label: "Profile",
      href: profileHref,
      title: `HCS-11 profile document. ${registered}`,
    });
  const registerHref = hashscanTxUrl(ROW_NETWORK, hedera.registerTx);
  if (registerHref) links.push({ label: "Hedera register", href: registerHref, title: registered });
  return links;
}

/** Compact UAID for a facts row. The full string belongs on `title`, never as the visible value. */
export function shortUaid(uaid: string): string {
  const semi = uaid.indexOf(";");
  const aid = semi >= 0 ? uaid.slice(0, semi) : uaid;
  if (aid.length <= 24) return aid;
  return `${aid.slice(0, 18)}…`;
}
