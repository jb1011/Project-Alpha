"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { useConnection, usePublicClient } from "wagmi";
import { StepNav } from "@/components/onboarding/OnboardingFlow";
import {
  Button,
  Callout,
  Card,
  Field,
  SectionTitle,
  Spinner,
  StepHeader,
  TextInput,
} from "@/components/onboarding/primitives";
import { useAllowedWrite, useLegalBodyOrdersQuery } from "@/lib/api/legalBodyHooks";
import type { Hex } from "@/lib/api/types";
import { arcTestnet, txUrl } from "@/lib/chain";
import { identityRegistryAbi, registerCall } from "@/lib/legalBody/chain";
import { LEGAL_BODY_COPY, fillCopy } from "@/lib/legalBody/copy";
import { sameAddress } from "@/lib/legalBody/flow";
import {
  REGISTER_RECEIPT_TIMEOUT_MS,
  cardOutcomeView,
  identityCardOutcome,
  identityChainOutcome,
  identityStepOffer,
  networkName,
  parseAgentId,
  parseAgentUri,
  readOwnerOf,
  registerFailureLines,
  registerReceiptOutcome,
  registerRefusalSentence,
  registerSendFailure,
  registrationView,
  suggestionCardOf,
  takenAgentIdOf,
  type CardOutcomeView,
  type IdentityCard,
  type IdentityCardOutcome,
  type RegistrationStage,
} from "@/lib/legalBody/identity";
import { noticeSentence } from "@/lib/legalBody/notice";
import type { IdentitySuggestionEvent } from "@/lib/legalBody/resume";
import type { OwnerChoice } from "@/lib/legalBody/storage";
import type { LegalBodyStepKit } from "./LegalBodyFlow";

const I = LEGAL_BODY_COPY.identity;

/** The chains this site reads: wagmi's config holds `arcTestnet` alone. */
const SITE_CHAIN_IDS: readonly number[] = [arcTestnet.id];

type Choice = IdentityCard | "register" | "suggestion";
type Checked = { card: IdentityCard; agentId: string; outcome: IdentityCardOutcome };
type Busy = "reading" | "sending" | "waiting" | null;

/** What the step tells the shell about the identity it offers again: a registration's new
 *  identity, a pick, and an offered identity found taken. */
export type IdentityStepEvent = Extract<
  IdentitySuggestionEvent,
  { kind: "registered" | "picked" | "dropped" }
>;

/**
 * Your agent's identity: which on-chain identity the legal body will stand behind.
 *
 * Three cards. "This wallet owns the identity" and "The identity is owned by another key" take an
 * agent id, read its owner on the chain (`ownerOf` through the public client, with the pinned ABI;
 * a revert means no identity with this id), read the tenant's orders again, and let
 * `identityCardOutcome` decide: an identity that already has a body is refused, this wallet's
 * identity is picked as this wallet's, and another key's is shown with its owner before the
 * person continues with it. "Register a new identity for this wallet" sends one `register`
 * transaction through the one allowlist (`useAllowedWrite`), waits up to three minutes for its
 * receipt, and takes the minted id from it; when the receipt names no id, the transaction's link
 * and a field for the id by hand.
 *
 * When the shell offers the identity already chosen on this visit (`suggestedAgentId`: picked or
 * registered, then left by a jump back on the rail), it comes first, with "Continue with" and
 * its id, and the three cards follow under "Or choose another identity" (`identityStepOffer`).
 * "Continue with" is a click that runs the same reads and the same decision as a typed id
 * (`suggestionCardOf` picks the card the answer is worded for): this wallet's identity is picked
 * at once, another key's is shown with its owner first, and a taken one is said and no longer
 * offered.
 *
 * A pick writes the owner choice and the identity to the memory, and the derivation moves on to
 * the link; the step also tells the shell (`onIdentity`) of a pick, a registration and an offered
 * identity found taken. Every read and the one transaction are a click's; nothing is sent on
 * mount. The one effect forgets an identity the derivation refused as taken, so the person picks
 * another; the refusal stays on screen.
 */
export function IdentityStep({
  kit,
  suggestedAgentId,
  onIdentity,
}: {
  kit: LegalBodyStepKit;
  /** The identity already chosen on this visit, offered first; null or absent for none. */
  suggestedAgentId?: string | null;
  /** Tells the shell of a registration, a pick, and an offered identity found taken. */
  onIdentity?: (event: IdentityStepEvent) => void;
}) {
  const { config, tenant, remember } = kit;
  const environment = config.environment;
  const chainStop = identityChainOutcome(config.chainId, SITE_CHAIN_IDS);
  const where = { chainId: config.chainId, factory: config.factory };

  const publicClient = usePublicClient({ chainId: config.chainId });
  const { address } = useConnection();
  const send = useAllowedWrite();
  const ordersQuery = useLegalBodyOrdersQuery();

  // The derivation's refusal of a remembered identity: kept on screen once the memory forgets it.
  const forget = takenAgentIdOf(kit.derivation);
  const [taken, setTaken] = useState<string | null>(forget);
  useEffect(() => {
    if (forget !== null) remember({ agentId: null });
  }, [forget, remember]);
  // An offered identity this step found taken: no longer offered here, whatever the shell says.
  const [dropped, setDropped] = useState<string | null>(null);
  const offer = identityStepOffer({
    suggestedAgentId: suggestedAgentId === dropped ? null : suggestedAgentId,
    orders: kit.orders,
    where,
  });
  const suggested = offer.kind === "suggestion" ? offer.agentId : null;
  const takenShown = forget ?? taken ?? (offer.kind === "taken" ? offer.agentId : null);
  const takenNotice = takenShown
    ? noticeSentence({ kind: "identity_taken", agentId: takenShown }, environment)
    : null;

  const [choice, setChoice] = useState<Choice | null>(null);
  const [idInput, setIdInput] = useState("");
  const [idProblem, setIdProblem] = useState<string | null>(null);
  const [uriInput, setUriInput] = useState("");
  const [uriProblem, setUriProblem] = useState<string | null>(null);
  const [checked, setChecked] = useState<Checked | null>(null);
  // The sentences of the last click that did not move the flow.
  const [lines, setLines] = useState<string[]>([]);
  const [busy, setBusy] = useState<Busy>(null);
  const [registration, setRegistration] = useState<{ stage: RegistrationStage; hash: Hex } | null>(
    null,
  );
  // Set and cleared inside a click: a second click before the first settles sends nothing.
  const inFlight = useRef(false);

  const view: CardOutcomeView | null = checked
    ? cardOutcomeView({ ...checked, environment })
    : null;

  /** A pick: the owner choice and the identity to the memory, and the shell told. */
  function pick(next: { ownerChoice: OwnerChoice; agentId: string }) {
    remember(next);
    onIdentity?.({ kind: "picked", agentId: next.agentId });
  }

  function choose(next: Choice) {
    if (inFlight.current) return;
    setChoice(next);
    setChecked(null);
    setLines([]);
    setIdProblem(null);
    setUriProblem(null);
  }

  function editId(value: string) {
    setIdInput(value);
    setIdProblem(null);
    setChecked(null);
  }

  /** The click on an identity card: the typed id, then its reads and outcome. */
  async function onCheck(card: IdentityCard) {
    if (inFlight.current || chainStop) return;
    setChecked(null);
    setLines([]);
    setTaken(null);
    const agentId = parseAgentId(idInput);
    if (agentId === null) {
      setIdProblem(I.agentIdProblem);
      return;
    }
    setIdProblem(null);
    await readIdentity(agentId, card);
  }

  /** The click on "Continue with": the offered identity, read and decided as a typed id. */
  async function onContinueSuggested(agentId: string) {
    if (inFlight.current || chainStop) return;
    setChoice("suggestion");
    setChecked(null);
    setLines([]);
    setTaken(null);
    setIdProblem(null);
    setUriProblem(null);
    await readIdentity(agentId, "suggestion");
  }

  /** The owner and the orders read for an id, then the outcome, worded for the card it came from
   *  (for the offered identity, the card its answer belongs to). */
  async function readIdentity(agentId: string, from: IdentityCard | "suggestion") {
    const client = publicClient;
    if (!client) {
      setLines([I.ownerUnread]);
      return;
    }
    inFlight.current = true;
    setBusy("reading");
    try {
      const [owner, fresh] = await Promise.all([
        readOwnerOf(() =>
          client.readContract({
            address: config.identityRegistry,
            abi: identityRegistryAbi,
            functionName: "ownerOf",
            args: [BigInt(agentId)],
          }),
        ),
        // The tenant's orders as they are now: an identity linked a moment ago is refused too.
        ordersQuery.refetch(),
      ]);
      if (fresh.error && kit.routeSignIn(fresh.error)) return;
      if (owner === "unreadable") {
        setLines([I.ownerUnread]);
        return;
      }
      // The facts decide, not the card: the offered identity is read as this wallet's card would.
      const outcome = identityCardOutcome({
        card: from === "suggestion" ? "this-wallet" : from,
        agentId,
        ownerOf: owner,
        connected: tenant,
        orders: fresh.data?.orders ?? kit.orders,
        where,
      });
      if (from === "suggestion" && outcome.kind === "taken") {
        // Said as the taken sentence, and no longer offered: the cards are the way on.
        setTaken(agentId);
        setDropped(agentId);
        setChoice(null);
        onIdentity?.({ kind: "dropped", agentId });
        return;
      }
      const card = from === "suggestion" ? suggestionCardOf(outcome) : from;
      const next = cardOutcomeView({ card, agentId, outcome, environment });
      if (next.auto && next.pick) {
        pick(next.pick);
        return;
      }
      setChecked({ card, agentId, outcome });
    } finally {
      inFlight.current = false;
      setBusy(null);
    }
  }

  /** This wallet's card found another key's identity: the third card, with what was read. */
  function toThirdCard() {
    if (!checked) return;
    setChoice("elsewhere");
    setChecked({ ...checked, card: "elsewhere" });
  }

  /** The click on "Register a new identity": one transaction, then its receipt. */
  async function onRegister() {
    if (inFlight.current || chainStop) return;
    setLines([]);
    const uri = parseAgentUri(uriInput);
    if (uri !== null && typeof uri === "object") {
      setUriProblem(uri.problem);
      return;
    }
    setUriProblem(null);
    // The wallet that sends is the one signed in: the minted identity must be the guardian's.
    if (!address || !sameAddress(address, tenant)) {
      setLines([I.notConnected]);
      return;
    }
    const client = publicClient;
    if (!client) {
      setLines([registerRefusalSentence("chain_not_configured", environment)]);
      return;
    }
    inFlight.current = true;
    setBusy("sending");
    setRegistration(null);
    try {
      let sent: Awaited<ReturnType<typeof send>>;
      try {
        sent = await send(registerCall(config, uri), { config, order: kit.order });
      } catch (e) {
        setLines(registerFailureLines(registerSendFailure(e), environment));
        return;
      }
      if (!sent.ok) {
        setLines([registerRefusalSentence(sent.problem, environment)]);
        return;
      }
      const hash = sent.hash;
      setRegistration({ stage: "waiting", hash });
      setBusy("waiting");
      let receipt: Awaited<ReturnType<typeof client.waitForTransactionReceipt>>;
      try {
        receipt = await client.waitForTransactionReceipt({
          hash,
          timeout: REGISTER_RECEIPT_TIMEOUT_MS,
        });
      } catch {
        setRegistration({ stage: "no_receipt", hash });
        return;
      }
      const outcome = registerReceiptOutcome(receipt, {
        registry: config.identityRegistry,
        owner: address,
      });
      if (outcome.kind === "registered") {
        remember({ ownerChoice: "this-wallet", agentId: outcome.agentId });
        onIdentity?.({ kind: "registered", agentId: outcome.agentId });
        return;
      }
      setRegistration({ stage: outcome.kind, hash });
    } finally {
      inFlight.current = false;
      setBusy(null);
    }
  }

  const idForm = (action: string, card: IdentityCard) => (
    <AgentIdForm
      value={idInput}
      problem={idProblem}
      busy={busy !== null}
      action={action}
      onChange={editId}
      onSubmit={() => void onCheck(card)}
    />
  );

  const result = (
    <Result view={view} lines={lines} reading={busy === "reading"} onToThirdCard={toThirdCard} />
  );

  const shownRegistration = registration ? registrationView(registration.stage) : null;
  // Once a transaction was sent and may have registered, the way on is its id, not a second one.
  const canRegister = registration === null || registration.stage === "reverted";

  return (
    <div>
      <StepHeader
        eyebrow={LEGAL_BODY_COPY.rail.labels.identity}
        title={I.title}
        intro={fillCopy(I.intro, { network: networkName(environment) })}
      />

      {takenNotice && (
        <Callout tone="warn" title={takenNotice.title} className="mb-6">
          {takenNotice.body}
        </Callout>
      )}

      {chainStop ? (
        <Callout tone="warn">
          {fillCopy(I.otherChain, { network: networkName(environment) })}
        </Callout>
      ) : (
        <div className="flex flex-col gap-4">
          {suggested !== null && (
            <>
              <SuggestionCard
                agentId={suggested}
                chosen={choice === "suggestion"}
                busy={busy}
                onContinue={() => void onContinueSuggested(suggested)}
              >
                {result}
              </SuggestionCard>
              <SectionTitle className="mt-4">{I.orChooseAnother}</SectionTitle>
            </>
          )}
          <ChoiceCard
            title={I.ownCard}
            body={I.ownBody}
            chosen={choice === "this-wallet"}
            disabled={busy !== null}
            onChoose={() => choose("this-wallet")}
          >
            {idForm(I.useIdentity, "this-wallet")}
            {result}
          </ChoiceCard>

          <ChoiceCard
            title={I.registerCard}
            body={I.registerBody}
            chosen={choice === "register"}
            disabled={busy !== null}
            onChoose={() => choose("register")}
          >
            <form
              className="mt-5 flex flex-col gap-4"
              onSubmit={(e) => {
                e.preventDefault();
                if (canRegister && busy === null) void onRegister();
              }}
            >
              <Field
                label={I.uriLabel}
                hint={I.uriHint}
                error={uriProblem ?? undefined}
                htmlFor="legal-body-agent-uri"
              >
                <TextInput
                  id="legal-body-agent-uri"
                  type="url"
                  value={uriInput}
                  onChange={(e) => {
                    setUriInput(e.target.value);
                    setUriProblem(null);
                  }}
                  invalid={uriProblem !== null}
                  autoComplete="off"
                  spellCheck={false}
                  disabled={busy !== null}
                />
              </Field>
              <p className="text-[12.5px] leading-[1.6] text-muted">
                {LEGAL_BODY_COPY.wallet.neverApprove}
              </p>
              {canRegister && (
                <div>
                  <Button type="submit" loading={busy === "sending"} disabled={busy !== null}>
                    {I.register}
                  </Button>
                </div>
              )}
            </form>

            {registration && shownRegistration && (
              <Callout tone={shownRegistration.tone} className="mt-5">
                <span className="flex flex-col gap-2">
                  <span className="flex items-center gap-2">
                    {registration.stage === "waiting" && <Spinner className="h-3.5 w-3.5" />}
                    {shownRegistration.text}
                  </span>
                  <a
                    href={txUrl(registration.hash)}
                    target="_blank"
                    rel="noreferrer"
                    className="break-all font-mono text-[11.5px] underline underline-offset-2"
                  >
                    {I.viewTransaction}: {registration.hash}
                  </a>
                </span>
              </Callout>
            )}
            {shownRegistration?.manualEntry && idForm(I.useIdentity, "this-wallet")}
            {result}
          </ChoiceCard>

          <ChoiceCard
            title={I.elsewhereCard}
            body={I.elsewhereBody}
            chosen={choice === "elsewhere"}
            disabled={busy !== null}
            onChoose={() => choose("elsewhere")}
          >
            {idForm(I.readOwner, "elsewhere")}
            {result}
          </ChoiceCard>
        </div>
      )}

      {view?.pick && (
        <StepNav>
          <Button onClick={() => view.pick && pick(view.pick)}>
            {view.pick.ownerChoice === "this-wallet" ? I.continueHere : I.continueElsewhere}
          </Button>
        </StepNav>
      )}
    </div>
  );
}

/** The identity already chosen on this visit, offered first: its id, and "Continue with" it. */
function SuggestionCard({
  agentId,
  chosen,
  busy,
  onContinue,
  children,
}: {
  agentId: string;
  chosen: boolean;
  busy: Busy;
  onContinue: () => void;
  children: ReactNode;
}) {
  return (
    <Card className={chosen ? "p-6 ring-1 ring-accent/40" : "p-6"}>
      <div className="text-[14px] font-medium text-ink">{I.yourIdentity}</div>
      <div className="mt-2 break-all font-mono text-[15px] text-ink">{agentId}</div>
      <p className="mt-1 text-[12.5px] leading-[1.6] text-muted">{I.suggestionBody}</p>
      <div className="mt-5">
        <Button
          onClick={onContinue}
          loading={chosen && busy === "reading"}
          disabled={busy !== null}
        >
          {fillCopy(I.continueWith, { agentId })}
        </Button>
      </div>
      {chosen && children}
    </Card>
  );
}

/** One of the three cards: its name and what it does; once chosen, its form. */
function ChoiceCard({
  title,
  body,
  chosen,
  disabled,
  onChoose,
  children,
}: {
  title: string;
  body: string;
  chosen: boolean;
  disabled: boolean;
  onChoose: () => void;
  children: ReactNode;
}) {
  return (
    <Card className={chosen ? "p-6 ring-1 ring-accent/40" : "p-6"}>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="text-[14px] font-medium text-ink">{title}</div>
          <p className="mt-1 text-[12.5px] leading-[1.6] text-muted">{body}</p>
        </div>
        {chosen ? (
          <span className="rounded-full border hairline-strong px-2.5 py-0.5 font-mono text-[11px] text-muted">
            {I.chosen}
          </span>
        ) : (
          <Button
            variant="subtle"
            onClick={onChoose}
            disabled={disabled}
            aria-label={`${I.choose}: ${title}`}
          >
            {I.choose}
          </Button>
        )}
      </div>
      {chosen && children}
    </Card>
  );
}

function AgentIdForm({
  value,
  problem,
  busy,
  action,
  onChange,
  onSubmit,
}: {
  value: string;
  problem: string | null;
  busy: boolean;
  action: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
}) {
  return (
    <form
      className="mt-5 flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
    >
      <Field
        label={I.agentIdLabel}
        hint={I.agentIdHint}
        error={problem ?? undefined}
        htmlFor="legal-body-agent-id"
      >
        <TextInput
          id="legal-body-agent-id"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          invalid={problem !== null}
          inputMode="numeric"
          autoComplete="off"
          spellCheck={false}
          disabled={busy}
        />
      </Field>
      <div>
        <Button type="submit" loading={busy} disabled={busy}>
          {action}
        </Button>
      </div>
    </form>
  );
}

/** What the last click found, inside the open card: the reading, the outcome, the sentences. */
function Result({
  view,
  lines,
  reading,
  onToThirdCard,
}: {
  view: CardOutcomeView | null;
  lines: string[];
  reading: boolean;
  onToThirdCard: () => void;
}) {
  return (
    <>
      {reading && (
        <div className="mt-5 flex items-center gap-2 text-[13px] text-muted">
          <Spinner className="h-3.5 w-3.5" /> {I.reading}
        </div>
      )}
      {view && (
        <Callout tone={view.tone} title={view.title ?? undefined} className="mt-5">
          <span className="break-words">{view.text}</span>
          {view.toThirdCard && (
            <span className="mt-3 block">
              <Button variant="ghost" onClick={onToThirdCard}>
                {I.toThirdCard}
              </Button>
            </span>
          )}
        </Callout>
      )}
      {lines.length > 0 && (
        <Callout tone="warn" className="mt-5">
          <span className="flex flex-col gap-2">
            {lines.map((line) => (
              <span key={line}>{line}</span>
            ))}
          </span>
        </Callout>
      )}
    </>
  );
}
