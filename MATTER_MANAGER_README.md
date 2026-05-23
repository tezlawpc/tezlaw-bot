# Matter Manager — TEZ Law P.C.

> Internal documentation for the case management system running on `tezlaw-bot.onrender.com`. Written May 23, 2026 after Phase 5 build. For JJ Zhang's eyes (and future-you).

---

## What this is

A server-backed matter management dashboard for active federal immigration matters. Lives at `/admin/matters/`. Built around:

- **Matter records** with new-style fields (opened_date, triggering_date, custody, petitioner, relief)
- **Deadlines** with parties (us/govt/court), citations, and dates
- **Files** (links to Dropbox/Drive folders — not actual file storage)
- **Notes** (autosaved free-text per matter)
- **Checklists** templated by matter type (PFR, Habeas, Mandamus, N400, APA, Removal, USCIS)
- **Court order parser** — paste any order, Claude extracts proposed deadlines
- **NEF intake parser** — paste a CM/ECF email, Claude proposes a matter draft
- **Proposal inbox** — accept/dismiss queue for everything the parsers propose
- **ICS calendar export** — point Outlook/Google Calendar at the per-user `.ics` URL

All matter data is per-user (`user_id` foreign key everywhere). All actions audit-logged.

## Compliance context (read first)

This system holds active client matter data. Cal. RPC 1.6 (confidentiality), Cal. RPC 1.1 (competence), Cal. State Bar Formal Op. 2010-179 (cloud computing duties) apply.

Practical implications baked into the design:

- **No auto-writes for deadlines.** The court order parser PROPOSES deadlines. You must click Accept per deadline. This friction is intentional — a wrongly-extracted "30 days from service" that silently becomes a calendar entry is malpractice waiting.
- **All ownership verified.** Every endpoint checks that the user owns the matter, checklist, item, or proposal being touched. Defense against horizontal escalation.
- **Audit log.** `audit_log` table records writes. Don't delete it.
- **Render Postgres = 7-day Point-in-Time Recovery.** Data loss is recoverable within a week.

---

## Architecture

```
┌─────────────────────┐       HTTPS         ┌──────────────────┐
│  matters.html (UI)  │ ◄────────────────► │  matter-manager  │
│  (browser, SPA)     │   /admin/matters    │  .js (Express)   │
└─────────────────────┘   /api/*            └────────┬─────────┘
                                                     │
                                                     ▼
                                            ┌──────────────────┐
                                            │  db.js (pg pool) │
                                            └────────┬─────────┘
                                                     │
                                                     ▼
                                            ┌──────────────────┐
                                            │ Render Postgres  │
                                            │ (zara-memory)    │
                                            └──────────────────┘
```

For parser endpoints (`POST /api/parse`, `/api/parse-intake`, `/api/ingest`, `/api/ingest-dry-run`), `matter-manager.js` calls the Anthropic API directly. Model: `claude-sonnet-4-6`. API key in `ANTHROPIC_API_KEY` env var on Render.

---

## File map

```
tezlaw-bot/                            ← GitHub: tezlawpc/tezlaw-bot
├── server.js                          ← Express boot, mounts router, env checks
├── db.js                              ← All schema init + pg helpers
├── matter-manager.js                  ← Router for /admin/matters/* (the whole API)
├── matters.html                       ← The dashboard SPA (CSS+JS in one file)
├── uscis-updater.js                   ← Background job pulls USCIS times from GitHub
├── fetch-uscis.js                     ← GitHub Actions weekly fetch script
└── uscis-times.json                   ← Cached USCIS data (committed by Actions weekly)
```

`matters.html` is monolithic (~2,300 lines, ~120KB). All CSS + JS inline. Don't try to split it without a build pipeline.

---

## Database schema

All tables defined in `db.js`, init functions called from `initDB()` on boot.

### Initialization order

```
initWave1Tables           → users, audit_log, intake_state, admin_sessions, etc.
initWave2Tables           → leads, drips, hot_leads, etc.
initMatterManagerTables   → matters, matter_deadlines, matter_files, matter_notes
initMatterManagerV2       → adds 5 columns to matters + checklist tables
initMatterManagerV3       → matter_proposals (inbox queue)
```

All are idempotent (CREATE TABLE IF NOT EXISTS, ALTER TABLE ADD COLUMN IF NOT EXISTS).

### Key tables

**`matters`** — top-level case record
| column | purpose |
|---|---|
| `id` SERIAL | primary key (integer — be careful, NOT a uuid) |
| `user_id` | FK to users (always 1 for now — JJ) |
| `client_name` | "Lu, Guangfeng v. Bondi" — UI splits on " v. " to derive adverse party |
| `matter_ref` | case number / A-number / docket # |
| `court` | "9th Cir.", "C.D. Cal.", "BIA" etc. (short form) |
| `case_type` | PFR/Habeas/Mandamus/N400/APA/Removal/USCIS/Business/RealEstate/Estate/Other |
| `status` | 'active' / 'archived' (no soft-delete column — status is the flag) |
| `dropbox_url`, `notes` | self-explanatory |
| `opened_date`, `triggering_date`, `custody_location`, `petitioner_name`, `relief_sought` | added in V2 |
| `created_at`, `updated_at` | timestamps |

**`matter_deadlines`** — per-matter deadlines, foreign key to matters
| column | purpose |
|---|---|
| `title`, `citation`, `due_date`, `party`, `note`, `completed` | self-explanatory |
| `party` | enum-like: 'us' / 'them' / 'court' |

**`matter_checklists`** — header for a checklist on a matter
- Has many `matter_checklist_items`. Both cascade on matter delete.

**`matter_checklist_items`** — individual checkbox items
- `text`, `citation`, `completed`, `display_order`

**`matter_files`** — link records (NOT actual file storage). `filename` + `url`.

**`matter_notes`** — legacy timestamped notes (kept for backward compat; UI uses scalar `matters.notes` field instead). New writes don't add rows here.

**`matter_proposals`** — the inbox queue
| column | purpose |
|---|---|
| `kind` | 'deadline' / 'field_update' / 'new_matter' |
| `source` | 'manual_paste' / 'email_inbound' / 'api' (currently always manual_paste; email_inbound for Phase 1) |
| `source_ref` | Message-ID of the email (for future dedup) |
| `proposed_data` JSONB | the actual proposal payload, shape varies by kind |
| `raw_excerpt` | original email/order text (truncated to ~4KB) |
| `status` | 'pending' / 'accepted' / 'dismissed' |
| `confidence` | 'high' / 'medium' / 'low' from parser |
| `matter_id` | nullable — null means unmatched, would create new matter on accept |

---

## API endpoints

All under `/admin/matters/api/*`. All require admin session auth via `requireAuth`.

### Matters CRUD
- `GET /api/matters?status=active|archived|all` — list matters with deadline counts + checklist progress
- `GET /api/matters/:id` — detail (matter + deadlines + notes + files + checklists with nested items)
- `POST /api/matters` — create
- `PATCH /api/matters/:id` — update (allowlist of fields, date format validation)
- `DELETE /api/matters/:id` — hard delete (cascades to all children)

### Deadlines CRUD
- `POST /api/matters/:matterId/deadlines`
- `PATCH /api/matters/:matterId/deadlines/:id`
- `DELETE /api/matters/:matterId/deadlines/:id`

### Files / Notes CRUD
- `POST/DELETE /api/matters/:matterId/files/:id?`
- `POST/DELETE /api/matters/:matterId/notes/:id?` (legacy, UI uses PATCH /api/matters/:id with notes field)

### Checklists
- `POST /api/matters/:matterId/checklists/template/:templateName` — seed PFR/Habeas/Mandamus template
- `POST /api/matters/:matterId/checklists` — create empty checklist
- `DELETE /api/checklists/:checklistId` — cascades to items
- `POST /api/checklists/:checklistId/items` — add one item
- `PATCH /api/checklist-items/:itemId` — toggle done / edit text
- `DELETE /api/checklist-items/:itemId`

### Parsers
- `POST /api/parse` — court order parser (pure read, returns proposed deadlines)
- `POST /api/parse-intake` — NEF parser (pure read, returns proposed matter fields)
- `POST /api/ingest-dry-run` — same matching/parsing as /ingest, but read-only (validation)
- `POST /api/ingest` — same as dry-run, but saves proposals to `matter_proposals`

### Proposal inbox
- `GET /api/proposals?status=pending&matter_id=N` — list
- `GET /api/proposals/count` — quick badge feed `{ pending: N, by_matter: {...} }`
- `PATCH /api/proposals/:id` — body `{ action: 'accept' | 'dismiss', matter_id?: N }`
  - On accept of `deadline`: inserts into matter_deadlines
  - On accept of `new_matter`: creates row in matters, re-attaches unmatched deadline proposals with same matter_ref
  - On accept of `field_update`: applies fields to matter row
  - On dismiss: marks as dismissed, no data written

### Calendar export
- `GET /calendar/:secret.ics` — RFC 5545 feed (mounted top-level, NOT under /admin, secret in URL)

---

## Common operations

### Add a new matter type (e.g., "TPS")

1. `matters.html` — add option to `<select id="nm-type">` (search for "Petition for Review")
2. `matters.html` — add to `matterTypeLabel()` map and `mapMatterFromDb()` typeKey detection
3. `matters.html` — add a CHECKLISTS template entry for the new type (or leave it empty for "no template")
4. Optional: add a hardcoded template in `matter-manager.js` `CHECKLIST_TEMPLATES` if you want server-side seeding
5. Update INTAKE_PROMPT in `matter-manager.js` to mention the new type

No DB migration needed — `case_type` is a free-form VARCHAR(50).

### Change a checklist template

Two places, both must be updated to stay in sync:

1. **Client-side display** — `matters.html`, the `CHECKLISTS` const around line 720
2. **Server-side seeding** — `matter-manager.js`, the `CHECKLIST_TEMPLATES` const around line 1830

The toggle handler in matters.html uses item TEXT to match between local template and DB row (because local IDs are strings like "pfr-1", DB rows have integer IDs). If you change template item text, existing matters that already applied the template won't sync — they'd keep the old text in the DB.

### Debug a failed parse

1. Render Logs tab → filter by `parse` or `ingest`
2. Look for the raw Claude response in the error log (we log it on JSON parse failure)
3. Common causes:
   - Claude wrapped JSON in markdown fences (we strip ```json now, but variants might slip through)
   - Long input (>50KB for order parser, >100KB for ingest) — truncate before pasting
   - Anthropic API key not set or expired

### Roll back a bad deploy

1. Render Dashboard → tezlaw-bot → Events tab
2. Find the previous successful deploy
3. Click "Rollback" — ~2 min

### Restore the database from a bad write

1. Render Dashboard → tezlaw-bot → Connect → Postgres
2. "Recovery" tab — pick a timestamp within last 7 days
3. Creates a new DB instance from that snapshot
4. Switch the `DATABASE_URL` env var to the recovered DB connection string
5. Redeploy

---

## Non-obvious decisions

### Why client_name is stored as "X v. Y" (not split into client + adverse columns)

Practical: matters can have multi-party captions ("Acme v. Doe, et al."), or no adverse party at all (estate planning), or the petitioner is the "et al" side. A single free-form field handles all of them. The UI splits on " v. " for display purposes only.

Side effect: matter created with client_name "Guangfeng Lu" (no " v. ") will have no adverse party in the UI even though the case caption is "Lu v. Bondi." Edit the matter and re-save with the full caption to fix.

### Why the parser is propose-only (no auto-add)

Extraction errors in legal contexts have real consequences. "Response due 14 days from service" misread as "Response due in 14 days" is a missed filing. The accept-button-per-deadline friction is the safety check. Do not remove it.

### Why matter_proposals.matter_id is nullable

A NEF can arrive for a case you haven't created in the system yet (Zhang v. MULLIN was the example). We store the proposal with `matter_id=NULL` and surface it under "Unmatched" in the inbox. Accept → creates the matter and links any other unmatched proposals with the same case number.

### Why we have BOTH matters.notes (scalar) AND matter_notes (table)

Legacy. The original UI design used the table (one row per timestamped note, like a journal). The new UI uses the scalar field as a single autosave textarea. The table still exists for backward compat but new writes don't add rows. If you ever want to restore the journal UI, the table is still there.

### Why case_type doesn't have a CHECK constraint

We support free-form types for non-immigration practice areas (Business Lit, Real Estate, Estate Planning). A CHECK constraint would force schema changes for every new type. The application layer validates known types where it matters (e.g., template seeding).

### Why proposals don't have an idempotency constraint

Known gap. Pasting the same NEF twice creates two proposals. Fix planned for Phase 1 (email pipeline) — needs unique constraint on (user_id, source_ref) when source_ref is non-null, plus content-hash dedup for null source_ref.

---

## What's deferred / known issues

**HIGH PRIORITY (do before Phase 1 email pipe ships):**
- Idempotency on `/api/ingest` — paste same email twice = duplicate proposals
- Test inbox flow with a real NEF that has deadlines (only tested with petition-filing NEFs, which produce 0 deadlines)
- Test matching when NEF matter_ref differs in formatting from stored matter_ref (e.g., "5:26-CV-02340" vs "5:26-cv-02340" — fuzzy match should handle this but not validated)

**MEDIUM PRIORITY:**
- USCIS data refresh broken — GitHub Actions runner IPs blocked by Akamai (HTTP 403). The bot uses static April 2026 data as fallback. Long-term: scrape from residential IP, use paid API, or manual quarterly refresh.
- Lu's matter is missing 6 of 7 deadlines (CAR 6/24, Govt response 7/15, Reply 7/22, Opening Brief 8/3, Answering 9/2, Optional Reply 9/23). Add via the deadline form or court order parser.
- Lu's client_name is "Guangfeng Lu" without " v. Bondi" — edit to fix display
- Lu's PFR checklist template not applied. First click on any item in the UI will auto-apply.

**LOW PRIORITY:**
- A stray matter id=2 from earlier testing may still be in the DB. `psql $DATABASE_URL -c "SELECT id, client_name FROM matters;"` to check, `DELETE FROM matters WHERE id=2;` to remove.
- `render.yaml` startCommand says `node whatsapp.js` (should be `node server.js`). Render dashboard config overrides this so it doesn't matter, but file lies. Fix when convenient.

**NOT STARTED:**
- Phase 1: SendGrid Inbound Parse + DNS for automatic CM/ECF email ingestion. Currently you paste emails into the inbox manually.

---

## Environment / deployment

**Render service:** `tezlaw-bot` (Web Service, Node.js)  
**Render Postgres:** `zara-memory` (Basic-256MB, Postgres 18, Oregon, 7-day PITR)  
**Auto-deploy:** on commit to `main` branch  
**GitHub repo:** `tezlawpc/tezlaw-bot`  
**Build command:** `npm install && pip install --break-system-packages eyecite==2.6.5`  
**Start command:** `node server.js`  

**Required env vars:**
- `ANTHROPIC_API_KEY` — for parsers
- `DATABASE_URL` — auto-set by Render Postgres link
- `TELEGRAM_TOKEN`, `WHATSAPP_TOKEN`, `WECHAT_APP_ID`, `COURTLISTENER_TOKEN`, `JJ_TELEGRAM_ID` — for Zara (not matter manager specifically)

**Manual ops:**
- Render Shell access: dashboard → service → Shell tab
- DB shell: `psql $DATABASE_URL`
- Restart: dashboard → service → Manual Deploy → "Clear cache & deploy"

---

## Backup plan if everything breaks

1. **Code lost:** GitHub history. Every commit is recoverable.
2. **DB corrupted:** Render PITR (7 days). Pick a timestamp before the corruption, restore as new DB.
3. **Render account locked:** GitHub repo + manual `pg_dump` you may or may not have. Worst case: re-deploy to new Render account, re-init schema from db.js (it'll create empty tables), restore from PITR.
4. **Anthropic API down:** Parsers stop working. Rest of the app keeps working. No data loss.

---

*End of README. Last updated: May 23, 2026.*
