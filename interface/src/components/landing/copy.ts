/** One promise and one onboarding count for every marketing surface. */
export const CREATE_COMPANY_CTA = "Create a company";

export const CREATE_SHORT_CTA = "Create";

export const ONBOARDING_STEP_COUNT = 8;

export const SEE_HOW_CTA = "See how it works";

export const READ_QUESTIONS_CTA = "Read the questions";

/**
 * Every sentence the public marketing pages show.
 * A test walks the strings: no dash characters, and no claim that this deployment files a real company.
 */
export const LANDING = {
  badge: "Live on Arc testnet. Mainnet soon.",
  problem:
    "Agents can already pay, but nobody will sign a contract with one or lend to it, because there is nobody to sue.",
  product:
    "A Wyoming DAO LLC, a USDC treasury, and spending rules on Arc. You set the limits and stay the guardian. Real filings are not on yet.",
  reasons: [
    {
      title: "Limited liability",
      body: "For the operator, through a Wyoming LLC. Real filings are not on yet.",
    },
    {
      title: "Rules the agent cannot break",
      body: "A spending cap, a pause, and who it may pay. The chain enforces them.",
    },
    {
      title: "Anyone can check",
      body: "The legal body behind the agent, and that a person answers for it.",
    },
  ],
  why: {
    label: "Why a legal body",
    heading: "A legal entity for an AI agent",
    intro:
      "An agent can already pay. A contract, a loan, or a claim needs a company on the other side, and a person who answers for it. That is the liability a Wyoming DAO LLC is meant to hold. On this testnet the company is a test declaration, and nothing here is a filing.",
    points: [
      {
        title: "Someone to answer",
        body: "Anyone dealing with the agent gets a registered body to check, and a person who stands behind it. A wallet alone gives them neither.",
      },
      {
        title: "Rules the agent cannot break",
        body: "You set a spending cap, a pause, and who the agent may pay. The agreement and the chain say the same thing.",
      },
      {
        title: "A record anyone can check",
        body: "Before they pay or sign, they can see whether a legal body stands behind the agent.",
      },
    ],
  },
  stepsHeading: "From a passkey to a company.",
  stepsLede:
    "Eight steps, in plain words. The same path as onboarding, on Arc testnet.",
  steps: [
    {
      title: "Wallet and passkey",
      body: "Sign in with your wallet, then create a passkey. The passkey is how you approve as a person.",
    },
    {
      title: "A person on record",
      body: "Verify with World ID. One person stands behind the company. We store a proof of that, never your name, a document, or a face.",
    },
    {
      title: "The company",
      body: "Bring a company you already own, or start a Wyoming LLC. On this testnet it is a test declaration. Nothing here is a filing.",
    },
    {
      title: "Who holds the keys",
      body: "Novi Corpus can hold the agent key, or you can hold it under your passkey. You can pause either way.",
    },
    {
      title: "The rules",
      body: "Set how much the agent may spend, and who it may pay.",
    },
    {
      title: "The agreement",
      body: "Those rules become the operating agreement. The chain enforces the same limits.",
    },
    {
      title: "On chain",
      body: "The agent is registered, the treasury is deployed, and you are recorded as the guardian.",
    },
    {
      title: "Test funds",
      body: "The platform can send test USDC to the treasury, up to 25 USDC at a time. You do not sign that transfer. It is test money, not a deposit.",
    },
  ],
  faq: {
    label: "Questions",
    heading: "What people ask first",
    items: [
      {
        q: "What is an AI agent LLC?",
        a: "A Wyoming DAO LLC with a person who answers for the agent, and spending rules the agent cannot break. On this testnet the company is a test declaration. Nothing here is a filing.",
      },
      {
        q: "Is the LLC real?",
        a: "Not on this deployment. The company is a test declaration, its check is automatic, and nothing here is a filing. Real Wyoming filings are not switched on yet.",
      },
      {
        q: "Who files it?",
        a: "When filings are on, Novi Corpus forms the Wyoming LLC. Today nothing is filed with the state.",
      },
      {
        q: "What does it cost?",
        a: "Free on testnet. There is no payment step on this deployment. A live filing will show its price before you pay.",
      },
      {
        q: "Which countries?",
        a: "The company Novi Corpus forms is a Wyoming LLC, in the United States. You can also declare a company you already control. This testnet does not file either one.",
      },
      {
        q: "What does World ID store?",
        a: "A proof that one unique person stands behind the account. Not your name, a document, or a face.",
      },
      {
        q: "Who holds the USDC?",
        a: "You choose. Novi Corpus can hold the agent key, or you hold it under your passkey. On testnet the platform can add test USDC, up to 25 USDC at a time. That is test money, not a deposit of yours.",
      },
    ],
  },
  close: {
    label: "Guardian controlled",
    heading: "A company someone can check.",
    body: "On Arc testnet you set the rules and stay the guardian. A real Wyoming filing is not on yet.",
    notes: ["Free on testnet", "You can pause and veto", "Test USDC only"],
  },
  preview: {
    window: "Agent desk",
    policyLabel: "Policy",
    policy: "Spend within your caps. Pause or veto anytime.",
    chip: "Testnet",
    agent: "Your agent",
    meta: "Test company on Arc",
    points: ["USDC treasury", "Rules you set"],
    status: "Guardian controls on",
    you: "You",
    role: "Guardian. Pause and veto.",
  },
  privacy: {
    title: "Privacy",
    paragraphs: [
      "Novi Corpus Labs, Inc. runs this site.",
      "When you verify with World ID, we store a nullifier. That is a proof one unique person stands behind the account. We do not store your name, a document, or a face.",
      "When you create a company, we store your wallet address, the company declaration, and the spending rules you set. On this testnet the company is a test declaration.",
      "On testnet the platform can send test USDC to a treasury, up to 25 USDC at a time. That is test money. It is not a deposit of yours.",
      "You can let Novi Corpus hold the agent key, or hold it yourself under your passkey. Signing in asks for a signature. It does not approve a transfer from your wallet.",
      "This page is a plain account of what the product stores. It is not a full legal policy.",
    ],
  },
  terms: {
    title: "Terms",
    paragraphs: [
      "Novi Corpus Labs, Inc. runs this site.",
      "The product on this site runs on Arc testnet. Mainnet is not on yet.",
      "A company you create here is a test declaration. Nothing here is a filing with Wyoming, and it is not a real LLC.",
      "There is no charge on this deployment. A live filing will show its price before you pay.",
      "Test USDC in a treasury is test money. The platform can send up to 25 USDC at a time. You do not sign that transfer. It is not cash you can redeem.",
      "You stay the guardian of what you create. You can pause it.",
      "These pages are not legal advice.",
    ],
  },
  notFound: {
    title: "This page is not here.",
    body: "The address may be wrong, or the page may have moved.",
    home: "Back home",
  },
} as const;

if (LANDING.steps.length !== ONBOARDING_STEP_COUNT) {
  throw new Error("Landing walkthrough must match ONBOARDING_STEP_COUNT");
}
