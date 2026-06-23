# Legal Operations — Making the Agent Legal Body Real

> Companion to `SPEC.md` and `RESEARCH_FINDINGS.md`. Produced 2026-06-03 via parallel web
> research (primary sources: Wyoming SOS, W.S. 17-31 statute, IRS SS-4 instructions, MIDAO,
> Bayern/LoPucki scholarship, Doola). Concrete operational detail for the **funded** legal phase.
>
> ⚠️ **Not legal advice.** This is a sourced operational map to validate with counsel (we have a
> lawyer on the team). Items that could not be confirmed against a primary source are flagged
> **[UNVERIFIED]** / **[flagged]**.
>
> ⚖️ **RESOLVED 2026-06-12 — read first.** Verified against primary sources: a fully human-less
> ("Bayern / zero-member") entity is **foreclosed**. A named, KYC'd **natural-person controller-of-record
> is mandatory**, triple-locked by (1) Wyoming DAO LLC statute W.S. 17-31-114 (dissolves an entity not
> under the control of ≥1 natural person), (2) the FinCEN CDD control prong, and (3) Circle's terms. The
> production model is **human-controller + agent-bounded-operator** (the human = our on-chain
> guardian/controller). Good news also verified: holding/operating USDC on-chain is permissionless, and a
> non-custodial design keeps us out of money-transmitter licensing. Treat the Bayern material below as
> origin/context. (Fiat on/off-ramp via Circle Mint is a later, counsel-gated milestone.)

---

## 0. The honest bottom line

A fully autonomous, **end-to-end zero-human entity is NOT achievable today**, in either Wyoming or
the Marshall Islands. A natural person is structurally required at three chokepoints in both paths:

1. **Formation signing** — a person delivers/signs the Articles.
2. **The EIN "responsible party"** — the IRS requires a natural person, never an entity or algorithm.
3. **Bank / fintech onboarding** — KYC attaches to a human signer / beneficial owner.

What *is* achievable: delegate **operational control** to the agent (as manager / via the smart
contract) while a KYC'd human sits at the identity perimeter. The realistic, defensible model is
**"human-backstopped autonomy,"** not memberlessness. The pure Bayern zero-human entity remains
**legally contested and has never been documented as actually formed.** This matches
`RESEARCH_FINDINGS.md` §1 ("treat it as a thesis to defend, not a fact").

---

## 1. The Bayern mechanism, deeper

Core idea (Bayern, *Of Bitcoins, Independently Wealthy Software, and the Zero-Member LLC*, 2014):
an operating agreement can condition the LLC's actions on an algorithm's output, because agreements
and algorithms are functionally isomorphic.

**The four concrete moves:**
1. A human forms a **member-managed LLC**.
2. That member signs an **operating agreement delegating the LLC's decisions to the autonomous
   system / smart contract**.
3. The agreement spells out the algorithmic governance as the operative decision rule.
4. The **sole member dissociates**, leaving zero human members but a still-binding agreement
   pointing at the algorithm.

**The load-bearing trick — overriding the dissolution default:** under RULLCA an LLC dissolves after
**90 consecutive days with no members**. Bayern argues this is only a default the operating
agreement can extend or eliminate. New York is his favored vehicle ("180 days or such other period
as is provided for in the operating agreement" → the "or such other period" hook). RULLCA also lets
an operating agreement condition its amendment on "a person that is not a party… or the satisfaction
of a condition" — i.e. bind the entity to a non-member algorithm.

**Cross-ownership backup** (for states where pure zero-member fails): form two LLCs A and B with
identical algorithm-control agreements, make A a member of B and B a member of A, then the human
withdraws from both. Neither is ever memberless, so the 90-day trigger never fires.

**Honest 2026 status — contested, never done:**
- Bayern: already viable under current US law; one state's permission suffices.
- Sherer (2018): a court likely would **not** recognize a continued zero-member LLC — but concedes
  the cross-ownership loophole could function as the equivalent of legal personhood.
- **No real formation is documented anywhere** (only symbolic events like Sophia's "citizenship").
- LoPucki (*Algorithmic Entities*, 2018) frictions: even if the entity exists on paper, an algorithm
  alone "could not open a bank account, sue to enforce its rights, or contract with legitimate
  businesses" because **it cannot accept responsibility.**

Sources: [Bayern 2014 (Northwestern)](https://scholarlycommons.law.northwestern.edu/nulr/vol108/iss4/9/) ·
[Bayern 2019 (Oxford summary)](https://blogs.law.ox.ac.uk/business-law-blog/blog/2019/11/autonomous-legal-entities-are-already-possible-under-american-law) ·
[LoPucki, *Algorithmic Entities*](https://journals.library.wustl.edu/lawreview/article/3143/galley/19976/view/) ·
[Wikipedia: Algorithmic entities](https://en.wikipedia.org/wiki/Algorithmic_entities).
**[flagged]** Bayern/LoPucki full PDFs could not be parsed; some content is from search extracts of
those primary sources.

---

## 2. Wyoming DAO LLC — concrete filing process

| Item | Detail | Source |
|---|---|---|
| Document filed | **Articles of Organization, DAO version** (no separate "Supplement" form to file; DAO content is folded into the Articles, selected as an "Additional Designation" in WyoBiz) | WY SOS DAO FAQ |
| Required DAO content | Statement it's a DAO (§106(a)); **public identifier of the managing smart contract** = the on-chain **contract address** (§106(b)); notice of restrictions on duties/transfers (§104(c)); statement of how it's managed incl. how much is algorithmic (§104(e)); name must end in **DAO / LAO / DAO LLC** (§106(d)); plus standard LLC content per §17-29-201 (name, registered agent, principal office, organizer signature) | statute + FAQ |
| Registered agent | **Mandatory**, must be a Wyoming agent, continuously maintained (§105(b)). ~**$25–$150/yr** (vendor-priced, indicative) | §105(b) |
| Filing fee / method | **$100** (+~$2–$3.75 online convenience fee), file on **WyoBiz** online (near-instant) or by mail | SOS fee schedule |
| 30-day cure | If filed without the contract identifier, **30 days** to add it by amendment, or the SOS **dissolves** the entity | §105(e) |
| Upgradeable requirement | **Every governing smart contract must be upgradeable.** In practice each contract swap is also an Articles amendment (new address filed) | §109 |
| Liveness rule | **Auto-dissolves after ~1 year** of no approved proposal / no action | SOS FAQ |
| Operating agreement | **Kept PRIVATE** (not filed; only the Articles are public). May define/reduce/eliminate fiduciary duties; good-faith covenant survives (§110); no statutory record-inspection right for on-chain info (§112) | §104–113 |
| Recurring | **Annual report / license tax: min $60/yr** (or $0.0002 × in-state assets, whichever greater), due first day of anniversary month + RA renewal. No state income tax | statebusinesscompliance |

**Nuances:**
- Our **beacon-proxy `LegalManager` already satisfies** the §109 upgradeability requirement.
- Post-2022 the statute dropped the "fully algorithmic" category. Management vests in "members **or**
  members and any applicable smart contracts" (§109) → commentators read this as requiring at least
  one member in the loop. **[flagged]** "at least one natural person" is interpretation, not a
  verbatim statutory phrase. Wyoming contemplates **members + smart contracts, not zero humans.**
- **[UNVERIFIED]** exact paper-filing turnaround for the DAO Articles from a primary SOS source.

Sources: [WY SOS DAO FAQs](https://sos.wyo.gov/Business/Docs/DAOs_FAQs.pdf) ·
[WY DAO Supplement statute](https://sos.wyo.gov/Forms/WyoBiz/DAO_Supplement.pdf) ·
[SF0038](https://www.wyoleg.gov/2021/Introduced/SF0038.pdf) · [WyoBiz](https://wyobiz.wyo.gov).

---

## 3. EIN, tax, banking (no human principal)

- **EIN responsible party must be a natural person** (IRS SS-4, verbatim: "must be an individual…
  not an entity"). An AI / smart contract cannot be it.
- **SSN/ITIN:** required to use the IRS **online** tool. A **foreign** responsible party with no
  SSN/ITIN can write "foreign" on line 7b but must apply by **fax (~4 business days)** or **phone
  (international line 267-941-1099, same-day)** — not online. International fax: 304-707-9471.
- **How "no SSN" services (Doola etc.) work:** foreign-person exception + fax/mail via a third-party
  designee. "No SSN" ≠ "no human."
- **Banking:** a zero-human entity **cannot open** a US account — KYC / beneficial-ownership rules
  require an identified human signer + passport at onboarding. The agent can *operate* the account
  afterward (API keys), but cannot *open* it.

Sources: [IRS SS-4 instructions](https://www.irs.gov/instructions/iss4) ·
[IRS responsible parties](https://www.irs.gov/businesses/small-businesses-self-employed/responsible-parties-and-nominees) ·
[Doola US bank account guide](https://www.doola.com/blog/how-to-open-a-us-bank-account-international/).

### When is an EIN actually required? ("USDC-only / no-bank" refinement)

Researched against primary IRS sources 2026-06-03. **Key correction: operating "USDC-only on Arc,
no US bank account" is a *banking* simplification, NOT a *tax* one.** It removes the bank KYC /
beneficial-ownership onboarding step (the main practical reason LLCs get an EIN), but does not remove
the federal tax obligation or the EIN where an IRS trigger applies.

- **EIN triggers (IRS):** employees; excise tax; multi-member (partnership) taxation; corporate
  election; **foreign ownership** (see below). Opening a bank account is a *bank* requirement, not an
  IRS one. [Get an EIN](https://www.irs.gov/businesses/small-businesses-self-employed/get-an-employer-identification-number) ·
  [Single member LLCs](https://www.irs.gov/businesses/small-businesses-self-employed/single-member-limited-liability-companies).
- **Crypto does NOT avoid tax.** Stablecoins are digital assets = **property**; income is taxable at
  USD fair-market value regardless of currency ("the medium… is immaterial"). [Digital assets](https://www.irs.gov/filing/digital-assets) ·
  [Notice 2014-21](https://www.irs.gov/pub/irs-drop/n-14-21.pdf) ·
  [Digital asset FAQ](https://www.irs.gov/individuals/international-taxpayers/frequently-asked-questions-on-digital-asset-transactions).
- **The split depends on WHO the owner is:**

| Owner (registering user) | EIN needed? | Human's ongoing obligation |
|---|---|---|
| **US person**, single-member, no employees/excise | **No EIN required** — may use owner's SSN; agent income reported on owner's Form 1040 | Owner's 1040 |
| **Foreign person**, once the LLC is funded | **EIN always required** — funding the LLC is itself a "reportable transaction" → **Form 5472 + pro forma 1120** annually, **$25,000** penalty if skipped | SS-4 responsible party + annual 5472 filer |

  Foreign-owned source: [Form 5472 instructions](https://www.irs.gov/instructions/i5472) (T.D. 9796,
  §6038A) + [SS-4 instructions](https://www.irs.gov/instructions/iss4) ("Foreign-owned U.S. disregarded
  entity-Form 5472").

- **Cleanest minimal-footprint structure:** a **US-person user, single-member WY LLC, USDC-only on
  Arc, no US bank account → no EIN**, agent income flows onto the user's personal 1040. About as close
  to "human just signs + reports taxes" as the law allows.
- **Hard floor:** there is **no structure where both the EIN and the human tax-filer disappear.** The
  agent can never be the owner, responsible party, or filer for IRS purposes.

### Where a human is unavoidable (US / Wyoming path)
- Organizer/signer of the Articles (§105(a)).
- Wyoming registered agent (§105(b)) — cannot be the AI agent.
- ≥1 member + non-purely-algorithmic management (§105(a), §109) — interpretive.
- EIN responsible party (natural person, name on SS-4).
- Bank/fintech onboarding (KYC + beneficial owner + passport).

---

## 4. Marshall Islands (MIDAO) DAO LLC

| Item | Amount | Source |
|---|---|---|
| Standard formation (one-time) | **$9,500** | MIDAO pricing |
| Annual renewal | **$2,000–$5,000 / yr** | MIDAO pricing |
| "TurboDAO" 24-hr onboarding | +$10,000 one-time | MIDAO pricing |
| Reseller all-in (varies) | $6k–$17.5k setup | OCI / DAObox |
| Timeline | ~30 days standard; 24h paid | DAObox / MIDAO |

- **Documents:** Certificate of Formation, Company Constitution / Articles of Association, Operating
  Agreement (the OA can simply point to the governance smart contracts — Pyth DAO LLC example).
- **KYC:** ≥1 **human founder** KYC'd at formation; anyone holding **≥25% governance** must be
  identified (passport + address); below 25% stays pseudonymous. Appointed managers/officers are
  normally treated as UBOs and identified.
- **Agent-as-manager-not-owner:** token holders are members/owners; management can be fully
  **algorithmic** (no required directors/officers). The agent *controls/operates*; members *own*.
- **Ongoing:** RMI registered agent + office always; **annual Beneficial Owner Information Report
  (BOIR)** (Jan 1–Mar 31 window **[UNVERIFIED]** at primary RMI source); annual renewal ~$2k–$5.5k;
  no "show activity or dissolve" liveness rule.
- **vs Wyoming:** also **human-backstopped** (needs a KYC'd founder), but no public smart-contract
  identifier filing and no 1-year liveness/dissolution rule. Purpose-marketed to "AI organizations."
  **Fully manual / white-glove, no API.**

Sources: [MIDAO pricing](https://www.midao.org/pricing) ·
[MIDAO jurisdiction comparison](https://docs.midao.org/the-marshall-islands-rmi-dao-llc/the-marshall-islands-rmi-dao-llc-vs.-other-jurisdictions-and-legal-forms) ·
[DAObox guide](https://docs.daobox.io/educational/marshall-islands-dao-llc-as-a-dao-legal-wrapper-comprehensive-guide) ·
[Offshore Companies Intl](https://offshoreincorporate.com/marshall-islands-dao-llcs/).

---

## 5. The per-registration runbook (automation reality)

**Closest thing to "formation as an API" = Doola:**
- Both a **Company Formation API** and an **in-Claude/Replit MCP** (launched **Apr 30 2026**); forms
  **Wyoming LLCs**, handles EIN + registered agent + US bank account, "no SSN required."
- **DAO LLC** supported via the API/whitelabel product (**not** confirmed in the consumer MCP — that
  launch described standard LLCs only). Access via "iFrame, API or MCP."
- **Pricing:** whitelabel formation from **~$297/company** + state fee. Retail: Starter $297/yr,
  Tax & Compliance $1,999/yr, Business-in-a-Box $2,999/yr.
- **Catch [flagged]:** whitelabel partner terms reportedly require **~150 formations/month and ~$25k/
  month** for the first 6 months — a high floor for an early platform; likely negotiable. For a first
  single entity, use the retail plan.

**Registered-agent-as-a-service (WY):** WyomingAgents ~$25/yr; Northwest free first year then $125/yr;
range ~$25–$249/yr. No public standalone developer API (bundled into formation partners).

**EIN:** **no public real-time API exists.** Services "handle the EIN" by staff-submitting SS-4
(fax/phone for non-US founders). Phone EIN can be same-day; fax days–weeks.

**MIDAO:** no API, fully manual — **unsuitable for per-registration automation** (15–25× the WY cost).
Useful only for a single flagship entity.

### Automation vs human-in-the-loop

| STEP | AUTOMATABLE? | WHO/WHAT | COST | TIME |
|---|---|---|---|---|
| Draft DAO operating agreement | One-time, reusable | Attorney (once) | ~$1–5k one-time **[est.]** | days (once) |
| Deploy governing smart contract | Yes | Your dev / Arc | gas only | minutes |
| File Articles of Organization (WY) | **Yes (API/MCP)** | Doola | $100 state + $297 | same-day |
| Registered agent | Yes (bundled) | Doola / WY agent | $25–125/yr | instant |
| EIN | Operationally automated, **not** a real IRS API; human responsible party | Doola submits SS-4 | $0 IRS | same-day phone → ~1–2 wk fax |
| KYC of responsible party | **No — human** | Founder + bank partner | included | minutes–days |
| US bank account | Human-in-loop (KYC) | Doola bank partner | included | days |
| Smart-contract identifier in articles | Yes (contract must be live first) | Doola / filing | included | instant |
| BOI / CTA filing | **N/A — US domestic exempt in 2026** | FinCEN (foreign only) | $0 | — |
| Annual report + license tax (WY) | Yes (recurring) | Doola / SOS e-file | ~$60/yr | annual |
| **MI alternative (whole stack)** | **No — fully manual** | MIDAO | $9,500 + $2k–$5k/yr | 24h–3wk + bank 4–8wk |

**Per-entity Wyoming:** ~**$400–600 first year**, ~**1 day to 2 weeks**.

**BOI / Corporate Transparency Act (2026) — VERIFIED:** US-formed (domestic) entities and US persons
are **currently EXEMPT** from FinCEN BOI reporting (interim final rule **March 26, 2025**); only
foreign-formed entities registered in the US remain reporting companies. **Still interim, not
finalized — could be reinstated.** Design the compliance layer to re-enable BOI if that happens.
Sources: [FinCEN news release](https://www.fincen.gov/news/news-releases/fincen-removes-beneficial-ownership-reporting-requirements-us-companies-and-us) ·
[Milligan Lawless 2026 update](https://www.milliganlawless.com/corporate-transparency-act/corporate-transparency-act-update-2026/).

### Minimum viable legal stack (testnet demo → ONE real entity with EIN + wallet)
1. Engage an attorney **once** to template a Wyoming-DAO-compliant operating agreement (reusable).
2. **Deploy the governing smart contract first** (required before an algo-managed DAO can register),
   or form a member-managed standard LLC to avoid the live-contract constraint.
3. **Form via Doola** (API or MCP) → Articles + registered agent (human approves payment).
4. **Get EIN** via Doola (staff-submitted SS-4; a human founder named as responsible party).
5. **Open US bank account** via Doola's bank partner (KYC on the responsible party).
6. **Provision the on-chain wallet** (Circle/Arc — separate layer) and reference its contract
   identifier in the DAO Articles.
7. **No BOI filing** (domestic exemption). Calendar the **$60 annual report** + RA renewal.

Doola sources: [newswire launch](https://www.newswire.com/news/doola-launches-agentic-llc-formation-start-a-u-s-company-in-minutes-22772465) ·
[Company Formation API](https://www.doola.com/business-solutions/company-formation-api/) ·
[pricing](https://www.doola.com/pricing/).

---

## 6. Implications for our protocol design

1. **Reframe "zero-human" → "human-backstopped autonomy."** The agent owns operations; a KYC'd human
   (settlor / responsible party) anchors identity. More honest, still novel. **The `guardian` role in
   `LegalManager` is a natural home for that backstop human.**
2. **The USDC-only-on-Arc lever (corrected, see §3):** operating purely in USDC with no US bank
   account removes the **banking** chokepoint, not the **tax/EIN** one. It pays off most for a
   **US-person user, single-member LLC** (no employees) → **no EIN**, income on the owner's 1040.
   For a **foreign-person** user it buys nothing on the IRS side (EIN + annual Form 5472 still
   required). So **owner nationality is an architectural input**, and a US-person + single-member +
   USDC-only + no-bank path is the minimal-human-footprint structure. Confirm with counsel.
3. **Jurisdiction strategy:** **Wyoming first** (cheap, automatable via Doola, repeatable), **MIDAO**
   for a single marquee entity (too manual/expensive per-registration).
4. **Role assignment (who is who):** four distinct roles, deliberately split — **Organizer** (files
   the Articles; us or the formation partner, low-risk), **Member/owner** (the registering **user**),
   **EIN responsible party** (the **user**), **Bank beneficial owner** (the **user**, only if a bank
   account is opened). We are infrastructure + organizer, **never** the responsible party/beneficial
   owner across many entities (unacceptable liability + KYC load). Liability chain:
   `user (human anchor) → LLC → ERC-8004 agentId → LegalManager → Circle wallet`. ERC-8004 stays the
   on-chain identity hub (stores EIN + OA hash); the LLC is its off-chain legal twin.
5. **Build vs buy:** integrate a **formation provider (Doola or similar) behind the `FormationProvider`
   interface** — they supply the legal shell (file LLC, EIN, registered agent, optional bank); **we**
   supply the agent body (ERC-8004 identity, LegalManager governance, law↔code policy translation,
   USDC treasury, autonomy). "Doola turns a human into a US company; we turn a US company into an
   autonomous on-chain agent." For the demo / first entity, go retail or semi-manual; negotiate a
   partner API only at volume (their whitelabel minimums looked steep, and DAO-LLC-via-API is
   unconfirmed).
6. **Cost lever at scale:** one LLC per agent (~$400-600 each) vs a **Wyoming Series LLC** (one parent,
   cheap sub-series per agent with liability walls). Series could cut per-agent cost dramatically;
   confirm the liability isolation and DAO-supplement interaction with counsel.

---

## 7. Items to confirm before relying on them
- Paper-filing turnaround for the WY DAO Articles (primary SOS source).
- Doola whitelabel minimums (~150/mo, ~$25k/mo) — confirm with Doola partnerships; likely negotiable.
- MIDAO annual BOIR window (Jan 1–Mar 31) against a primary RMI source.
- Whether Doola's consumer (in-Claude) MCP forms **DAO** LLCs vs standard LLCs only.
- Attorney one-time OA-template cost (estimate only).
- Whether a USDC-native, no-US-bank entity can lawfully skip/defer the EIN (counsel question).
