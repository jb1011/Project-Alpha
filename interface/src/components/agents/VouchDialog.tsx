"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import { useQueryClient } from "@tanstack/react-query";
import {
  useAgentBookRegisterMutation,
  useAgentBookSessionMutation,
  useEntityAgentBookQuery,
  useWorldIdMeQuery,
} from "@/lib/api/hooks";
import { apiKeys } from "@/lib/api/keys";
import { ApiError, apiErrorDetail, type AgentBookSessionView } from "@/lib/api/types";
import { checkPin } from "@/lib/agentbook/pin";
import { normalizeProof } from "@/lib/agentbook/proof";
import { signalMatches } from "@/lib/agentbook/signal";
import { WORLDCHAIN_EXPLORER_URL } from "@/lib/agentbook/chipState";
import { useAuth } from "@/components/onboarding/AuthProvider";
import { Button, Spinner } from "@/components/onboarding/primitives";

/**
 * The vouch dialog: a guardian, as a person, putting their World ID behind an agent's payment
 * address in AgentBook — World's public registry on World Chain (design 2026-08-25 v3 §3, §5).
 *
 * Three things here are load-bearing and easy to lose in a refactor:
 *
 * 1. **The signal is recomputed locally (D8).** The session hands us `signal` next to the address
 *    and nonce it claims to have built it from. We rebuild it and refuse to show a QR unless they
 *    agree. A backend that is the sole author of what a guardian signs can put a human behind an
 *    address the dialog never showed them, and no amount of copy fixes that.
 * 2. **The address is pinned in this browser.** Trust on first use. It cannot catch a backend that
 *    lied from the start; it catches one that starts lying later.
 * 3. **Nothing here says more than "a World ID verified human has vouched for this agent's payment
 *    address in AgentBook"** (D9). Not "human-backed", not "proves control", not "permanent proof".
 */

/* ── Copy. Every string a guardian can see lives here, so the ceiling can be read in one place ── */

/** §5.3, one message for every non-Orb guardian. Byte-identical to the backend's
 *  `NOT_ELIGIBLE_MESSAGE`, so the local check and the 403 read the same. */
export const NOT_ELIGIBLE_COPY =
  "AgentBook vouching needs a World ID from an Orb. Your access here is unaffected. AgentBook is World's public registry and only accepts Orb-verified proofs. There is nothing we can substitute for that, and we will not fake it.";

/** The disabled-button reason and the `not_ready` 409 for an agent with no pocket yet. */
export const NO_POCKET_COPY = "Available once the agent has a payment address";

const NOT_ON_CHAIN_COPY =
  "This agent is not fully on chain yet. Vouching becomes available once it is. Nothing was sent.";

/** Both caps (per-agent lifetime, per-account per hour) arrive as `limit_exceeded`. The design's
 *  "after that, contact support" for a re-vouch after a dispute is enforced by the lifetime cap,
 *  so this is where a guardian learns what to do next. */
const LIMIT_COPY =
  "This agent has reached its AgentBook vouch limit. Nothing was sent. If your vouch was replaced and you need another, contact support.";

const UNAVAILABLE_COPY =
  "AgentBook is not reachable right now. Nothing was sent. Try again in a minute.";

const CONFLICT_COPY =
  "The registry moved while you were approving. Nothing was written. Start again when you are ready.";

const GENERIC_COPY = "Something went wrong before anything was written. Try again.";

const SIGNAL_MISMATCH_COPY =
  "The server's request did not match this agent's payment address. Nothing was signed.";

const PIN_CHANGED_COPY =
  "This agent's payment address differs from the one this browser saw before. Nothing was signed. Check the address on Arcscan before trying again.";

const TIMEOUT_COPY = "Timed out waiting for World App. Nothing was written.";

const BRIDGE_UNREACHABLE_COPY = "World App could not be reached. Nothing was signed.";

const PROOF_SHAPE_COPY = "World App returned a proof in an unexpected format. Nothing was written.";

/** The one automatic restart: a fresh session, and the guardian approves once more. */
const CONFLICT_RETRY_NOTICE =
  "The registry changed while you were approving, so nothing was written. Here is a fresh request — approving it completes the vouch.";

/* ── Constants ──────────────────────────────────────────────────────────────── */

/** World App credentials AgentBook accepts. Mirrors the backend's `ORB_CREDENTIALS`. */
const ORB = new Set(["orb", "proof_of_human"]);
/** How often we ask World's bridge whether the guardian has approved. */
const BRIDGE_POLL_MS = 1_000;
/** Hard ceiling on the wait, whatever the session says. */
const TIMEOUT_MS = 300_000;
/** How often the dashboard's AgentBook row is re-read while a vouch is in flight. */
const STATUS_POLL_MS = 5_000;

type Phase =
  | { kind: "confirm" }
  | { kind: "starting" }
  | {
      kind: "awaiting";
      session: AgentBookSessionView;
      connectorURI: string;
      qr: string;
      deadline: number;
    }
  | { kind: "submitting" }
  | { kind: "vouched"; txHash: string | null }
  | { kind: "failed"; message: string; retryable: boolean };

/**
 * Mount/unmount is the reset.
 *
 * The body owns a live World App round trip and a pinned bridge client; resetting that in an
 * effect when an `open` prop flips leaves a poll loop running against a store the next open will
 * not use. The parent renders this only while open, so closing unmounts and the ref-guarded loop
 * stops on its own.
 */
export function VouchDialog(props: {
  entityId: string;
  agentId: string;
  open: boolean;
  onClose: () => void;
}) {
  if (!props.open) return null;
  return (
    <VouchDialogBody entityId={props.entityId} agentId={props.agentId} onClose={props.onClose} />
  );
}

function VouchDialogBody({
  entityId,
  agentId,
  onClose,
}: {
  entityId: string;
  agentId: string;
  onClose: () => void;
}) {
  const me = useWorldIdMeQuery();
  const status = useEntityAgentBookQuery(entityId);
  const sessionMutation = useAgentBookSessionMutation(entityId);
  const register = useAgentBookRegisterMutation(entityId);
  const queryClient = useQueryClient();
  const { session: auth } = useAuth();

  const [phase, setPhase] = useState<Phase>({ kind: "confirm" });
  const [accepted, setAccepted] = useState(false);
  const [details, setDetails] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const cancelled = useRef(false);
  const conflictRetried = useRef(false);

  // The poll loop below outlives a close by up to one tick; this is what stops it.
  useEffect(() => {
    cancelled.current = false;
    return () => {
      cancelled.current = true;
    };
  }, []);

  /** The dashboard chip and this dialog read ONE query. Invalidating is how the chip learns. */
  const token = auth?.token ?? "";
  const refreshStatus = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: apiKeys.entityAgentBook(token, entityId) });
  }, [queryClient, token, entityId]);

  // While our row is moving, re-read it. Only the dialog knows a flow is in flight, so the poll
  // lives here rather than on the query every dashboard mounts (Task 7's note on `hooks.ts`).
  const rowStatus = status.data?.status;
  const inFlight = rowStatus === "pending" || rowStatus === "submitted";
  useEffect(() => {
    if (!inFlight) return;
    const timer = setInterval(refreshStatus, STATUS_POLL_MS);
    return () => clearInterval(timer);
  }, [inFlight, refreshStatus]);

  const credential = me.data?.credential ?? null;
  const eligible = credential !== null && ORB.has(credential);
  const pocketAddress = status.data?.address ?? null;
  const disputed = status.data?.outcome === "disputed" || status.data?.disputed === true;

  /** `carryNotice` survives the restart: the only caller that passes one is the conflict retry,
   *  and it is the line that explains why a second QR just appeared. */
  async function start(carryNotice: string | null = null) {
    setNotice(carryNotice);
    setPhase({ kind: "starting" });

    let s: AgentBookSessionView;
    try {
      s = await sessionMutation.mutateAsync();
    } catch (e) {
      setPhase(failureFor(e));
      return;
    }
    // A pending row exists from here on: the chip must stop saying "not in AgentBook".
    refreshStatus();

    // D8: recompute the signal locally and refuse a session whose signal differs. Never show a QR
    // for bytes this client did not derive itself.
    if (!signalMatches(s.pocketAddress, s.nonce, s.signal)) {
      setPhase({ kind: "failed", message: SIGNAL_MISMATCH_COPY, retryable: false });
      return;
    }
    if (checkPin(entityId, s.pocketAddress) === "changed") {
      setPhase({ kind: "failed", message: PIN_CHANGED_COPY, retryable: false });
      return;
    }
    const appId = asAppId(s.appId);
    if (!appId) {
      setPhase({ kind: "failed", message: SIGNAL_MISMATCH_COPY, retryable: false });
      return;
    }

    // World's v2 bridge, loaded ONLY here (design v3 §4.6): it needs `window.crypto.subtle`, so it
    // must never be imported on the server or on a page without this dialog. v4's `IDKit.request`
    // cannot be used at all — it needs an `rp_context` signed by the app owner, and the AgentBook
    // app is World's, not ours.
    let bridge: BridgeStore | null = null;
    let connectorURI: string | null = null;
    try {
      const { createWorldBridgeStore } = await import("idkit-core-v2");
      bridge = createWorldBridgeStore();
      await bridge.getState().createClient({
        app_id: appId,
        action: s.action,
        // The 52-byte packed signal we just recomputed. IDKit hex-validates a string signal and
        // hashes those exact bytes, which is byte-for-byte the backend's `hashSignal(buildSignal)`
        // — and unlike handing it `solidityEncode(...)`, the bytes the guardian commits to are the
        // ones this client derived (D8).
        signal: s.signal,
      });
      connectorURI = bridge.getState().connectorURI;
    } catch {
      setPhase({ kind: "failed", message: BRIDGE_UNREACHABLE_COPY, retryable: true });
      return;
    }
    if (!bridge || !connectorURI) {
      setPhase({ kind: "failed", message: BRIDGE_UNREACHABLE_COPY, retryable: true });
      return;
    }
    const client = bridge;

    const qr = await QRCode.toDataURL(connectorURI, { margin: 1, width: 240 });
    const deadline = Date.now() + Math.min(TIMEOUT_MS, Math.max(0, s.expiresAt - Date.now()));
    setPhase({ kind: "awaiting", session: s, connectorURI, qr, deadline });

    while (Date.now() < deadline && !cancelled.current) {
      try {
        await client.getState().pollForUpdates();
      } catch {
        setPhase({ kind: "failed", message: BRIDGE_UNREACHABLE_COPY, retryable: true });
        return;
      }
      if (cancelled.current) return;
      const { result, errorCode } = client.getState();
      if (errorCode) {
        setPhase({ kind: "failed", message: bridgeMessage(errorCode), retryable: true });
        return;
      }
      if (result) {
        const proof = normalizeProof(result.proof);
        if (!proof) {
          setPhase({ kind: "failed", message: PROOF_SHAPE_COPY, retryable: true });
          return;
        }
        setPhase({ kind: "submitting" });
        try {
          const out = await register.mutateAsync({
            sessionId: s.sessionId,
            root: result.merkle_root,
            nonce: s.nonce,
            nullifierHash: result.nullifier_hash,
            proof,
          });
          setPhase({ kind: "vouched", txHash: out.txHash });
        } catch (e) {
          // One automatic restart on a conflict: the nonce moved or the session expired while the
          // guardian was approving, so the proof is spent and only a fresh session can work.
          if (e instanceof ApiError && e.code === "conflict" && !conflictRetried.current) {
            conflictRetried.current = true;
            await start(CONFLICT_RETRY_NOTICE);
            return;
          }
          setPhase(failureFor(e));
        }
        return;
      }
      await sleep(BRIDGE_POLL_MS);
    }
    if (!cancelled.current)
      setPhase({ kind: "failed", message: TIMEOUT_COPY, retryable: true });
  }

  const gate = confirmGate({
    meLoading: me.isPending,
    meFailed: me.isError,
    eligible,
    statusLoading: status.isPending,
    statusFailed: status.isError,
    pocketAddress,
  });

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="vouch-dialog-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
    >
      <div className="max-h-[90vh] w-full max-w-[560px] overflow-y-auto rounded-2xl border hairline bg-paper-2 p-6">
        <h2 id="vouch-dialog-title" className="text-[20px] font-medium text-ink">
          Vouch for this agent in AgentBook
        </h2>

        {phase.kind === "confirm" &&
          (gate ? (
            gate.loading ? (
              <Line>
                <Spinner className="h-3.5 w-3.5" /> {gate.text}
              </Line>
            ) : (
              <p className="mt-4 text-[13.5px] leading-[1.6] text-muted-1">{gate.text}</p>
            )
          ) : (
            <ConfirmBody
              agentId={agentId}
              pocketAddress={pocketAddress ?? ""}
              disputed={disputed}
              accepted={accepted}
              onAccepted={setAccepted}
              details={details}
              onDetails={setDetails}
            />
          ))}

        {phase.kind === "starting" && (
          <Line>
            <Spinner className="h-3.5 w-3.5" /> Preparing the request…
          </Line>
        )}

        {phase.kind === "awaiting" && (
          <div className="mt-4 flex flex-col items-center gap-3">
            {notice && (
              <p className="w-full text-[12.5px] leading-[1.55] text-amber-300">{notice}</p>
            )}
            {/* eslint-disable-next-line @next/next/no-img-element -- a data: URI generated in the
                browser; next/image has nothing to optimise and would only add a loader. */}
            <img src={phase.qr} alt="Scan with World App to approve the vouch" width={240} height={240} />
            <a
              className="text-[13px] text-accent-soft underline underline-offset-2"
              href={phase.connectorURI}
              target="_blank"
              rel="noreferrer"
            >
              Open in World App
            </a>
            <p className="text-[12.5px] text-muted-2">
              Approving in World App completes a public vouch.
            </p>
            <Countdown deadline={phase.deadline} />
            <p className="w-full text-[12px] leading-[1.6] text-muted-2">
              Payment address <code className="font-mono">{phase.session.pocketAddress}</code> ·
              agent #{phase.session.agentId}
            </p>
            {phase.session.network === "testnet" && (
              <p className="w-full text-[12px] leading-[1.6] text-muted-2">
                This agent runs on Arc testnet. The vouch is on World Chain mainnet and is just as
                permanent.
              </p>
            )}
            {phase.session.priorVouches > 0 && (
              <p className="w-full text-[12px] leading-[1.6] text-muted-2">
                You have already vouched for {phase.session.priorVouches}{" "}
                {phase.session.priorVouches === 1 ? "agent" : "agents"} from this account. This
                vouch will be publicly linkable to them.
              </p>
            )}
          </div>
        )}

        {phase.kind === "submitting" && (
          <Line>
            <Spinner className="h-3.5 w-3.5" /> Writing the registration on World Chain…
          </Line>
        )}

        {phase.kind === "vouched" && (
          <p className="mt-4 text-[13.5px] leading-[1.6] text-ink">
            Registration submitted.{" "}
            {phase.txHash ? (
              <a
                className="underline underline-offset-2"
                href={`${WORLDCHAIN_EXPLORER_URL}/tx/${phase.txHash}`}
                target="_blank"
                rel="noreferrer"
              >
                View the transaction
              </a>
            ) : (
              "We are confirming it with the registry and will update the dashboard."
            )}
          </p>
        )}

        {phase.kind === "failed" && (
          <p className="mt-4 text-[13.5px] leading-[1.6] text-amber-300">{phase.message}</p>
        )}

        <div className="mt-6 flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            {phase.kind === "vouched" ? "Close" : "Cancel"}
          </Button>
          {phase.kind === "confirm" && !gate && (
            <Button
              disabled={!accepted}
              onClick={() => {
                // Anything unexpected (a QR encoder throw, a bridge import failure) still ends as
                // a phase, never as an unhandled rejection with the dialog stuck on "starting".
                void start().catch(() =>
                  setPhase({ kind: "failed", message: GENERIC_COPY, retryable: true }),
                );
              }}
            >
              Vouch permanently
            </Button>
          )}
          {phase.kind === "failed" && phase.retryable && (
            <Button onClick={() => setPhase({ kind: "confirm" })}>Try again</Button>
          )}
        </div>
      </div>
    </div>
  );
}

/* ── The confirmation body (design v3 §5.1, verbatim) ───────────────────────── */

function ConfirmBody(p: {
  agentId: string;
  pocketAddress: string;
  disputed: boolean;
  accepted: boolean;
  onAccepted: (v: boolean) => void;
  details: boolean;
  onDetails: (v: boolean) => void;
}) {
  return (
    <div className="mt-4 flex flex-col gap-3 text-[13.5px] leading-[1.6] text-muted-1">
      <p>You are about to publicly vouch for this agent, as a person.</p>
      <p>
        <b>Public, forever.</b> A pseudonym from your World ID is written to a public blockchain
        next to this agent&apos;s payment address{" "}
        <code className="font-mono text-[12.5px] text-ink">{p.pocketAddress}</code> (agent #
        {p.agentId}, the address that pays its x402 invoices). It cannot be removed, by you, by us
        or by World.
      </p>
      <p>
        <b>The same pseudonym every time.</b> Anyone can see that every agent you vouch for in
        AgentBook, here or anywhere else, shares one backer, and that Novi Corpus submitted it.
      </p>
      <p>
        <b>Someone else can replace it.</b> Any World ID verified person can vouch for this address
        and overwrite yours. Your agent&apos;s dashboard will show it; we cannot prevent or undo it.
      </p>
      <p>
        <b>Not a proof of control, not a legal signature.</b> It says one thing: a verified human
        chose to stand behind this address.
      </p>
      <p>
        Novi Corpus pays the network fee. World App will show a request from <b>AgentKit</b>,
        World&apos;s registry app, and may ask for Face Auth. Approving it is the vouch.
      </p>
      <button
        type="button"
        className="self-start text-[12.5px] underline underline-offset-2"
        onClick={() => p.onDetails(!p.details)}
        aria-expanded={p.details}
      >
        {p.details ? "Details ▴" : "Details ▾"}
      </button>
      {p.details && (
        <div className="flex flex-col gap-2 rounded-lg border hairline p-3 text-[12.5px]">
          <p>
            <b>What this does.</b> It writes a record in AgentBook, a public registry on World
            Chain, saying that a World ID verified human stands behind this agent&apos;s payment
            address. Sellers who check AgentBook will see that a World ID verified human has vouched
            for this agent&apos;s payment address.
          </p>
          <p>
            <b>What becomes public, forever.</b> A pseudonym derived from your World ID is published
            on a public blockchain, linked to this address. It does not reveal your name. But it is
            the same pseudonym every time you vouch in AgentBook, here or anywhere else, so anyone
            can see that every agent you vouch for shares one backer. The transaction is sent by
            Novi Corpus, so anyone can also list every address Novi Corpus has vouched for.
          </p>
          <p>
            <b>You cannot remove this.</b> AgentBook has no removal function. Not you, not us, not
            World. The record outlives this agent and your account.
          </p>
          <p>
            <b>Someone else can replace it.</b> AgentBook lets any World ID verified person vouch
            for any address, including this one, which overwrites the current vouch. Your
            agent&apos;s dashboard shows that state as &quot;disputed&quot;; we cannot prevent it or
            undo it.
          </p>
          <p>
            <b>What this does not do.</b> It does not prove you control this address, and it is not
            a legal signature.
          </p>
        </div>
      )}
      {p.disputed && (
        <p className="text-[12.5px] leading-[1.6] text-amber-300">
          Someone else has vouched for this address. Vouching again replaces theirs in the registry.
          Every record stays public, and every vouch you make is linkable to the others.
        </p>
      )}
      <label className="mt-2 flex items-start gap-2 text-ink">
        <input
          type="checkbox"
          className="mt-1"
          checked={p.accepted}
          onChange={(e) => p.onAccepted(e.target.checked)}
        />
        <span>I understand this is public, permanent, and can be replaced by someone else.</span>
      </label>
    </div>
  );
}

/* ── Small parts ────────────────────────────────────────────────────────────── */

function Line(p: { children: React.ReactNode }) {
  return (
    <p className="mt-4 flex items-center gap-2 text-[13.5px] text-muted-1">{p.children}</p>
  );
}

/** Seconds left on the session. The first tick lands within half a second of mounting; nothing is
 *  computed during render, which keeps this pure. */
function Countdown(p: { deadline: number }) {
  const [now, setNow] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, []);
  if (now === 0) return null;
  return (
    <p className="text-[12px] text-muted-2">
      {Math.ceil(Math.max(0, p.deadline - now) / 1000)}s left
    </p>
  );
}

/* ── Pure helpers ───────────────────────────────────────────────────────────── */

type BridgeStore = ReturnType<
  (typeof import("idkit-core-v2"))["createWorldBridgeStore"]
>;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** IDKit types the app id as a template literal; the wire gives us a string. One checked narrowing
 *  beats a cast at the call site. */
function asAppId(value: string): `app_${string}` | null {
  return value.startsWith("app_") ? (value as `app_${string}`) : null;
}

/**
 * What blocks the confirmation body, if anything.
 *
 * Order matters: "not eligible" is a statement about the person reading it, so it is never shown
 * on a credential we have not actually read back.
 */
function confirmGate(input: {
  meLoading: boolean;
  meFailed: boolean;
  eligible: boolean;
  statusLoading: boolean;
  statusFailed: boolean;
  pocketAddress: string | null;
}): { loading: boolean; text: string } | null {
  if (input.meLoading) return { loading: true, text: "Checking your World ID…" };
  if (input.meFailed)
    return { loading: false, text: "We could not check your World ID. Nothing was sent." };
  if (!input.eligible) return { loading: false, text: NOT_ELIGIBLE_COPY };
  if (input.statusLoading)
    return { loading: true, text: "Checking this agent's AgentBook standing…" };
  if (input.statusFailed)
    return {
      loading: false,
      text: "We could not read this agent's AgentBook standing. Nothing was sent.",
    };
  if (!input.pocketAddress) return { loading: false, text: NO_POCKET_COPY };
  return null;
}

/**
 * Server error → what the guardian is told. Never the raw message: a route's text is not copy, and
 * a contract revert carries the proof arguments (§4.7).
 */
function failureFor(e: unknown): { kind: "failed"; message: string; retryable: boolean } {
  const fail = (message: string, retryable: boolean) =>
    ({ kind: "failed" as const, message, retryable });
  if (!(e instanceof ApiError)) return fail(GENERIC_COPY, true);
  const detail = apiErrorDetail(e.details);
  switch (e.code) {
    case "not_eligible":
      return fail(NOT_ELIGIBLE_COPY, false);
    case "not_ready":
      return fail(detail?.reason === "no-pocket-yet" ? NO_POCKET_COPY : NOT_ON_CHAIN_COPY, false);
    case "limit_exceeded":
      return fail(LIMIT_COPY, false);
    case "unavailable":
      return fail(UNAVAILABLE_COPY, true);
    case "conflict":
      return fail(CONFLICT_COPY, true);
    case "proof_rejected":
      return fail(
        detail?.errorName
          ? `World rejected the proof (${detail.errorName}). Nothing was written.`
          : "World rejected the proof. Nothing was written.",
        false,
      );
    default:
      return fail(GENERIC_COPY, true);
  }
}

/** World App's own refusal codes. The code is an enum value, never World App's error text. */
function bridgeMessage(code: string): string {
  switch (code) {
    case "verification_rejected":
      return "You declined the request in World App. Nothing was written.";
    case "credential_unavailable":
      return NOT_ELIGIBLE_COPY;
    case "max_verifications_reached":
      return "Your World ID has already been used for this AgentBook action as often as World allows. Nothing was written.";
    case "inclusion_proof_pending":
    case "inclusion_proof_failed":
      return "World is still publishing your World ID to the on-chain set. Try again in a few minutes. Nothing was written.";
    default:
      return `World App did not complete the request (${code}). Nothing was written.`;
  }
}
