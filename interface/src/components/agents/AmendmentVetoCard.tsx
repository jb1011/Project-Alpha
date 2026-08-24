"use client";

import { useEffect, useState, type ReactNode } from "react";
import { getAbiItem, type Address, type Hex, type PublicClient } from "viem";
import { useAccount, usePublicClient, useWriteContract } from "wagmi";
import type { EntityView } from "@/lib/api/types";
import { arcTestnet } from "@/lib/chain";
import { legalManagerAbi } from "@/lib/legalManagerAbi";
import { Button, Card, Spinner, cx } from "@/components/onboarding/primitives";
import { shortAddress } from "@/components/onboarding/types";

/** One `AmendmentScheduled` hash, joined with what the chain says about it NOW. */
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
  /** True when the RPC refused a full-history query and only a recent window was read. */
  partial: boolean;
};

// `0n` literals need an ES2020 target; this package compiles to ES2017, like the rest of it.
const ZERO = BigInt(0);

const SCHEDULED_EVENT = getAbiItem({ abi: legalManagerAbi, name: "AmendmentScheduled" });

/** How far back to look when an RPC refuses `fromBlock: 0`. Arc finalises sub-second, so this is
 *  a window of hours — comfortably longer than any amendment timelock we deploy. */
const FALLBACK_LOOKBACK = BigInt(200_000);

/**
 * The guardian's pending-amendment card (design §8, audit H4).
 *
 * **Everything actionable here is read from the chain, over the user's own RPC.** The backend
 * cannot be the source of the hash a guardian vetoes: a compromised one would offer a harmless
 * hash, keep the malicious one scheduled, and the veto would land on nothing. So the card
 * enumerates `AmendmentScheduled` logs from the entity's own proxy, asks the contract which of
 * them are still live (`scheduledAt != 0`) or parked (`vetoed`), and vetoes what IT found.
 *
 * The API's `oa_manifest_pending_hash` is used for exactly two things, both of them labels: which
 * VERSION a hash is, and whether the platform's record agrees with the chain. When it does not,
 * that is not a rendering detail — it is the alarm this card exists to raise, and it says so in
 * as many words.
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

  const [chain, setChain] = useState<ChainState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [txError, setTxError] = useState<string | null>(null);
  const [busyHash, setBusyHash] = useState<Hex | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const now = useNow();

  const proxy = entity.proxy as Address | null;
  const anchor = entity.oaAnchor;
  const apiPendingHash =
    anchor && anchor.scheme === "manifest" ? (anchor.pendingHash ?? null) : null;
  const apiPendingVersion =
    anchor && anchor.scheme === "manifest" ? (anchor.pendingVersion ?? null) : null;
  const apiExecutableAt =
    anchor && anchor.scheme === "manifest" ? (anchor.amendmentExecutableAt ?? null) : null;

  const isGuardian =
    !!address && !!entity.guardian && address.toLowerCase() === entity.guardian.toLowerCase();

  useEffect(() => {
    if (!publicClient || !proxy) return;
    let cancelled = false;
    void (async () => {
      try {
        const next = await readAmendments(publicClient, proxy);
        if (cancelled) return;
        setChain(next);
        setLoadError(null);
      } catch (e) {
        if (cancelled) return;
        setChain(null);
        setLoadError(e instanceof Error ? shortenErr(e.message) : "Could not read the chain.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [publicClient, proxy, refreshKey]);

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
      setRefreshKey((k) => k + 1);
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

  // Nothing to show for an entity with no LegalManager yet (still provisioning) or a legacy row
  // that never used the manifest scheme.
  if (!proxy) return null;

  const live = (chain?.amendments ?? []).filter((a) => a.scheduledAt !== ZERO);
  const parked = (chain?.amendments ?? []).filter((a) => a.scheduledAt === ZERO && a.vetoed);
  const anchoredDisagrees =
    chain != null && entity.oaHash != null && !sameHash(chain.anchored, entity.oaHash);
  const apiClaimsPendingButChainDoesNot =
    chain != null && apiPendingHash != null && !live.some((a) => sameHash(a.hash, apiPendingHash));

  return (
    <Card className="p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <SectionTitle>Operating-agreement amendments</SectionTitle>
        {chain && (
          <button
            type="button"
            onClick={() => setRefreshKey((k) => k + 1)}
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

      {!chain && !loadError && (
        <div className="mt-4 flex items-center gap-2 text-[12.5px] text-muted">
          <Spinner className="h-3.5 w-3.5" /> Reading {shortAddress(proxy)}…
        </div>
      )}

      {loadError && (
        <Banner tone="warn" title="Could not read the amendment state from the chain">
          {loadError} This card deliberately has no fallback to the platform&apos;s copy: a hash
          this backend chose is not one you should veto on.
        </Banner>
      )}

      {chain?.partial && (
        <Banner tone="muted" title="Partial history">
          Your RPC refused a full-history log query, so only the last {String(FALLBACK_LOOKBACK)}{" "}
          blocks were read. An older amendment that is still live would not appear here — the
          contract&apos;s own `scheduledAt` is the authority, and a different RPC will show more.
        </Banner>
      )}

      {anchoredDisagrees && (
        <Banner tone="alarm" title="The platform's record disagrees with the chain">
          The contract currently carries <Mono>{chain.anchored}</Mono>, and this platform reports{" "}
          <Mono>{entity.oaHash}</Mono> as the anchored hash. Do not trust the platform copy. Treat
          anything below as suspect and contact the operator.
        </Banner>
      )}

      {chain && live.length === 0 && !loadError && (
        <p className="mt-4 text-[12.5px] text-muted">
          No amendment is scheduled on-chain right now.
        </p>
      )}

      {apiClaimsPendingButChainDoesNot && (
        <Banner tone="muted" title="The platform reports a pending version the chain has not got">
          It reports <Mono>{apiPendingHash}</Mono>
          {apiPendingVersion != null && ` (v${apiPendingVersion})`} as pending, but nothing with
          that hash is scheduled on this contract. Usually that means the schedule transaction has
          not confirmed yet — nothing to veto until it does.
        </Banner>
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
                : `Executable ${new Date(executableAtMs).toLocaleString()}`}
              {matchesApi &&
                apiExecutableAt != null &&
                Number(a.scheduledAt) !== apiExecutableAt &&
                " · the platform reports a different execution time for this hash."}
            </p>

            {!matchesApi && (
              <Banner tone="alarm" title="The platform's record disagrees with the chain">
                {apiPendingHash == null
                  ? "This platform reports NO pending amendment, yet this hash is scheduled and executable on your contract. A version the platform has abandoned or superseded stays executable on-chain forever — this is exactly the case to veto."
                  : "This platform reports a different hash as pending. Do not trust the platform copy: the hash above is what your contract will actually apply."}
              </Banner>
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
          <div className="text-[11px] uppercase tracking-[0.18em] text-muted-2">Vetoed hashes</div>
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
 * Enumerate every amendment this proxy has ever scheduled, then ask the contract about each.
 *
 * The logs answer "which hashes exist"; the contract answers "which of them matter now". Neither
 * question is asked of the backend. `fromBlock: 0` first, because a live amendment older than a
 * fixed window is exactly the one worth catching; public RPCs that cap log ranges get a bounded
 * retry and the card says the history is partial rather than quietly showing less.
 */
async function readAmendments(client: PublicClient, proxy: Address): Promise<ChainState> {
  const latest = await client.getBlockNumber();
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

  const hashes: Hex[] = [];
  for (const log of logs) {
    const hash = (log as { args?: { newHash?: Hex } }).args?.newHash;
    if (hash && !hashes.includes(hash)) hashes.push(hash);
  }

  const amendments = await Promise.all(
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

  const meta = await client.readContract({
    address: proxy,
    abi: legalManagerAbi,
    functionName: "meta",
  });

  return { amendments, anchored: meta[2], partial };
}

/**
 * A wall clock that ticks.
 *
 * Starts at 0 — one frame of "not elapsed yet" — because the alternative is reading `Date.now()`
 * during render, which is impure and, worse, frozen: the "executable now" state would only appear
 * when some unrelated re-render happened to occur.
 */
function useNow(): number {
  const [now, setNow] = useState(0);
  useEffect(() => {
    const tick = () => setNow(Date.now());
    const immediate = setTimeout(tick, 0);
    const interval = setInterval(tick, 1000);
    return () => {
      clearTimeout(immediate);
      clearInterval(interval);
    };
  }, []);
  return now;
}

function sameHash(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function GuardianOnlyNote({ guardian }: { guardian: string }) {
  return (
    <span className="text-[11.5px] text-muted-2">
      Guardian only — connect {shortAddress(guardian)} to sign.
    </span>
  );
}

function Banner({
  tone,
  title,
  children,
}: {
  tone: "alarm" | "warn" | "muted";
  title: string;
  children: ReactNode;
}) {
  const tones = {
    alarm: "border-[#ff5f57]/45 bg-[#ff5f57]/[0.09] text-[#ff8a84]",
    warn: "border-[#febc2e]/35 bg-[#febc2e]/[0.07] text-[#f3cd72]",
    muted: "border-line-strong bg-paper-2/70 text-muted",
  } as const;
  return (
    <div className={cx("mt-4 rounded-xl border px-4 py-3 text-[12px] leading-[1.55]", tones[tone])}>
      <div className="font-medium text-ink">{title}</div>
      <div className="mt-1">{children}</div>
    </div>
  );
}

function Mono({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <code className={cx("break-all font-mono text-[11px] text-ink", className)}>{children}</code>
  );
}

function SectionTitle({ children }: { children: ReactNode }) {
  return <div className="text-[11px] uppercase tracking-[0.18em] text-muted-2">{children}</div>;
}

function shortenErr(msg: string): string {
  const first = msg.split("\n")[0]?.trim() ?? "Transaction failed.";
  return first.length > 140 ? `${first.slice(0, 140)}…` : first;
}
