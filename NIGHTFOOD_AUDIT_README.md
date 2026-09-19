# Nightfood Holdings, Inc. — PCAOB Audit Portal

A document-exchange and close-control platform for **NGTF** and its auditor, built on the same
Node/Express/PostgreSQL stack as the civil-litigation module in `tezlaw-bot`.

Management uploads; the portal reads each file, works out what it is, files it in the designated
folder, ticks the checklist item it satisfies, and tells the auditor what arrived and why it matters.
The auditor downloads, accepts or rejects, and raises review notes. Every period generates its own
checklist — monthly, quarterly, annual — with the questions that catch the documents nobody
remembered existed.

---

## 1. Install

### Files to add to `tezlawpc/tezlaw-bot`

```
audit-taxonomy.js      Document brackets and categories — the source of truth
audit-calendar.js      Fiscal calendar, SEC deadlines, AS 1215 clocks
audit-classifier.js    Auto-classification (deterministic + Claude Haiku)
audit-checklists.js    Monthly / quarterly / annual checklist generation
audit-schema.js        Tables, indexes, AS 1215 immutability triggers
audit-auth.js          Self-contained authentication and roles
audit-notify.js        Notification routing and outbox
audit-store.js         Engagements, documents, checklist logic
audit-api.js           HTTP routes
audit-ui.js            Server-rendered pages
audit-mount.js         Single entry point (in-process mount)
audit-server.js        Standalone entry point — own service, own database
render.yaml            Render blueprint for the standalone service
```

Drop them in the repository root alongside `civil-litigation.js`. **No new npm dependencies** — the
module uses `express`, `multer`, `pg`, `nodemailer`, `node-cron`, `xlsx`, `mammoth`, `pdf-parse`,
`axios` and `@anthropic-ai/sdk`, all already in `package.json`.

### Choose a deployment shape

The portal runs either way, from the same files. **Standalone is the one to use.**

| | **A. Standalone service** (recommended) | **B. In-process** |
|---|---|---|
| Runs as | Its own Render web service | Inside `tezlaw-bot` |
| Database | Its own Postgres | Shares the bot's |
| Entry point | `node audit-server.js` | two lines in `server.js` |
| Crash domain | Separate | Shared with Zara |
| Redeploys when | Only `audit-*.js` change | Every bot commit |
| Cost | One web service + one Postgres | Nothing |

Three reasons standalone wins, in order of how much they should worry you:

1. **TAAD gets credentials.** An outside audit firm holding logins on the service that also
   holds the firm's client matters is hard to defend if anyone ever asks, and the database is
   shared even though the tables are not.
2. **WeChat has a five-second reply window.** The portal parses PDFs and spreadsheets up to
   50MB. In-process, one large upload blocks the event loop and Zara's WeChat reply is simply
   lost.
3. **It should end up at Nightfood.** Once NGTF is listed, this is the issuer's
   books-and-records system and belongs in Nightfood's own Render account, not its counsel's.
   Moving a standalone service is a DNS change. Extracting audit tables from a shared database
   is a project.

---

### Option A — standalone service

Files are the same; add `audit-server.js` and `render.yaml` to the eleven listed above.

**1. Create the database.** Render dashboard → **New → Postgres**. Name `ngtf-audit-db`,
database `ngtf_audit`, a paid plan so you get daily backups. This holds audit evidence under a
seven-year AS 1215 retention obligation, so the free tier's no-backup posture is not appropriate.
Copy the **Internal Database URL**.

**2. Create the web service.** **New → Web Service**, point it at `tezlawpc/tezlaw-bot`, the
same repo the bot uses. Then:

| Setting | Value |
|---|---|
| Name | `ngtf-audit-portal` |
| Runtime | Node |
| Build command | `npm ci --omit=dev` |
| Start command | `node audit-server.js` |
| Health check path | `/healthz` |
| Plan | Starter (512MB) |

**3. Set environment variables** on the new service:

```
DATABASE_URL        <Internal Database URL from step 1 — NOT the bot's>
NODE_ENV            production
AUDIT_BASE_PATH     /audit
AUDIT_TZ            America/New_York
AUDIT_MAX_FILE_MB   50
AUDIT_FROM_NAME     Nightfood Audit Portal
AUDIT_FROM_EMAIL    <a Nightfood address, not a Tez Law one>
AUDIT_SMTP_USER     <smtp user>
AUDIT_SMTP_PASS     <smtp password>
ANTHROPIC_API_KEY   <optional — see §5>
```

`AUDIT_PORTAL_URL` can be left unset; it falls back to `RENDER_EXTERNAL_URL`, which Render
populates with this service's own address.

> **Double-check `DATABASE_URL` before the first deploy.** If it points at the bot's database,
> the portal will create its tables there and quietly succeed, which is the one mistake this
> whole arrangement exists to prevent.

**4. Set a build filter** so bot commits do not redeploy the portal. Service → **Settings →
Build Filters → Included Paths**:

```
audit-*.js
db.js
package.json
```

Without this, every autoposter tweak restarts the portal, possibly during fieldwork.

**5. Deploy**, then confirm:

```bash
curl https://ngtf-audit-portal.onrender.com/healthz
# {"ok":true,"service":"ngtf-audit-portal","base":"/audit", ...}
```

`ok:true` means the process is up *and* its database answers. Visit the root URL and you are
redirected to `/audit/setup`.

**6. Custom domain.** Use a Nightfood domain, not `tezlawfirm.com` — `audit.nightfood.com` or
similar. The hostname the auditors see should not be their client's law firm.

If you prefer to do all of this from a blueprint instead of the dashboard, `render.yaml` in the
repo has the same configuration; merge its two entries into the bot's existing `render.yaml` if
one is already there.

---

### Option B — in-process

Two lines in `server.js`, near the other feature mounts:

```js
const ngtfAudit = require("./audit-mount");
ngtfAudit.mount(app);
```

Nothing else. The module creates its own tables on boot, registers its own authentication and
routes, and starts its own scheduled sweeps.

**Mount it at `/audit`, not `/admin/audit`.** The portal deliberately sits outside the Tez Law
admin authentication: TAAD's engagement team gets accounts here and must never inherit access to
the firm's system, appear in its user list, or see its navigation. Do not add
`app.use("/audit", auth.requireAdminAuth)`.

Everything below applies to both shapes.

---

---

## 2. Environment variables

Only `DATABASE_URL` is required — it is already set on the Render service.

| Variable | Default | What it does |
|---|---|---|
| `DATABASE_URL` | — | **Required.** Existing Render Postgres connection string. |
| `ANTHROPIC_API_KEY` | — | Enables Haiku adjudication for ambiguous documents and writes the plain-English brief the auditor receives. Without it, classification still works — see §5. |
| `AUDIT_PORTAL_URL` | `RENDER_EXTERNAL_URL` | Base URL used to build links inside notification emails. |
| `AUDIT_SMTP_USER` / `AUDIT_SMTP_PASS` | falls back to `GMAIL_EMAIL` / `GMAIL_APP_PASSWORD` | Email delivery. Reuses the existing Gmail credentials if you set nothing. |
| `AUDIT_SMTP_HOST` / `AUDIT_SMTP_PORT` | Gmail service | Set these to use a dedicated SMTP host instead of Gmail. |
| `AUDIT_FROM_EMAIL` / `AUDIT_FROM_NAME` | SMTP user / "Nightfood Audit Portal" | Sender identity. Worth setting to a Nightfood address rather than a Tez Law one. |
| `AUDIT_TZ` | `America/New_York` | Timezone for the scheduled sweeps. Nightfood is in Tarrytown, NY and SEC deadlines run Eastern. |
| `AUDIT_MAX_FILE_MB` | `50` | Per-file upload cap. |
| `AUDIT_BASE_PATH` | `/audit` | Mount path. Every link in the portal is built from this, so it can be changed safely. |
| `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` / `AUDIT_SMS_FROM` | — | Optional SMS for escalations only (overdue gating items, filing deadlines). |
| `AUDIT_WEBHOOK_URL` | — | Optional. POSTs every notification as JSON — useful for piping into Zara or Telegram. |
| `AUDIT_INSECURE_COOKIES` | unset | Leave unset. Set to `1` **only** for local HTTP development. |
| `AUDIT_LOGIN_MAX_FAILS` / `AUDIT_LOGIN_WINDOW_MIN` | `8` / `15` | Login throttle. |
| `AUDIT_LEAD_Q_GATE` / `_Q_STD` / `_A_GATE` / `_A_STD` | `25` / `18` / `60` / `45` | Days before the statutory filing deadline that PBC items fall due. Tune with TAAD. |

Verify delivery after deploy: **POST** `/audit/api/notify/test` as the portal administrator sends
yourself a test email and reports which transports are configured.

---

## 3. The issuer profile this is built around

Verified on EDGAR in September 2026. **Re-verify the filer-status line each year** at the Rule 12b-2
measurement date (the last business day of December).

| | |
|---|---|
| Entity | NightFood Holdings, Inc. — **CIK 0001593001**, ticker NGTF, Nevada, Tarrytown NY |
| **Fiscal year end** | **June 30** — the whole calendar is built on this, not on December |
| Filer status | **Non-accelerated**, smaller reporting company, **not an EGC** |
| Deadlines | 10-K **90 days** (Sept 28); 10-Q **45 days** (Nov 14 / Feb 14 / May 15), rolled per Rule 0-3 |
| ICFR | **No SOX 404(b) auditor attestation.** Management's own 404(a) COSO report is still mandatory |
| CAMs | **Required.** Because NGTF is not an EGC, AS 3101 critical audit matters apply |
| Going concern | Substantial doubt; FY2024 and FY2025 opinions both modified |
| Auditor | **TAAD, LLP** (engaged 28 Oct 2025). Predecessor **Fruci & Associates II, PLLC** |
| Segments | Foodservice Packaging (SWC/CarryOutSupplies), Robotics-as-a-Service (TechForce/RoboOp365), Hospitality Asset Ownership, Snack & Beverage (discontinued 30 June 2025) |

These are stored in the `ngtf_audit_settings` table under the `issuer` and `auditor` keys and can be
edited via `POST /audit/api/settings/:key` without touching code.

### Four things in the record that shape the design

1. **The late-filing pattern.** NT 10-K for FYE 6/30/2025; NT 10-Q for Q1 and Q3 FY2026; and the Q2
   FY2026 10-Q appears to have been filed after its due date with no Form 12b-25 on file. Nasdaq Rule
   5250(c) makes timely filing a continued-listing condition, so this needs closing out *before* a
   listing application. The portal drives backward from each statutory deadline and escalates gating
   items, which is the point.

2. **The 71-day acquired-business clock.** The Victorville Treasure Holdings 8-K was filed 3 Sept 2025
   and the Item 9.01 amendment came 3 Feb 2026 — well past 71 days. The `SW-ACQUISITION` sweep now
   forces the Rule 3-05/8-04 significance test at signing, when there is still time to commission the
   target audit.

3. **Dilution.** Shares outstanding went from 151.9M (Oct 2025) to 507.5M (May 2026). The cap table
   must foot to the transfer agent report every close, and the ASC 815-40 derivative classification
   behind those convertible notes is the most likely restatement risk and a probable CAM.

4. **Four auditor changes since 2022.** AS 2610 predecessor access is at Fruci's discretion, not
   TAAD's right — a real scheduling risk, and something Nasdaq will ask about.

---

## 4. How the document index works

**13 brackets, 128 categories.** Every category carries the PCAOB or SEC provision that makes the
document necessary, so neither side has to argue about whether an item belongs on the list.

```
A  Governance & Entity Records              H  Equity & Share-Based Compensation
B  Financial Close & General Ledger         I  Payroll, Tax & Related Parties
C  Cash & Treasury                          J  Estimates, Valuations & Going Concern
D  Revenue, Receivables & Contracts         K  Legal, Regulatory & Litigation
E  Inventory & Cost of Sales                L  SEC Reporting, Controls & Deliverables
F  Fixed Assets, Leases & Hospitality RE    M  Business Combinations & Acquired Businesses
G  Debt, Convertibles & Derivatives
```

Documents file to a designated folder path:

```
/FY2027/Q1-2026-09-30/C-Cash-and-Treasury/C-030 Complete Bank Account Listing
```

**35 categories are gating items** — ones where a standard or rule prevents the report or filing from
issuing until delivered. The AS 4105 quarterly representation letter is the clearest example: without
it the interim review is incomplete, and Reg S-X 10-01(d) means the 10-Q cannot be filed compliantly.

Editing `audit-taxonomy.js` changes the checklists, the folder structure and the classifier all at
once. Nothing else needs touching.

---

## 5. Classification

Two stages, and the first one always runs:

**Stage 1 — deterministic scoring.** Filename, spreadsheet sheet names and extracted text are scored
against token weights. No network, no cost, reproducible, and every decision stores its reasoning
trail — which matters, because an auditor may legitimately ask why a document landed where it did.

On a 97-file corpus of realistic PBC filenames, with **no document text and no AI**, stage 1 alone
placed **97 of 97 correctly**.

**Stage 2 — Haiku adjudication.** Runs only when stage 1 is ambiguous (below 70%, or the top two
candidates within 12 points). Haiku picks from the shortlist only — it cannot invent a category — and
writes the two-to-three sentence brief the auditor receives. Without `ANTHROPIC_API_KEY` the
deterministic result stands and the item is flagged for confirmation; uploads are never blocked on the
AI being reachable.

Anything that cannot be placed goes to **Triage**, not to the bin. Every file is stored, hashed and
versioned regardless.

**Pre-flight checks** catch what would otherwise bounce back from the auditor: a journal-entry export
with no user ID or approver column (AS 2401.58 needs both), an unsigned representation letter, a
valuation model sent as a flat PDF when AS 2501 requires testing the data and assumptions. These
checks only run when text was actually extracted — a scanned PDF reports "could not inspect", never a
false accusation.

---

## 6. Checklists, and the part that actually catches things

Each period generates two kinds of item.

**Document items** are satisfied by uploading a file the classifier routes to that category. They tick
themselves.

**Sweep questions** are the ones that matter. "Were any bank accounts opened, closed or re-titled this
period — including zero-balance accounts?" A **NO** is recorded as signed negative assurance with the
answerer and timestamp. A **YES** requires a description and *automatically adds the documents it
implies* to the checklist, with their own due dates, linked back to the question that produced them.

A checklist of only "upload X" items can never surface the thing you forgot existed. A sweep question
can — and these are the questions the auditor is required to ask anyway under AS 4105.18, so answering
them is the company pre-answering the interim review inquiries.

| | Document items | Sweeps | Gating |
|---|---|---|---|
| **Monthly** | 36 | 12 | 12 |
| **Quarterly** | 78 | 18 | 22 |
| **Annual** | 112 | 23 | 28 |
| **S-1 bring-down** | 15 | 2 | 7 |

The S-1 tier is opened per amendment from the Calendar page (AS 4101 requires the bring-down procedures to
be repeated at *each* amendment, so each gets its own checklist).

Due dates are computed *backward* from the statutory filing deadline, so they respect Rule 0-3
business-day rolling and the June-30 fiscal year automatically.

---

## 7. Notifications

**The auditor hears about evidence arriving. The company hears about obligations coming due.** Sending
both sides everything is how a notification system gets muted in week two — and a muted system is
worse than none, because it still produces a record saying the auditor was told.

| Event | Goes to |
|---|---|
| Document uploaded, with the brief and pre-flight flags | Auditor, immediately |
| Sweep answered YES — new obligations found | Auditor, immediately |
| Item due soon / overdue / **gating item overdue** | Company (gates also to the engagement partner) |
| Auditor review note or rejection | Company, immediately |
| Filing deadline at T-30/14/7/3/1 | Company leads |
| AS 1215 archive countdown | Auditor lead |
| Weekly status roll-up | Audit committee only |

Every notification is written to an outbox table **before** it is sent. If SMTP is down the record
still exists and retries on the next sweep — that ordering matters, because "the auditor was notified"
is itself evidence under AS 1301.25 (difficulties encountered, including delays in receiving
information), and that record cannot depend on the mail server having been up.

Scheduled sweeps (all `AUDIT_TZ`): outbox drain every 5 min; obligations sweep weekdays 07:30; filing
reminders weekdays 08:00; archive countdown daily 08:15; committee digest Mondays 08:30.

---

## 8. Why it is safe to hand an auditor a login

**Independence is structural, not a setting.** Auditor accounts can download everything and raise
review notes, but the permission matrix gives them no route — through the interface or the API — to
upload a document or answer a sweep question. SEC Rule 2-01(c)(4) treats bookkeeping and management
functions as impairing independence, so the portal is built so it cannot become an independence
problem. Company users, conversely, cannot accept PBC items on the auditor's behalf.

**Documents are versioned, never overwritten.** Re-uploading a changed file creates v2 and retains v1
as superseded. AS 1215.06 requires an experienced auditor with no previous connection to the
engagement to reconstruct what the auditor saw and when; overwriting destroys exactly that.

**The AS 1215 lifecycle is enforced in the database, not the interface.** Setting the report release
date starts the **14-day** documentation completion clock (AS 1215.15 as amended by Release 2024-004 —
the old 45-day window is gone, and for a firm auditing 100 or fewer issuers it applies to fiscal years
beginning on or after 15 Dec 2025, which covers FY2027). Archiving makes the engagement append-only:
PostgreSQL triggers block deletion, block modification of file bytes, hash, size, name, version,
engagement linkage and provenance, block `TRUNCATE`, and refuse any post-archive insert that does not
record the date, the preparer and the reason AS 1215.16 requires. The chain-of-custody log is
append-only unconditionally — it cannot be edited or deleted by anyone, including a portal
administrator.

Every download is logged against the requesting account with IP and user agent.

---

## 9. Verification performed

Exercised against a real PostgreSQL 16 instance over HTTP, not just reviewed:

- **Filing calendar** reconciled against NGTF's actual EDGAR due dates — Q1 FY26 → 14 Nov 2025,
  Q2 → 17 Feb 2026 (after Washington's Birthday), Q3 → 15 May 2026
- **Classifier**: 97/97 on the realistic corpus, filename only, no text, no AI
- **AS 1215 triggers**: deletion, byte modification, engagement detachment, metadata erasure and
  `TRUNCATE` all blocked; post-archive addition refused without a reason and accepted with one
- **Independence boundary**: auditor upload and sweep-answer attempts refused at the API
- **Concurrency**: 6 simultaneous uploads of one category produced a clean v1→v6 chain with exactly
  one active version; 3 separate processes racing schema creation on an empty database all succeeded
- **Timezone**: dates stable across UTC, New York, Tokyo, Sydney and Los Angeles
- **Full walkthrough**: setup → users → seed year → upload → sweep → download → review note →
  PBC export → report release → archive → post-archive addition

A security review found and closed: a path by which the portal re-opened to anonymous administrator
creation, three trigger bypasses, an API-level archive bypass, a login timing oracle, missing login
throttling, a duplicate-detection rule that blocked legitimate cross-period filing, and a version race
that forked the document chain.

### Known limitations

- Deadline calculations are derived from the rules cited, not quoted from a filing. They are a working
  calendar, not legal advice — securities counsel owns the filing calendar.
- `AS 1215.15`'s 14-day rule is confirmed as effective; the further December 2026 QC 1000-conforming
  amendments to AS 1215/1220/4105 should be diffed before finalizing a long-range compliance calendar.
- **Resolved since first delivery:** the China-based-company rule is **Rule 5210(l)** (lower-case L), not
  5210(i), and it names the PRC, Hong Kong and Macau only. Taiwan is not covered, and the separate
  "Restrictive Market" test in Rule 5005(a)(37) turns on PCAOB inspection access, which Taiwan permits.
  The larger exposure is **Rule 5110(c) reverse-merger seasoning**, which could push a listing application
  past the Company's stated window unless a $40M firm-commitment offering is done. See the memo to
  securities counsel.
- Six of the quarterly sweeps spawn nothing, because everything they imply is already a standing item
  on that checklist — a YES on those produces the notification but no new rows.

---

## 10. Handing it to Nightfood later

Deployed standalone (Option A), the handover is an afternoon, not a project:

1. Render **Settings → Transfer Service** moves `ngtf-audit-portal` to Nightfood's account.
   Transfer the Postgres instance in the same pass.
2. Repoint the custom domain.
3. Rotate `AUDIT_SMTP_*`, `AUDIT_FROM_EMAIL` and `ANTHROPIC_API_KEY` to Nightfood's own.
4. Deactivate Tez Law accounts in **Users**. Their audit trail rows survive deactivation, which
   is the point: `ngtf_audit_events` is append-only and a deactivated user's history stays
   readable.

The codebase would need to be copied out of `tezlaw-bot` into a repo Nightfood controls. That is
twelve files plus `db.js` and nothing else — the portal shares no code with Zara, the civil
litigation module, or anything else in the repo.

Worth doing before the uplisting rather than after. Once NGTF is listed, this is the issuer's
books-and-records system, and an issuer whose audit evidence repository is administered by its
own outside counsel is a question you would rather not be answering.
