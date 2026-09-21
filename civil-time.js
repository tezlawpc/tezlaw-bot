// ============================================================
//  civil-time.js — time entries and invoices for a civil matter
//  ─────────────────────────────────────────────────────────
//  Time could already be recorded — as billable hours on a logged
//  event or communication — but only inside "Log event", and there
//  was nowhere to see it, correct it, or bill it. So:
//
//    · A time entry is a first-class thing: date, timekeeper, hours,
//      narrative, UTBMS codes, rate, no-charge flag.
//    · The case page lists unbilled time with its running total.
//    · "Prepare invoice" sweeps the unbilled time in a date range onto
//      a numbered invoice, which prints as a client invoice and exports
//      as LEDES 1998B for clients who require it.
//
//  Storage deliberately reuses what exists. A time entry IS a
//  civil_case_events row (event_kind 'time'), so every report that
//  already sums billable_hours — the financials panel, the WIP report,
//  the budget alert, LEDES — keeps working unchanged and counts it.
//  Communication time (a billed phone call) is listed and invoiced
//  alongside it, because it is billed alongside it.
//
//  Rules that protect the books:
//
//    · Billed time is frozen. An entry on an invoice cannot be edited
//      or deleted — void the invoice first. An invoice the client has
//      seen must match what the system says was on it.
//    · Voiding never deletes. The invoice stays, marked void, and its
//      entries go back to unbilled.
//    · No-charge time is recorded at $0 and printed as NO CHARGE, so
//      the client sees the work that was done without paying for it.
// ============================================================

const db = require("./db");

let ready = null;
function initTables() {
  if (ready) return ready;
  ready = (async () => {
    await db.query(`
      CREATE TABLE IF NOT EXISTS civil_invoices (
        id              SERIAL PRIMARY KEY,
        case_id         INTEGER REFERENCES civil_cases(id) ON DELETE CASCADE,
        invoice_number  TEXT UNIQUE NOT NULL,
        invoice_date    DATE NOT NULL DEFAULT CURRENT_DATE,
        period_from     DATE,
        period_to       DATE,
        total_hours     NUMERIC DEFAULT 0,
        total_amount    NUMERIC DEFAULT 0,
        status          TEXT DEFAULT 'issued',
        notes           TEXT,
        created_by      TEXT,
        created_at      TIMESTAMPTZ DEFAULT NOW(),
        voided_at       TIMESTAMPTZ,
        voided_by       TEXT
      )`);
    for (const tbl of ["civil_case_events", "civil_case_communications"]) {
      await db.query(`ALTER TABLE ${tbl} ADD COLUMN IF NOT EXISTS invoice_id INTEGER`).catch(() => {});
      await db.query(`ALTER TABLE ${tbl} ADD COLUMN IF NOT EXISTS no_charge BOOLEAN DEFAULT FALSE`).catch(() => {});
      await db.query(`ALTER TABLE ${tbl} ADD COLUMN IF NOT EXISTS utbms_code TEXT`).catch(() => {});
      await db.query(`ALTER TABLE ${tbl} ADD COLUMN IF NOT EXISTS utbms_activity TEXT`).catch(() => {});
    }
  })().catch(e => { ready = null; throw e; });
  return ready;
}

const SOURCES = { event: "civil_case_events", comm: "civil_case_communications" };

function num(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Hours to the tenth, the way the firm bills. 0.25 stays 0.25. */
function roundHours(h) {
  return Math.round(h * 100) / 100;
}

// ── Listing ─────────────────────────────────────────────────

/**
 * Every billable entry on a matter, newest first.
 * status: "unbilled" | "billed" | "all"
 */
async function listTime(caseId, { status = "unbilled" } = {}) {
  await initTables();
  const billed = status === "billed" ? "AND t.invoice_id IS NOT NULL"
               : status === "unbilled" ? "AND t.invoice_id IS NULL" : "";
  const r = await db.query(
    `WITH t AS (
       SELECT 'event' AS source, id, case_id, event_date AS entry_date,
              COALESCE(NULLIF(description, ''), title) AS narrative, title,
              billable_hours, billable_rate, billable_amount, no_charge, invoice_id,
              utbms_code, utbms_activity, attorney_id, paralegal_id, created_by, created_at, event_kind
         FROM civil_case_events
        WHERE case_id = $1 AND billable_hours IS NOT NULL
       UNION ALL
       SELECT 'comm', id, case_id, created_at::date,
              COALESCE(NULLIF(subject, ''), NULLIF(body, ''), kind), subject,
              billable_hours, billable_rate, billable_amount, no_charge, invoice_id,
              utbms_code, utbms_activity, attorney_id, paralegal_id, created_by, created_at, 'communication'
         FROM civil_case_communications
        WHERE case_id = $1 AND billable_hours IS NOT NULL
     )
     SELECT t.*, u.full_name AS timekeeper_name, u.username AS timekeeper_username,
            i.invoice_number
       FROM t
       LEFT JOIN admin_users u ON u.id = COALESCE(t.attorney_id, t.paralegal_id)
       LEFT JOIN civil_invoices i ON i.id = t.invoice_id
      WHERE 1=1 ${billed}
      ORDER BY t.entry_date DESC NULLS LAST, t.created_at DESC`,
    [caseId]
  );
  return r.rows.map(row => Object.assign(row, {
    billable_hours: num(row.billable_hours),
    billable_rate: num(row.billable_rate),
    billable_amount: row.no_charge ? 0 : num(row.billable_amount),
    timekeeper: row.timekeeper_name || row.timekeeper_username || row.created_by || null,
  }));
}

function totals(rows) {
  const t = { entries: rows.length, hours: 0, amount: 0, no_charge_hours: 0, unpriced: 0 };
  for (const r of rows) {
    t.hours += r.billable_hours || 0;
    if (r.no_charge) t.no_charge_hours += r.billable_hours || 0;
    else if (r.billable_amount == null) t.unpriced++;
    else t.amount += r.billable_amount;
  }
  t.hours = roundHours(t.hours);
  t.no_charge_hours = roundHours(t.no_charge_hours);
  t.amount = Math.round(t.amount * 100) / 100;
  return t;
}

// ── Entering time ───────────────────────────────────────────

/**
 * Log time. Rate resolution is logEvent's: an explicit rate wins, else
 * the timekeeper's case-team rate, else their firm default, else the
 * matter's hourly rate.
 */
async function logTime(caseId, data, { by = null, userId = null } = {}) {
  await initTables();
  const civil = require("./civil-litigation");
  const hours = num(data.hours);
  if (!hours || hours <= 0) throw new Error("Enter the hours worked");
  if (hours > 24) throw new Error("More than 24 hours in one entry — split it by day");
  const narrative = String(data.description || "").trim();
  if (!narrative) throw new Error("Describe the work — it prints on the invoice");

  // Whoever is logging is the timekeeper unless someone else is named.
  const tk = num(data.timekeeper_id) || num(userId);
  const isParalegal = String(data.timekeeper_role || "").match(/paralegal|case_manager|clerk|assistant/);

  const row = await civil.logEvent(caseId, {
    event_kind: "time",
    event_date: data.date || new Date().toISOString().slice(0, 10),
    title: narrative.length > 80 ? narrative.slice(0, 77) + "…" : narrative,
    description: narrative,
    billable_hours: roundHours(hours),
    billable_rate: num(data.rate),
    attorney_id: isParalegal ? null : tk,
    paralegal_id: isParalegal ? tk : null,
    created_by: by,
  });

  await db.query(
    `UPDATE civil_case_events SET utbms_code = $2, utbms_activity = $3, no_charge = $4,
            billable_amount = CASE WHEN $4 THEN 0 ELSE billable_amount END
      WHERE id = $1`,
    [row.id, data.utbms_code || null, data.utbms_activity || null, !!data.no_charge]
  );
  return (await db.query(`SELECT * FROM civil_case_events WHERE id = $1`, [row.id])).rows[0];
}

async function loadEntry(source, id) {
  const tbl = SOURCES[source];
  if (!tbl) throw new Error("Unknown time entry source");
  const r = await db.query(`SELECT * FROM ${tbl} WHERE id = $1`, [id]);
  if (!r.rows.length) throw new Error("Time entry not found");
  return { tbl, row: r.rows[0] };
}

function assertUnbilled(row) {
  if (row.invoice_id) {
    throw new Error("This time is already on an invoice. Void the invoice first if it needs to change — " +
                    "the invoice the client received has to match the books.");
  }
}

async function updateTime(source, id, data) {
  await initTables();
  const { tbl, row } = await loadEntry(source, id);
  assertUnbilled(row);

  const hours = data.hours !== undefined ? num(data.hours) : num(row.billable_hours);
  if (!hours || hours <= 0) throw new Error("Hours must be more than zero");
  const rate = data.rate !== undefined ? num(data.rate) : num(row.billable_rate);
  const noCharge = data.no_charge !== undefined ? !!data.no_charge : !!row.no_charge;
  const amount = noCharge ? 0 : (rate != null ? Math.round(hours * rate * 100) / 100 : null);

  const sets = ["billable_hours = $2", "billable_rate = $3", "billable_amount = $4", "no_charge = $5"];
  const vals = [id, roundHours(hours), rate, amount, noCharge];
  let i = 6;
  if (data.utbms_code !== undefined) { sets.push(`utbms_code = $${i++}`); vals.push(data.utbms_code || null); }
  if (data.utbms_activity !== undefined) { sets.push(`utbms_activity = $${i++}`); vals.push(data.utbms_activity || null); }
  if (tbl === "civil_case_events") {
    if (data.date !== undefined) { sets.push(`event_date = $${i++}`); vals.push(data.date || null); }
    if (data.description !== undefined) {
      const d = String(data.description || "").trim();
      if (!d) throw new Error("The description cannot be empty — it prints on the invoice");
      sets.push(`description = $${i++}`); vals.push(d);
      sets.push(`title = $${i++}`); vals.push(d.length > 80 ? d.slice(0, 77) + "…" : d);
    }
  }
  const r = await db.query(`UPDATE ${tbl} SET ${sets.join(", ")} WHERE id = $1 RETURNING *`, vals);
  return r.rows[0];
}

/**
 * Remove time. A 'time' event is deleted outright. Time that rides on some
 * other record — a logged hearing, a phone call — keeps the record and just
 * loses its hours, because the hearing still happened.
 */
async function deleteTime(source, id) {
  await initTables();
  const { tbl, row } = await loadEntry(source, id);
  assertUnbilled(row);
  if (tbl === "civil_case_events" && row.event_kind === "time") {
    await db.query(`DELETE FROM civil_case_events WHERE id = $1`, [id]);
    return { ok: true, mode: "deleted" };
  }
  await db.query(
    `UPDATE ${tbl} SET billable_hours = NULL, billable_rate = NULL, billable_amount = NULL WHERE id = $1`, [id]);
  return { ok: true, mode: "hours_removed" };
}

// ── Invoices ────────────────────────────────────────────────

async function nextInvoiceNumber(caseId) {
  const r = await db.query(`SELECT COUNT(*)::int AS n FROM civil_invoices WHERE case_id = $1`, [caseId]);
  const seq = String((r.rows[0] ? r.rows[0].n : 0) + 1).padStart(3, "0");
  return `TEZ-${caseId}-${seq}`;
}

/**
 * Put the unbilled time in [from, to] on a new invoice.
 * Both dates optional; no range means "everything unbilled".
 */
async function createInvoice(caseId, { from = null, to = null, notes = null, by = null } = {}) {
  await initTables();
  const all = await listTime(caseId, { status: "unbilled" });
  const inRange = all.filter(r => {
    const d = r.entry_date ? new Date(r.entry_date).toISOString().slice(0, 10) : null;
    if (from && (!d || d < from)) return false;
    if (to && (!d || d > to)) return false;
    return true;
  });
  if (!inRange.length) throw new Error("No unbilled time in that period");

  const unpriced = inRange.filter(r => !r.no_charge && r.billable_amount == null);
  if (unpriced.length) {
    throw new Error(`${unpriced.length} entr${unpriced.length === 1 ? "y has" : "ies have"} no rate, so ` +
      "the invoice total would be wrong. Set a rate on those entries (or on the case / timekeeper) first.");
  }

  const t = totals(inRange);
  const number = await nextInvoiceNumber(caseId);
  const dates = inRange.map(r => r.entry_date && new Date(r.entry_date).toISOString().slice(0, 10)).filter(Boolean).sort();
  const inv = (await db.query(
    `INSERT INTO civil_invoices (case_id, invoice_number, period_from, period_to, total_hours, total_amount, notes, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [caseId, number, from || dates[0] || null, to || dates[dates.length - 1] || null, t.hours, t.amount, notes, by]
  )).rows[0];

  for (const r of inRange) {
    await db.query(`UPDATE ${SOURCES[r.source]} SET invoice_id = $1 WHERE id = $2 AND invoice_id IS NULL`, [inv.id, r.id]);
  }

  try {
    await require("./civil-litigation").logEvent(caseId, {
      event_kind: "note",
      event_date: new Date().toISOString().slice(0, 10),
      title: `Invoice ${number} prepared`,
      description: `${t.entries} entries · ${t.hours} hours · $${t.amount.toFixed(2)}` +
                   (t.no_charge_hours ? ` (${t.no_charge_hours} hours no charge)` : ""),
      created_by: by,
    });
  } catch (e) { /* the invoice exists either way */ }

  return Object.assign(inv, { totals: t });
}

async function listInvoices(caseId) {
  await initTables();
  const r = await db.query(
    `SELECT * FROM civil_invoices WHERE case_id = $1 ORDER BY created_at DESC`, [caseId]);
  return r.rows.map(x => Object.assign(x, { total_hours: num(x.total_hours), total_amount: num(x.total_amount) }));
}

async function getInvoice(invoiceId) {
  await initTables();
  const r = await db.query(`SELECT * FROM civil_invoices WHERE id = $1`, [invoiceId]);
  if (!r.rows.length) throw new Error("Invoice not found");
  const inv = r.rows[0];
  const all = await listTime(inv.case_id, { status: "all" });
  const lines = all.filter(x => x.invoice_id === inv.id)
    .sort((a, b) => new Date(a.entry_date || 0) - new Date(b.entry_date || 0));
  return { invoice: inv, lines, totals: totals(lines) };
}

async function voidInvoice(invoiceId, { by = null } = {}) {
  await initTables();
  const r = await db.query(`SELECT * FROM civil_invoices WHERE id = $1`, [invoiceId]);
  const inv = r.rows[0];
  if (!inv) throw new Error("Invoice not found");
  if (inv.status === "void") return inv;
  for (const tbl of Object.values(SOURCES)) {
    await db.query(`UPDATE ${tbl} SET invoice_id = NULL WHERE invoice_id = $1`, [invoiceId]);
  }
  const u = await db.query(
    `UPDATE civil_invoices SET status = 'void', voided_at = NOW(), voided_by = $2 WHERE id = $1 RETURNING *`,
    [invoiceId, by]);
  try {
    await require("./civil-litigation").logEvent(inv.case_id, {
      event_kind: "note",
      event_date: new Date().toISOString().slice(0, 10),
      title: `Invoice ${inv.invoice_number} voided`,
      description: "Its time entries are unbilled again and can be corrected and re-invoiced.",
      created_by: by,
    });
  } catch (e) { /* non-fatal */ }
  return u.rows[0];
}

// ── The printable invoice ───────────────────────────────────

function esc(s) {
  return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function usd(n) {
  return "$" + Number(n || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function day(d) {
  if (!d) return "";
  const t = new Date(d);
  return isNaN(t) ? "" : t.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

/** A standalone, print-ready HTML invoice. No scripts. */
async function renderInvoiceHtml(invoiceId) {
  const { invoice: inv, lines, totals: t } = await getInvoice(invoiceId);
  const c = (await db.query(`SELECT * FROM civil_cases WHERE id = $1`, [inv.case_id])).rows[0] || {};
  let clientName = c.client_key;
  try {
    const n = await db.query(
      `SELECT client_name FROM tasks WHERE client_key = $1 AND client_name IS NOT NULL ORDER BY created_at ASC LIMIT 1`,
      [c.client_key]);
    if (n.rows[0]) clientName = n.rows[0].client_name;
  } catch (e) { /* fall back to the key */ }

  const byTk = {};
  lines.forEach(l => {
    const k = l.timekeeper || "—";
    byTk[k] = byTk[k] || { hours: 0, amount: 0, rate: l.billable_rate };
    byTk[k].hours += l.billable_hours || 0;
    byTk[k].amount += l.no_charge ? 0 : (l.billable_amount || 0);
  });

  const rows = lines.map(l => `
    <tr>
      <td class="d">${esc(day(l.entry_date))}</td>
      <td>${esc(l.timekeeper || "")}</td>
      <td>${esc(l.narrative || "")}${l.utbms_code ? ` <span class="code">${esc(l.utbms_code)}${l.utbms_activity ? "/" + esc(l.utbms_activity) : ""}</span>` : ""}</td>
      <td class="n">${(l.billable_hours || 0).toFixed(2)}</td>
      <td class="n">${l.billable_rate != null ? usd(l.billable_rate) : ""}</td>
      <td class="n">${l.no_charge ? "NO CHARGE" : usd(l.billable_amount)}</td>
    </tr>`).join("");

  const tkRows = Object.keys(byTk).map(k => `
    <tr><td>${esc(k)}</td><td class="n">${roundHours(byTk[k].hours).toFixed(2)}</td>
        <td class="n">${byTk[k].rate != null ? usd(byTk[k].rate) : ""}</td><td class="n">${usd(byTk[k].amount)}</td></tr>`).join("");

  return `<!doctype html><html><head><meta charset="utf-8">
<title>Invoice ${esc(inv.invoice_number)} — ${esc(c.case_name || "")}</title>
<style>
  body { font-family: Georgia, "Times New Roman", serif; color: #222; max-width: 8.5in; margin: 0 auto; padding: 0.6in 0.6in; font-size: 11pt; }
  h1 { font-size: 20pt; margin: 0; letter-spacing: 1px; }
  .firm { font-size: 10pt; color: #444; line-height: 1.5; }
  .top { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 2px solid #222; padding-bottom: 12px; }
  .meta { text-align: right; font-size: 10pt; line-height: 1.6; }
  .block { margin: 18px 0; font-size: 10.5pt; line-height: 1.55; }
  table { width: 100%; border-collapse: collapse; font-size: 9.5pt; }
  th { text-align: left; border-bottom: 1px solid #222; padding: 6px 4px; font-size: 8.5pt; letter-spacing: .5px; text-transform: uppercase; }
  td { padding: 6px 4px; border-bottom: 1px solid #ddd; vertical-align: top; }
  td.n, th.n { text-align: right; white-space: nowrap; }
  td.d { white-space: nowrap; }
  .code { color: #888; font-size: 8pt; }
  .total { font-size: 12pt; font-weight: bold; }
  .void { color: #a00; border: 3px solid #a00; display: inline-block; padding: 4px 12px; font-size: 16pt; letter-spacing: 3px; transform: rotate(-4deg); }
  .foot { margin-top: 28px; font-size: 9pt; color: #555; line-height: 1.5; }
  .bar { margin-bottom: 18px; } .bar button { padding: 8px 16px; font-size: 11pt; cursor: pointer; }
  @media print { .bar { display: none; } body { padding: 0; } }
</style></head><body>
<div class="bar"><button onclick="window.print()">Print / Save as PDF</button></div>
<div class="top">
  <div>
    <h1>TEZ LAW, P.C.</h1>
    <div class="firm">West Covina, California</div>
  </div>
  <div class="meta">
    <div><strong>INVOICE ${esc(inv.invoice_number)}</strong></div>
    <div>Date: ${esc(day(inv.invoice_date))}</div>
    ${inv.period_from || inv.period_to ? `<div>Services: ${esc(day(inv.period_from))} – ${esc(day(inv.period_to))}</div>` : ""}
    ${inv.status === "void" ? `<div style="margin-top:6px;"><span class="void">VOID</span></div>` : ""}
  </div>
</div>
<div class="block">
  <strong>Client:</strong> ${esc(clientName)}<br>
  <strong>Matter:</strong> ${esc(c.case_name || "")}${c.case_number ? ` · Case No. ${esc(c.case_number)}` : ""}${c.court ? `<br><strong>Court:</strong> ${esc(c.court)}` : ""}
</div>
<table>
  <thead><tr><th>Date</th><th>Timekeeper</th><th>Description</th><th class="n">Hours</th><th class="n">Rate</th><th class="n">Amount</th></tr></thead>
  <tbody>${rows}</tbody>
</table>
<table style="margin-top:18px;width:60%;margin-left:auto;">
  <thead><tr><th>Timekeeper summary</th><th class="n">Hours</th><th class="n">Rate</th><th class="n">Amount</th></tr></thead>
  <tbody>${tkRows}
    <tr><td class="total">Total fees</td><td class="n total">${t.hours.toFixed(2)}</td><td></td><td class="n total">${usd(t.amount)}</td></tr>
  </tbody>
</table>
${t.no_charge_hours ? `<div class="foot">Includes ${t.no_charge_hours.toFixed(2)} hours of work performed at no charge.</div>` : ""}
${inv.notes ? `<div class="foot">${esc(inv.notes)}</div>` : ""}
<div class="foot">Thank you for the opportunity to represent you. Please contact our office with any questions about this statement.</div>
</body></html>`;
}

module.exports = {
  initTables, listTime, totals, logTime, updateTime, deleteTime,
  createInvoice, listInvoices, getInvoice, voidInvoice, renderInvoiceHtml,
  roundHours, SOURCES,
};
