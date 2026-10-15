"use client";

import { useEffect, useRef, useState } from "react";
import { useReadContract } from "wagmi";
import { StepNav } from "@/components/onboarding/OnboardingFlow";
import {
  Button,
  Callout,
  Card,
  SectionTitle,
  Spinner,
  StepHeader,
} from "@/components/onboarding/primitives";
import { useRefreshBindingMutation } from "@/lib/api/legalBodyHooks";
import type { Address, BindingState, LegalBodyOrderView } from "@/lib/api/types";
import {
  identityRegistryAbi,
  legalBodyFactoryAbi,
  POINTER_KEY,
} from "@/lib/legalBody/chain";
import { LEGAL_BODY_COPY, fillCopy } from "@/lib/legalBody/copy";
import {
  pastePointerState,
  pointerCallRows,
  pointerCallText,
  pointerChecksOf,
  pointerSeen,
  pointerWatchInterval,
  pointerWatchStatus,
  refreshErrorLine,
  type PointerCallText,
} from "@/lib/legalBody/paste";
import { REFRESH_RETRY_MS, refreshPlan } from "@/lib/legalBody/polling";
import type { LegalBodyStepKit } from "./LegalBodyFlow";
import { CopyBox, FieldRows, McpNote } from "./PasteLinkPanel";

const P = LEGAL_BODY_COPY.paste;
const POINTER = LEGAL_BODY_COPY.pointer;

/** A chain read asked once: a revert is an answer, and a failure has its own Try again. Not asked
 *  again on focus or on reconnect either: a failed read there would take the call off the screen
 *  in the middle of a round. */
const ONCE = { retry: false, refetchOnWindowFocus: false, refetchOnReconnect: false } as const;

/** This browser's clock, read inside a click, its continuations and the watch's interval only. */
const nowMs = () => Date.now();

/**
 * Point the identity from another key: the call to send, decoded, for the owner key to send
 * wherever it lives. No wallet is prompted on this panel and no API key is asked for.
 *
 * The call is the one allowlist's (`pointerCallText`) for this order only. Before it is shown, three
 * chain reads: the factory's own encoding of the pointer for this body, which must be the same 96
 * bytes (a mismatch is a stop), and the identity's owner now and at the body's creation, which
 * must both be the owner the order recorded (`pastePointerState`). Then the call, its calldata to
 * copy, the gas note, "send this from the owner key", and the never-approve sentence.
 *
 * Once shown, the identity's pointer is read every 30 seconds for two minutes, or until "I sent
 * it" is clicked: reads only. The click asks Novi Corpus to check the pointer once
 * (`binding/refresh`), then as often as `refreshPlan` says, each a continuation of that click;
 * nothing is ever sent from an effect.
 */
export function PastePointerPanel({ kit }: { kit: LegalBodyStepKit }) {
  const order = kit.order;
  if (order === null) return null;
  const call = pointerCallText(kit.config, order);
  return (
    <div>
      <StepHeader
        eyebrow={LEGAL_BODY_COPY.rail.labels.pointer}
        title={P.pointerTitle}
        intro={order.agentId !== null ? fillCopy(P.pointerIntro, { agentId: order.agentId }) : undefined}
      />
      {"ok" in call ? (
        <Callout tone="warn">{fillCopy(P.callRefused, { problem: call.problem })}</Callout>
      ) : (
        <PointerChecks kit={kit} order={order} call={call} />
      )}
      <McpNote />
    </div>
  );
}

/** The three reads, and what they decide. */
function PointerChecks({
  kit,
  order,
  call,
}: {
  kit: LegalBodyStepKit;
  order: LegalBodyOrderView;
  call: PointerCallText;
}) {
  const { config } = kit;
  // The allowlist accepted the order, so its body is there and well formed.
  const body = order.bodyAddress as Address;
  const agentId = BigInt(call.args[0]);

  const factoryPointer = useReadContract({
    address: config.factory,
    abi: legalBodyFactoryAbi,
    functionName: "encodePointer",
    args: [body],
    chainId: config.chainId,
    query: ONCE,
  });
  const ownerOf = useReadContract({
    address: config.identityRegistry,
    abi: identityRegistryAbi,
    functionName: "ownerOf",
    args: [agentId],
    chainId: config.chainId,
    query: ONCE,
  });
  const ownerAtCreation = useReadContract({
    address: config.factory,
    abi: legalBodyFactoryAbi,
    functionName: "identityOwnerAtCreation",
    args: [body],
    chainId: config.chainId,
    query: ONCE,
  });

  const state = pastePointerState({
    call,
    identityOwner: order.identityOwner,
    checks: pointerChecksOf({ factoryPointer, ownerOf, ownerAtCreation }),
  });

  switch (state.kind) {
    case "loading":
      return (
        <div className="flex items-center gap-2 py-8 text-[13px] text-muted">
          <Spinner className="h-3.5 w-3.5" /> {P.checking}
        </div>
      );
    case "unreadable":
      return (
        <>
          <Callout tone="warn">{P.checksUnread}</Callout>
          <StepNav>
            <Button
              onClick={() => {
                void factoryPointer.refetch();
                void ownerOf.refetch();
                void ownerAtCreation.refetch();
              }}
            >
              {P.retry}
            </Button>
          </StepNav>
        </>
      );
    case "refused":
      return <Callout tone="warn">{fillCopy(P.callRefused, { problem: state.problem })}</Callout>;
    case "pointer_mismatch":
      return (
        <Callout tone="warn">{fillCopy(P.pointerStop, { reason: POINTER.factoryMismatch })}</Callout>
      );
    case "moved":
      return (
        <Callout tone="warn">
          {state.reason === "no_identity"
            ? fillCopy(P.noIdentity, { agentId: call.args[0] })
            : POINTER.identityMoved}
        </Callout>
      );
    case "ready":
      return <SendFromOwner kit={kit} order={order} call={state.call} owner={state.owner} body={body} />;
  }
}

/** The plan after "I sent it": its own clock, the refreshes made, and the state last answered. */
type PlanRun = {
  startedAtMs: number;
  refreshes: number;
  lastRefreshAtMs: number | null;
  state: BindingState;
};

/** The call to send, the watch of the pointer, and the click that asks for the check. */
function SendFromOwner({
  kit,
  order,
  call,
  owner,
  body,
}: {
  kit: LegalBodyStepKit;
  order: LegalBodyOrderView;
  call: PointerCallText;
  owner: Address;
  body: Address;
}) {
  const { config } = kit;
  const refresh = useRefreshBindingMutation(order.id);
  const expected = call.args[2];

  // The watch's clock starts when the call is shown.
  const [startedAt] = useState(nowMs);
  const [sent, setSent] = useState(false);
  // Read by the watch's interval, which is asked outside a render.
  const sentRef = useRef(false);

  const watch = useReadContract({
    address: config.identityRegistry,
    abi: identityRegistryAbi,
    functionName: "getMetadata",
    args: [BigInt(call.args[0]), POINTER_KEY],
    chainId: config.chainId,
    query: {
      enabled: !sent,
      retry: false,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
      refetchInterval: (query) =>
        pointerWatchInterval({
          startedAtMs: startedAt,
          nowMs: nowMs(),
          sent: sentRef.current,
          seen: pointerSeen(query.state.data, expected),
        }),
    },
  });
  const watchStatus = pointerWatchStatus({
    startedAtMs: startedAt,
    lastReadAtMs: Math.max(watch.dataUpdatedAt, watch.errorUpdatedAt),
    seen: pointerSeen(watch.data, expected),
  });

  // The plan after a click. Set and cleared inside the click and its continuations.
  const run = useRef<PlanRun | null>(null);
  const inFlight = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [checking, setChecking] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [lines, setLines] = useState<string[]>([]);
  const [keepChecking, setKeepChecking] = useState(false);

  // A cleanup only: a continuation still waiting when the panel goes is dropped, so nothing is
  // sent once the person has left. It starts nothing.
  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
      run.current = null;
    },
    [],
  );

  function finish(r: PlanRun) {
    run.current = null;
    setChecking(false);
    setKeepChecking(r.state !== "linked");
  }

  /** One step of the plan: a refresh, a wait, or the end. */
  async function step() {
    const r = run.current;
    if (r === null) return;
    const action = refreshPlan({ ...r, nowMs: nowMs() });
    if (action === "stop") {
      finish(r);
      return;
    }
    if (action === "refresh") {
      r.refreshes += 1;
      r.lastRefreshAtMs = nowMs();
      setRefreshing(true);
      try {
        const binding = await refresh.mutateAsync();
        const state: unknown = binding?.state;
        if (typeof state === "string") r.state = state as BindingState;
        setLines([]);
      } catch (e) {
        if (kit.routeSignIn(e)) {
          run.current = null;
          setChecking(false);
          return;
        }
        setLines([refreshErrorLine(e)]);
      } finally {
        setRefreshing(false);
      }
      if (run.current !== r) return;
      if (refreshPlan({ ...r, nowMs: nowMs() }) === "stop") {
        finish(r);
        return;
      }
    }
    timer.current = setTimeout(() => {
      timer.current = null;
      void step();
    }, REFRESH_RETRY_MS);
  }

  /** "I sent it": the watch ends, and one check now, then the plan. */
  async function onSent() {
    if (inFlight.current || run.current !== null) return;
    inFlight.current = true;
    sentRef.current = true;
    setSent(true);
    setKeepChecking(false);
    setLines([]);
    run.current = { startedAtMs: nowMs(), refreshes: 0, lastRefreshAtMs: null, state: order.state };
    setChecking(true);
    try {
      await step();
    } finally {
      inFlight.current = false;
    }
  }

  const rows = pointerCallRows(call, { owner, body, chainId: config.chainId });
  const watchLine = sent
    ? null
    : watchStatus === "seen"
      ? P.seen
      : watchStatus === "ended"
        ? P.watchEnded
        : P.watching;

  return (
    <>
      <Card className="p-6">
        <SectionTitle>{P.sendFromOwner}</SectionTitle>
        <FieldRows rows={rows} />
      </Card>

      <Card className="mt-6 p-6">
        <CopyBox heading={P.calldataHeading} text={call.calldata} />
      </Card>

      <div className="mt-6 flex flex-col gap-3 text-[12.5px] leading-[1.6] text-muted">
        <p>{config.environment === "sandbox" ? P.gasSandbox : P.gasProduction}</p>
        <p>{POINTER.sevenDays}</p>
        <p>{LEGAL_BODY_COPY.wallet.neverApprove}</p>
      </div>

      {watchLine && (
        <Callout tone="info" className="mt-6">
          {watchLine}
        </Callout>
      )}

      {refreshing && (
        <div className="mt-4 flex items-center gap-2 text-[13px] text-muted">
          <Spinner className="h-3.5 w-3.5" /> {P.refreshing}
        </div>
      )}

      {(lines.length > 0 || keepChecking) && (
        <Callout tone="warn" className="mt-6">
          <span className="flex flex-col gap-2">
            {lines.map((line) => (
              <span key={line}>{line}</span>
            ))}
            {keepChecking && <span>{P.keepChecking}</span>}
          </span>
        </Callout>
      )}

      <StepNav>
        <Button onClick={() => void onSent()} loading={checking}>
          {P.sent}
        </Button>
      </StepNav>
    </>
  );
}
