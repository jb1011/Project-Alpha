"use client";

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getAbiItem, type Address, type Hex, type PublicClient } from "viem";
import { useAccount, usePublicClient, useWriteContract } from "wagmi";
import { collectAmendmentHashes, sameHash } from "@/lib/amendments";
import { apiKeys } from "@/lib/api/keys";
import type { EntityView } from "@/lib/api/types";
import { shortenErr } from "@/lib/errors";
import { formatDateTime } from "@/lib/format";
import { legalManagerAbi } from "@/lib/legalManagerAbi";
import { useAuth } from "@/components/onboarding/AuthProvider";
import { arcTestnet } from "@/lib/chain";
import {
  Button,
  Callout,
  Card,
  SectionTitle,
  Spinner,
  cx,
} from "@/components/onboarding/primitives";
import { shortAddress } from "@/components/onboarding/types";

/** One amendment hash, joined with what the chain says about it NOW. */
type Amendment = {
  hash: Hex;
  /** From `scheduledAt(hash)` — unix seconds, 0 when nothing is live for this hash. This is the
   *  authority, not the log's `executableAt`: a reschedule resets the clock and the mapping is
   *  what the contract will actually check. */
  scheduledAt: bigint;
  /** Sticky. Set by `cancelOperatingAgreementUpdate`, cleared only by `liftVeto`. */
  vetoed: boolean;
};

type ChainState = {
  amendments: Amendment[];
  /** The hash the contract currently carries — read here, not taken from the API. */
  anchored: Hex;
  /** True when the RPC refused a full-history log query and only a recent window was scanned. */
  partial: boolean;
};

// `0n` literals need an ES2020 target; this package compiles to ES2017, like the rest of it.
const ZERO = BigInt(0);

const SCHEDULED_EVENT = getAbiItem({ abi: legalManagerAbi, name: "AmendmentScheduled" });

/**
 * How far back to scan when an RPC refuses `fromBlock: 0`.
 *
 * A bounded window and NOT a safe one: an amendment timelock can be set as high as 365 days, and
 * no fixed block count covers that on a chain that finalises sub-second. This window discovers
 * recent hashes; it is not evidence that an older schedule does not exist, and the card says so
 * rather than presenting a truncated scan as a clean bill of health. The hash the platform reports
 * is read directly regardless of any window (see `collectAmendmentHashes`).
 */
const FALLBACK_LOOKBACK = BigInt(200_000);

/** Chain reads are cheap but not free, and a schedule cannot appear without a transaction. */
const CHAIN_STALE_TIME = 3 * 60_000;

/**
 * The guardian's pending-amendment card (design §8, audit H4).
 *
 * **Everything actionable here is read from the chain, over the user's own RPC.** The backend
 * cannot be the source of the hash a guardian vetoes: a compromised one would offer a harmless
 * hash, keep the malicious one scheduled, and the veto would land on nothing. So the card
 * enumerates `AmendmentScheduled` logs from the entity's own proxy, asks the contract which hashes
 * are still live (`scheduledAt != 0`) or parked (`vetoed`), and vetoes what IT found.
 *
 * The API's `oa_manifest_pending_hash` is used for exactly two things, both of them labels: which
 * VERSION a hash is, and whether the platform's record agrees with the chain. When it does not,
 * that is not a rendering detail — it is the alarm this card exists to raise, and it says so in as
 * many words. Sparingly, though: the anchored-hash alarm now confirms the disagreement against a
 * fresh entity read before it fires, because it used to go off for a second or two every time an
 * amendment executed normally and the platform had not yet re-read the chain. An alarm that cries
 * wolf during routine operation is an alarm a guardian learns to click past.
 *
 * The superseded case falls out of the same comparison: the backend marks a version superseded and
 * stops driving it, but the schedule it already broadcast stays executable on-chain forever. To
 * the chain that is simply a live amendment the platform is not talking about, which is precisely
 * the thing a guardian should be told to veto proactively.
 */
export function AmendmentVetoCard({ entity }: { entity: EntityView }) {
  const publicClient = usePublicClient();
  const { address } = useAccount();
  const { writeContractAsync } = useWriteContract();
  const queryClient = useQueryClient();
  const { session } = useAuth();

  const [txError, setTxError] = useState<string | null>(null);
  const [busyHash, setBusyHash] = useState<Hex | null>(null);

  const proxy = entity.proxy as Address | null;
  // Narrowed ONCE. Four fields were each re-asking `anchor?.scheme === "manifest"` in their own
  // ternary, which is four chances for one of them to drift to a different predicate.
  const anchor = entity.oaAnchor;
  const manifest = anchor?.scheme === "manifest" ? anchor : null;
  const apiPendingHash = manifest?.pendingHash ?? null;
  const apiPendingVersion = manifest?.pendingVersion ?? null;
  const apiExecutableAt = manifest?.amendmentExecutableAt ?? null;

  // A row the backend EXPLICITLY calls legacy never used the manifest scheme, so there is nothing
  // here to show and nothing to read — the docblock always said so, the code never did it. An
  // ABSENT anchor is not the same claim: that is a backend predating the field, and skipping the
  // read on it would let an old (or tampered) response switch the guardian's own view off.
  const legacy = anchor?.scheme === "legacy";

  const chainId = publicClient?.chain?.id;
  const queryKey = useMemo(
    () =>
      [
        "chain",
        "legalManagerAmendments",
        chainId ?? null,
        proxy?.toLowerCase() ?? null,
        apiPendingHash?.toLowerCase() ?? null,
      ] as const,
    [chainId, proxy, apiPendingHash],
  );

  const chainQuery = useQuery({
    queryKey,
    queryFn: () => readAmendments(publicClient as PublicClient, proxy as Address, apiPendingHash),
    enabled: !!publicClient && !!proxy && !legacy,
    staleTime: CHAIN_STALE_TIME,
    retry: false,
  });

  const rereadChain = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey });
  }, [queryClient, queryKey]);

  const token = session?.token;
  const refetchEntity = useCallback(async () => {
    if (!token) return;
    await queryClient.invalidateQueries({ queryKey: apiKeys.entity(token, entity.id) });
  }, [queryClient, token, entity.id]);

  const chain = chainQuery.data ?? null;
  const loadError =
    chainQuery.error instanceof Error
      ? shortenErr(chainQuery.error.message)
      : chainQuery.error
        ? "Could not read the chain."
        : null;

  const amendments = useMemo(() => chain?.amendments ?? [], [chain]);
  const live = amendments.filter((a) => a.scheduledAt !== ZERO);
  const parked = amendments.filter((a) => a.scheduledAt === ZERO && a.vetoed);

  /**
   * The platform's anchored hash against the contract's — confirmed before it becomes an alarm.
   *
   * These disagree for one alarming reason and one entirely ordinary one. The ordinary one is
   * propagation: an amendment executes on-chain and, for as long as it takes the backend to notice,
   * its record names the previous hash. Firing the red banner there taught guardians that the red
   * banner means "wait a moment", which is precisely what it must never mean. So a first
   * disagreement triggers one entity refetch and shows a muted "syncing"; only a disagreement that
   * survives that refetch is the real thing.
   */
  const disagreementKey =
    chain != null && entity.oaHash != null && !sameHash(chain.anchored, entity.oaHash)
      ? `${chain.anchored}:${entity.oaHash}`.toLowerCase()
      : null;
  const [confirmedDisagreement, setConfirmedDisagreement] = useState<string | null>(null);

  useEffect(() => {
    if (!disagreementKey || confirmedDisagreement === disagreementKey) return;
    let cancelled = false;
    void (async () => {
      await refetchEntity();
      // Confirmed for THIS pair only: if the refetch changed the platform's hash the pair changes
      // with it and gets its own single re-read, and if it agrees now there is no pair at all.
      if (!cancelled) setConfirmedDisagreement(disagreementKey);
    })();
    return () => {
      cancelled = true;
    };
  }, [disagreementKey, confirmedDisagreement, refetchEntity]);

  const syncingAnchor = disagreementKey != null && confirmedDisagreement !== disagreementKey;
  const anchoredAlarm = disagreementKey != null && confirmedDisagreement === disagreementKey;

  /**
   * The hash the platform reports pending, as the CONTRACT sees it.
   *
   * Always a direct `scheduledAt`/`vetoed` point read (`collectAmendmentHashes` puts it in the
   * batch whether or not a log turned it up), so "nothing is scheduled for it" is something the
   * contract said rather than something a truncated log scan failed to mention.
   */
  const pendingRead = apiPendingHash
    ? amendments.find((a) => sameHash(a.hash, apiPendingHash))
    : undefined;
  const apiClaimsPendingButChainDoesNot =
    pendingRead != null && pendingRead.scheduledAt === ZERO && !pendingRead.vetoed;

  // The last deadline on the card. Past it every badge is settled, so the clock stops rather than
  // re-rendering this card once a second for the life of the page.
  const latestDeadlineMs = live.reduce(
    (max, a) => Math.max(max, Number(a.scheduledAt) * 1000),
    0,
  );
  const now = useNow(latestDeadlineMs);

  async function runTx(hash: Hex, functionName: "cancelOperatingAgreementUpdate" | "liftVeto") {
    if (!proxy || !publicClient) return;
    setTxError(null);
    setBusyHash(hash);
    try {
      const txHash = await writeContractAsync({
        address: proxy,
        abi: legalManagerAbi,
        functionName,
        args: [hash],
        chainId: arcTestnet.id,
      });
      await publicClient.waitForTransactionReceipt({ hash: txHash });
      rereadChain();
      await refetchEntity();
    } catch (e) {
      setTxError(
        e instanceof Error
          ? shortenErr(e.message)
          : "Transaction failed — is this the guardian wallet?",
      );
    } finally {
      setBusyHash(null);
    }
  }

  const isGuardian =
    !!address && !!entity.guardian && address.toLowerCase() === entity.guardian.toLowerCase();

  // Nothing to show for an entity with no LegalManager yet (still provisioning) or a row the
  // backend states never used the manifest scheme.
  if (!proxy || legacy) return null;

  return (
    <Card className="p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <SectionTitle>Operating-agreement amendments</SectionTitle>
        {/* Offered on failure TOO: a read that errored is exactly when a retry is wanted, and
            gating this on `chain` made it unreachable in the one state that needs it. */}
        {(chain || loadError) && (
          <button
            type="button"
            onClick={rereadChain}
            className="text-[11.5px] text-muted-2 underline-offset-2 hover:text-ink hover:underline"
          >
            Re-read the chain
          </button>
        )}
      </div>
      <p className="mt-1 text-[12px] leading-[1.5] text-muted-2">
        Read from your entity&apos;s contract over your own RPC — never from this platform. A
        scheduled amendment changes what your entity commits to on-chain once its timelock
        elapses; vetoing it here parks that hash until you lift the veto yourself.
      </p>

      {chainQuery.isPending && (
        <div className="mt-4 flex items-center gap-2 text-[12.5px] text-muted">
          <Spinner className="h-3.5 w-3.5" /> Reading {shortAddress(proxy)}…
        </div>
      )}

      {loadError && (
        <Callout tone="warn" className="mt-4" title="Could not read the amendment state from the chain">
          {loadError} This card deliberately has no fallback to the platform&apos;s copy: a hash
          this backend chose is not one you should veto on.
        </Callout>
      )}

      {chain?.partial && (
        <Callout tone="muted" className="mt-4" title="Partial history">
          Your RPC refused a full-history log query, so only the last {String(FALLBACK_LOOKBACK)}{" "}
          blocks were scanned for scheduled amendments. An amendment scheduled before that window
          would not be listed here — and a timelock can run to a year, so &ldquo;older&rdquo; does
          not mean &ldquo;expired&rdquo;. A different RPC will show more. The hash this platform
          reports as pending is read from the contract directly and is unaffected by this window.
        </Callout>
      )}

      {syncingAnchor && (
        <Callout tone="muted" className="mt-4" title="Checking the anchored hash">
          <span className="inline-flex items-center gap-2">
            <Spinner className="h-3 w-3" />
            The contract and this platform report different anchored hashes. That is normal for a
            moment after an amendment executes, so the platform&apos;s record is being re-read
            before anything is made of it.
          </span>
        </Callout>
      )}

      {anchoredAlarm && chain && (
        <Callout tone="alarm" className="mt-4" title="The platform's record disagrees with the chain">
          The contract currently carries <Mono>{chain.anchored}</Mono>, and this platform still
          reports <Mono>{entity.oaHash}</Mono> as the anchored hash after a fresh read. Do not
          trust the platform copy. Treat anything below as suspect and contact the operator.
        </Callout>
      )}

      {chain && live.length === 0 && (
        <p className="mt-4 text-[12.5px] text-muted">
          {chain.partial
            ? "No amendment is scheduled on-chain within the range this RPC allowed."
            : "No amendment is scheduled on-chain right now."}
        </p>
      )}

      {apiClaimsPendingButChainDoesNot && (
        <Callout
          tone="muted"
          className="mt-4"
          title="The platform reports a pending version the chain has not got"
        >
          It reports <Mono>{apiPendingHash}</Mono>
          {apiPendingVersion != null && ` (v${apiPendingVersion})`} as pending, and the contract
          answers that nothing is scheduled for that hash. Usually that means the schedule
          transaction has not confirmed yet — nothing to veto until it does.
        </Callout>
      )}

      {live.map((a) => {
        const matchesApi = apiPendingHash != null && sameHash(a.hash, apiPendingHash);
        const executableAtMs = Number(a.scheduledAt) * 1000;
        // `now` ticks in an effect rather than being read during render: a countdown read at
        // render time is both impure and frozen until something else re-renders the card.
        const elapsed = now > 0 && now >= executableAtMs;
        return (
          <div
            key={a.hash}
            className={cx(
              "mt-4 rounded-xl border px-4 py-3.5",
              matchesApi ? "border-[#febc2e]/30 bg-[#febc2e]/[0.06]" : "border-[#ff5f57]/40 bg-[#ff5f57]/[0.07]",
            )}
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-[12.5px] font-medium text-ink">
                Amendment scheduled
                {matchesApi && apiPendingVersion != null && ` — v${apiPendingVersion}`}
              </span>
              <span
                className={cx(
                  "rounded-full border px-2.5 py-0.5 text-[10.5px] uppercase tracking-[0.14em]",
                  elapsed
                    ? "border-[#ff5f57]/40 bg-[#ff5f57]/10 text-[#ff8a84]"
                    : "border-[#febc2e]/40 bg-[#febc2e]/10 text-[#f3cd72]",
                )}
              >
                {elapsed ? "executable now" : "in timelock"}
              </span>
            </div>
            <Mono className="mt-2 block">{a.hash}</Mono>
            <p className="mt-2 text-[11.5px] text-muted-2">
              {elapsed
                ? "The timelock has elapsed — this can be executed at any moment. Vetoing still blocks it, but only until it executes."
                : `Executable ${formatDateTime(executableAtMs)}`}
              {matchesApi &&
                apiExecutableAt != null &&
                Number(a.scheduledAt) !== apiExecutableAt &&
                " · the platform reports a different execution time for this hash."}
            </p>

            {!matchesApi && (
              <Callout tone="alarm" className="mt-4" title="The platform's record disagrees with the chain">
                {apiPendingHash == null
                  ? "This platform reports NO pending amendment, yet this hash is scheduled and executable on your contract. A version the platform has abandoned or superseded stays executable on-chain forever — this is exactly the case to veto."
                  : "This platform reports a different hash as pending. Do not trust the platform copy: the hash above is what your contract will actually apply."}
              </Callout>
            )}

            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Button
                variant="danger"
                size="md"
                disabled={!isGuardian || busyHash !== null}
                loading={busyHash === a.hash}
                onClick={() => void runTx(a.hash, "cancelOperatingAgreementUpdate")}
              >
                Veto this amendment
              </Button>
              {!isGuardian && <GuardianOnlyNote guardian={entity.guardian} />}
            </div>
          </div>
        );
      })}

      {parked.length > 0 && (
        <div className="mt-5 border-t hairline pt-4">
          <SectionTitle>Vetoed hashes</SectionTitle>
          <p className="mt-1 text-[11.5px] leading-[1.5] text-muted-2">
            Parked until you lift the veto. The manager cannot re-schedule a vetoed hash, so
            lifting one is what lets that version proceed again.
          </p>
          <ul className="mt-3 flex flex-col gap-2">
            {parked.map((a) => (
              <li
                key={a.hash}
                className="flex flex-wrap items-center justify-between gap-2 rounded-xl border hairline bg-paper/50 px-3 py-2.5"
              >
                <Mono className="min-w-0 truncate">{a.hash}</Mono>
                <Button
                  variant="ghost"
                  size="md"
                  disabled={!isGuardian || busyHash !== null}
                  loading={busyHash === a.hash}
                  onClick={() => void runTx(a.hash, "liftVeto")}
                >
                  Lift veto
                </Button>
              </li>
            ))}
          </ul>
          {!isGuardian && (
            <div className="mt-2">
              <GuardianOnlyNote guardian={entity.guardian} />
            </div>
          )}
        </div>
      )}

      {txError && <p className="mt-3 text-[12px] text-[#ff8a84]">{txError}</p>}
    </Card>
  );
}

/* ------------------------------------------------------------------ */

/**
 * Everything the card needs from the chain, in as few round trips as the RPC allows.
 *
 * The block height and the anchored hash do not depend on each other, so they go together. The log
 * scan DISCOVERS hashes — `fromBlock: 0` first, because a live amendment older than any fixed
 * window is exactly the one worth catching, with a bounded retry for public RPCs that cap ranges.
 * The per-hash `scheduledAt`/`vetoed` pairs are then one multicall rather than 2N eth_calls, and
 * the hash the platform reports is in that batch whether or not the scan found it.
 */
async function readAmendments(
  client: PublicClient,
  proxy: Address,
  apiPendingHash: string | null,
): Promise<ChainState> {
  const [latest, meta] = await Promise.all([
    client.getBlockNumber(),
    client.readContract({ address: proxy, abi: legalManagerAbi, functionName: "meta" }),
  ]);

  let partial = false;
  let logs: Awaited<ReturnType<typeof client.getLogs>>;
  try {
    logs = await client.getLogs({
      address: proxy,
      event: SCHEDULED_EVENT,
      fromBlock: ZERO,
      toBlock: latest,
    });
  } catch {
    partial = true;
    logs = await client.getLogs({
      address: proxy,
      event: SCHEDULED_EVENT,
      fromBlock: latest > FALLBACK_LOOKBACK ? latest - FALLBACK_LOOKBACK : ZERO,
      toBlock: latest,
    });
  }

  const fromLogs: Hex[] = [];
  for (const log of logs) {
    const hash = (log as { args?: { newHash?: Hex } }).args?.newHash;
    if (hash) fromLogs.push(hash);
  }

  const amendments = await readAmendmentStates(
    client,
    proxy,
    collectAmendmentHashes(fromLogs, apiPendingHash),
  );

  return { amendments, anchored: meta[2], partial };
}

/**
 * `scheduledAt` + `vetoed` for every hash — batched where the chain offers a batcher.
 *
 * Multicall3 is not deployed on every chain this UI can be pointed at, and a card that threw
 * "chain does not support contract multicall3" would be a card that tells the guardian nothing at
 * all. So the batch is an optimisation with a plain fallback under it, never a requirement.
 */
async function readAmendmentStates(
  client: PublicClient,
  proxy: Address,
  hashes: Hex[],
): Promise<Amendment[]> {
  if (hashes.length === 0) return [];

  if (client.chain?.contracts?.multicall3) {
    try {
      const contracts = hashes.flatMap((hash) => [
        { address: proxy, abi: legalManagerAbi, functionName: "scheduledAt", args: [hash] } as const,
        { address: proxy, abi: legalManagerAbi, functionName: "vetoed", args: [hash] } as const,
      ]);
      const results = (await client.multicall({
        contracts,
        allowFailure: false,
      })) as unknown as (bigint | boolean)[];
      return hashes.map((hash, i) => ({
        hash,
        scheduledAt: results[i * 2] as bigint,
        vetoed: results[i * 2 + 1] as boolean,
      }));
    } catch {
      /* fall through to individual reads */
    }
  }

  return Promise.all(
    hashes.map(async (hash): Promise<Amendment> => {
      const [scheduledAt, vetoed] = await Promise.all([
        client.readContract({
          address: proxy,
          abi: legalManagerAbi,
          functionName: "scheduledAt",
          args: [hash],
        }),
        client.readContract({
          address: proxy,
          abi: legalManagerAbi,
          functionName: "vetoed",
          args: [hash],
        }),
      ]);
      return { hash, scheduledAt, vetoed };
    }),
  );
}

/**
 * A wall clock that ticks only while something is counting down.
 *
 * Starts at 0 — one frame of "not elapsed yet" — because the alternative is reading `Date.now()`
 * during render, which is impure and, worse, frozen: the "executable now" state would only appear
 * when some unrelated re-render happened to occur.
 *
 * `latestDeadlineMs` is 0 when nothing is scheduled, and past it every badge on the card is
 * settled. In both cases the interval stops: an idle settings page was re-rendering this whole
 * card, hash rows and all, once a second for as long as it stayed open.
 */
function useNow(latestDeadlineMs: number): number {
  const [now, setNow] = useState(0);
  const counting = latestDeadlineMs > 0 && (now === 0 || now < latestDeadlineMs);

  useEffect(() => {
    if (latestDeadlineMs === 0) return;
    const tick = () => setNow(Date.now());
    // Through a timer rather than called inline: a setState in an effect body cascades a render.
    const immediate = setTimeout(tick, 0);
    if (!counting) return () => clearTimeout(immediate);
    const interval = setInterval(tick, 1000);
    return () => {
      clearTimeout(immediate);
      clearInterval(interval);
    };
  }, [counting, latestDeadlineMs]);

  return now;
}

function GuardianOnlyNote({ guardian }: { guardian: string }) {
  return (
    <span className="text-[11.5px] text-muted-2">
      Guardian only — connect {shortAddress(guardian)} to sign.
    </span>
  );
}

function Mono({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <code className={cx("break-all font-mono text-[11px] text-ink", className)}>{children}</code>
  );
}
