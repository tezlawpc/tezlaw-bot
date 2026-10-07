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
audit-delivery.js      Transmittals, delivery receipts and chasing
audit-subledger.js     AR/AP subledgers, audit sampling and support indexing
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
| `AUDIT_MAIL_WEBHOOK_SECRET` | — | Enables `POST /audit/hook/mail`, where the mail provider reports whether a message was **delivered** or **bounced**. Without it the portal knows only that its own relay accepted the message. See §7a. |
| `AUDIT_DELIVERY_SUPPRESS_UPLOAD_EMAIL` | unset | Set to `1` to stop the per-file "something arrived" email and let the transmittal carry it instead. Quieter, at the cost of up to the auto-transmit window before anyone hears. |

No new variables are needed for the AR/AP subledger — see §7b.
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
| **Event** | 37 | 0 | 7 |

The S-1 tier is opened per amendment from the Calendar page (AS 4101 requires the bring-down procedures to
be repeated at *each* amendment, so each gets its own checklist).

The **event** tier is a transaction rather than a period — an acquisition, disposition, auditor change or
non-reliance determination — and its clock starts on the day the event occurred. Two deadlines drive it:
the initial Form 8-K within **four business days** (Gen. Instr. B.1), and, where the Rule 3-05/8-04
significance test clears 20%, audited financial statements of the acquired business within **71 calendar
days** of that 8-K due date (Item 9.01(a)(4)). Only M-020 and M-030 carry the 71-day date; the other
gating items are needed for the initial 8-K. Open one from the Calendar page, or upload a document that
classifies to an event category and the portal opens one from the document's own date and filename.

> Checked against the real case: the Victorville Treasure Holdings 8-K of 3 Sept 2025 produces an
> Item 9.01 amendment deadline of **19 Nov 2025**. The amendment was filed 3 Feb 2026.

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

## 7a. The delivery ledger — "we sent it" / "we never got it"

That exchange costs more days in a small-cap close than any accounting question, and **nothing in a
shared folder can settle it**. A folder knows a file exists. It does not know that a named person was
told, that the message reached their mail server, that they opened it, or that they agreed the package
was complete. Those are four separate facts, they fail separately, and only the last one closes an item.

### The unit of delivery is a transmittal

A numbered package handed from one side to the other, the way a law firm numbers a production:
`T-0001`, `T-0002`. Numbering is the cheap trick that makes the whole thing work, because it gives both
sides a noun. "Transmittal 14, sent the 6th, acknowledged the 8th" ends an argument that "the files are
in the folder" cannot even begin.

Batching matters too. Twelve files uploaded in one sitting are **one package and one email**, not twelve.

Each package carries a **manifest fingerprint** — a SHA-256 over its own ordered list of file names,
file hashes and sizes. Both sides can recompute it, and the canonical form is shown on screen so they
can. That turns "you never sent the September bank statement" from an argument into arithmetic: either
that file's hash is under the fingerprint or it is not.

### Nothing may sit un-notified

An active document that has never appeared on a live transmittal is **undelivered** — a tracked state
with its own alarm, not an absence. That silent state is what produced the problem in the first place:
files landed, and no procedure carried the fact to the other side. `auto_transmit` closes the window on
its own, hourly.

If there are **no active auditor accounts**, the portal refuses to create a package and says so plainly
rather than recording a delivery that cannot have happened. On a fresh install that is the honest answer.

### The receipt facts, graded by what they can support

The portal never calls a package "read" on the strength of a tracking pixel.

| Fact | What it actually supports |
|---|---|
| `email_sent_at` | Our relay accepted it. Says **nothing** about arrival. |
| `email_delivered_at` | Their mail server accepted it. **This is the fact that answers "it never arrived."** Requires the provider callback — see `AUDIT_MAIL_WEBHOOK_SECRET`. |
| `email_bounced_at` | It demonstrably did **not** arrive. The most valuable column here: knowable on day zero instead of in week three, and the sender is paged immediately. |
| `email_opened_at` | Unreliable in both directions — gateways prefetch the image, most clients block it. **Off by default**, recorded raw but never believed, labelled unreliable wherever shown. |
| `link_clicked_at` | The link addressed to this person was clicked. The token identifies a recipient and **grants nothing** — the handler records the click and sends them to sign in. Better evidence than a pixel, and no pixel. |
| `first_viewed_at` | Opened the package in the portal, signed in as themselves. |
| `download_count` | Took the files. Strongest observation. |
| `acknowledged_at` | **Stated on the record that the package is complete.** The only receipt that closes an item, because it is the only one that is a statement by them rather than an observation about them. |
| `disputed_at` | Said something is missing. A fast objection beats slow silence, and the sender hears at once. |

**Acknowledging is checked per row, not per role** — against the named recipients of that specific
package. An acknowledgment from somebody it was not addressed to is worth nothing, and a role check
would have let any auditor sign for a colleague's package.

### Chasing is business-day arithmetic

Defaults, all in the `delivery` settings key and all editable via `POST /audit/api/settings/delivery`:

| Setting | Default | Meaning |
|---|---|---|
| `auto_transmit_after_minutes` | `30` | How long an upload session batches before a package is issued. |
| `undelivered_alert_after_hours` | `24` | When an un-transmitted document raises the alarm. |
| `ack_due_business_days` | `3` | The date the email asks them to acknowledge by. |
| `view_reminder_business_days` | `[1, 3]` | Rungs when the package has not been opened at all. |
| `ack_reminder_business_days` | `[3, 6]` | Rungs when it has been seen but not acknowledged. A different problem, so a different ladder. |
| `stalled_business_days` | `5` | Past this it stops being a reminder and becomes a recorded delay. |
| `max_reminders` | `4` | Then it stops nagging the recipient. |
| `escalate_to_lead_from_reminder` | `2` | From this rung the **sender's** lead is copied — chasing it is their move, not the recipient's. |

Three behaviours worth knowing:

- **The rung is chosen by age, not by how many were sent.** A package already eight business days old
  with no reminder goes straight to the rung its age has earned, so the sender's lead is copied on the
  first message rather than a day later. Still exactly one email; skipped rungs are marked spent.
- **One reminder per person per day**, whatever the ladder says.
- **A bounced address is never nudged again.** Shouting into a void produces a record claiming the
  recipient was reminded. The sender is told instead.

### AS 1301.25, built from the ledger

`/audit/delays` assembles the schedule of **difficulties encountered, including delays in receiving
information**, in both directions and with dates. That communication is normally reconstructed from
memory at the end of fieldwork, which is why it is always vague and always contested. Built from the
ledger it is a factual schedule — which also means it will sometimes show the delay was not the
company's. Whether any of it was significant to the audit stays the engagement partner's judgment.

This is the page that makes the feature worth something to **TAAD** rather than only to Nightfood.

### Everything here is append-only, by trigger

A sent-items folder proves nothing in a dispute, because the person holding it could have edited it.
The question is never "do you have a record" but "can the record have been changed." So, enforced in
the database rather than in application code:

- A receipt timestamp, once written, **cannot be cleared, moved or overwritten**; no counter can decrease.
- An **acknowledgment is final**. So is a recorded dispute — resolution is a separate field.
- A **manifest is sealed** when the package is issued. Anything left out goes in a further transmittal;
  that is what the numbering is for.
- A transmittal cannot be **deleted**, only **voided with a reason**. The recipients saw it, and a hole
  in the numbering is harder to explain than a withdrawal.
- `TRUNCATE` is blocked on all three tables (row triggers do not fire on `TRUNCATE`).

### New routes

| Route | Who |
|---|---|
| `/audit/transmittals` | Ledger, plus the **Undelivered** tab |
| `/audit/transmittal/new` | Compose — either direction |
| `/audit/transmittal/:id` | Manifest, per-recipient receipt timeline, chain of custody, **Print receipt** |
| `/audit/delays` | The AS 1301.25 schedule |
| `/audit/r/:token` | **Public.** Records a click, then sends them to sign in. Grants nothing. |
| `/audit/hook/mail` | **Public**, shared-secret. Mail provider delivery and bounce callbacks. |
| `GET /audit/api/delivery/due` | Dry run of the chaser — inspect it before trusting it |
| `POST /audit/api/delivery/chase` | Run the chaser now |
| `POST /audit/api/delivery/auto-transmit` | Sweep the undelivered queue now |

Added sweeps (all `AUDIT_TZ`): auto-transmit hourly at `:10`; chaser weekdays 08:45; undelivered alarm
weekdays 09:15.

**On the mail webhook and HMAC.** Resend and others sign callbacks with Svix, which needs the *raw*
request body. The host application's global JSON parser has already consumed it by the time this
router is reached, and verifying a signature here would mean reaching into the host app's middleware
stack — which this module promises not to do. A high-entropy shared secret over HTTPS is the honest
trade: the endpoint is write-only into a log, the worst a forged call can do is assert a delivery or a
bounce, the raw payload is kept as received, and the provider's own console remains the authority if
anything is ever contested.

Configure it in Resend as
`https://tezlaw-bot-nightfood.onrender.com/audit/hook/mail?s=<AUDIT_MAIL_WEBHOOK_SECRET>`.

---

## 7b. AR / AP subledgers and the sample list

"Here are our forty selections. Please provide support." That email is where a small-cap close goes to die —
not because the documents don't exist, they almost always do, but because **a receivable lives in the
accounting system as a number while the evidence that the number is real lives in somebody's inbox.** Forty
selections then become forty separate archaeology projects.

### This is not an AR/AP system

The accounting system stays the system of record. Replacing it would be a year of work and the auditor would
still ask for exactly the same things. Three narrower things were missing:

1. **A frozen snapshot that ties to the general ledger.** Export an aging **detail** report as of the period
   end — CSV or Excel, as it comes out of the books — and the importer reads it, including the title rows
   above the header, the per-bucket group headers and the subtotal rows that QuickBooks and Sage put inside
   the body. Column headings are matched by synonym, so `Open Balance` / `Amount Due` / `Balance Due` all land
   in the right place.
2. **A document index keyed to the invoice number**, because that is the identifier the auditor will quote.
3. **A matching engine for the selection list.**

### The tie-out is also the proof the import read your file correctly

Enter the general-ledger balance for the control account. If the amount column had been picked up wrongly the
total would not agree — so one action is both the reconciliation the auditor wants and the check that the
import worked. **A variance is allowed; an unexplained one is not** — under half a dollar it passes silently,
and above that the explanation is required and kept.

A tie-out is final once recorded, and the population freezes with it: after tie-out a line's counterparty,
number, date and amount cannot be changed and no line can be deleted, by trigger. A corrected aging is
imported as a **new version** that supersedes the old one without destroying it, because the old one is the
population that was tested.

### You do not have to wait for the sample

You cannot know which items they will pick. You *can* know which ones are near-certain, because the method is
not a secret: everything above a threshold is tested individually and the remainder is sampled. So the portal
marks a **likely-picks** worklist — the large items plus the markers an auditor is trained to look at:

| Marker | Why |
|---|---|
| `key_item` | Above the auditor's individual-testing threshold. |
| `top_by_amount`, `largest_for_counterparty` | Large items are tested individually, not sampled. |
| `related_party` | Attention out of all proportion to size — ASC 850, AS 2410. |
| `contra_balance` | A credit in AR or a debit in AP usually belongs on the other side of the balance sheet. |
| `cutoff_window` | Dated in the last five days before the cutoff; the period turns on the delivery date, not the invoice date. |
| `dated_after_period_end` | Should not be in that aging at all. Find it before they do. |
| `over_90`, `round_amount` | Feeds the allowance question; round numbers draw a second look. |

On the test population of 827 open invoices this is **under 45% of lines and in practice a few dozen worth
chasing** — which is the difference between answering a selection list in a morning and answering it in a
fortnight. **When the auditor has not shared a threshold the portal refuses to invent one**, says so on
screen, and falls back to the largest items plus the markers. It is labelled a heuristic everywhere it
appears, because it is one.

### Readiness is measured in dollars

95% of lines covered while the three largest invoices are missing is not 95% ready, it is zero — they sample
by dollars and test the large items individually. Both figures are shown and **the dollar figure leads**.

### The selection list

Paste what the auditor sent — a block copied out of Excel, a CSV, or a few typed lines. A header row of
Selection, Customer, Invoice, Date, Amount is surest; without one, the column shapes are inferred. Matching
is tried in descending order of certainty and **stops at the first method that identifies exactly one line**:

| Outcome | Example from the test suite |
|---|---|
| `doc_number_and_amount` | `INV-0010104` + the amount agreeing. |
| `doc_digits_and_amount` | The auditor wrote `Inv 10533`; the ledger holds `INV-0010533`. |
| matched, amount disagrees | Matched on the number, and the difference is **surfaced rather than smoothed over** — it is exactly what they are testing for. |
| `counterparty_and_amount` | No invoice number given at all. |
| **ambiguous → refused** | One invoice number used by two different customers. A person chooses; **a confidently wrong match is worse than an honest gap**, because the gap gets filled and the wrong match gets delivered. |
| **unmatched** | And the reason distinguishes "your customer, not that invoice" from "neither is in this aging — they are probably working from a different population", which is a five-minute email rather than a week of searching. |

The auditor's own words are stored **verbatim and immutable**. Where their list and the aging disagree, that
disagreement is the finding, so it cannot be tidied up to make a match work.

**Who chose the sample is kept separate from who typed it in.** Under AS 2315 and AS 2310.15 the auditor
selects the items; a transcribed list has to name the firm it came from, and the portal refuses one that
doesn't. A record implying the company selected its own audit sample is both wrong and hard to explain later.

### The AS 2310 confirmation boundary is structural

**AS 2310 is already in force for NGTF** — fiscal years ending on or after **15 June 2025**, so the June 30
year end was subject to it on the FY2025 audit. AS 2310.24 requires the auditor to confirm receivables or
obtain the equivalent directly from an external source; .25 allows alternative procedures instead only where
confirmation is **not feasible**, documented. And **.15 makes selecting, sending and receiving the auditor's
job.**

So on a confirmation request the portal accepts **verified contact detail and nothing else**, and
`confirmation_response` is refused outright with the reason. Companies do sometimes try to help by collecting
those; it voids the procedure rather than speeding it up.

### Finishing the job

When every selection is complete or waived with a written reason, one click issues it as a **numbered
transmittal** through §7a, so the handover is signed for. `package.zip` is foldered one directory per
selection, named with the selection number and counterparty, each file prefixed with its support type
(`INV`, `POD`, `CASH`…), plus `index.json` and `index.csv` tying every selection back to the auditor's own
row. That naming is most of the perceived quality of a sample response and it costs nothing.

**Waiving needs a reason.** "We cannot produce this" is a real answer the auditor is entitled to in writing,
and it is one they will follow up — which beats a silent omission. A request will not go out while any
selection is unmatched.

### Three categories were added to the index

| Code | Why it was missing |
|---|---|
| **C-090** Subsequent-Period Disbursement Register | C-070 is the register for the period under audit; this is the register for the period **after** it, which is the population the **search for unrecorded liabilities** is run against. The procedure that finds the understatement in a company short of accounting staff, and the item most often absent from a first PBC package. Not a gate — an AS 4105 interim review doesn't require it, so making it one would block a 10-Q over a procedure never performed at interim. |
| **D-120** Customer Confirmation Contact Detail | All the company supplies under AS 2310.15, with the basis on which each address was verified. |
| **D-130** Subsequent Cash Receipts Applied to Period-End Receivables | What saves the audit when confirmations don't come back, which is usually. AS 2310.23 sends a non-response to Appendix C, and the first alternative there is subsequent cash receipts. The highest-return item on the receivables side of a PBC list. |

### Readiness checks

Run per snapshot, and **they go quiet once satisfied** rather than nagging: not tied out, unexplained
variance, wrong-signed balances (Reg S-X 5-02, ASC 210-20-45-1), lines dated after the period end,
counterparty concentration ≥10% (ASC 275-10-50-20, and ASC 280-10-50-42 if also ≥10% of revenue), over-90
balances with no CECL support on file (ASC 326-20-30-1), the missing subsequent-disbursement register, no
vendor statements (AS 1105.08 — third-party evidence outweighs the company's own ledger), and likely-picked
lines with nothing attached.

### Routes, including the ones for the bot

| Route | What |
|---|---|
| `/audit/subledgers` | Snapshots, tie-out state, import |
| `/audit/subledger/:id` | Aging, concentration, coverage, checks, the line browser with per-line upload |
| `/audit/samples`, `/audit/sample/:id` | Requests and the worklist |
| `POST /audit/api/sample/match` | **Dry run.** Give it a list; get back what matches and what is missing, recording nothing. This is the one Zara should call. |
| `GET /audit/api/subledger/lookup?doc=Inv+10104` | One invoice and everything filed behind it. Loose numbers work. |
| `GET /audit/api/sample/:id/package.zip` | The foldered package |
| `POST /audit/api/subledger/support` | Upload and file against a line in **one action** — "upload, then go and find the line, then attach it" is three steps and the third is the one that gets skipped |

Added sweep: outstanding sample requests, weekdays 09:30.

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
- **Delivery ledger**: 119 assertions, driven over HTTP as five different users against a real
  PostgreSQL 16 and a real (fake) SMTP server — auto-transmit; one email per recipient rather than per
  file; the receipt link, view, download and acknowledgment path; a non-recipient refused; every
  append-only trigger (back-dating, deletion, cleared timestamps, wound-back counters, re-pointed
  receipts, sealed manifests, `TRUNCATE`) refused at the database; provider delivery and bounce
  callbacks applied and the sender paged; open tracking stored raw but **not** believed; the reminder
  ladder, the rung-by-age jump, the one-per-day guard, the bounced-address skip; dispute and
  resolution; the AS 1301.25 schedule; and the no-auditor-accounts case
- **AR/AP subledger and sampling**: 130 assertions over HTTP as four users, against a real PostgreSQL 16 and
  1,240 lines of QuickBooks-shaped aging (title rows, per-bucket group headers, subtotals, a grand total,
  credit balances, lines dated after the period end, and duplicate invoice numbers across two customers).
  Covers the import and column detection; the tie-out refusing an unexplained variance and accepting an
  explained one; re-import superseding without destroying the tested population; every frozen-population
  trigger; the likely-picks worklist with and without a supplied threshold; each matching outcome including
  the ambiguous one it refuses and both kinds of unmatched; the independence boundary (auditor cannot import,
  attach or reconcile, but can record their own selections); the AS 2310 confirmation boundary; waivers;
  delivery as a transmittal; the package's folders and index; and both bot endpoints
- **Upgrade in place**: the three tables, four triggers and five added columns were stripped from a
  populated database and the service rebooted. Everything returned, and 115 checklist items, 7
  documents, 45 chain-of-custody rows and the Q1 filing date (16 Nov 2026) were byte-identical before
  and after — verified by md5 over the item/status/due-date set

**A real bug found while building this, and fixed across the whole module.** `cal.iso()` reads UTC
parts while `cal.dstr()` deliberately reads *local* parts (so a `DATE` column comes back as the day
that was stored). `cal.iso(new Date())` is therefore **not today's date** — it is today's date in UTC,
which after about 17:00 Pacific or 20:00 Eastern is *tomorrow*. Thirteen places compared one against
the other. On a UTC container it is invisible; with `TZ` set to a US zone, every evening after eight
o'clock an item due tomorrow read as overdue, a package sent a minute ago read as a day old, and a
once-a-day guard that asks "have I already done this today" never matched — which in testing sent a
chasing email within seconds of the package arriving, and again on every run. `cal.today()` now exists,
is documented with the trap, and all thirteen call sites use it. The rule: `dstr()` for values from the
database, `iso()` for the result of internal arithmetic, `today()` for now.

**A second real bug, found the same way.** The sample-package route built a byte-complete zip and never
called `res.end()`. `ZipWriter.finish()` writes the central directory but does not close the socket, so the
download hung forever on an archive that was already finished — the most confusing possible way for it to
fail, and invisible to any test that did not actually wait for the transfer.

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
- **The delivery ledger cannot know a message arrived until the mail provider is wired up.** Without
  `AUDIT_MAIL_WEBHOOK_SECRET` and the callback configured, the strongest thing the portal can say about
  an email is that its own relay accepted it — and `email_delivered_at` and `email_bounced_at` stay
  empty. The in-portal receipts (link clicked, viewed, downloaded, acknowledged) work regardless.
- The mail callback is authenticated by shared secret, not by HMAC signature verification, for the
  reason given at the end of §7a.
- Where a callback carries no identifying header and no matchable message id, a bounce or delivery is
  matched to the recipient's **most recent outstanding receipt within 21 days**. That is a heuristic and
  is recorded as one (`matched_by = recipient_address_heuristic`). In practice one person has one
  package in flight; where it is wrong, a bounce is attributed to the wrong package, which is still a
  loud and correct signal about that address.
- Open tracking remains **off**. Turning it on adds a tracking pixel to correspondence with the
  company's auditor, and the evidence it yields is unreliable in both directions. The receipt link is
  better evidence and needs no pixel.
- The subledger importer reads an aging **detail** report. A summary by customer has no invoice rows, so
  there is nothing for a selection to match against, and it is refused with that explanation.
- Aging buckets are computed in **calendar** days from the due date (falling back to the document date),
  which is what every accounting system does — so the buckets reconcile to the report the company already
  produces. Where the export carries its own `Aging` column, that is used instead.
- The likely-picks worklist is a **heuristic, not a prediction** of the auditor's sample, and is labelled as
  one. Without a threshold from the auditor it is the largest items plus the risk markers; the portal will
  not invent a materiality figure.
- Where a counterparty name differs between the auditor's list and the ledger beyond punctuation and the
  usual entity suffixes, the name match will miss. The invoice-number match carries those cases, and a
  genuinely ambiguous match is referred to a person rather than guessed.

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
