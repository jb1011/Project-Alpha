"use client";

import { useState, type ReactNode } from "react";
import Link from "next/link";
import { useQueryClient } from "@tanstack/react-query";
import { AgentTabs } from "@/components/agents/AgentTabs";
import { usePublicClient, useWriteContract } from "wagmi";
import { agentBookChipState, vouchButtonVisible } from "@/lib/agentbook/chipState";
import {
  legalBodyChipState,
  type LegalBodyChipKind,
  type LegalBodyChipState,
} from "@/lib/legalBody/chipState";
import { useAgentDashboardQueries, usePublicConfigQuery } from "@/lib/api/hooks";
import { apiKeys } from "@/lib/api/keys";
import type { AgentRun, EntityView } from "@/lib/api/types";
import { ENS_EXPLORER_URL, ENS_PARENT_NAME } from "@/lib/api/config";
import { addressUrl, arcTestnet, txUrl } from "@/lib/chain";
import { hashscanAccountUrl, hashscanTxUrl } from "@/lib/hedera/hashscan";
import {
  hederaIdentityChip,
  hederaIdentityFromMetadata,
  hederaNetworkLabel,
  httpsUrl,
  shortUaid,
} from "@/lib/hedera/identity";
import { shortenErr } from "@/lib/errors";
import { oaAnchorLabel, pendingAnchorLabel } from "@/lib/oaAnchor";
import { treasuryAbi } from "@/lib/treasuryAbi";
import { useAuth } from "@/components/onboarding/AuthProvider";
import { JobsReputationCard } from "@/components/agents/JobsReputationCard";
import { ConnectAgentPanel } from "@/components/agents/ConnectAgentPanel";
import { VouchDialog } from "@/components/agents/VouchDialog";
import { NO_POCKET_COPY } from "@/lib/agentbook/failure";
import { FormationCard } from "@/components/agents/FormationCard";
import { AmberPill, Card, cx, ExternalIcon, ShieldIcon } from "@/components/onboarding/primitives";
import { AgentConfig, formatUsdc, shortAddress } from "@/components/onboarding/types";

/** One class for every AgentBook state. The chip used to turn emerald with a filled dot when the
 *  registry answered yes — a registry entry is a fact to link to, not a badge (design v3 D9). */
const AGENTBOOK_CHIP_CLASS =
  "inline-flex items-center gap-1.5 rounded-full border hairline-strong bg-paper-3/60 px-3 py-1.5 text-[11.5px] text-muted-2 transition-colors hover:text-ink";

const CHIP_SHAPE =
  "inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[11.5px] transition-colors";

/**
 * The Legal body chip, per state (design 2026-09-10).
 *
 * It MAY be positive where the AgentBook chip may not, and the difference is what each one is a
 * statement about. AgentBook's is a claim about a person, so it stays neutral whatever the answer
 * (D9). This one is two on-chain reads — a LegalManager status and a treasury pause flag — and
 * an active standing is exactly what they say, so `active` wears the same accent the rest of the
 * card uses for a live on-chain fact. `inactive` takes the amber the paused pill takes, because
 * it is usually the same pause seen from the other side, and `unknown` takes AgentBook's neutral:
 * a read that failed looks like the other things we could not check.
 */
const LEGAL_BODY_CHIP_CLASS: Record<LegalBodyChipKind, string> = {
  active:
    "border-accent/30 bg-accent/[0.07] text-accent-soft hover:bg-accent/[0.14] hover:text-ink",
  inactive: "border-[#febc2e]/40 bg-[#febc2e]/10 text-[#f3cd72] hover:text-ink",
  unknown: "hairline-strong bg-paper-3/60 text-muted-2 hover:text-ink",
};

export function AgentDashboard({
  entityId,
  config,
  onRestart,
}: {
  entityId: string;
  config?: AgentConfig;
  onRestart?: () => void;
}) {
  const { session } = useAuth();
  const queryClient = useQueryClient();
  const publicClient = usePublicClient();
  const { writeContractAsync } = useWriteContract();

  const {
    entity: entityQuery,
    treasury: treasuryQuery,
    runs: runsQuery,
    agentBook: agentBookQuery,
    legalBody: legalBodyQuery,
    metadata: metadataQuery,
  } = useAgentDashboardQueries(entityId);

  const entity = entityQuery.data ?? null;
  const treasury = treasuryQuery.data ?? null;
  const runs = runsQuery.data ?? [];
  const agentBookChip = agentBookChipState(agentBookQuery.data);
  const hedera = hederaIdentityFromMetadata(metadataQuery.data);
  const hederaChip = hederaIdentityChip(hedera);
  /** " (testnet)" / " (mainnet)", or nothing at all where the registration named no chain we
   *  know: a label may not name a network the links could not be built on. */
  const hederaNet = hedera?.network ? ` (${hedera.network})` : "";
  /** The registration transaction on HashScan, on the registration's OWN network. */
  const hederaRegisterHref = hashscanTxUrl(hedera?.network, hedera?.registerTx);
  const agentBookView = agentBookQuery.data ?? null;
  /** The address both questions are about: the pocket that signs AgentKit challenges and pays
   *  x402 invoices. It is what AgentBook binds and what a seller looks up. */
  const pocketAddress = agentBookView?.address ?? null;
  /**
   * The SECOND chip (design 2026-09-10): Novi's own registry, read from the chain, beside
   * AgentBook's answer about a human. A lookup that could not be read is its own variant, not a
   * fabricated `standing` — the helper decides that both wear "Could not check".
   */
  const legalBodyChip = legalBodyChipState(
    legalBodyQuery.error ? { unreadable: true } : legalBodyQuery.data,
  );
  const loadError =
    entityQuery.error instanceof Error
      ? entityQuery.error.message
      : entityQuery.error
        ? "Failed to load agent."
        : null;

  const [pausing, setPausing] = useState(false);
  const [pauseError, setPauseError] = useState<string | null>(null);

  /**
   * The vouch affordance (design v3 §3, §5). Shown DISABLED with the reason rather than hidden:
   * an owner who cannot vouch is owed the reason, and a button that appears and disappears with a
   * poll is worse than one that says why it is off. `disputed` deliberately re-enables it — a
   * guardian may answer a replacement once; the backend's lifetime cap is what stops the loop.
   *
   * The ONE exception is a vouch that already exists, and it is not a disabled state: the button
   * is not rendered at all (`vouchButtonVisible`). There is nothing left to offer — AgentBook has
   * no second vouch to make and no removal function — so the chip is the whole answer.
   */
  const publicConfig = usePublicConfigQuery();
  const [vouchOpen, setVouchOpen] = useState(false);
  const canVouch = publicConfig.data?.agentBookRegistrationAvailable === true;
  // A `pending` row does NOT disable this. It is a session waiting for World App, and
  // `POST /entities/:id/agentbook/session` (back/backend/src/api/routes/agentBook.ts) does not
  // refuse while one exists — it opens another, bounded by the lifetime and per-hour caps. So the
  // only honest states here are the ones the chip already distinguishes: `submitting` is a
  // broadcast transaction, `vouched` an entry in the registry (final review FR-B).
  const vouchDisabledReason = publicConfig.isPending
    ? "Checking whether vouching is enabled here"
    : !canVouch
      ? "Vouching is not enabled on this deployment"
      : !agentBookView
        ? "Checking this agent's AgentBook standing"
        : agentBookView.reason === "no-pocket-yet"
          ? NO_POCKET_COPY
          : agentBookChip?.kind === "submitting"
            ? "A vouch for this address is already in flight"
            : null;

  const treasuryAddr = entity?.treasury ?? null;

  async function refreshDashboard() {
    // The legal-body lookup FIRST, and outside the token check: it is the public route, keyed by
    // address rather than by session, and the one answer here that a guardian's own pause changed
    // a moment ago — standing is `legalStatus === 0 && !treasuryPaused`. (The backend memoises a
    // definitive answer for 15 s, so an unpause can take that long to show; the alternative is
    // asking again every few seconds for an answer that changes twice a year.)
    if (pocketAddress) {
      await queryClient.invalidateQueries({ queryKey: apiKeys.legalBody(pocketAddress) });
    }
    const token = session?.token;
    if (!token) return;
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: apiKeys.entity(token, entityId) }),
      queryClient.invalidateQueries({ queryKey: apiKeys.entityTreasury(token, entityId) }),
      queryClient.invalidateQueries({ queryKey: apiKeys.entityRuns(token, entityId) }),
      // The chip is on this card too, and the dialog's poll dies with the dialog: without this,
      // Refresh is the one control that cannot refresh the one answer that changes on its own.
      queryClient.invalidateQueries({ queryKey: apiKeys.entityAgentBook(token, entityId) }),
    ]);
  }

  const paused = treasury?.paused ?? false;
  const balanceUsdc = treasury ? Number(treasury.usdcBalance) / 1e6 : null;
  const capUsdc = treasury ? Number(treasury.cap) / 1e6 : Number(config?.dailyCap) || 0;
  const spentUsdc = treasury
    ? Math.max(0, (Number(treasury.cap) - Number(treasury.available)) / 1e6)
    : 0;
  const perTxUsdc = entity?.perTxCap
    ? Number(entity.perTxCap) / 1e6
    : config?.perTxCap
      ? Number(config.perTxCap)
      : null;
  const displayName = entity?.name?.trim() || config?.name?.trim() || "Your agent";
  const periodHours = treasury ? Math.round(Number(treasury.period) / 3600) : null;
  const ceilingUsdc = treasury?.standing?.ceiling ? Number(treasury.standing.ceiling) / 1e6 : null;
  const standingTotalUsdc =
    treasury?.standing?.total != null ? Number(treasury.standing.total) / 1e6 : null;
  const legalActive = treasury?.legalActive;

  const onTogglePause = async () => {
    if (!treasuryAddr) return;
    setPauseError(null);
    setPausing(true);
    try {
      const hash = await writeContractAsync({
        address: treasuryAddr as `0x${string}`,
        abi: treasuryAbi,
        functionName: paused ? "unpause" : "pause",
        chainId: arcTestnet.id,
      });
      if (publicClient) await publicClient.waitForTransactionReceipt({ hash });
      await refreshDashboard();
    } catch (e) {
      setPauseError(
        e instanceof Error
          ? shortenErr(e.message)
          : "Transaction failed — is this the guardian wallet?",
      );
    } finally {
      setPausing(false);
    }
  };

  const settingsHref = `/agents/${encodeURIComponent(entityId)}/settings`;

  if (loadError && !entity) {
    return (
      <div className="py-12 text-center text-[13px] text-[#ff8a84]">{loadError}</div>
    );
  }

  return (
    <div className="anim-line flex flex-col gap-4" style={{ animationDuration: "0.45s" }}>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 text-[11px] uppercase tracking-[0.2em] text-muted-2">
            <span className="font-mono text-muted">Agent dashboard</span>
            <span className="inline-block h-px w-6 bg-line-strong" />
          </div>
          <h1 className="mt-3 flex flex-wrap items-center gap-3 text-[30px] font-medium leading-tight tracking-[-0.02em] text-ink sm:text-[36px]">
            {displayName}
            <span
              className={cx(
                "inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-[11.5px] font-normal tracking-normal",
                paused
                  ? "border-[#febc2e]/40 bg-[#febc2e]/10 text-[#f3cd72]"
                  : "border-accent/30 bg-accent/10 text-accent-soft",
              )}
            >
              <span
                className={cx(
                  "h-1.5 w-1.5 rounded-full",
                  paused ? "bg-[#febc2e]" : "bg-accent animate-pulse",
                )}
              />
              {paused ? "Paused" : "Operational"}
            </span>
            {entity?.walletProvider && (
              <span
                className="inline-flex items-center rounded-full border hairline-strong bg-paper-2/60 px-3 py-1 text-[11.5px] font-normal tracking-normal text-muted"
                title={
                  entity.walletProvider === "circle"
                    ? "Operator keys are Novi-managed (Circle MPC smart account). Your guardian wallet keeps every on-chain override."
                    : "Operator keys live in a vault rooted under your guardian passkey."
                }
              >
                {entity.walletProvider === "circle" ? "Novi-managed" : "Passkey-rooted"}
              </span>
            )}
          </h1>
          <p className="mt-2 max-w-xl text-[14px] text-muted">
            Monitor activity and treasury. Identity, rules, and connection details are below. Edit
            rules in{" "}
            <Link href={settingsHref} className="text-accent-soft underline-offset-2 hover:underline">
              Settings
            </Link>
            .
          </p>
        </div>
        <div className="flex flex-col items-stretch gap-3 sm:items-end">
          <div className="flex items-center gap-4">
            <AgentTabs entityId={entityId} active="dashboard" />
            {onRestart && (
              <button
                onClick={onRestart}
                className="text-[12.5px] text-muted-2 underline-offset-2 hover:text-ink hover:underline"
              >
                Reset onboarding
              </button>
            )}
          </div>
          <button
            type="button"
            onClick={() => void onTogglePause()}
            disabled={pausing || !treasuryAddr}
            className="flex items-center justify-between gap-4 rounded-xl border hairline-strong bg-paper px-4 py-3 text-left transition-colors hover:bg-paper-2 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <div>
              <div className="flex items-center gap-2 text-[13px] font-medium text-ink">
                <ShieldIcon className="h-3.5 w-3.5 text-muted-2" />
                {pausing ? "Confirm in wallet…" : paused ? "Resume agent" : "Pause agent"}
              </div>
              <div className="mt-0.5 text-[11px] text-muted-2">
                {paused ? "Re-enable autonomous spending" : "Freeze all autonomous spending"}
              </div>
            </div>
            <span
              className={cx(
                "relative h-5 w-9 shrink-0 rounded-full transition-colors",
                paused ? "bg-[#febc2e]/40" : "bg-accent/50",
              )}
            >
              <span
                className={cx(
                  "absolute top-0.5 h-4 w-4 rounded-full bg-ink transition-all",
                  paused ? "left-0.5" : "left-[18px]",
                )}
              />
            </span>
          </button>
          <p className="max-w-[280px] text-[11px] leading-[1.45] text-muted-2 sm:text-right">
            Your human safety brake — freeze all autonomous spending on-chain, signed by your wallet.
          </p>
          {pauseError && (
            <p className="max-w-[280px] text-[11.5px] leading-[1.4] text-[#ff8a84] sm:text-right">
              {pauseError}
            </p>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Card className="border-accent/20 bg-accent/[0.04] p-4">
          <BoxTitle>Treasury</BoxTitle>
          <div className="mt-2 flex items-baseline gap-1.5">
            <span className="text-[26px] font-medium tabular-nums text-ink">
              {balanceUsdc === null ? "—" : formatUsdc(balanceUsdc)}
            </span>
            <span className="text-[12px] text-muted-2">USDC</span>
          </div>
        </Card>
        <Card className="p-4">
          <BoxTitle>Spent this period</BoxTitle>
          <div className="mt-2 flex items-baseline gap-1.5">
            <span className="text-[26px] font-medium tabular-nums text-ink">
              {treasury ? formatUsdc(spentUsdc) : "—"}
            </span>
            <span className="text-[12px] text-muted-2">/ {formatUsdc(capUsdc)}</span>
          </div>
          <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-paper">
            <div
              className="h-full rounded-full bg-accent"
              style={{ width: `${capUsdc ? Math.min(100, (spentUsdc / capUsdc) * 100) : 0}%` }}
            />
          </div>
        </Card>
        <Card className="p-4">
          <BoxTitle>Per transaction cap</BoxTitle>
          <div className="mt-2 flex items-baseline gap-1.5">
            <span className="text-[26px] font-medium tabular-nums text-ink">
              {perTxUsdc === null ? "—" : formatUsdc(perTxUsdc)}
            </span>
            <span className="text-[12px] text-muted-2">USDC</span>
          </div>
        </Card>
      </div>

      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-2">
        <div className="flex flex-col gap-4">
          <JobsReputationCard entityId={entityId} />
          {entity && (
            <>
          <VouchDialog
            entityId={entityId}
            agentId={entity.agentId ?? ""}
            open={vouchOpen}
            onClose={() => setVouchOpen(false)}
          />
<IdentityGroup title="This agent">
            <dl className="grid grid-cols-1 gap-3 text-[12px] sm:grid-cols-2">
              {entity.agentId && <OnChainRow label="Agent ID" value={`#${entity.agentId}`} />}
              {entity.treasury && (
                <OnChainRow
                  label="Treasury"
                  value={shortAddress(entity.treasury)}
                  href={addressUrl(entity.treasury)}
                />
              )}
              {entity.operator && (
                <OnChainRow label="Operator" value={shortAddress(entity.operator)} />
              )}
              {entity.guardian && (
                <OnChainRow label="Guardian" value={shortAddress(entity.guardian)} />
              )}
            </dl>
            {ensName(entity) && (
              <a
                href={`${ENS_EXPLORER_URL}/${ensName(entity)}`}
                target="_blank"
                rel="noreferrer"
                title="Resolve this agent in any ENS client — addr, legal status, registration"
                className="group mt-3 inline-flex max-w-full items-center gap-2 rounded-full border border-accent/30 bg-accent/[0.07] px-3 py-1.5 font-mono text-[12px] text-accent-soft transition-colors hover:bg-accent/[0.14] hover:text-ink"
              >
                <EnsGlobe className="h-3.5 w-3.5 shrink-0 opacity-80" />
                <span className="truncate">{ensName(entity)}</span>
                <span aria-hidden className="text-[10px] opacity-70">↗</span>
              </a>
            )}
          </IdentityGroup>
          <IdentityGroup id="standing" title="Standing">
            <div className="flex flex-wrap items-center gap-2">
              {agentBookChip &&
                (agentBookChip.href ? (
                  <a
                    href={agentBookChip.href}
                    target="_blank"
                    rel="noreferrer"
                    title={agentBookChip.title}
                    className={AGENTBOOK_CHIP_CLASS}
                  >
                    {agentBookChip.label}
                  </a>
                ) : (
                  <span title={agentBookChip.title} className={AGENTBOOK_CHIP_CLASS}>
                    {agentBookChip.label}
                  </span>
                ))}
              {legalBodyChip && <LegalBodyChip state={legalBodyChip} />}
              {vouchButtonVisible(agentBookChip) && (
                <button
                  type="button"
                  disabled={vouchDisabledReason !== null}
                  title={vouchDisabledReason ?? "Vouch for this agent in AgentBook"}
                  onClick={() => setVouchOpen(true)}
                  className="rounded-full border hairline-strong bg-paper-3/60 px-3 py-1.5 text-[11.5px] text-ink transition-colors hover:bg-paper-2 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {agentBookChip?.kind === "disputed"
                    ? "Vouch again in AgentBook"
                    : "Vouch in AgentBook"}
                </button>
              )}
            </div>
            {agentBookChip?.note && (
              <p className="mt-3 max-w-[70ch] text-[11.5px] leading-[1.55] text-muted-2">
                {agentBookChip.note}
              </p>
            )}
          </IdentityGroup>
            </>
          )}
          <div id="activity" className="scroll-mt-24">
            <Card className="overflow-hidden">
              <div className="flex items-baseline justify-between gap-3 border-b hairline px-4 py-3">
                <BoxTitle>Activity</BoxTitle>
                <span className="shrink-0 text-[12px] text-muted-2">Agent jobs · x402</span>
              </div>
              {runs.length === 0 ? (
                <div className="px-4 py-8 text-center text-[12.5px] text-muted-2">
                  No agent payments yet — this agent hasn&apos;t transacted.
                </div>
              ) : (
                <ul>
                  {runs.map((run) => (
                    <RunRow key={run.id} run={run} />
                  ))}
                </ul>
              )}
            </Card>
          </div>
        </div>

        <div className="flex flex-col gap-4">
      <div id="rules" className="scroll-mt-24">
      <Card className="p-4">
        <BoxTitle
          aside={
            <Link href={settingsHref} className="text-[13px] text-muted-2 hover:text-accent-soft">
              Edit →
            </Link>
          }
        >
          Active rules
        </BoxTitle>
        <dl className="mt-3 flex flex-col gap-2 text-[12.5px]">
          <RuleRow k="Period cap" v={`${formatUsdc(capUsdc)} USDC`} />
          <RuleRow k="Period" v={periodHours ? `${periodHours}h rolling` : "—"} />
          <RuleRow k="Guardian pause" v={paused ? "On" : "Off"} />
          <RuleRow
            k="Legal status"
            v={
              legalActive === undefined || legalActive === null
                ? "—"
                : legalActive
                  ? "Active"
                  : "Suspended"
            }
          />
          <RuleRow
            k="Allowlist (direct spend)"
            v={
              config?.allowlist.length
                ? `${config.allowlist.length} allowlisted`
                : "Any (within caps)"
            }
          />
          <RuleRow
            k="Per-tx cap"
            v={perTxUsdc === null ? "Not set" : `${formatUsdc(perTxUsdc)} USDC`}
          />
          <RuleRow
            k="Standing float total"
            v={standingTotalUsdc === null ? "—" : `${formatUsdc(standingTotalUsdc)} USDC`}
          />
          <RuleRow
            k="Standing float ceiling"
            v={ceilingUsdc === null ? "—" : `≤ ${formatUsdc(ceilingUsdc)} USDC`}
          />
          <RuleRow
            k="Buyer trust policy"
            v={
              entity?.trustPolicy
                ? entity.trustPolicy === "verified-legal-bodies-only"
                  ? "Strictest — legal bodies only (own setting)"
                  : entity.trustPolicy === "verified-sellers-only"
                    ? "Strict — sellers vouched for in AgentBook (own setting)"
                    : "Open (own setting)"
                : "Platform default"
            }
          />
        </dl>
        <p className="mt-4 border-t hairline pt-3 text-[11.5px] leading-[1.5] text-muted-2">
          On-chain rules are the hard stop, and the payment service rechecks them before each x402
          payment.
        </p>
        <details className="mt-3">
          <summary className="cursor-pointer text-[11.5px] text-muted-2 hover:text-ink">
            How these rules are enforced
          </summary>
          <div className="mt-3 text-[11px] uppercase tracking-[0.18em] text-muted-2">
            On-chain (enforced by the treasury contract)
          </div>
          <p className="mt-1.5 text-[11.5px] leading-[1.5] text-muted-2">
            Period cap, period, guardian pause, legal status, and the direct-spend allowlist.
          </p>
          <div className="mt-4 text-[11px] uppercase tracking-[0.18em] text-muted-2">
            Software-enforced on x402 payments
          </div>
          <p className="mt-1.5 text-[11px] leading-[1.5] text-muted-2">
            The backend checks each payment against fresh on-chain state — not guaranteed if the
            backend is compromised.
          </p>
          <dl className="mt-3 flex flex-col gap-3 text-[12.5px]">
            <RuleRow k="Allowlist / threshold" v="Re-asserted before every payment" />
            <RuleRow k="Pause + legal status" v="Re-checked before every payment" />
          </dl>
          <p className="mt-4 text-[11px] leading-[1.5] text-muted-2">
            x402 payments enforce the same allowlist, per-tx and cap rules as direct on-chain
            spends — in software, against live on-chain reads. The float ceiling keeps how much
            sits beyond the guardian&apos;s reach small in normal operation; the on-chain period
            cap is the hard backstop.
          </p>
        </details>
      </Card>
      </div>


          {entity?.formation && (
            <div id="formation" className="scroll-mt-24">
              <FormationCard formation={entity.formation} />
            </div>
          )}

          {entity && (
            <>


          {(hederaChip ||
            hedera?.uaid ||
            hedera?.hederaAgentId ||
            hedera?.accountId ||
            hedera?.profileUrl ||
            hedera?.verifyUrl ||
            hedera?.attestor) && (
            <IdentityGroup title="Hedera">
              {hederaChip && (
                <div className="mb-3">
                  {hederaChip.href ? (
                    <a
                      href={hederaChip.href}
                      target="_blank"
                      rel="noreferrer"
                      title={hederaChip.title}
                      className={AGENTBOOK_CHIP_CLASS}
                    >
                      {hederaChip.label}
                    </a>
                  ) : (
                    <span title={hederaChip.title} className={AGENTBOOK_CHIP_CLASS}>
                      {hederaChip.label}
                    </span>
                  )}
                </div>
              )}
              <dl className="grid grid-cols-1 gap-3 text-[12px] sm:grid-cols-2">
                {hedera?.uaid && (
                  <OnChainRow label="UAID" value={shortUaid(hedera.uaid)} title={hedera.uaid} />
                )}
                {hedera?.hederaAgentId && (
                  <OnChainRow
                    label={`Hedera agent${hederaNet}`}
                    value={`#${hedera.hederaAgentId}`}
                    title={`Registered on ${hederaNetworkLabel(hedera.network)} as ERC-8004 agent ${hedera.hederaAgentId}.`}
                    href={hederaRegisterHref}
                  />
                )}
                {hedera?.accountId && (
                  <OnChainRow
                    label={`Hedera account${hederaNet}`}
                    value={hedera.accountId}
                    title={`The ${hederaNetworkLabel(hedera.network)} account this agent's key is linked to.`}
                    href={hashscanAccountUrl(hedera.network, hedera.accountId)}
                  />
                )}
                {hedera?.profileUrl && (
                  <OnChainRow
                    label={`Hedera profile${hederaNet}`}
                    value="HCS-11 profile"
                    title={`The HCS-11 profile document a ${hederaNetworkLabel(hedera.network)} reader resolves this company by.`}
                    href={httpsUrl(hedera.profileUrl)}
                  />
                )}
                {hedera?.verifyUrl && (
                  <OnChainRow
                    label="Paid standing check"
                    value="x402 /verify"
                    title={hedera.verifyUrl}
                  />
                )}
                {hedera?.attestor && (
                  <OnChainRow
                    label="Attestor"
                    value={shortAddress(hedera.attestor)}
                    title="Address of the key that signs this company's paid standing attestations (EIP-712). Not a Hedera account."
                  />
                )}
              </dl>
            </IdentityGroup>

          )}

          {(entity.oaHash ||
            entity.createTxHash ||
            entity.bindTxHash ||
            entity.fundTxHash ||
            hederaRegisterHref) && (
            <IdentityGroup title="Records">
              {entity.oaHash && (
                <dl className="grid grid-cols-1 gap-3 text-[12px] sm:grid-cols-2">
                  <OnChainRow
                    label={oaAnchorLabel(entity)}
                    value={`${entity.oaHash.slice(0, 14)}…`}
                    chip={pendingAnchorChip(entity)}
                  />
                </dl>
              )}
              <div className="mt-4 flex flex-wrap gap-3">
                {entity.createTxHash && <TxLink hash={entity.createTxHash} label="Create tx" />}
                {entity.bindTxHash && <TxLink hash={entity.bindTxHash} label="Bind tx" />}
                {entity.fundTxHash && <TxLink hash={entity.fundTxHash} label="Fund tx" />}
                {hederaRegisterHref && (
                  <a
                    href={hederaRegisterHref}
                    target="_blank"
                    rel="noreferrer"
                    title={`The registration transaction on ${hederaNetworkLabel(hedera?.network)}, on HashScan.`}
                    className="inline-flex items-center gap-1.5 rounded-full border hairline-strong px-3 py-1.5 text-[11.5px] text-muted transition-colors hover:text-accent-soft"
                  >
                    Hedera register
                    <ExternalIcon className="h-3 w-3" />
                  </a>
                )}
              </div>
            </IdentityGroup>
          )}
            </>
          )}
          {entity && (
            <div id="connect" className="scroll-mt-24">
              <ConnectAgentPanel entity={entity} />
            </div>
          )}
        </div>
      </div>

    </div>
  );
}

function BoxTitle({ children, aside }: { children: ReactNode; aside?: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <h2 className="text-[20px] font-medium leading-tight tracking-[-0.02em] text-ink">{children}</h2>
      {aside}
    </div>
  );
}

function IdentityGroup({
  id,
  title,
  className,
  children,
}: {
  id?: string;
  title: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Card className={cx("p-4", className)}>
      <section id={id} className="scroll-mt-24">
        <BoxTitle>{title}</BoxTitle>
        <div className="mt-3">{children}</div>
      </section>
    </Card>
  );
}

/**
 * The Legal body chip. Its WORDING and its link live in `lib/legalBody/chipState`, where they are
 * tested; this is the rendering and nothing else.
 *
 * The ↗ is a separate glyph rather than part of the label so the label stays exactly the string
 * the ceiling fixed, and so a chip with no link (the lookup could not be read) does not advertise
 * one.
 */
function LegalBodyChip({ state }: { state: LegalBodyChipState }) {
  const className = cx(CHIP_SHAPE, LEGAL_BODY_CHIP_CLASS[state.kind]);
  if (!state.href) {
    return (
      <span title={state.title} className={className}>
        {state.label}
      </span>
    );
  }
  return (
    <a
      href={state.href}
      target="_blank"
      rel="noreferrer"
      title={state.title}
      className={className}
    >
      {state.label}
      <span aria-hidden className="text-[10px] opacity-70">
        ↗
      </span>
    </a>
  );
}

function RunRow({ run }: { run: AgentRun }) {
  const [open, setOpen] = useState(false);
  const profit = Number(run.pnl) >= 0;
  return (
    <li className="border-b hairline last:border-0">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between gap-3 px-5 py-3.5 text-left hover:bg-paper-2/40"
      >
        <div className="min-w-0">
          <div className="truncate text-[13px] text-ink">{run.query}</div>
          <div className="mt-0.5 text-[11.5px] text-muted-2">
            spent {formatUsdc(Number(run.cost) / 1e6)} USDC · earned{" "}
            {formatUsdc(Number(run.revenue) / 1e6)} USDC
          </div>
        </div>
        <span
          className={cx(
            "shrink-0 font-mono text-[13px] tabular-nums",
            profit ? "text-accent-soft" : "text-[#ff8a84]",
          )}
        >
          {profit ? "+" : "−"}
          {formatUsdc(Math.abs(Number(run.pnl)) / 1e6)}
        </span>
      </button>
      {open && (
        <div className="border-t hairline bg-paper/40 px-5 py-3">
          {(run.payments ?? []).map((p, i) => (
            <div
              key={p.transferId ?? i}
              className="flex items-center justify-between gap-3 py-1.5 text-[11.5px]"
            >
              <span className="text-muted">
                {p.direction === "buy" ? "Paid" : "Received"}{" "}
                {formatUsdc(Number(p.amount) / 1e6)} USDC · {shortAddress(p.counterparty)}
              </span>
              <span className="font-mono text-muted-2">
                {p.transferId ? `settle ${p.transferId.slice(0, 8)}…` : p.status}
              </span>
            </div>
          ))}
        </div>
      )}
    </li>
  );
}

/** `<publicId>.novicorpus.eth` — the wildcard gateway resolves any entity by its publicId label.
 *  The view doesn't carry publicId, but the public metadataURI ends with it. file:// legacy
 *  agents predate the ENS integration and simply don't get a name shown. */
function ensName(entity: { metadataURI: string | null }): string | null {
  const uri = entity.metadataURI;
  if (!uri || !/^https?:\/\//.test(uri)) return null;
  const label = uri.split("/").filter(Boolean).pop();
  return label ? `${label.toLowerCase()}.${ENS_PARENT_NAME}` : null;
}

/** The chip beside the anchored hash. Its TEXT — including whether a version number can honestly
 *  be named at all — is decided in `lib/oaAnchor.ts`, where it is tested. */
function pendingAnchorChip(entity: Pick<EntityView, "oaAnchor">): ReactNode {
  const label = pendingAnchorLabel(entity);
  if (!label) return null;
  return (
    <AmberPill
      size="sm"
      className="font-normal"
      title="A new version of this entity's anchor is scheduled behind the guardian timelock. Review or veto it in Settings."
    >
      {label}
    </AmberPill>
  );
}

function EnsGlobe({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden>
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.4" />
      <ellipse cx="12" cy="12" rx="4.2" ry="9" stroke="currentColor" strokeWidth="1.2" />
      <path d="M3.6 9.5h16.8M3.6 14.5h16.8" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  );
}

function OnChainRow({
  label,
  value,
  href,
  title,
  chip,
}: {
  label: string;
  value: string;
  href?: string;
  title?: string;
  chip?: ReactNode;
}) {
  return (
    <div>
      <dt className="text-muted-2">{label}</dt>
      <dd className="mt-0.5 flex flex-wrap items-center gap-2 font-mono text-ink">
        {href ? (
          <a
            href={href}
            target="_blank"
            rel="noreferrer"
            title={title}
            className="hover:text-accent-soft"
          >
            {value}
          </a>
        ) : (
          <span title={title}>{value}</span>
        )}
        {chip}
      </dd>
    </div>
  );
}

function TxLink({ hash, label }: { hash: string; label: string }) {
  return (
    <a
      href={txUrl(hash)}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-1.5 rounded-full border hairline-strong px-3 py-1.5 text-[11.5px] text-muted transition-colors hover:text-accent-soft"
    >
      {label}
      <ExternalIcon className="h-3 w-3" />
    </a>
  );
}


function RuleRow({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex items-center justify-between">
      <dt className="text-muted-2">{k}</dt>
      <dd className="text-ink">{v}</dd>
    </div>
  );
}
