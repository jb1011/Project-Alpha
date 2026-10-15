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
    tryAgainSoon: "Your order is kept: try again in a moment, with Sign.",
    buildFailed:
      "Something went wrong building the link on this page, so the link door could not read it, and nothing was created. Sign again; if this repeats, reload the page.",
    title: "Sign the link with this wallet",
    intro:
      "Your wallet signs one message, the link, which binds identity {agentId} to the legal body of this order. Signing sends nothing and approves nothing.",
    howItWorks:
      "When you click Sign, this page asks for the link, checks every field of it against your order, your identity, the agreement you read and this wallet, and only then opens your wallet.",
    fieldsHeading: "The link you sign",
    fields: {
      agentId: "agentId",
      guardian: "guardian",
      amendmentDelay: "amendment delay",
      agreementHash: "agreement hash",
      deadline: "deadline",
      domain: "domain",
    },
    yourWallet: "your wallet",
    theOneYouRead: "the one you read",
    deadlineIn: "in {left}",
    lessThanAMinute: "less than a minute",
    domainValue: "{name}, version {version}, chain {chainId}, verifying contract {contract}",
    asking: "Asking for the link…",
    inWallet: "Waiting for your wallet…",
    sending: "Sending the signed link…",
    retry: "Try again",
    identityUnknown:
      "The identity for this order is not known on this page. Go back to the identity step and pick it again.",
    refused:
      "The link served does not match your order, your identity, the agreement you read or this wallet ({problem}), so your wallet was not opened and nothing was signed.",
    declined: "Your wallet did not sign the link, so nothing was sent.",
    declinedOtherNetwork:
      "Your wallet did not sign the link, so nothing was sent. It is on another network than {network}, and a wallet may refuse to sign the link until it is switched there.",
    notConnected:
      "This wallet is not connected in this browser just now. Connect it again to sign; nothing was asked for and nothing was sent.",
    noAnswerMessage: "No answer came back for the link, so nothing was signed. Try again.",
    noAnswerSubmit:
      "No answer came back, so whether the link was taken is not known yet. Your order is read again; if it has not moved, try again, and the same signed link is sent.",
    unreadableAnswer:
      "The answer to the signed link could not be read, so whether it was taken is not known yet. Your order is read again; if it has not moved, sign again.",
  },

  /** The identity is owned by another key: the link is signed and the pointer sent wherever that
   *  key lives. Data only on these screens: typed data, a hex value, a decoded call. */
  paste: {
    signerNote:
      "sign this with the key that owns identity {agentId}, wherever it lives: your agent's signer, a hardware wallet, or circle wallet sign typed-data; a signer that takes whole typed data signs it as is; an ethers signer must drop types.EIP712Domain",
    sendFromOwner: "send this from the owner key",
    sent: "I sent it",

    title: "Sign the link with the key that owns the identity",
    intro:
      "Identity {agentId} is owned by another key. That key signs the link wherever it lives, and you paste its signature back here; your wallet is not asked for anything on this step.",
    howItWorks:
      "When you click Get the link, this page asks for the link with a six-hour deadline, checks every field of it against your order, your identity, the agreement you read and this wallet as the guardian, and only then shows it to copy.",
    getLink: "Get the link",
    owner: "The identity's owner, as the link door read it: {owner}.",
    typedDataHeading: "The typed data to sign, exactly as served",
    copy: "Copy",
    copied: "Copied",
    copyByHand: "Select the text above and copy it.",
    signatureLabel: "The signature",
    signatureHint: "hex, with or without 0x, at most 2,048 bytes",
    send: "Send the signature",
    /** Said under the signature field; the field's label comes first. */
    problems: {
      empty: "is empty: paste the signature the owner key made",
      not_hex: "holds a character that is not hex: only 0-9 and a-f, with or without 0x",
      odd_length: "has an odd number of hex digits, so it is not whole bytes",
      too_long: "is longer than 2,048 bytes",
    },
    refused:
      "The link served does not match your order, your identity, the agreement you read or this wallet as the guardian ({problem}), so it is not shown and nothing should be signed.",
    ttlAboveMax:
      "This deployment serves links for less than six hours, so a link to sign elsewhere cannot be asked for here.",
    stale:
      "This link's deadline is too close to use, so the signature was not sent. Get the link again and sign the new one.",
    tryAgainSoon: "Your order is kept: in a moment, send the same signature again.",
    unreadableAnswer:
      "The answer to the signature could not be read, so whether it was taken is not known yet. Your order is read again; if it has not moved, send the signature again.",
    mcp: "An automated agent can take these steps with the MCP tools get_link_message, submit_link and get_binding instead. They need an API key, minted on /agents/connect as for any connection, and that key reaches further than one link: it acts for your whole account. This page never asks for one.",

    pointerTitle: "Write the pointer from the key that owns the identity",
    pointerIntro:
      "Identity {agentId} is owned by another key, so that key sends the one transaction that points the identity at its legal body. This page shows the call to send; your wallet is not asked for anything on this step.",
    checking: "Checking the pointer against the factory, and the identity's owner, on the chain…",
    checksUnread: "The chain could not be read just now, so the call is not shown yet. Try again.",
    callRefused:
      "The call could not be built for this order ({problem}), so it is not shown and nothing should be sent.",
    pointerStop: "The call is not shown, so nothing should be sent from the owner key: {reason}.",
    noIdentity:
      "The identity registry has no identity {agentId} now, so no pointer can be written for it.",
    rows: {
      from: "from",
      to: "to",
      function: "function",
      agentId: "agentId",
      key: "key",
      value: "value",
      nativeValue: "native value",
    },
    notes: {
      from: "the identity's owner",
      to: "the identity registry",
      value:
        "96 bytes: version 1, chain {chainId}, body {body}; the same bytes the factory encodes for this body",
      nativeValue: "nothing is sent with the call",
    },
    calldataHeading: "The calldata",
    gasSandbox:
      "The owner key pays the gas: it needs a little native USDC on Arc testnet, which the Arc testnet faucet provides.",
    gasProduction: "The owner key pays the gas: it needs a little native USDC on Arc.",
    watching:
      "This page reads the identity's pointer on the chain every 30 seconds for two minutes. Once the transaction is sent, click I sent it.",
    seen: "The pointer is on the chain. Click I sent it, and Novi Corpus checks it now.",
    watchEnded:
      "This page has stopped reading the pointer. Once the transaction is sent, click I sent it.",
    refreshing: "Asking Novi Corpus to check the pointer…",
    refreshNoAnswer: "No answer came back from the check just now.",
    retry: "Try again",
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
