"use client";

import { useEffect, useRef, useState } from "react";
import {
  useBalance,
  useConnection,
  useEstimateFeesPerGas,
  useEstimateGas,
  usePublicClient,
  useReadContract,
} from "wagmi";
import { StepNav } from "@/components/onboarding/OnboardingFlow";
import { Button, Callout, Card, Spinner, StepHeader } from "@/components/onboarding/primitives";
import {
  useAllowedWrite,
  useGasSeedMutation,
  useLegalBodyBindingQuery,
  useLegalBodyOrderQuery,
  useRefreshBindingMutation,
} from "@/lib/api/legalBodyHooks";
import {
  BINDING_STATES,
  type Address,
  type BindingState,
  type Hex,
  type LegalBodyOrderView,
} from "@/lib/api/types";
import { txUrl } from "@/lib/chain";
import { identityRegistryAbi, legalBodyFactoryAbi, pointerCall } from "@/lib/legalBody/chain";
import { LEGAL_BODY_COPY, fillCopy } from "@/lib/legalBody/copy";
import { sameAddress } from "@/lib/legalBody/flow";
import { isSignInRequired } from "@/lib/legalBody/gates";
import { registerSendFailure } from "@/lib/legalBody/identity";
import { pointerCallText, pointerChecksOf } from "@/lib/legalBody/paste";
import {
  POINTER_RECEIPT_TIMEOUT_MS,
  bindingSettled,
  bindingWatchDelayMs,
  browserPointerScreen,
  chainUnreadLine,
  gasEstimateWei,
  gasLine,
  gasLines,
  gasSeedAnswer,
  gasSeedSuccess,
  pointerFailureLines,
  pointerRefusalSentence,
  pointerSentence,
  pointerTxStage,
  pointerTxView,
  preflightSentence,
  refreshAnswer,
  seedOffered,
  sendOffered,
  type PointerTxStage,
} from "@/lib/legalBody/pointer";
import { REFRESH_RETRY_MS, refreshPlan } from "@/lib/legalBody/polling";
import type { LegalBodyStepKit } from "./LegalBodyFlow";

const PT = LEGAL_BODY_COPY.pointer;

/** A chain read asked once: a revert is an answer, and a failure has its own Try again. */
const ONCE = { retry: false } as const;
/** Stands in for the body and the identity while the allowlist refuses the call: no read is made
 *  with it, since every read is disabled then. */
const NO_BODY = "0x0000000000000000000000000000000000000000" as Address;

/** This browser's clock, read inside a click and its continuations only. */
const nowMs = () => Date.now();

/** A binding state from an answer, or null when the answer names none this build knows. */
function stateOf(answer: unknown): BindingState | null {
  const state: unknown =
    typeof answer === "object" && answer !== null ? (answer as { state?: unknown }).state : undefined;
  return typeof state === "string" && (BINDING_STATES as readonly string[]).includes(state)
    ? (state as BindingState)
    : null;
}

/** What the step needs from the flow: the deployment, the order, and the way back to sign-in. The
 *  legal body's own page can pass the same. */
export type PointerStepKit = Pick<LegalBodyStepKit, "config" | "order" | "routeSignIn">;

/** The refresh plan after the receipt: its own clock, the refreshes made, and the state last read. */
type PlanRun = {
  startedAtMs: number;
  refreshes: number;
  lastRefreshAtMs: number | null;
  state: BindingState;
};

/**
 * Point your identity: the connected wallet owns the identity, so it writes the one transaction
 * that points the identity at its legal body.
 *
 * The binding is read first: a body winding down or dissolved asks for no pointer, and the step
 * says so. Then the call for this order only (`pointerCallText`: `pointerCall` then `allowedCall`,
 * which refuses a revoked, replaced or superseded body before any read), and three chain reads:
 * the factory's own encoding of the pointer for this body, which must be the same 96 bytes (a
 * mismatch is a stop), and the identity's owner now and at the body's creation, which must be the
 * owner the order recorded and the wallet connected here (`pointerPreflight`). Only then the
 * sentence of what the wallet writes, the gas line in Arc's native unit with its 18 decimals, the
 * gas seed where the deployment offers it, the 7-day fact, and the button.
 *
 * The click sends through `useAllowedWrite` alone, waits for the receipt, then asks Novi Corpus to
 * check the pointer once (`binding/refresh`) as that click's continuation; then every 30 seconds
 * the binding is read and refreshed as `refreshPlan` says; then, if the body is still not linked,
 * the binding is read at a slowing pace while the page is open. A refresh answering
 * `chain_unavailable` keeps the stored binding on screen and the plan goes on. Once the body reads
 * `linked`, the order is read again and the flow moves on to done. Nothing is sent from an
 * effect: the only effect drops the timers when the step goes.
 */
export function PointerStep({ kit }: { kit: PointerStepKit }) {
  const order = kit.order;
  if (order === null) return null;
  return <PointerStepForOrder kit={kit} order={order} />;
}

function PointerStepForOrder({ kit, order }: { kit: PointerStepKit; order: LegalBodyOrderView }) {
  const { config } = kit;
  const environment = config.environment;
  const { address } = useConnection();
  const connected = (address ?? null) as Address | null;
  const publicClient = usePublicClient({ chainId: config.chainId });
  const send = useAllowedWrite();
  const bindingQuery = useLegalBodyBindingQuery(order.id);
  // The same order the flow reads: read again here once the body reads linked.
  const orderQuery = useLegalBodyOrderQuery(order.id, { pollWhileReserved: false });
  const refresh = useRefreshBindingMutation(order.id);
  const seed = useGasSeedMutation(order.id);

  // The allowlist's answer for this order; the reads are made only once it accepted the call.
  const call = pointerCallText(config, order);
  const accepted = "ok" in call ? null : call;
  const body = accepted ? (order.bodyAddress as Address) : NO_BODY;
  const agentId = accepted ? BigInt(accepted.args[0]) : BigInt(0);
  const reads = { ...ONCE, enabled: accepted !== null };

  const factoryPointer = useReadContract({
    address: config.factory,
    abi: legalBodyFactoryAbi,
    functionName: "encodePointer",
    args: [body],
    chainId: config.chainId,
    query: reads,
  });
  const ownerOf = useReadContract({
    address: config.identityRegistry,
    abi: identityRegistryAbi,
    functionName: "ownerOf",
    args: [agentId],
    chainId: config.chainId,
    query: reads,
  });
  const ownerAtCreation = useReadContract({
    address: config.factory,
    abi: legalBodyFactoryAbi,
    functionName: "identityOwnerAtCreation",
    args: [body],
    chainId: config.chainId,
    query: reads,
  });

  const screen = browserPointerScreen({
    binding: bindingQuery.data ?? null,
    bindingFailed: bindingQuery.isError,
    order,
    call,
    connected,
    checks: pointerChecksOf({ factoryPointer, ownerOf, ownerAtCreation }),
    environment,
  });
  const ready = screen.kind === "ready" ? screen : null;

  // The gas line: reads, made only once every check passed.
  const gas = useEstimateGas({
    account: ready?.owner,
    to: config.identityRegistry,
    data: ready?.call.calldata,
    chainId: config.chainId,
    query: { ...ONCE, enabled: ready !== null },
  });
  const fees = useEstimateFeesPerGas({ chainId: config.chainId, query: { ...ONCE, enabled: ready !== null } });
  const balance = useBalance({
    address: ready?.owner,
    chainId: config.chainId,
    query: { ...ONCE, enabled: ready !== null },
  });
  const line = gasLine({
    estimateWei: gasEstimateWei({ gas: gas.data, maxFeePerGas: fees.data?.maxFeePerGas }),
    balanceWei: balance.data?.value ?? null,
  });
  const gasView = gasLines({ line, estimating: gas.isLoading || fees.isLoading, environment });

  // The send, its receipt, and the plan after it. Set and cleared inside the click and its
  // continuations.
  const inFlight = useRef(false);
  const run = useRef<PlanRun | null>(null);
  const watch = useRef<{ reads: number } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [busy, setBusy] = useState<"sending" | "waiting" | null>(null);
  const [tx, setTx] = useState<{ hash: Hex; stage: PointerTxStage } | null>(null);
  // The sentence said when the transaction was sent, kept while the binding moves on.
  const [sentSentence, setSentSentence] = useState<string | null>(null);
  const [lines, setLines] = useState<string[]>([]);
  const [checking, setChecking] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [chainUnread, setChainUnread] = useState(false);
  const [keepChecking, setKeepChecking] = useState(false);

  // The gas seed, where offered: one click, one request.
  const seedInFlight = useRef(false);
  const [seedBusy, setSeedBusy] = useState(false);
  const [seedFinal, setSeedFinal] = useState(false);
  const [seedLine, setSeedLine] = useState<{ text: string; tone: "info" | "warn" } | null>(null);
  const [seedHash, setSeedHash] = useState<Hex | null>(null);

  // A cleanup only: a continuation still waiting when the step goes is dropped, so nothing is sent
  // or read once the person has left. It starts nothing.
  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = null;
      run.current = null;
      watch.current = null;
    },
    [],
  );

  function later(next: () => void, ms: number) {
    timer.current = setTimeout(() => {
      timer.current = null;
      next();
    }, ms);
  }

  /** The plan is over: the order is read again when the binding no longer waits; otherwise the
   *  binding is read at a slowing pace, reads only. */
  function finish(r: PlanRun) {
    run.current = null;
    setChecking(false);
    if (bindingSettled(r.state)) {
      setKeepChecking(false);
      void orderQuery.refetch();
      return;
    }
    setKeepChecking(true);
    const w = { reads: 0 };
    watch.current = w;
    later(() => void watchRead(w), bindingWatchDelayMs(w.reads));
  }

  /** One read of the binding after the plan: the order again once it no longer waits. */
  async function watchRead(w: { reads: number }) {
    if (watch.current !== w) return;
    w.reads += 1;
    const read = await bindingQuery.refetch();
    if (watch.current !== w) return;
    if (bindingSettled(stateOf(read.data))) {
      watch.current = null;
      setKeepChecking(false);
      void orderQuery.refetch();
      return;
    }
    later(() => void watchRead(w), bindingWatchDelayMs(w.reads));
  }

  /** One tick of the plan: after the first, a free read of the binding; then a refresh when
   *  `refreshPlan` says so; then the next tick in 30 seconds, or the end. */
  async function tick(first: boolean) {
    const r = run.current;
    if (r === null) return;
    if (!first) {
      const read = await bindingQuery.refetch();
      if (run.current !== r) return;
      r.state = stateOf(read.data) ?? r.state;
    }
    if (refreshPlan({ ...r, nowMs: nowMs() }) === "refresh") {
      r.refreshes += 1;
      r.lastRefreshAtMs = nowMs();
      setRefreshing(true);
      try {
        const answer = await refresh.mutateAsync();
        r.state = stateOf(answer) ?? r.state;
        setLines([]);
        setChainUnread(false);
      } catch (e) {
        if (kit.routeSignIn(e)) {
          run.current = null;
          setChecking(false);
          return;
        }
        const outcome = refreshAnswer(e);
        setChainUnread(outcome.kind === "chain_unavailable");
        setLines(outcome.kind === "line" ? [outcome.line] : []);
      } finally {
        setRefreshing(false);
      }
      if (run.current !== r) return;
    }
    if (refreshPlan({ ...r, nowMs: nowMs() }) === "stop") {
      finish(r);
      return;
    }
    later(() => void tick(false), REFRESH_RETRY_MS);
  }

  /** "Write the pointer": the one transaction, its receipt, then one check now and the plan. */
  async function onSend() {
    if (inFlight.current || run.current !== null || ready === null) return;
    setLines([]);
    // The wallet that sends is the identity's owner, as the preflight read it.
    if (!connected || !sameAddress(connected, ready.owner)) {
      setLines([PT.notConnected]);
      return;
    }
    const client = publicClient;
    if (!client) {
      setLines([pointerRefusalSentence("chain_not_configured", environment)]);
      return;
    }
    const req = pointerCall(config, order);
    if ("ok" in req) {
      setLines([fillCopy(PT.callRefused, { problem: req.problem })]);
      return;
    }
    inFlight.current = true;
    setBusy("sending");
    setTx(null);
    setChainUnread(false);
    setKeepChecking(false);
    try {
      let sent: Awaited<ReturnType<typeof send>>;
      try {
        sent = await send(req, { config, order });
      } catch (e) {
        setLines(pointerFailureLines(registerSendFailure(e)));
        return;
      }
      if (!sent.ok) {
        setLines([pointerRefusalSentence(sent.problem, environment)]);
        return;
      }
      const hash = sent.hash;
      setSentSentence(pointerSentence(ready.intent, environment));
      setTx({ hash, stage: "waiting" });
      setBusy("waiting");
      let receipt: { status?: string } | null;
      try {
        receipt = await client.waitForTransactionReceipt({ hash, timeout: POINTER_RECEIPT_TIMEOUT_MS });
      } catch {
        receipt = null;
      }
      const stage = pointerTxStage(receipt);
      setTx({ hash, stage });
      setBusy(null);
      if (stage === "reverted") return;
      // The one refresh after the receipt: this click's continuation.
      run.current = {
        startedAtMs: nowMs(),
        refreshes: 0,
        lastRefreshAtMs: null,
        state: bindingQuery.data?.state ?? order.state,
      };
      setChecking(true);
      await tick(true);
    } finally {
      inFlight.current = false;
      setBusy(null);
    }
  }

  /** "Ask for a little gas": one request; its answer read by `gasSeedOutcome`. */
  async function onSeed() {
    if (seedInFlight.current) return;
    seedInFlight.current = true;
    setSeedBusy(true);
    setSeedLine(null);
    try {
      const sent = gasSeedSuccess(await seed.mutateAsync());
      setSeedLine({ text: sent.line, tone: "info" });
      setSeedHash(sent.hash);
      // One seed per tenant, ever: asking again cannot change anything.
      setSeedFinal(true);
      void balance.refetch();
    } catch (e) {
      if (kit.routeSignIn(e)) return;
      const answer = gasSeedAnswer(e);
      setSeedLine({ text: answer.line, tone: "warn" });
      if (answer.final) setSeedFinal(true);
    } finally {
      seedInFlight.current = false;
      setSeedBusy(false);
    }
  }

  async function retryBinding() {
    const read = await bindingQuery.refetch();
    if (read.error && isSignInRequired(read.error)) kit.routeSignIn(read.error);
  }

  const sentView = tx !== null && tx.stage !== "reverted";
  const intro = sentView ? sentSentence : ready ? pointerSentence(ready.intent, environment) : null;

  return (
    <div>
      <StepHeader
        eyebrow={LEGAL_BODY_COPY.rail.labels.pointer}
        title={PT.title}
        intro={intro ?? undefined}
      />

      {sentView ? (
        <SentPanel
          tx={tx}
          refreshing={refreshing}
          checking={checking}
          chainLine={chainUnread ? chainUnreadLine(bindingQuery.data?.state ?? order.state) : null}
          lines={lines}
          keepChecking={keepChecking}
        />
      ) : (
        <>
          {screen.kind === "loading" && (
            <div className="flex items-center gap-2 py-8 text-[13px] text-muted">
              <Spinner className="h-3.5 w-3.5" />{" "}
              {bindingQuery.data ? LEGAL_BODY_COPY.paste.checking : PT.loading}
            </div>
          )}
          {screen.kind === "binding_unreadable" && (
            <>
              <Callout tone="warn">{PT.bindingUnread}</Callout>
              <StepNav>
                <Button onClick={() => void retryBinding()}>{PT.retry}</Button>
              </StepNav>
            </>
          )}
          {screen.kind === "no_intent" && (
            <Callout tone="warn" title={screen.title}>
              {screen.body}
            </Callout>
          )}
          {screen.kind === "refused" && (
            <Callout tone="warn">{fillCopy(PT.callRefused, { problem: screen.problem })}</Callout>
          )}
          {screen.kind === "unreadable" && (
            <>
              <Callout tone="warn">{PT.checksUnread}</Callout>
              <StepNav>
                <Button
                  onClick={() => {
                    void factoryPointer.refetch();
                    void ownerOf.refetch();
                    void ownerAtCreation.refetch();
                  }}
                >
                  {PT.retry}
                </Button>
              </StepNav>
            </>
          )}
          {screen.kind === "pointer_mismatch" && (
            <Callout tone="warn">{fillCopy(PT.stop, { reason: PT.factoryMismatch })}</Callout>
          )}
          {screen.kind === "preflight_refused" && (
            <Callout tone="warn">
              {preflightSentence(screen.reason, {
                agentId: order.agentId ?? "",
                owner: order.identityOwner ?? NO_BODY,
              })}
            </Callout>
          )}
          {ready && (
            <>
              <Callout tone={gasView.tone}>
                <span className="flex flex-col gap-1">
                  {gasView.lines.map((l) => (
                    <span key={l}>{l}</span>
                  ))}
                </span>
              </Callout>

              {seedOffered({ gasSeedOffered: config.gasSeedOffered, enough: line.enough, final: seedFinal }) && (
                <div className="mt-4">
                  <Button variant="ghost" onClick={() => void onSeed()} loading={seedBusy}>
                    {PT.seed}
                  </Button>
                </div>
              )}
              {seedLine && (
                <Callout tone={seedLine.tone} className="mt-4">
                  <span className="flex flex-col gap-1">
                    <span>{seedLine.text}</span>
                    {seedHash && <TxLink hash={seedHash} />}
                  </span>
                </Callout>
              )}

              <div className="mt-6 flex flex-col gap-3 text-[12.5px] leading-[1.6] text-muted">
                <p>{PT.sevenDays}</p>
                <p>{LEGAL_BODY_COPY.wallet.neverApprove}</p>
              </div>

              {tx && (
                <Callout tone={pointerTxView(tx.stage).tone} className="mt-6">
                  <span className="flex flex-col gap-2">
                    <span>{pointerTxView(tx.stage).text}</span>
                    <TxLink hash={tx.hash} />
                  </span>
                </Callout>
              )}
              {lines.length > 0 && (
                <Callout tone="warn" className="mt-6">
                  <span className="flex flex-col gap-2">
                    {lines.map((l) => (
                      <span key={l}>{l}</span>
                    ))}
                  </span>
                </Callout>
              )}
              {busy === "sending" && (
                <div className="mt-4 flex items-center gap-2 text-[13px] text-muted">
                  <Spinner className="h-3.5 w-3.5" /> {PT.inWallet}
                </div>
              )}

              {sendOffered(tx?.stage ?? null) && (
                <StepNav>
                  <Button onClick={() => void onSend()} loading={busy !== null}>
                    {PT.send}
                  </Button>
                </StepNav>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}

/** After the send: the transaction, the checks, and what the last one said. */
function SentPanel({
  tx,
  refreshing,
  checking,
  chainLine,
  lines,
  keepChecking,
}: {
  tx: { hash: Hex; stage: PointerTxStage };
  refreshing: boolean;
  checking: boolean;
  chainLine: string | null;
  lines: string[];
  keepChecking: boolean;
}) {
  const view = pointerTxView(tx.stage);
  return (
    <>
      <Card className="p-6">
        <div className="flex flex-col gap-2 text-[13px] leading-[1.6] text-muted">
          <span className="flex items-center gap-2">
            {tx.stage === "waiting" && <Spinner className="h-3.5 w-3.5" />}
            {view.text}
          </span>
          <TxLink hash={tx.hash} />
        </div>
      </Card>

      {(refreshing || checking) && (
        <div className="mt-4 flex items-center gap-2 text-[13px] text-muted">
          <Spinner className="h-3.5 w-3.5" /> {PT.refreshing}
        </div>
      )}

      {(chainLine || lines.length > 0 || keepChecking) && (
        <Callout tone="warn" className="mt-6">
          <span className="flex flex-col gap-2">
            {chainLine && <span>{chainLine}</span>}
            {lines.map((l) => (
              <span key={l}>{l}</span>
            ))}
            {keepChecking && <span>{PT.keepChecking}</span>}
          </span>
        </Callout>
      )}

      <div className="mt-6 flex flex-col gap-3 text-[12.5px] leading-[1.6] text-muted">
        <p>{PT.sevenDays}</p>
        <p>{LEGAL_BODY_COPY.wallet.neverApprove}</p>
      </div>
    </>
  );
}

function TxLink({ hash }: { hash: Hex }) {
  return (
    <a
      href={txUrl(hash)}
      target="_blank"
      rel="noreferrer"
      className="break-all font-mono text-[11.5px] underline underline-offset-2"
    >
      {LEGAL_BODY_COPY.identity.viewTransaction}: {hash}
    </a>
  );
}
