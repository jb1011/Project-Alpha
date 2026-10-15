import type { CheckReasonCode } from "@/lib/api/types";

/**
 * Every sentence the legal-body flow shows, in one place, grouped by screen.
 *
 * A screen takes its words from here and never writes its own, so one test walks them all against
 * the claims ceiling: "a registered legal body", and never a word that claims more than the facts
 * behind it; no em dash; "verified" said only of the person (`PERSON_SENTENCES`); "Novi Corpus"
 * everywhere, and "Novi" alone only in the one approved sentence (`APPROVED_NOVI_SENTENCES`). On
 * a deployment that charges nothing, the one sentence about money is `sandbox.noPaymentStep`.
 *
 * The API's refusal sentences are not here: a screen shows them as served, never rewritten.
 *
 * `{name}` marks a value the screen fills in with `fillCopy`.
 */

/** The yes sentence: what a counterparty may say of an `active` standing, and nothing more. */
const YES_SENTENCE =
  "a registered legal body stands behind this agent, and Novi states its standing as active";

/** Said of the person on record, never of a company. */
const PERSON_ON_RECORD =
  "World ID shows a verified person behind this account; every legal body on it relies on that record.";

const OPERATOR_CHECKS =
  "A Novi Corpus operator checks the declaration against the registry and your document. This is done by a person; it is not instant.";

export const LEGAL_BODY_COPY = {
  page: {
    title: "A legal body for your agent",
    description:
      "Give an AI agent you already run a registered legal body: declare your company, sign the link, and point the agent's on-chain identity at the body.",
  },

  frame: {
    exit: "Exit",
    loading: "Loading…",
  },

  rail: {
    heading: "A legal body for your agent",
    footer:
      "Two signatures and one or two transactions from your wallet. Never an approval or a transfer.",
    labels: {
      signin: "Sign in",
      human: "Accountable human",
      company: "Your company",
      agreement: "Agreement",
      identity: "Your agent's identity",
      link: "Sign the link",
      pointer: "Point your identity",
      payment: "Payment",
      done: "Done",
    },
  },

  door: {
    notOffered: "This deployment does not offer legal bodies on your own identity.",
    home: "Back to the home page",
    unreadable: "This deployment's settings could not be read just now.",
    retry: "Try again",
  },

  sandbox: {
    banner:
      "Arc testnet. The company is a test declaration, its check is automatic, and the wording is a draft; nothing here is a filing.",
    noPaymentStep: "There is no payment step on this testnet deployment.",
  },

  wallet: {
    neverApprove: "Never approve or transfer anything to Novi Corpus.",
  },

  signIn: {
    title: "Sign in with the wallet that will answer for the legal body.",
    intro:
      "This wallet becomes the guardian: it signs the company's declaration and the link, and it is the wallet that answers for the legal body.",
    body: "Connect the wallet you want as the guardian, then sign in with it. Signing in asks for a signature only: it sends nothing and approves nothing.",
    checking: "Reading this wallet on the chain…",
    checkFailedTitle: "This wallet could not be read",
    checkFailed:
      "The chain could not be read just now, so it is not yet known whether this wallet can sign the declaration.",
    smartAccountTitle: "A plain wallet is needed",
    smartAccount:
      "This wallet is a smart account. The declaration needs a plain wallet signature, so a smart account cannot be the guardian here.",
    expiredTitle: "Your sign-in has ended",
    expired: "Sign in again with the same wallet to continue. Nothing was changed.",
    signInAgain: "Sign in again",
    errorTitle: "Something went wrong",
    retry: "Try again",
    continue: "Continue",
  },

  human: {
    titleAsk: "Who answers for this agent?",
    titleAccepted: "A person is on record.",
    introAccepted: PERSON_ON_RECORD,
    product:
      "A legal body for your agent needs a real person on record; a waiver is not accepted for this product.",
    points: [
      "Only a unique person can stand behind an agent's legal body.",
      "Novi Corpus stores a nullifier, never your name, document or face.",
      "Verify once; every legal body on this account relies on it.",
    ],
    notAccepted:
      "The record on this account is not accepted for this product: it needs a real World ID verification, and a waiver does not count.",
    unavailable:
      "This deployment cannot check World ID, so a legal body cannot be requested here.",
    checking: "Reading the guardian record…",
    unreadable: "The guardian record could not be read just now.",
    verify: "Verify with World ID",
    continue: "Continue",
    retry: "Try again",
    back: "Back",
    worldErrors: {
      sameHuman:
        "This person is already on record for another account. World issues one proof per person here, so it cannot be used again for this account.",
      dismissed:
        "You dismissed the request in World App. Nothing was recorded; start again when you are ready.",
      other: "World ID could not finish the verification ({code}). Nothing was recorded; try again.",
    },
  },

  thread: {
    loading: "Reading your companies and orders…",
    unreadable: "Your companies and orders could not be read just now.",
    retry: "Try again",
    placeholder: "This step is not available on this page yet.",
  },

  chooser: {
    title: "Which one do you want to continue?",
    intro:
      "You have more than one company or order in progress. Pick one; the others stay as they are.",
    unnamed: "A declared company",
    companyRow: "Declared; no order placed yet",
    orderStates: {
      draft: "Order placed; the link is not signed yet",
      reserved: "Novi Corpus is creating the body",
      deployed: "Body created; the pointer is not written yet",
      broken: "Body created; its pointer needs writing again",
      other: "Order in progress",
    },
    identity: "Identity {agentId}",
    continue: "Continue this one",
  },

  closed: {
    /** The closed screen's heading: the order is closed, not done. */
    eyebrow: "This order",
    newOrder: "Place a new order",
    newCompany: "Declare a company",
    unknownTitle: "This order cannot move",
    unknownBody: "Its state is not one this page knows, so nothing is offered for it.",
  },

  /** The notices of the derivation, one per kind; `notice.ts` picks and fills them. */
  notices: {
    expired: {
      title: "This order expired",
      body: "A draft can be linked for 24 hours after it is placed, and this one was not. Nothing was created.",
    },
    lapsed: {
      title: "This order lapsed",
      reasons: {
        deadline_passed:
          "The signed link reached its deadline before the body was created, so the reservation closed without a body.",
        owner_changed:
          "The identity changed hands, and its new owner signed a link for it, so this reservation closed without a body.",
        foreign_body:
          "A body made for another owner already stands where this order's body would have been created, so the reservation closed without a body.",
        refused_before_send:
          "The chain would have refused to create the body, so nothing was sent and the reservation closed.",
        unknown: "The reservation closed without a body.",
      },
    },
    superseded: {
      title: "A newer order took this one's place",
      body: "A newer order for the same identity was linked, so this one can no longer move.",
    },
    replaced: {
      title: "Another body was linked in this one's place",
      body: "A newer body was linked to the same identity. Writing this body's pointer again would undo that, so it is not offered.",
    },
    newerOrder: "The newer order is {by}.",
    abandoned: {
      title: "This order was abandoned",
      body: "It can no longer move.",
    },
    order_revoked: {
      title: "This order was revoked",
      body: "A Novi Corpus operator revoked it, and a revocation is never undone.",
    },
    other_deployment: {
      title: "This order belongs to another deployment",
      body: "It was placed under another chain or factory, so it can be read here and nothing else.",
    },
    company_failed: {
      title: "The company's check did not pass",
      noReason: "The check did not pass, and no reason was recorded.",
      wayBackSandbox: "Declare the company again with a new test declaration.",
      wayBackProduction:
        "You can add evidence and wait for a new check, or declare the company again.",
    },
    company_revoked: {
      title: "The company's check was revoked",
      body: "A Novi Corpus operator revoked the check, so no new order can move on this company.",
    },
    company_awaiting_check: {
      title: "The company is waiting for its check",
      sandbox:
        "On this testnet the check is normally written at the declaration; this company was put back to be checked again, and waits for an operator.",
      production: OPERATOR_CHECKS,
    },
    company_abandoned: {
      title: "This company was abandoned",
      body: "It can take no order. Declare the company again to continue.",
    },
    creating: {
      title: "Novi Corpus is creating the body",
      body: "This takes a few seconds; this page checks again every 5 seconds.",
    },
    winding_down: {
      title: "This body is winding down",
      body: "The body reports that it is winding down, so no pointer is offered for it.",
    },
    dissolved: {
      title: "This body is dissolved",
      body: "The body reports that it is dissolved, so no pointer is offered for it.",
    },
    broken_reason_unknown: {
      title: "The pointer is no longer seen",
      body: "The identity no longer points at this body, and the reason could not be read, so no pointer is offered for now.",
    },
    identity_taken: {
      title: "This identity already has a legal body",
      body: "Identity {agentId}: this identity already has a legal body; replacing it is not offered yet.",
    },
  },

  /* ── The steps after the gates. Each screen's own sentences, carried here so the one walk covers
        them from the start. ─────────────────────────────────────────────────────────────────── */

  company: {
    declarationsOff: "This deployment does not take new declarations.",
    nameHintSandbox: "On this deployment the company name must say it is a test.",
    numberHintSandbox: "It starts with TEST- and no other company has used it.",
    nameCharset:
      "may hold only the characters a Wyoming entity name takes: A-Z, a-z, 0-9, spaces and & ' - , . ( ) +",
    sandboxCheck:
      "On this testnet the check is automatic and checks nothing. On production you upload a document showing you control the company, for example the IRS EIN letter naming you, and a Novi Corpus operator checks it against the Wyoming registry.",
    testLabel: "test declaration",
    draftWording: "draft wording",
    waiting: OPERATOR_CHECKS,
    evidenceUnavailable: "The upload is not available on this screen yet.",
    newDeclaration: "Declare the company again",
    title: "Declare your company",
    introSandbox: "Name a test company and sign the statement of authority with this wallet.",
    introProduction:
      "Declare the Wyoming LLC behind your agent and sign the statement of authority with this wallet.",
    labels: {
      companyName: "Company name",
      filingNumber: "Filing number",
      declarantName: "Your legal name",
      declarantTitle: "Your title in the company",
    },
    /** Shown on a sandbox only, where both are inventions that say they are a test. */
    placeholdersSandbox: {
      companyName: "Example Test Holdings LLC",
      filingNumber: "TEST-0001",
    },
    numberHintProduction: "The number the Wyoming registry gave the company.",
    sign: "Sign the declaration",
    statementHeading: "The statement you sign",
    wordingVersion: "wording {version}",
    renewed:
      "The statement was issued too long ago to be accepted, so a new one was asked for. Read it and sign again.",
    declined: "Your wallet did not sign, so nothing was sent.",
    declinedOtherNetwork:
      "Your wallet did not sign, so nothing was sent. It is on another network than {network}, and a wallet may refuse to sign this statement until it is switched there.",
    refused:
      "The statement served does not match what you typed or this deployment ({problem}), so your wallet was not opened and nothing was declared.",
    noAnswer:
      "No answer came back, so whether the declaration was made is not known yet. Your companies are read again; if nothing changes, try again.",
    alreadyYours: "You already declared a company with this number.",
    continueWith: "Continue with that company",
    evidenceTitle: "Evidence for the check",
    abandon: "Abandon this company",
    abandonConfirm: "Abandoning closes this company for good: it can take no order again.",
    abandonYes: "Abandon it",
    abandonKeep: "Keep it",
    abandonNoAnswer:
      "No answer came back, so whether the company was abandoned is not known yet; try again.",
    /** The declaration doors' own problems, word for word, shown under the field they name. A
     *  door's answer, when it comes, is shown instead. */
    problems: {
      required: "is required",
      control: "holds a control or invisible character",
      otherSpace: "holds a space other than a plain space",
      doubleQuote: "holds a double quote",
      length: "must be {min} to {max} characters long",
      nameTest: "must say it is a test on this deployment",
      numberCharset: "may hold only A-Z, a-z, 0-9 and hyphens",
      numberTest:
        "must be a test number on this deployment: TEST- then 4 to 27 of A-Z, 0-9 and hyphens",
      declarantNameCharset: "may hold only letters, spaces, apostrophes, hyphens and full stops",
      declarantTitleCharset:
        "may hold only letters, digits, spaces, apostrophes, hyphens, full stops, &, / and commas",
    },
  },

  agreement: {
    placeOrder: "Place the order and read the agreement",
    continueDraft: "Continue with the order placed {hours} hours ago",
    unverifiable: "The agreement could not be checked against its hash.",
    hashNote: "this is what your link will sign",
    readCheckbox: "I have read this draft",
    draftWording: "draft wording",
    title: "Read the operating agreement",
    introBefore:
      "Placing the order freezes the operating agreement for it: the text, and the hash your link will sign. A draft order can be linked for 24 hours, and placing it sends nothing from your wallet.",
    introAfter:
      "This is the operating agreement of your order, frozen when the order was placed. Read it before you go on; nothing is recorded on this step.",
    continueDraftOneHour: "Continue with the order placed 1 hour ago",
    continueDraftRecent: "Continue with the order placed less than an hour ago",
    draftOffered:
      "This company already has a draft order that can still be linked, so it is offered instead of a new one.",
    termsHeading: "The operating agreement",
    wordingVersion: "wording {version}",
    hashLabel: "Agreement hash",
    delay:
      "Amendment delay: {delay}. A change to this agreement takes effect only once this delay has passed since it was scheduled.",
    expiry:
      "This draft can be linked until {time}, {left} from now; after that it expires, and a new order is needed.",
    reading: "Reading the agreement…",
    unreadable: "The agreement could not be read just now.",
    retry: "Try again",
    continue: "Continue",
    cannotContinue:
      "The order is placed, but your orders could not be read again yet. Reload this page to continue with it.",
    noAnswer:
      "No answer came back, so whether the order was placed is not known yet. Your orders are read again; if nothing changes, try again.",
    /** Durations in words, for the delay, the expiry and a draft's age. */
    words: {
      lessThanAnHour: "less than an hour",
      hour: "1 hour",
      hours: "{n} hours",
      minute: "1 minute",
      minutes: "{n} minutes",
      second: "1 second",
      seconds: "{n} seconds",
    },
  },

  identity: {
    ownCard: "This wallet owns the identity",
    registerCard: "Register a new identity for this wallet",
    elsewhereCard: "The identity is owned by another key",
    taken: "this identity already has a legal body; replacing it is not offered yet",
    receiptUnreadable:
      "the registration could not be read from the receipt: enter the agent id by hand",
    title: "Which identity will the legal body stand behind?",
    intro:
      "Your agent's identity on the ERC-8004 identity registry of {network}. The key that owns it signs the link; this wallet stays the guardian either way.",
    ownBody:
      "Enter its agent id. This page reads the identity's owner on the chain, and it must be this wallet.",
    registerBody:
      "This wallet sends one transaction that registers a new identity it owns. It approves nothing and transfers nothing.",
    elsewhereBody:
      "Enter its agent id. This page reads the identity's owner; that key signs the link wherever it lives, and you paste the signature back here.",
    chosen: "Chosen",
    choose: "Choose",
    agentIdLabel: "Agent id",
    agentIdHint: "the number the identity registry gave your agent",
    agentIdProblem:
      "must be a whole number as the registry gave it: digits only, no sign, no leading zero, within uint256",
    useIdentity: "Use this identity",
    readOwner: "Read the owner",
    reading: "Reading the identity's owner on the chain…",
    ownerUnread:
      "The chain could not be read just now, so the identity's owner is not known yet. Try again.",
    noIdentity:
      "There is no identity {agentId} on the identity registry of {network}. Check the number, or register a new identity.",
    ownedHere:
      "Identity {agentId} is owned by this wallet, so this wallet signs the link and writes the pointer here.",
    notThisWallet:
      "Identity {agentId} is owned by {owner}, not by this wallet. If that key signs for it, use the third card: the identity is owned by another key.",
    ownedElsewhere:
      "Identity {agentId} is owned by {owner}. That key signs the link wherever it lives and writes the pointer; this wallet stays the guardian.",
    toThirdCard: "Use the third card",
    continueHere: "Continue with this wallet",
    continueElsewhere: "Continue with that key",
    otherChain:
      "This site reads {network} only, and this deployment names another chain, so the identity cannot be read or registered here.",
    uriLabel: "Agent URI",
    uriHint: "optional; where your agent's registration file lives",
    uriProblems: {
      length: "must be at most 2,048 characters long",
      characters: "holds a space, a control or an invisible character",
      https: "must be an https address",
    },
    register: "Register a new identity",
    notConnected:
      "This wallet is not connected in this browser just now. Connect it again to register; nothing was sent.",
    waiting:
      "Waiting for the registration to be confirmed on the chain. This can take up to 3 minutes.",
    viewTransaction: "See the transaction",
    reverted: "The registration transaction failed on the chain, so no identity was registered.",
    noReceipt:
      "No receipt came back within 3 minutes, so whether the registration landed is not known yet. Look at the transaction; once it is confirmed, enter the agent id by hand.",
    rejected: "Your wallet did not send the registration, so nothing was registered. It said: {message}",
    rejectedNoWords: "Your wallet did not send the registration, so nothing was registered.",
    cannotSendWayOut:
      "If another key that can send owns your agent's identity, use the third card.",
    otherNetwork:
      "Your wallet is on another network than {network}. Switch it there and register again; nothing was sent.",
    refusedBeforeWallet:
      "The registration was refused before your wallet opened ({problem}), so nothing was sent.",
  },

  link: {
    sign: "Sign",
    creating: "Novi Corpus is creating the body",
    placeNewOrder: "Place a new order",
    tryAgainSoon: "try again in a moment",
    buildFailed: "something went wrong building the link",
  },

  paste: {
    signerNote:
      "sign this with the key that owns identity {agentId}, wherever it lives: your agent's signer, a hardware wallet, or circle wallet sign typed-data; a signer that takes whole typed data signs it as is; an ethers signer must drop types.EIP712Domain",
    sendFromOwner: "send this from the owner key",
    sent: "I sent it",
  },

  pointer: {
    sentence:
      "Your wallet will write a pointer from identity {agentId} to body {body} on {network}; this is the only transaction, and it approves nothing.",
    networkSandbox: "Arc testnet",
    networkProduction: "Arc",
    factoryMismatch: "the pointer could not be checked against the factory",
    identityMoved:
      "The identity changed hands since the link; its current owner needs a new link, which makes a new body.",
    gas: "Your wallet needs a little native USDC on Arc testnet for gas; the Arc testnet faucet provides it.",
    keepChecking: "We keep checking; this page updates when the pointer is seen.",
    cannotSend:
      "Your wallet can sign but it cannot send a transaction on Arc, so it cannot write the pointer. The identity's owner must be a key that can send, or its sponsor must pay.",
    chainUnread: "could not read the chain just now",
    sevenDays:
      "Novi Corpus stops watching an unpointed body after 7 days and the order no longer counts against your open orders; the body stays where it is, and a refresh from this page links it.",
  },

  done: {
    yes: YES_SENTENCE,
    notYetVisible: "the record appears within a minute of the pointer being seen",
    notYetPaid: "not yet paid",
    checkNotStanding: "the operator's check is no longer standing",
    chainUnread: "the chain could not be read just now",
    filingFactsMissing: "the filing facts are not recorded",
    anotherAgent: "Get a legal body for another agent",
    anotherCompany: "Declare another company",
  },

  entry: {
    button: "Get a legal body for an agent you already run",
  },

  transparency: {
    intro:
      "Legal bodies on customer-owned identities. On Arc testnet these are test declarations, checked automatically, and nothing here is a filing.",
    statTile: "Legal bodies on own identities",
    unavailable: "The legal-body list could not be read just now.",
    empty: "No legal body is linked yet.",
  },
} as const;

/** Why an operator's check failed, one sentence per reason code. The operator's own words are
 *  never served, so these are all a screen can say. */
export const CHECK_REASON_SENTENCES: Record<CheckReasonCode, string> = {
  name_mismatch: "The name on the registry does not match the declared company name.",
  filing_not_found: "The registry has no filing with the declared filing number.",
  not_active: "The registry does not show the company as active.",
  control_not_shown: "The documents do not show that you control the company.",
  other: "The operator could not confirm the declaration.",
};

/** The only sentences allowed to say "verified": each is about the person on record. */
export const PERSON_SENTENCES: readonly string[] = [PERSON_ON_RECORD];

/** The only sentences allowed to say "Novi" without "Corpus". */
export const APPROVED_NOVI_SENTENCES: readonly string[] = [YES_SENTENCE];

/** `template` with each `{name}` replaced by its value. A name with no value stays as written, so
 *  a missing value shows up as a visible mistake rather than a silent gap. */
export function fillCopy(template: string, values: Readonly<Record<string, string>>): string {
  return template.replace(/\{([a-zA-Z]+)\}/g, (whole, name: string) =>
    Object.prototype.hasOwnProperty.call(values, name) ? values[name] : whole,
  );
}
