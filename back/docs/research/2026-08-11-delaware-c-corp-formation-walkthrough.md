# Delaware C-Corp Formation Walkthrough — Novi Corpus

**Date:** 2026-08-11 · **Status:** ready to execute
**Context:** Executes the recommendation from the 2026-08-09 entity-formation research
(memo artifact: <https://claude.ai/code/artifact/e9fbc24d-14e5-46cb-a582-33212e1a6b12>):
**Delaware C-Corp topco now; French SAS subsidiary later (before anyone is paid in France); Wyoming (DAO-)LLCs stay product-side only.**
Team: 2 French tax residents + 1 US person. Driver: credible funded entity before the Circle grant / Arc Builders Fund conversations; Arc mainnet **Sept 16, 2026**.

---

## TL;DR

| Question | Answer |
|---|---|
| Can it be done 100% online? | **Yes.** Formation, signatures, EIN, and banking are all online. The only possibly-physical step is mailing the 83(b) elections (certified mail; IRS Form 15620 e-filing may now cover this — verify at filing time). No US visit, no SSN/ITIN needed for the French founders. |
| Time to "incorporated" | 1–3 business days after submitting |
| Time to "fully operational" (docs signed, EIN, bank account) | **~2 weeks** (long pole = Mercury KYB review) |
| Hard internal deadline | **83(b) elections within 30 days of stock issuance — no extensions, ever** |
| Cash to incorporate + bank | **~$550** (Stripe Atlas path) |
| Realistic year-1 all-in with professional advice | **~$4k–9k** (counsel review + French fiscaliste opinion + US CPA) |
| Recurring baseline | ~$550/yr to Delaware + agent, plus $1.5k–3k/yr CPA for Form 1120 + 5472 |

---

## Step 0 — Decisions to lock before filing (Day 0, founders only)

1. **Legal name.** e.g. "Novi Corpus, Inc." — check availability on the [Delaware name search](https://icis.corp.delaware.gov/ecorp/entitysearch/namesearch.aspx). The formation service checks this too.
2. **Authorized shares: 10,000,000 common, par value $0.0001.** This is the VC-standard default and what every service pre-fills. ⚠ The scary "$85k Delaware franchise tax" figure people see is the *Authorized Shares Method*; startups always elect the **Assumed Par Value Capital Method** on the annual report → **$400 minimum** while gross assets are small (see Step 7).
3. **Founder equity split + vesting.** Standard: restricted-stock purchases at par, **4-year vesting, 1-year cliff**, IP assignment (CIIA) from all three founders. Decide the split before you file — repricing later is painful.
4. **Officers/directors: the US founder is CEO and sole/lead director on paper-day-one.** This is load-bearing twice over (from the 2026-08-09 memo):
   - It is the primary mitigation for the **#1 risk: French *siège de direction effective* / permanent establishment** (2-of-3 founders running a bare Delaware entity from France is the highest-risk configuration — worldwide French IS requalification, *activité occulte* 80% penalties). Board decisions should be genuinely made and minuted from the US.
   - It makes the US founder the **IRS "responsible party" → same-day online EIN** (vs 4–6 weeks by fax for a foreign responsible party).
5. **Incorporator/registered agent:** the formation service supplies both — nothing to decide.

## Step 1 — Choose the formation service (Day 0)

All three are fully online and incorporate in 1–3 days:

| Service | Price | What you get | Fit |
|---|---|---|---|
| **Stripe Atlas** ⭐ recommended | **$500** one-time | DE filing + fees, **EIN handled**, post-inc doc suite (bylaws, board consent, restricted stock w/ vesting, CIIA, 83(b) prep), 1st-year registered agent ($100/yr after), $2,500 Stripe credits + partner perks | Fastest single-package path to incorporated + EIN + banked; docs are VC-standard |
| Clerky | ~$499 setup (+$299 post-inc pack; $819 lifetime) | The YC document stack, built by ex-WilmerHale lawyers; the paperwork big-firm lawyers prefer in diligence | Marginally better optics for the **Circle Ventures / Arc Builders Fund** diligence path; slightly more self-serve |
| Firstbase | $399 + add-ons | Formation + upsells (bookkeeping, payroll) | Strongest pitch is for teams with *no* US founder — doesn't apply to us |

**Recommendation: Stripe Atlas.** One flow covers Steps 2–5 below, and we already live in the Stripe/Vercel ecosystem. Clerky is the defensible alternative if we want to optimize purely for VC-diligence paperwork.

DIY for reference (not recommended — saves ~$200, loses the document suite): DE certificate of incorporation ~**$109** minimum (fee scales with authorized capital; 10M × $0.0001 par stays in the bottom tier) + expedite fee + registered agent $50–300/yr. Note **HB 400** (signed May 21, 2026) raised expedited-fee *maximums* effective **Aug 1, 2026**: 24-hr up to $300, same-day up to $500, 2-hr up to $1,500, 1-hr up to $2,500. (HB 400's annual-tax hikes hit LLCs — $300→$400 — **not** corporations.)

## Step 2 — File (Days 1–3)

Submit through the service: name, share structure, founder details (French founders: passport + French address — that's all), US founder as director/CEO. Delaware routine processing via the services runs 1–3 business days. Output: **file-stamped Certificate of Incorporation**.

## Step 3 — Post-incorporation documents (Week 1, all e-signed)

The service generates; every founder e-signs:

- Bylaws; initial board consent (appoints officers, adopts everything)
- **Restricted Stock Purchase Agreements** — founders buy shares at par (total ~$100–1,000 real money, actually pay it and keep the receipt), 4-yr/1-yr-cliff vesting
- **Confidential Information & Invention Assignment (CIIA)** from each founder — this is what moves the existing Novi Corpus IP into the company; note the repo/codebase explicitly
- Indemnification agreements (optional but standard)

## Step 4 — EIN (Week 1, same day)

US founder applies as responsible party at the [IRS online EIN application](https://www.irs.gov/businesses/small-businesses-self-employed/apply-for-an-employer-identification-number-ein-online) (weekday US business hours) → **EIN issued instantly**. Atlas handles this within their flow. *(Foreign responsible party would mean Form SS-4 by fax/phone, 4–6 weeks — this is exactly why the US founder holds the role.)*

## Step 5 — 83(b) elections — ⏰ 30 hard days from stock purchase

Because founder stock vests, **each founder should file an 83(b) election within 30 days of the purchase date**. Miss it and every vesting tranche becomes taxable income at then-current value — potentially catastrophic, and there is no relief.

- Use **IRS Form 15620** (the standardized 83(b) form). Canonical safe method: **USPS certified mail with return receipt**, keep a stamped copy. The IRS has been rolling out e-filing for 15620 — use it if live, but keep proof either way.
- **French founders file protectively too.** They're nonresident aliens with (today) no US tax, but a protective 83(b) costs a stamp and forecloses ugly outcomes if they later move to the US or the IRS re-characterizes. → Confirm with the US CPA (it's on the memo's question list).

## Step 6 — Bank account: Mercury (Weeks 1–2)

Apply online with the Certificate of Incorporation + EIN + post-inc docs. Verified in the 2026-08-09 research: **Mercury banks non-custodial crypto infrastructure with foreign founders — no SSN needed for the French founders.** KYB review is the schedule's long pole (days to ~2 weeks).

⚠ **Staying non-MSB is load-bearing for banking.** Describe the business as non-custodial software infrastructure. The memo's caveat stands: the current architecture (shared pocket seed, S3/S4 open, Circle developer-controlled wallets as platform default since P4) cuts against that claim — architecture must match the claim or counsel must re-scope it. Don't oversell "non-custodial" on the KYB form; keep it consistent with what counsel signs off on.

## Step 7 — Recurring compliance calendar

| When | What | Cost |
|---|---|---|
| **March 1, yearly** | Delaware annual report + franchise tax — **elect the Assumed Par Value Capital Method** on the report: $400 minimum while gross assets are low, + $50 report fee. (Authorized-shares method on 10M shares ≈ $85k — never let it default to that.) | **$450** |
| Yearly (anniversary) | Registered agent renewal | $100 (Atlas) |
| **April 15** (calendar tax year) | Federal **Form 1120** + **Form 5472** — 5472 is mandatory (≥25% foreign shareholders), **$25k penalty** per missed form. **Log every related-party transaction from day one** (founder cash in, anything crossing the FR founders or the future SAS). | CPA $1.5k–3k/yr |
| One-time check | FinCEN BOI/CTA: US-formed companies were **exempted** by the March 2025 interim rule — verify still true at filing, then ignore | $0 |
| Ongoing | Board minutes for real decisions, **made and documented from the US** (PE substance) | $0, discipline |

Delaware has no state income tax for corporations not operating in-state; no DE business license needed if not physically there.

## Step 8 — France-side workstream (parallel, before money moves)

Not blocking incorporation, but from the memo, do not skip:

1. **Fiscaliste written opinion** (€2–5k) on (a) *siège de direction effective* / PE exposure with 2 FR founders, and (b) the **123 bis CGI** edge case — a C-Corp whose balance sheet is mostly USDC can look *"préponderamment financière"*. Get this within the first weeks, not after a year.
2. **No French salaries from the C-Corp, ever.** The **French SAS subsidiary** (with a cost-plus agreement; unlocks CIR 30% R&D credit + JEI relief) comes before anyone is paid in France. Full topco+sub structure ≈ **$15–25k phased** — separate, later workstream.
3. French founders as pure shareholders have **no US filing obligations**; dividends (eventually) at the 15% treaty rate, capital gains taxed in France only.

## Step 9 — Optional but recommended: US counsel review

$1k–3k for a startup lawyer to sanity-check the doc set + the non-custodial characterization (feeds both Mercury KYB and the MiCA/money-transmitter analysis). The memo's professional question lists (fiscaliste, US CPA, Circle asks) are in the 2026-08-09 memo artifact.

---

## Budget roll-up

| Scenario | Cost |
|---|---|
| **Bare minimum to incorporated + EIN + banked** | **~$550** (Atlas $500 + certified mail + par-value stock purchases) |
| + US counsel review | +$1k–3k |
| + French fiscaliste written opinion | +€2–5k |
| **Realistic year-1 all-in** | **~$4k–9k** (incl. first CPA cycle) |
| Recurring baseline (yr 2+) | ~$550/yr (DE + agent) + $1.5k–3k CPA |
| Future: French SAS sub + intercompany setup | $15k–25k, phased, post-grant |

## Execution timeline

```
Day 0        Lock name, split, vesting, US founder = CEO/director
Day 0        Start Stripe Atlas application (~1 hr of form-filling)
Day 1–3      Delaware files → Certificate of Incorporation
Week 1       E-sign post-inc docs; founders pay for stock (par)
Week 1       EIN online, same day (US founder = responsible party)
Week 1       Mercury application submitted
Week 1–2     Mercury approved → operational
≤ Day 30     83(b) × 3 founders, certified mail  ⏰ HARD DEADLINE
Weeks 2–4    Fiscaliste opinion + counsel review (parallel)
March 1 '27  First DE franchise tax ($450, assumed-par-value method)
```

## Sources (verified 2026-08-11)

- [Delaware Div. of Corporations — franchise tax calculation](https://corp.delaware.gov/frtaxcalc/) · [annual report & tax](https://corp.delaware.gov/paytaxes/)
- [HB 400 fee changes (CSC)](https://blog.cscglobal.com/delaware-house-bill-400-enacted-new-annual-taxes-and-filing-fee-increases-effective-august-1-2026/) · [Harvard Business Services on HB 400](https://www.delawareinc.com/blog/delaware-franchise-tax-update-hb-400/)
- [Stripe Atlas pricing](https://sparklaun.ch/compare/stripe-atlas) · [Atlas vs Clerky comparison](https://www.flowjam.com/blog/stripe-atlas-vs-clerky-which-is-better-for-your-startup) · [Delaware incorporation costs (Stripe)](https://stripe.com/resources/more/delaware-incorporation-costs-and-fees-what-corporations-and-llcs-need-to-know)
- [Clerky — DE franchise tax help](https://help.clerky.com/article/2796-calculate-delaware-franchise-tax)
- 2026-08-09 entity-formation memo (Carmejane, PE analysis, MiCA, banking): <https://claude.ai/code/artifact/e9fbc24d-14e5-46cb-a582-33212e1a6b12>
