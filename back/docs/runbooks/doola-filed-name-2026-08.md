# Where the accepted company name is readable — live probe, 2026-08-29 (A1 merge gate 1)

Script: `back/backend/scripts/doola-filed-name-probe.mts` (sandbox-only; creates a company with
three name options, completes formation via the playground, then reads every surface).
Run `1788011951`, customer `3IaoHQb1co3iW7fJTZWhdKkuaqp`, company `3IaoHXXPPiMnrBIkT0DilvlHT3w`.

| Surface | Reports | Matches a candidate? |
|---|---|---|
| `GET /companies/{id}` `.nameOptions` | all three options, `position` **0-based** (`0,1,2`; the docs say `1` = first) | n/a: no winner flag |
| `GET /companies/{id}` top level | no name field at all | n/a |
| `GET /companies?customerId=…` list item `.name` | `"Novi Filed Name Alpha 1788011951"` = our FIRST option WITHOUT its ending | yes (bare name) |
| AOO document `.name` | `playground-articlesoforganization.pdf` (sandbox placeholder) | no |
| `GET /companies/{id}` `.formationFilingNumber` | `PLAYGROUND-FILING` | n/a |

Two operational facts the probe re-proved: the list endpoint is **eventually consistent** (the
probe's immediate list read returned nothing; the same query minutes later returned the row), so
any name read from the list must tolerate an empty first read; and the `position` values a
sandbox company echoes back are 0-based whatever we send, so nothing may key on `position`.

**Conclusion for the §5 matcher (as implemented in A1):** the only surface that reports a name is
the list item, and in sandbox it is always our first option (the playground never rejects a
name), so the probe cannot show what happens when the state files option 2 or 3. The matcher
therefore compares the reported name against the bare `name` of ALL stored candidates (endings
stripped, NFC, casefold) and sets `legal_name_filed` only on a match; a no-match raises the
required-action and leaves `manifest.legal.companyName` absent. The question "where is the
state-accepted name readable when a lower-ranked option wins" is open with doola (asked
2026-08-27); the answer may move the matcher's source, not its rule.
