# Rad Work Order Reviewer

A Rovo agent, built on Atlassian Forge, that reviews a radiation protection
Work Order (WO) in Jira against reference cards kept in Confluence, before
the job starts.

Built for Codegeist 2026 by a senior radiation protection technician.

## The problem

In a nuclear plant, a Work Order describes the job (a valve repair, a
grind-out, an inspection). Radiation protection reviews it against the
procedures before anyone enters the area: dose setpoints, coverage, air
sampling, stay time, contamination controls. The review is done by hand,
under time pressure, and a small omission can end in an unplanned dose or
an intake. Several of the demo Work Orders in this project are modelled on
events described in public NRC documents.

## What the agent does

Ask it in Rovo chat: `Review work order WO-7`.

It answers with:

- **Conflicts**: the WO says something a procedure does not allow.
- **Missing**: a procedure requires something the WO does not state.
- **Covered**: requirements the WO meets.
- **Checked, not needed**: checks that do not apply to this job.
- **Keep in mind during the job**: reminders, with numbers already worked
  out (for example, 80% of a 50 mRem setpoint is 40 mRem).

Every finding cites the NISP-RP document and section it comes from.

The agent says plainly that it is an AI, that it does not approve work, and
that a qualified radiation protection technician makes the decision.

## How it works

```
Rovo chat ──> Rovo agent ──> action: review-work-order
                                 │
                 ┌───────────────┼────────────────┐
                 ▼               ▼                ▼
           Jira issue     Confluence cards   Rules engine
           (the WO)       (status REVIEWED)  (src/engine.js)
```

The design decision that matters: **the language model does not decide the
findings.** A deterministic rules engine in plain JavaScript reads the WO
and applies the rules; the model only presents the result, word for word.

We got there the hard way. The first version let the model do the review.
The same WO gave different counts on different runs, values were invented,
and findings were duplicated. That is not acceptable in an industry where
small errors are penalised. With the engine, the same WO always gives the
same answer, and a regression test proves it.

### Reference cards and governance

The Confluence space `RPREF` holds one card per procedure. A card is a
paraphrase of the requirements with the section number and a link to the
public source, not a copy of the procedure text.

Each card carries `Card status: REVIEWED` or `Card status: DRAFT`. The
engine applies only the rules of REVIEWED cards. Today those are:

| Card | Subject |
|---|---|
| NISP-RP-010 | Radiological job coverage |
| NISP-RP-002 | Radiation and contamination surveys |
| NISP-RP-003 | Radiological air sampling |

Ten more cards (001, 004 to 009, 011 to 013) are in the space as DRAFT.
The agent shows them only when asked, in a separate section, and never
counts them.

### Agent actions

| Action | Purpose |
|---|---|
| `review-work-order` | Runs the engine on a WO and returns the findings |
| `get-work-order` | Reads a WO from Jira |
| `get-reference-cards` | Reads the cards from Confluence |
| `list-capabilities` | What the agent can and cannot do, so it does not over-promise |

Scopes are read-only: `read:jira-work`, `read:space:confluence`,
`read:page:confluence`. The agent writes nothing.

## Run it

Requirements: Node.js 22 or 24, the Forge CLI (`npm install -g @forge/cli`),
an Atlassian site with Jira, Confluence and Rovo.

```
npm install
npm test          # 13 demo Work Orders against expected counts
forge register    # only if you are deploying your own copy
forge deploy
forge install     # once for Jira, once for Confluence
```

Then, on the site:

1. Create a Confluence space with key `RPREF` and add the reference cards.
   Each card title must contain its number, for example `NISP-RP-010`, and
   the page must contain a line `Card status: REVIEWED` or
   `Card status: DRAFT`.
2. Create Work Orders as Jira issues. The engine reads labelled lines in
   the description; `test/fixtures.mjs` has 13 examples.
3. Open Rovo chat, pick **Rad Work Order Reviewer**, and type
   `Review work order <KEY>`.

## Tests

`npm test` runs the engine over 13 Work Orders and compares the number of
conflicts and missing items with `test/expected.mjs`. `node test/run.mjs
--show` prints every finding. A rule change that moves a count fails the
test until the expected value is updated on purpose.

## Sources and data

- Procedures: the NISP-RP series, in the public copies published by
  Westinghouse, and 10 CFR Part 20.
- Demo Work Orders WO-4 to WO-13 are fictional, each inspired by a public
  NRC document cited in the issue.
- Nothing in this repository comes from any employer or restricted source.
  All plant data, names and numbers are invented.

## Limits

- It is a review aid, not an approval. It can miss things.
- It reads Work Orders written with labelled fields. Free text that does
  not follow the format is reported under "Could not read from the WO".
- Three of thirteen procedures have rules today.
- Some findings are field practice rather than procedure; those are
  labelled as such.

## What is next

- Rules for the remaining cards, starting with 004 and 005.
- Cross-check against the survey record instead of the WO text alone.
- Save the review as a Confluence page for the job file.
- A connector for sites that keep their records in a local database.

## Built with

Atlassian Forge, Rovo agents, Jira, Confluence. Development assisted by
Claude (Anthropic). The author, a radiation protection technician, reviews
each card against the public procedures before it is marked REVIEWED.
