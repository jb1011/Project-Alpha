"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { getAddress } from "viem";
import { useQueryClient } from "@tanstack/react-query";
import {
  useAgentBookRegisterMutation,
  useAgentBookSessionMutation,
  useEntityAgentBookQuery,
  useWorldIdMeQuery,
} from "@/lib/api/hooks";
import { apiKeys } from "@/lib/api/keys";
import { ApiError, type AgentBookSessionView } from "@/lib/api/types";
import {
  bridgeMessage,
  failureFor,
  isRegistryMoved,
  GENERIC_COPY,
  NOT_ELIGIBLE_COPY,
  NOT_ON_CHAIN_COPY,
  NO_POCKET_COPY,
} from "@/lib/agentbook/failure";
import { checkPin } from "@/lib/agentbook/pin";
import { normalizeProof } from "@/lib/agentbook/proof";
import { buildSignal, signalMatches } from "@/lib/agentbook/signal";
import { WORLDCHAIN_EXPLORER_URL } from "@/lib/agentbook/chipState";
import { useAuth } from "@/components/onboarding/AuthProvider";
import { Button, Spinner } from "@/components/onboarding/primitives";

/**
 * The vouch dialog: a guardian, as a person, putting their World ID behind an agent's payment
 * address in AgentBook — World's public registry on World Chain (design 2026-08-25 v3 §3, §5).
 *
 * Four things here are load-bearing and easy to lose in a refactor:
 *
 * 1. **The signal is derived locally (D8).** The session hands us `signal` next to the address and
 *    nonce it claims to have built it from. We rebuild it, refuse to continue unless they agree,
 *    and hand OUR bytes to World's bridge. A backend that is the sole author of what a guardian
 *    signs can put a human behind an address the dialog never showed them.
 * 2. **The address is pinned in this browser, and re-checked against the confirm step.** Trust on
 *    first use catches a backend that starts lying later; the second check catches an address that
 *    changed between the paragraph the guardian read and the request they approve.
 * 3. **Nothing is ever restarted automatically.** A conflict returns to the confirmation step with
 *    the box unticked: re-vouching is deliberate (§5.2), never a retry loop.
 * 4. **"Nothing was written" is a claim, not a consolation.** It is said only for failures the
 *    route raises before it claims the row; everything else gets §5.2's sentence.
 */

/* ── Copy owned by the dialog. The error/gate copy lives in lib/agentbook/failure.ts ── */

const SIGNAL_MISMATCH_COPY =
  "The server's request did not match this agent's payment address. Nothing was signed.";

const PIN_CHANGED_COPY =
  "This agent's payment address differs from the one this browser saw before. Nothing was signed. Check the address on Arcscan before trying again.";

const ADDRESS_DRIFT_COPY =
  "The payment address in this request is not the one shown on the previous step. Nothing was signed.";

const TIMEOUT_COPY = "Timed out waiting for World App. Nothing was written.";

const BRIDGE_UNREACHABLE_COPY = "World App could not be reached. Nothing was signed.";

const PROOF_SHAPE_COPY = "World App returned a proof in an unexpected format. Nothing was written.";

/** A conflict sends the guardian back to the confirmation step. Both notices say the same two
 *  things: nothing was written, and the next step is a decision rather than a retry. */
const CONFLICT_NOTICE =
  "That request is no longer valid, and nothing was written. Read the terms again and confirm if you still want to vouch — World App will show a fresh request.";

const REGISTRY_MOVED_NOTICE =
  "The registry moved while you were approving, so nothing was written: someone else's vouch for this address may have landed. Read the terms again and confirm only if you still want to vouch.";

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

/** Whether the confirmation step warns that another vouch for this address exists, or might. */
type Linkage = "none" | "disputed" | "maybe";

/**
 * Mount/unmount is the reset.
 *
 * The body owns a live World App round trip and a pinned bridge client; resetting that in an
 * effect when an `open` prop flips leaves a poll loop running against a store the next open will
 * not use. The parent renders this only while open, so closing unmounts and the ref-guarded loop
 * stops on its own.
 *
 * **It has to be a portal.** The dashboard renders this from inside a `<Card>`, and `Card` carries
 * `backdrop-blur-sm`. A non-`none` `backdrop-filter` makes that card the containing block for
 * `position: fixed` descendants AND its own stacking context, so an inline overlay would size
 * `inset-0` to the card instead of the viewport and have its `z-50` clamped below the later
 * sibling cards ("Treasury balance", "Spent this period", "Per-tx cap"), which are `Card`s too and
 * therefore stacking contexts of their own, painted after it. `document.body` is the only parent
 * with no such ancestor between it and the viewport.
 */
export function VouchDialog(props: {
  entityId: string;
  agentId: string;
  open: boolean;
  onClose: () => void;
}) {
  // `open` is false on the server and on the first client render alike (it only turns true from a
  // click), so there is nothing to hydrate here and no mismatch to guard against — the `document`
  // check is only so this file stays importable in a server render.
  if (!props.open || typeof document === "undefined") return null;
  return createPortal(
    <VouchDialogBody entityId={props.entityId} agentId={props.agentId} onClose={props.onClose} />,
    document.body,
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
  const [registryMoved, setRegistryMoved] = useState(false);
  const cancelled = useRef(false);

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
  // lives here rather than on the query every dashboard mounts (Task 7's note on `hooks.ts`). It
  // also runs on `submitted`, which is the state a submit failure we could not classify leaves
  // behind: the chip, not this dialog, is what finally answers whether the vouch landed.
  const rowStatus = status.data?.status;
  const inFlight = rowStatus === "pending" || rowStatus === "submitted";
  useEffect(() => {
    if (!inFlight) return;
    const timer = setInterval(refreshStatus, STATUS_POLL_MS);
    return () => clearInterval(timer);
  }, [inFlight, refreshStatus]);

  const credential = me.data?.credential ?? null;
  const eligible = credential !== null && ORB.has(credential);
  // ONE casing on both steps. The guardian is asked (D8) to compare this against the address that
  // pays on Arcscan, so a checksummed session address beside a stored-form status address would
  // put a visible discrepancy in front of exactly that comparison. The GET checksums it too; this
  // also covers the deploy window where a new interface meets the API that does not yet. Equality
  // is never done on the rendered form: every comparison below lowercases first.
  const rawAddress = status.data?.address ?? null;
  const pocketAddress = useMemo(() => checksum(rawAddress), [rawAddress]);
  const disputed = status.data?.outcome === "disputed" || status.data?.disputed === true;
  // "Someone else MAY have vouched" is retired only by a positive answer: the registry now holds
  // an entry that is not foreign (a foreign one reads `disputed` and is handled above), so the
  // address the nonce moved for is ours. An `unregistered` read does NOT retire it — registrations
  // are never cleared, so a moved nonce with no entry behind it means our read lags, and dropping
  // the warning on it would be the under-claiming direction.
  const registryAnswered = status.data?.outcome === "registered";
  const linkage: Linkage =
    disputed ? "disputed" : registryMoved && !registryAnswered ? "maybe" : "none";

  /** Back to the decision, never around it: the box is unticked and a NEW session needs a click. */
  function returnToConfirm(text: string, movedOnChain: boolean) {
    setAccepted(false);
    setDetails(false);
    setNotice(text);
    setRegistryMoved((was) => was || movedOnChain);
    setPhase({ kind: "confirm" });
  }

  async function start() {
    // A dialog that is closing must not leave a session row behind it.
    if (cancelled.current) return;
    setNotice(null);
    setPhase({ kind: "starting" });

    let s: AgentBookSessionView;
    try {
      s = await sessionMutation.mutateAsync();
    } catch (e) {
      const f = failureFor(e, "session");
      setPhase({ kind: "failed", message: f.message, retryable: f.retryable });
      return;
    }
    // A pending row exists from here on, and the chip re-reads it.
    refreshStatus();
    // Closing DURING the session POST used to carry on into the bridge: a live request to
    // World's bridge for a QR nobody will ever see. The mount-effect guard only covers the poll
    // loop below, so the awaits above need their own check.
    if (cancelled.current) return;

    // D8: rebuild the signal from the address and nonce, and refuse a session whose signal
    // disagrees. Never ask for a proof over bytes this client did not derive.
    if (!signalMatches(s.pocketAddress, s.nonce, s.signal)) {
      setPhase({ kind: "failed", message: SIGNAL_MISMATCH_COPY, retryable: false });
      return;
    }
    const localSignal = buildSignal(s.pocketAddress, s.nonce);
    // The address the guardian actually read on the confirmation step. Equal to `s.pocketAddress`
    // in every honest case; a difference means the paragraph they agreed to is about a different
    // address than the request they are being asked to approve.
    if (!pocketAddress || pocketAddress.toLowerCase() !== s.pocketAddress.toLowerCase()) {
      setPhase({ kind: "failed", message: ADDRESS_DRIFT_COPY, retryable: false });
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
        // OUR 52 bytes, not the server's string. IDKit hex-validates a string signal and hashes
        // exactly these bytes, which is byte-for-byte the backend's `hashSignal(buildSignal(…))` —
        // so the invariant D8 asks for lives in the code rather than in a comparison we then
        // throw away.
        signal: localSignal,
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
    if (cancelled.current) return;

    // Loaded here, beside the bridge, for the same reason: this dialog is statically imported by
    // the agent dashboard, and a QR encoder used on exactly one line must not sit in the first
    // load of the page every agent owner opens (final review FR-G).
    const QRCode = (await import("qrcode")).default;
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
          // A conflict is a DECISION point, never an automatic restart (§5.2): the proof is spent,
          // a new session means a new World App approval, and when the registry moved someone
          // else's vouch may now stand — which the guardian must weigh before doing it again.
          if (e instanceof ApiError && e.code === "conflict") {
            const moved = isRegistryMoved(e);
            returnToConfirm(moved ? REGISTRY_MOVED_NOTICE : CONFLICT_NOTICE, moved);
            return;
          }
          const f = failureFor(e, "register");
          setPhase({ kind: "failed", message: f.message, retryable: f.retryable });
        }
        return;
      }
      await sleep(BRIDGE_POLL_MS);
    }
    if (!cancelled.current) setPhase({ kind: "failed", message: TIMEOUT_COPY, retryable: true });
  }

  const gate = confirmGate({
    meLoading: me.isPending,
    meFailed: me.isError,
    eligible,
    statusLoading: status.isPending,
    statusFailed: status.isError,
    pocketAddress,
    agentId,
  });

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="vouch-dialog-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
    >
      <div className="max-h-[calc(100vh-2rem)] w-full max-w-[560px] overflow-y-auto rounded-2xl border hairline bg-paper-2 p-6">
        <h2 id="vouch-dialog-title" className="text-[20px] font-medium text-ink">
          Vouch for this agent in AgentBook
        </h2>

        {notice && (phase.kind === "confirm" || phase.kind === "awaiting") && (
          <p className="mt-4 text-[12.5px] leading-[1.55] text-amber-300">{notice}</p>
        )}

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
              network={status.data?.network}
              priorVouches={status.data?.priorVouches}
              linkage={linkage}
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
  /** The AGENT's network. Absent from a backend that predates the field — the line is then
   *  omitted, never guessed: "mainnet" would suppress a true warning and "testnet" would print a
   *  false one. */
  network?: "testnet" | "mainnet";
  /** Confirmed vouches from this account. Absent means "not told"; a rendered 0 would read as a
   *  claim that this is their first. */
  priorVouches?: number;
  linkage: Linkage;
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
      {/* §5.1's two conditional lines, "inserted before the checkbox" — the consent has to carry
          them, not the screen after it (final review FR-F). They are repeated on the QR step,
          where the guardian is looking at the request itself. */}
      {p.network === "testnet" && (
        <p className="text-[12.5px] leading-[1.6] text-muted-2">
          This agent runs on Arc testnet. The vouch is on World Chain mainnet and is just as
          permanent.
        </p>
      )}
      {p.priorVouches !== undefined && p.priorVouches > 0 && (
        <p className="text-[12.5px] leading-[1.6] text-muted-2">
          You have already vouched for {p.priorVouches}{" "}
          {p.priorVouches === 1 ? "agent" : "agents"} from this account. This vouch will be publicly
          linkable to them.
        </p>
      )}
      {p.linkage !== "none" && (
        <p className="text-[12.5px] leading-[1.6] text-amber-300">
          {p.linkage === "disputed"
            ? "Someone else has vouched for this address. Vouching again replaces theirs in the registry. Every record stays public, and every vouch you make is linkable to the others."
            : "Someone else may have vouched for this address already. Vouching again replaces theirs in the registry. Every record stays public, and every vouch you make is linkable to the others."}
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
  return <p className="mt-4 flex items-center gap-2 text-[13.5px] text-muted-1">{p.children}</p>;
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

type BridgeStore = ReturnType<(typeof import("idkit-core-v2"))["createWorldBridgeStore"]>;

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
  agentId: string;
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
  // An entity can have a pocket and no on-chain id yet — the state the session route refuses with
  // `no-agent-id-yet`. Without this the guardian reads a consent paragraph naming "agent #" with
  // nothing after it, and only learns the agent is not ready after clicking.
  if (!input.agentId) return { loading: false, text: NOT_ON_CHAIN_COPY };
  return null;
}

/** EIP-55, or the value unchanged when it is not an address we can checksum (an older backend's
 *  stored form still renders; an absent one stays absent). Never used for comparison. */
function checksum(address: string | null | undefined): string | null {
  if (!address) return null;
  try {
    return getAddress(address);
  } catch {
    return address;
  }
}
