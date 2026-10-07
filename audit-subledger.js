// ============================================================
//  NIGHTFOOD HOLDINGS, INC. — PCAOB AUDIT PORTAL
//  audit-subledger.js — AR / AP SUBLEDGERS AND AUDIT SAMPLING
//  ─────────────────────────────────────────────────────────
//  "Here are our forty selections. Please provide support."
//
//  That email is where a small-cap close goes to die. Not because
//  the documents don't exist — they almost always do — but because
//  a receivable lives in the accounting system as a NUMBER while
//  the evidence that the number is real lives in somebody's inbox.
//  Forty selections then become forty separate archaeology
//  projects, run by whoever happens to still work there.
//
//  ── What this module is NOT ──
//  It is not an AR/AP system. The accounting system stays the
//  system of record. Replacing it would be a year of work and the
//  auditor would still ask for exactly the same things. Three
//  narrower things are missing, and they are cheap:
//
//    1. A FROZEN SNAPSHOT that ties to the general ledger. An
//       aging is evidence as of a date, so once it has been tied
//       out it cannot be edited — a corrected aging is a new
//       snapshot. The unexplained variance IS the finding, and
//       this module's job is to refuse to hide it.
//
//    2. A DOCUMENT INDEX keyed to the invoice number, because the
//       invoice number is the identifier the auditor will quote.
//       Normalising it once on import ("Inv 1234" / "INV-0001234")
//       removes ten minutes per line, forty times.
//
//    3. A MATCHING ENGINE for the selection list, so a sample
//       becomes a worklist with owners and gaps.
//
//  ── You do not have to wait for the sample ──
//  You cannot know which items they will pick. You CAN know which
//  ones are near-certain: auditors test everything above a
//  threshold individually and sample the rest. So likelySelections()
//  produces a worklist — the large items plus the risk markers an
//  auditor is trained to look at. In a distribution business with
//  four thousand open invoices that is forty or sixty lines, and
//  getting those sixty covered before fieldwork is the whole game.
//  It is labelled a heuristic everywhere it appears, because it is
//  one, and when the auditor has not shared a threshold the module
//  refuses to invent one.
//
//  ── Readiness is measured in DOLLARS ──
//  95% of lines covered while the three largest invoices are
//  missing is not 95% ready, it is zero: they sample by dollars.
//  Every readiness figure here is reported both ways and the
//  dollar one leads.
//
//  ── The AS 2310 boundary is structural ──
//  AS 2310 applies to fiscal years ending on or after 15 June 2025,
//  so a June year end was already subject to it on the FY2025
//  audit. Paragraph .15 requires the AUDITOR to select the items,
//  send the confirmation requests and receive the responses. So for
//  a confirmation procedure this module will accept customer
//  contact detail and nothing else, and it refuses a confirmation
//  response from the company side outright. Companies do sometimes
//  try to help by collecting those, and it destroys the evidence
//  rather than speeding it up.
//
//  No new dependencies — `xlsx` is already in package.json.
// ============================================================

const crypto = require("crypto");
const db = require("./db");
const cal = require("./audit-calendar");
const schema = require("./audit-schema");

// ── Support types ───────────────────────────────────────────
//
// Separate types rather than one "supporting documents" bucket,
// because the procedures need different things and an invoice alone
// does not evidence that goods were delivered. That distinction is the
// entire point of the alternative procedures in AS 2310 Appendix C.
const SUPPORT_TYPES = {
  invoice: { label: "Invoice", short: "INV", kinds: ["ar", "ap"], proves: "The amount billed, to whom, and when." },
  po_or_contract: { label: "Purchase order or contract", short: "PO", kinds: ["ar", "ap"], proves: "That the counterparty agreed to buy or supply, at that price." },
  proof_of_delivery: { label: "Proof of delivery", short: "POD", kinds: ["ar"], proves: "That the performance obligation was satisfied and WHEN — which is what decides the period. A bill of lading, a signed delivery receipt, carrier tracking." },
  receiving_report: { label: "Receiving report", short: "RR", kinds: ["ap"], proves: "That the goods or services were actually received, and in which period." },
  cash_receipt: { label: "Cash receipt / bank detail", short: "CASH", kinds: ["ar"], proves: "That the receivable was collected. The single most efficient piece of evidence for AR existence." },
  remittance_advice: { label: "Remittance advice", short: "REM", kinds: ["ar"], proves: "Which invoices a payment was applied to." },
  payment_proof: { label: "Cleared payment", short: "PAY", kinds: ["ap"], proves: "That the payable was settled — cleared cheque, wire confirmation, ACH detail." },
  credit_memo: { label: "Credit memo", short: "CM", kinds: ["ar", "ap"], proves: "A reduction after the fact. Credit memos issued after period end are a classic cutoff test." },
  vendor_statement: { label: "Vendor statement", short: "VS", kinds: ["ap"], proves: "What the VENDOR says is owed — third-party evidence, which under AS 1105 outweighs the company's own ledger." },
  reconciliation: { label: "Reconciliation", short: "REC", kinds: ["ar", "ap"], proves: "How a difference between two records was resolved." },
  counterparty_contact: { label: "Confirmation contact detail", short: "CONTACT", kinds: ["ar", "ap"], proves: "Who to send a confirmation to, and at what verified address. This is ALL the company supplies for a confirmation." },
  other: { label: "Other support", short: "OTH", kinds: ["ar", "ap"], proves: "Anything else relied on." },
};

// Never acceptable from the company side, for any procedure.
const COMPANY_FORBIDDEN_SUPPORT = {
  confirmation_response:
    "A confirmation response may not be uploaded here. AS 2310.15 requires the AUDITOR to send the requests and receive the responses — a reply that passed through the company is not confirmation evidence, and submitting one does not speed the audit up, it voids the procedure and forces it to be redone.",
};

// ── Procedures ──────────────────────────────────────────────
const PROCEDURES = {
  confirmation: {
    label: "Receivable confirmation",
    kind: "ar",
    requires: ["counterparty_contact"],
    authority: ["PCAOB AS 2310.24", "AS 2310.15"],
    note:
      "The auditor selects the items, sends the requests and receives the responses — AS 2310.15. The company supplies verified contact detail and nothing else. Do not contact the customer about the confirmation; a response that came through the company is not confirmation evidence.",
    companySuppliesOnly: true,
  },
  alternative_procedures: {
    label: "Receivable alternative procedures (non-response)",
    kind: "ar",
    requires: ["invoice", "proof_of_delivery", "cash_receipt"],
    authority: ["PCAOB AS 2310.23 and Appendix C"],
    note:
      "What the auditor does when a confirmation does not come back. Subsequent cash receipt is the strongest single item; where the invoice has not been paid, the invoice plus proof of delivery carries it.",
  },
  ar_details_test: {
    label: "Receivable test of details (existence / valuation)",
    kind: "ar",
    requires: ["invoice", "proof_of_delivery"],
    authority: ["PCAOB AS 2301", "AS 1105"],
    note: "Does the receivable exist, at that amount, as of that date.",
  },
  revenue_cutoff: {
    label: "Revenue cutoff",
    kind: "ar",
    requires: ["invoice", "proof_of_delivery", "po_or_contract"],
    authority: ["ASC 606-10-25-23", "PCAOB AS 2301"],
    note:
      "Was control transferred before or after the period end. The DELIVERY DATE decides it, not the invoice date, so proof of delivery is the item that matters here and shipping terms have to be legible on it.",
  },
  unrecorded_liabilities: {
    label: "Search for unrecorded liabilities",
    kind: "ap",
    requires: ["invoice", "payment_proof"],
    authority: ["PCAOB AS 2301", "AS 2810"],
    note:
      "The auditor takes payments made AFTER the period end above a threshold and asks, for each, whether the liability belonged in the period just closed. The test turns on the DATE THE SERVICE WAS PERFORMED or the goods received, not the invoice date — so the invoice has to show the service period.",
  },
  ap_details_test: {
    label: "Payable test of details",
    kind: "ap",
    requires: ["invoice", "receiving_report"],
    authority: ["PCAOB AS 2301", "AS 1105"],
    note: "Does the payable exist, at that amount, and was the thing actually received.",
  },
  vendor_statement: {
    label: "Vendor statement reconciliation",
    kind: "ap",
    requires: ["vendor_statement", "reconciliation"],
    authority: ["PCAOB AS 1105.08", "AS 2301"],
    note:
      "What the vendor says is owed, reconciled to the ledger. Third-party evidence, so under AS 1105.08 it carries more weight than the company's own records — which is also why an unreconciled difference is taken seriously.",
  },
  other: {
    label: "Other selection",
    kind: null,
    requires: ["invoice"],
    authority: [],
    note: "Whatever the request asks for; set the required support by hand.",
  },
};

// ── Normalisation ───────────────────────────────────────────
//
// The join key that makes the whole feature work. An auditor writes
// "Inv 1234"; the accounting system holds "INV-0001234". A person
// reconciling those by eye spends ten minutes a line and makes mistakes
// at line thirty. Doing it once on import is the entire trick.

function normDoc(v) {
  const s = String(v == null ? "" : v).toUpperCase().replace(/[^A-Z0-9]/g, "");
  return s || null;
}

/** Digits only, leading zeros stripped — the fallback match. */
function normDocDigits(v) {
  const d = String(v == null ? "" : v).replace(/\D/g, "").replace(/^0+/, "");
  return d || null;
}

const NAME_NOISE = /\b(INC|INCORPORATED|LLC|L L C|LTD|LIMITED|CORP|CORPORATION|CO|COMPANY|PLC|LP|LLP|THE|AND|DBA)\b/g;

function normName(v) {
  let s = String(v == null ? "" : v).toUpperCase();
  s = s.replace(/[.,'"&()\/\\-]/g, " ").replace(/\s+/g, " ").trim();
  s = s.replace(NAME_NOISE, " ").replace(/\s+/g, " ").trim();
  return s || null;
}

/** "$ (1,234.56)" → -1234.56. Parentheses are negative, as in every aging. */
function parseAmount(v) {
  if (v == null || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  let s = String(v).trim();
  const neg = /^\(.*\)$/.test(s) || /-\s*$/.test(s);
  s = s.replace(/[()]/g, "").replace(/[^0-9.\-]/g, "");
  if (!s || s === "-" || s === ".") return null;
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return neg && n > 0 ? -n : n;
}

const MONTHS3 = { JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6, JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12 };

/**
 * Tolerant date parsing, because exports are not consistent even within
 * one system. Returns an ISO date string or null.
 *
 * Ambiguous DD/MM vs MM/DD is resolved as US order, which is what every
 * accounting system in use here emits. Where the first part is above 12
 * it is taken as a day, so a European export still lands correctly.
 */
function parseDate(v) {
  if (v == null || v === "") return null;
  if (v instanceof Date) return isNaN(v) ? null : cal.dstr(v);
  // Excel serial dates arrive as numbers when a sheet is read raw.
  if (typeof v === "number" && v > 20000 && v < 60000) {
    const ms = Math.round((v - 25569) * 86400000);
    return cal.dstr(new Date(ms));
  }
  const s = String(v).trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${String(+m[2]).padStart(2, "0")}-${String(+m[3]).padStart(2, "0")}`;
  m = s.match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})$/);
  if (m) {
    let [, a, b, y] = m;
    let mo = +a;
    let d = +b;
    if (mo > 12 && d <= 12) {
      mo = +b;
      d = +a;
    }
    let yr = +y;
    if (yr < 100) yr += yr < 70 ? 2000 : 1900;
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    return `${yr}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  }
  m = s.match(/^(\d{1,2})[\-\s]([A-Za-z]{3})[A-Za-z]*[\-\s](\d{2,4})$/);
  if (m) {
    const mo = MONTHS3[m[2].toUpperCase()];
    let yr = +m[3];
    if (yr < 100) yr += yr < 70 ? 2000 : 1900;
    if (!mo) return null;
    return `${yr}-${String(mo).padStart(2, "0")}-${String(+m[1]).padStart(2, "0")}`;
  }
  m = s.match(/^([A-Za-z]{3})[A-Za-z]*\s+(\d{1,2}),?\s+(\d{4})$/);
  if (m) {
    const mo = MONTHS3[m[1].toUpperCase()];
    if (!mo) return null;
    return `${m[3]}-${String(mo).padStart(2, "0")}-${String(+m[2]).padStart(2, "0")}`;
  }
  const d2 = new Date(s);
  return isNaN(d2) ? null : cal.dstr(d2);
}

// ── Column detection ────────────────────────────────────────
//
// The "easy" in "an easy solution" is almost entirely here. Nobody is
// going to reformat a QuickBooks export by hand every month, so the
// importer has to read what the accounting system actually emits —
// including the three title rows above the header and the per-customer
// subtotal rows inside the body.
const FIELD_SYNONYMS = {
  counterparty_name: [
    "name", "customer", "customer name", "customer:job", "vendor", "vendor name", "supplier",
    "supplier name", "contact", "contact name", "payee", "client", "account name", "account",
    "bill to", "sold to", "entity",
  ],
  counterparty_code: ["customer id", "customer no", "customer number", "customer code", "vendor id", "vendor no", "vendor number", "vendor code", "account no", "account number", "account id", "contact id"],
  doc_number: [
    "num", "no", "no.", "number", "doc no", "doc number", "document number", "document no",
    "invoice", "invoice #", "invoice no", "invoice no.", "invoice number", "inv no", "inv #",
    "bill no", "bill number", "bill #", "transaction number", "trans #", "trans no", "txn no",
    "reference number", "ref no", "voucher", "voucher no",
  ],
  doc_date: ["date", "invoice date", "transaction date", "doc date", "document date", "bill date", "txn date", "posting date", "issue date"],
  due_date: ["due date", "due", "date due", "maturity", "maturity date", "terms due date"],
  amount: ["amount", "total", "invoice amount", "original amount", "doc amount", "document amount", "gross", "total amount", "debit", "amt"],
  open_amount: ["open balance", "open amount", "amount due", "balance", "balance due", "outstanding", "amount remaining", "remaining", "unpaid", "net due", "current balance"],
  days_outstanding: ["aging", "age", "days", "days outstanding", "days past due", "days overdue", "days late"],
  po_number: ["po", "po #", "po no", "po number", "purchase order", "purchase order no", "customer po"],
  reference: ["reference", "ref", "memo/description", "your ref", "their ref"],
  memo: ["memo", "description", "note", "notes", "comment", "comments", "detail", "line description"],
  currency: ["currency", "curr", "ccy", "currency code"],
  terms: ["terms", "payment terms"],
};

function headerKey(h) {
  return String(h == null ? "" : h).toLowerCase().replace(/[\s_]+/g, " ").replace(/[^a-z0-9 #.:\/]/g, "").trim();
}

/** Score a candidate header row by how many fields it resolves. */
function mapHeaderRow(row) {
  const map = {};
  const used = new Set();
  const keys = row.map(headerKey);
  // Longest synonym first, so "invoice date" wins over "date" and
  // "open balance" is not eaten by "balance".
  const fields = Object.keys(FIELD_SYNONYMS);
  const pairs = [];
  for (const f of fields) for (const syn of FIELD_SYNONYMS[f]) pairs.push([f, syn]);
  pairs.sort((a, b) => b[1].length - a[1].length);
  for (const [field, syn] of pairs) {
    if (map[field] != null) continue;
    for (let i = 0; i < keys.length; i++) {
      if (used.has(i) || !keys[i]) continue;
      if (keys[i] === syn) {
        map[field] = i;
        used.add(i);
        break;
      }
    }
  }
  // Second pass: contains-match, for headers like "Invoice Amount (USD)".
  for (const [field, syn] of pairs) {
    if (map[field] != null) continue;
    for (let i = 0; i < keys.length; i++) {
      if (used.has(i) || !keys[i] || keys[i].length < 3) continue;
      if (keys[i].includes(syn)) {
        map[field] = i;
        used.add(i);
        break;
      }
    }
  }
  return map;
}

function mapScore(map) {
  let n = 0;
  if (map.counterparty_name != null) n += 3;
  if (map.doc_number != null) n += 3;
  if (map.amount != null || map.open_amount != null) n += 3;
  if (map.doc_date != null) n += 2;
  if (map.due_date != null) n += 1;
  if (map.days_outstanding != null) n += 1;
  return n;
}

/**
 * Read a sheet into rows, then find the header.
 *
 * QuickBooks and Sage put the company name, the report title and the
 * date range in the rows above the header, so the header is rarely row
 * one. The best-scoring row in the first 25 wins.
 */
function sheetToRows(buffer, filename) {
  const name = String(filename || "").toLowerCase();
  if (name.endsWith(".csv") || name.endsWith(".txt")) {
    const text = buffer.toString("utf8").replace(/^﻿/, "");
    return parseCsv(text);
  }
  const XLSX = require("xlsx");
  const wb = XLSX.read(buffer, { type: "buffer", cellDates: true });
  const sheetName = wb.SheetNames[0];
  const ws = wb.Sheets[sheetName];
  if (!ws) throw new Error("That workbook has no readable sheet.");
  return XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null, blankrows: false });
}

/** RFC 4180-ish CSV, quotes and embedded newlines included. */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else q = false;
      } else field += c;
      continue;
    }
    if (c === '"') q = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n") {
      row.push(field);
      field = "";
      rows.push(row);
      row = [];
    } else if (c !== "\r") field += c;
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((x) => String(x == null ? "" : x).trim() !== ""));
}

function detectHeader(rows) {
  let best = { index: -1, map: {}, score: 0 };
  const limit = Math.min(rows.length, 25);
  for (let i = 0; i < limit; i++) {
    const map = mapHeaderRow(rows[i] || []);
    const score = mapScore(map);
    if (score > best.score) best = { index: i, map, score };
  }
  return best;
}

/** Rows that are subtotals, group headers or the grand total. */
function looksLikeTotalRow(cells) {
  const joined = cells.map((c) => String(c == null ? "" : c).trim()).filter(Boolean);
  if (!joined.length) return true;
  const first = joined[0].toLowerCase();
  if (/^total\b/.test(first) || /\btotal$/.test(first) || first === "subtotal") return true;
  // A group header in a QuickBooks aging detail: one text cell, no numbers.
  if (joined.length === 1) return true;
  return false;
}

// ── Import ──────────────────────────────────────────────────

/**
 * Parse a subledger export into rows WITHOUT writing anything.
 *
 * Split from the write so the interface can show what it understood and
 * let a person fix the column mapping before anything is committed. An
 * importer that silently guesses wrong on the amount column is worse
 * than one that refuses.
 */
function parseSubledger({ buffer, filename, kind, asOfDate, columnMap = null }) {
  const rows = sheetToRows(buffer, filename);
  if (!rows.length) throw new Error("That file has no rows in it.");

  const detected = detectHeader(rows);
  const map = columnMap || detected.map;
  const headerIndex = columnMap ? (columnMap.__headerIndex != null ? columnMap.__headerIndex : detected.index) : detected.index;

  if (map.counterparty_name == null) {
    throw new Error(
      "Could not find a customer or vendor column. Set the column mapping by hand, or check that the export has a header row."
    );
  }
  if (map.amount == null && map.open_amount == null) {
    throw new Error(
      "Could not find an amount or open-balance column. Set the column mapping by hand — this is the one field the importer will not guess at."
    );
  }

  const asOf = parseDate(asOfDate);
  if (!asOf) throw new Error("An as-of date is required, and it has to be the period end the aging was run at.");
  const asOfD = cal.parse(asOf);

  const header = (rows[headerIndex] || []).map((h) => String(h == null ? "" : h));
  const out = [];
  const skipped = [];
  let lineNo = 0;

  for (let i = headerIndex + 1; i < rows.length; i++) {
    const cells = rows[i] || [];
    const at = (f) => (map[f] == null ? null : cells[map[f]]);

    const name = String(at("counterparty_name") == null ? "" : at("counterparty_name")).trim();
    const docNumber = at("doc_number") == null ? "" : String(at("doc_number")).trim();
    const amount = parseAmount(at("amount"));
    const open = parseAmount(at("open_amount"));
    const effective = open != null ? open : amount;

    if (looksLikeTotalRow(cells)) {
      skipped.push({ row: i + 1, reason: "subtotal or group header" });
      continue;
    }
    if (!name && !docNumber) {
      skipped.push({ row: i + 1, reason: "no counterparty and no document number" });
      continue;
    }
    if (effective == null) {
      skipped.push({ row: i + 1, reason: "no readable amount" });
      continue;
    }
    // A fully settled line is history, not an open balance. Keeping it
    // would put the aging out of agreement with the general ledger,
    // which is the one thing this snapshot exists to demonstrate.
    if (Math.abs(effective) < 0.005) {
      skipped.push({ row: i + 1, reason: "zero balance" });
      continue;
    }

    const docDate = parseDate(at("doc_date"));
    const dueDate = parseDate(at("due_date"));
    let days = at("days_outstanding") == null ? null : Number(parseAmount(at("days_outstanding")));
    if (days == null || !Number.isFinite(days)) {
      // Aged from the DUE date where there is one, otherwise the document
      // date. Every aging report does it this way and the buckets will
      // not agree with the company's own report if it is done otherwise.
      //
      // CALENDAR days, not business days: an aging bucket is "1-30 days",
      // and nobody's accounting system has ever aged a receivable on
      // business days. The buckets have to reconcile to the report the
      // company already produces or the tie-out argument starts again.
      const basis = dueDate || docDate;
      days = basis ? Math.round((asOfD - cal.parse(basis)) / 86400000) : null;
    }
    days = days == null || !Number.isFinite(days) ? null : Math.round(days);

    lineNo++;
    out.push({
      line_no: lineNo,
      counterparty_name: name || "(unnamed)",
      counterparty_code: at("counterparty_code") == null ? null : String(at("counterparty_code")).trim() || null,
      norm_counterparty: normName(name),
      doc_number: docNumber || null,
      norm_doc_number: normDoc(docNumber),
      norm_doc_digits: normDocDigits(docNumber),
      doc_date: docDate,
      due_date: dueDate,
      amount: amount != null ? amount : effective,
      open_amount: effective,
      currency: at("currency") == null ? null : String(at("currency")).trim().slice(0, 8) || null,
      days_outstanding: days,
      aging_bucket: bucketOf(days),
      po_number: at("po_number") == null ? null : String(at("po_number")).trim() || null,
      reference: at("reference") == null ? null : String(at("reference")).trim() || null,
      memo: at("memo") == null ? null : String(at("memo")).trim().slice(0, 500) || null,
      raw: rowObject(header, cells),
    });
  }

  if (!out.length) {
    throw new Error(
      `No usable transaction rows were found. ${skipped.length} row(s) were skipped — check the column mapping and that this is a DETAIL aging rather than a summary by customer.`
    );
  }

  return {
    kind,
    asOfDate: asOf,
    columnMap: Object.assign({}, map, { __headerIndex: headerIndex }),
    header,
    detectedScore: detected.score,
    lines: out,
    skipped,
    totals: totalsOf(out),
  };
}

function rowObject(header, cells) {
  const o = {};
  for (let i = 0; i < Math.max(header.length, cells.length); i++) {
    const k = (header[i] || `col${i + 1}`).toString().slice(0, 60);
    const v = cells[i];
    if (v != null && String(v).trim() !== "") o[k] = v instanceof Date ? cal.dstr(v) : v;
  }
  return o;
}

function bucketOf(days) {
  if (days == null) return "unknown";
  if (days <= 0) return "current";
  if (days <= 30) return "1_30";
  if (days <= 60) return "31_60";
  if (days <= 90) return "61_90";
  return "over_90";
}

function totalsOf(lines) {
  const t = {
    row_count: lines.length,
    total_amount: 0,
    debit_count: 0,
    debit_amount: 0,
    bucket_current: 0,
    bucket_1_30: 0,
    bucket_31_60: 0,
    bucket_61_90: 0,
    bucket_over_90: 0,
    counterparties: new Set(),
  };
  for (const l of lines) {
    const v = Number(l.open_amount) || 0;
    t.total_amount += v;
    if (v < 0) {
      t.debit_count++;
      t.debit_amount += v;
    }
    const b = l.aging_bucket === "unknown" ? "current" : l.aging_bucket;
    t["bucket_" + b] += v;
    t.counterparties.add(l.norm_counterparty || l.counterparty_name);
  }
  t.total_amount = round2(t.total_amount);
  t.debit_amount = round2(t.debit_amount);
  for (const k of ["bucket_current", "bucket_1_30", "bucket_31_60", "bucket_61_90", "bucket_over_90"]) t[k] = round2(t[k]);
  t.counterparty_count = t.counterparties.size;
  delete t.counterparties;
  return t;
}

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

/**
 * Commit a parsed subledger.
 *
 * The source file is ALSO put through the ordinary document store, with
 * the category forced to the aging category, so that one action satisfies
 * the checklist item, lands in the document index and becomes
 * transmittable. An import that produced data the auditor could not be
 * handed would be half a feature.
 */
async function importSubledger({
  kind,
  asOfDate,
  buffer,
  filename,
  engagementId = null,
  columnMap = null,
  note = null,
  keyItemThreshold = null,
  thresholdSource = null,
  actor = null,
  req = null,
}) {
  if (!["ar", "ap"].includes(kind)) throw new Error(`Subledger kind must be 'ar' or 'ap', not "${kind}".`);
  const parsed = parseSubledger({ buffer, filename, kind, asOfDate, columnMap });

  // File it as a document first, so the checklist item is satisfied by
  // the same act and the aging itself is in the chain of custody.
  let documentId = null;
  let documentCategory = null;
  try {
    const store = require("./audit-store");
    const category = kind === "ar" ? "D-010" : "J-090";
    const ing = await store.ingestDocument({
      buffer,
      filename,
      mimeType: /\.csv$/i.test(filename) ? "text/csv" : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      user: actor,
      periodHint: parsed.asOfDate,
      categoryOverride: category,
      engagementOverride: engagementId,
      req,
      source: "subledger_import",
    });
    documentId = ing && ing.document ? ing.document.id : null;
    documentCategory = category;
    if (!engagementId && ing && ing.engagement) engagementId = ing.engagement.id;
  } catch (err) {
    // The data is the point; filing the source file is a bonus. A
    // classifier or duplicate-detection failure must not lose the import.
    console.error("[ngtf-audit subledger] source file not filed as a document:", err.message);
  }

  const t = parsed.totals;
  const sha = crypto.createHash("sha256").update(buffer).digest("hex");

  const client = await db.connect();
  let head;
  try {
    await client.query("BEGIN");

    // A re-import for the same date supersedes rather than replaces. The
    // old population stays, because it is what was tested.
    const prev = await client.query(
      `SELECT id, version FROM ngtf_audit_subledgers
        WHERE kind=$1 AND as_of_date=$2 AND status='active' ORDER BY version DESC LIMIT 1`,
      [kind, parsed.asOfDate]
    );
    const version = prev.rows.length ? Number(prev.rows[0].version) + 1 : 1;
    if (prev.rows.length) {
      await client.query(`UPDATE ngtf_audit_subledgers SET status='superseded' WHERE id=$1`, [prev.rows[0].id]);
    }

    const ins = await client.query(
      `INSERT INTO ngtf_audit_subledgers
         (kind, engagement_id, as_of_date, period_label, version, supersedes_id, document_id,
          source_filename, source_sha256, column_map, row_count, total_amount, debit_count, debit_amount,
          counterparty_count, bucket_current, bucket_1_30, bucket_31_60, bucket_61_90, bucket_over_90,
          key_item_threshold, threshold_source, imported_by, note)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)
       RETURNING *`,
      [
        kind,
        engagementId,
        parsed.asOfDate,
        null,
        version,
        prev.rows.length ? prev.rows[0].id : null,
        documentId,
        filename,
        sha,
        JSON.stringify(parsed.columnMap),
        t.row_count,
        t.total_amount,
        t.debit_count,
        t.debit_amount,
        t.counterparty_count,
        t.bucket_current,
        t.bucket_1_30,
        t.bucket_31_60,
        t.bucket_61_90,
        t.bucket_over_90,
        keyItemThreshold == null ? null : round2(keyItemThreshold),
        thresholdSource || null,
        actor ? actor.id : null,
        note || null,
      ]
    );
    head = ins.rows[0];

    // Batched insert. A 4,000-line aging as 4,000 round trips is twenty
    // seconds of nothing happening; in pages of 250 it is under one.
    const cols = [
      "subledger_id", "line_no", "counterparty_name", "counterparty_code", "norm_counterparty",
      "doc_number", "norm_doc_number", "norm_doc_digits", "doc_date", "due_date", "amount",
      "open_amount", "currency", "days_outstanding", "aging_bucket", "po_number", "reference",
      "memo", "raw",
    ];
    const PAGE = 250;
    for (let i = 0; i < parsed.lines.length; i += PAGE) {
      const chunk = parsed.lines.slice(i, i + PAGE);
      const values = [];
      const params = [];
      chunk.forEach((l, j) => {
        const base = j * cols.length;
        values.push("(" + cols.map((_, k) => `$${base + k + 1}`).join(",") + ")");
        params.push(
          head.id, l.line_no, l.counterparty_name, l.counterparty_code, l.norm_counterparty,
          l.doc_number, l.norm_doc_number, l.norm_doc_digits, l.doc_date, l.due_date, l.amount,
          l.open_amount, l.currency, l.days_outstanding, l.aging_bucket, l.po_number, l.reference,
          l.memo, JSON.stringify(l.raw)
        );
      });
      await client.query(
        `INSERT INTO ngtf_audit_subledger_lines (${cols.join(",")}) VALUES ${values.join(",")}`,
        params
      );
    }
    await client.query("COMMIT");
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* the pool will discard it */
    }
    throw err;
  } finally {
    client.release();
  }

  await schema.logEvent({
    subledgerId: head.id,
    documentId,
    engagementId,
    event: "subledger_imported",
    actor,
    ip: reqIp(req),
    detail: {
      kind,
      asOf: parsed.asOfDate,
      version: head.version,
      rows: t.row_count,
      total: t.total_amount,
      skipped: parsed.skipped.length,
      filename,
      sha256: sha,
      columnsDetected: parsed.detectedScore,
      filedAs: documentCategory,
    },
  });

  await computeRisk({ subledgerId: head.id });
  return {
    subledger: await getSubledger(head.id),
    skipped: parsed.skipped,
    columnMap: parsed.columnMap,
    header: parsed.header,
    documentId,
  };
}

function reqIp(req) {
  if (!req) return null;
  const fwd = req.headers && req.headers["x-forwarded-for"];
  if (fwd) return String(fwd).split(",")[0].trim();
  return (req.ip || (req.socket && req.socket.remoteAddress) || null) || null;
}

// ── The tie-out ─────────────────────────────────────────────

/**
 * Agree the aging to the general ledger.
 *
 * The first thing an auditor does with an aging and the first thing that
 * fails. A variance is permitted — they often exist for real reasons —
 * but it must be EXPLAINED, and the explanation is kept. Recording a
 * variance with no reason is refused, because an unexplained difference
 * that nobody wrote down is how a reconciliation becomes a discussion in
 * February about what somebody meant in October.
 */
async function tieOut({ subledgerId, glBalance, glSource = null, note = null, actor = null, req = null }) {
  const sub = await getSubledger(subledgerId);
  if (!sub) throw new Error("No such subledger snapshot.");
  if (sub.subledger.tied_out) {
    throw new Error(
      `This snapshot was already tied out on ${cal.dstr(sub.subledger.tied_out_at)} and a reconciliation is final. Import a corrected aging, which supersedes this one.`
    );
  }
  const gl = parseAmount(glBalance);
  if (gl == null) throw new Error("Enter the general-ledger balance for this account as of the same date.");

  const variance = round2(Number(sub.subledger.total_amount) - gl);
  const tol = 0.5;
  if (Math.abs(variance) > tol && (!note || String(note).trim().length < 10)) {
    throw new Error(
      `The aging totals ${fmtMoney(sub.subledger.total_amount)} and the general ledger says ${fmtMoney(gl)} — a difference of ${fmtMoney(variance)}. Explain it in at least ten characters before recording the tie-out. An unexplained variance is the finding, and it is cheaper to write down now than to reconstruct in February.`
    );
  }

  const r = await db.query(
    `UPDATE ngtf_audit_subledgers
        SET gl_balance=$2, gl_source=$3, variance=$4, tie_out_note=$5,
            tied_out=TRUE, tied_out_by=$6, tied_out_at=NOW()
      WHERE id=$1 AND tied_out=FALSE
      RETURNING *`,
    [subledgerId, gl, glSource || null, variance, note ? String(note).trim() : null, actor ? actor.id : null]
  );
  if (!r.rows.length) throw new Error("That snapshot could not be tied out — it may already be.");

  await schema.logEvent({
    subledgerId,
    engagementId: sub.subledger.engagement_id,
    event: "subledger_tied_out",
    actor,
    ip: reqIp(req),
    detail: {
      kind: sub.subledger.kind,
      asOf: cal.dstr(sub.subledger.as_of_date),
      subledgerTotal: Number(sub.subledger.total_amount),
      glBalance: gl,
      variance,
      glSource: glSource || null,
      explanation: note || null,
      clean: Math.abs(variance) <= tol,
    },
  });
  return r.rows[0];
}

function fmtMoney(n) {
  const v = Number(n) || 0;
  return (v < 0 ? "-$" : "$") + Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// ── Risk markers and the likely-selection worklist ──────────
//
// You cannot know which items the auditor will pick. You can know which
// ones are near-certain, because the method is not a secret: everything
// above a threshold is tested individually and the remainder is sampled.
// So this marks the large items and the things an auditor is trained to
// look at, and it is a HEURISTIC — labelled as one everywhere it shows.
//
// When no threshold has been shared, no `key_item` flag is produced. The
// module will not invent a materiality number and present the result as
// though it knew the sample; the worklist is then simply the largest
// items plus the risk markers, and it says so.

const TOP_N_DEFAULT = 25;

async function computeRisk({ subledgerId, threshold = undefined, thresholdSource = null, topN = TOP_N_DEFAULT, actor = null }) {
  const head = await db.query(`SELECT * FROM ngtf_audit_subledgers WHERE id=$1`, [subledgerId]);
  if (!head.rows.length) throw new Error("No such subledger snapshot.");
  const sub = head.rows[0];

  if (threshold !== undefined) {
    const t = threshold == null ? null : parseAmount(threshold);
    await db.query(`UPDATE ngtf_audit_subledgers SET key_item_threshold=$2, threshold_source=$3 WHERE id=$1`, [
      subledgerId,
      t,
      t == null ? null : thresholdSource || "entered by the company",
    ]);
    sub.key_item_threshold = t;
    sub.threshold_source = t == null ? null : thresholdSource;
  }
  const keyThreshold = sub.key_item_threshold == null ? null : Number(sub.key_item_threshold);
  const asOf = cal.dstr(sub.as_of_date);
  const asOfD = cal.parse(asOf);
  const cutoffFrom = cal.iso(cal.addDays(asOfD, -5));

  const lines = await db.query(
    `SELECT id, counterparty_name, norm_counterparty, doc_date, open_amount, aging_bucket, days_outstanding, memo, reference
       FROM ngtf_audit_subledger_lines WHERE subledger_id=$1`,
    [subledgerId]
  );

  // Biggest open item per counterparty — auditors reach for these even
  // when they are below the individual-testing threshold.
  const biggestFor = new Map();
  for (const l of lines.rows) {
    const k = l.norm_counterparty || l.counterparty_name;
    const cur = biggestFor.get(k);
    if (!cur || Math.abs(Number(l.open_amount)) > Math.abs(Number(cur.open_amount))) biggestFor.set(k, l);
  }
  const topIds = new Set(
    lines.rows
      .slice()
      .sort((a, b) => Math.abs(Number(b.open_amount)) - Math.abs(Number(a.open_amount)))
      .slice(0, topN)
      .map((l) => l.id)
  );

  const RELATED = /\b(affiliate|related|shareholder|officer|director|member|parent|subsidiar|insider|due from|due to)\b/i;
  let flagged = 0;
  const updates = [];
  for (const l of lines.rows) {
    const amt = Number(l.open_amount) || 0;
    const flags = [];
    if (keyThreshold != null && Math.abs(amt) >= keyThreshold) flags.push("key_item");
    if (topIds.has(l.id)) flags.push("top_by_amount");
    const k = l.norm_counterparty || l.counterparty_name;
    if (biggestFor.get(k) && biggestFor.get(k).id === l.id) flags.push("largest_for_counterparty");
    if (RELATED.test(`${l.counterparty_name} ${l.memo || ""} ${l.reference || ""}`)) flags.push("related_party");
    if (amt < 0) flags.push("contra_balance");
    if (l.aging_bucket === "over_90") flags.push("over_90");
    const dd = cal.dstr(l.doc_date);
    if (dd && dd > asOf) flags.push("dated_after_period_end");
    else if (dd && dd >= cutoffFrom) flags.push("cutoff_window");
    if (Math.abs(amt) >= 10000 && Math.abs(amt) % 1000 === 0) flags.push("round_amount");

    const likely =
      flags.includes("key_item") ||
      flags.includes("top_by_amount") ||
      flags.includes("largest_for_counterparty") ||
      flags.includes("related_party") ||
      flags.includes("contra_balance") ||
      flags.includes("cutoff_window") ||
      flags.includes("dated_after_period_end");
    if (likely) flagged++;
    updates.push([l.id, flags, likely]);
  }

  const PAGE = 400;
  for (let i = 0; i < updates.length; i += PAGE) {
    const chunk = updates.slice(i, i + PAGE);
    // One statement per page, driven by a VALUES list, so that a four
    // thousand line aging is a handful of round trips rather than four
    // thousand. The frozen-population trigger permits these two columns.
    const vals = chunk.map((_, j) => `($${j * 3 + 1}::bigint, $${j * 3 + 2}::text[], $${j * 3 + 3}::boolean)`).join(",");
    const params = [];
    chunk.forEach((u) => params.push(u[0], u[1], u[2]));
    await db.query(
      `UPDATE ngtf_audit_subledger_lines l
          SET risk_flags = v.flags, likely_selected = v.likely
         FROM (VALUES ${vals}) AS v(id, flags, likely)
        WHERE l.id = v.id`,
      params
    );
  }

  const isRelated = (f) => f.includes("related_party");
  return {
    subledgerId,
    lines: lines.rows.length,
    likely: flagged,
    threshold: keyThreshold,
    thresholdSource: sub.threshold_source || null,
    thresholdSupplied: keyThreshold != null,
    relatedParty: updates.filter((u) => isRelated(u[1])).length,
    topN,
  };
}

const RISK_FLAG_LABELS = {
  key_item: ["Above the auditor's threshold", "Near-certain to be tested individually rather than sampled."],
  top_by_amount: ["Among the largest open items", "Large items are tested individually, not sampled."],
  largest_for_counterparty: ["Largest item for this counterparty", "Reached for even when below the individual-testing threshold."],
  related_party: ["Looks like a related party", "Related-party balances get attention out of all proportion to their size — ASC 850 and AS 2410."],
  contra_balance: ["Wrong-signed balance", "A credit in receivables or a debit in payables usually belongs on the other side of the balance sheet."],
  over_90: ["Over 90 days", "Feeds the allowance question under ASC 326-20."],
  cutoff_window: ["Dated in the last five days before the cutoff", "The period this belongs in turns on the delivery or receipt date, not the invoice date."],
  dated_after_period_end: ["Dated AFTER the period end", "This should not be in an aging as of that date at all. Check it before the auditor does."],
  round_amount: ["Round amount", "Round numbers draw a second look, fairly or not."],
};

// ── Reading ─────────────────────────────────────────────────

async function getSubledger(id) {
  const r = await db.query(
    `SELECT s.*, e.period_label AS engagement_period, e.period_name, e.status AS engagement_status,
            iu.name AS imported_by_name, tu.name AS tied_out_by_name,
            d.filename AS document_filename
       FROM ngtf_audit_subledgers s
       LEFT JOIN ngtf_audit_engagements e ON e.id = s.engagement_id
       LEFT JOIN ngtf_audit_users iu ON iu.id = s.imported_by
       LEFT JOIN ngtf_audit_users tu ON tu.id = s.tied_out_by
       LEFT JOIN ngtf_audit_documents d ON d.id = s.document_id
      WHERE s.id = $1`,
    [id]
  );
  if (!r.rows.length) return null;
  const subledger = r.rows[0];
  const concentration = await topCounterparties(id, 5);
  return { subledger, concentration };
}

async function listSubledgers({ kind = null, includeSuperseded = false, limit = 60 } = {}) {
  const params = [];
  const where = [];
  if (kind) {
    params.push(kind);
    where.push(`s.kind = $${params.length}`);
  }
  if (!includeSuperseded) where.push(`s.status = 'active'`);
  params.push(limit);
  const r = await db.query(
    `SELECT s.*, e.period_label AS engagement_period,
            (SELECT COUNT(*) FROM ngtf_audit_subledger_lines l WHERE l.subledger_id=s.id AND l.likely_selected)::int AS likely_count,
            (SELECT COUNT(DISTINCT l.id) FROM ngtf_audit_subledger_lines l
               JOIN ngtf_audit_subledger_support sp ON sp.line_id = l.id
              WHERE l.subledger_id=s.id)::int AS lines_with_support
       FROM ngtf_audit_subledgers s
       LEFT JOIN ngtf_audit_engagements e ON e.id = s.engagement_id
      ${where.length ? "WHERE " + where.join(" AND ") : ""}
      ORDER BY s.as_of_date DESC, s.kind, s.version DESC
      LIMIT $${params.length}`,
    params
  );
  return r.rows;
}

async function topCounterparties(subledgerId, n = 10) {
  const r = await db.query(
    `SELECT counterparty_name, SUM(open_amount)::numeric(18,2) AS amount, COUNT(*)::int AS lines
       FROM ngtf_audit_subledger_lines WHERE subledger_id=$1
      GROUP BY counterparty_name ORDER BY SUM(ABS(open_amount)) DESC LIMIT $2`,
    [subledgerId, n]
  );
  const tot = await db.query(`SELECT SUM(ABS(open_amount)) AS t FROM ngtf_audit_subledger_lines WHERE subledger_id=$1`, [
    subledgerId,
  ]);
  const total = Number(tot.rows[0].t) || 1;
  return r.rows.map((x) => Object.assign({}, x, { pct: Math.round((Math.abs(Number(x.amount)) / total) * 1000) / 10 }));
}

/** Browse / search the population. */
async function searchLines({ subledgerId, q = null, filter = null, limit = 200, offset = 0 } = {}) {
  const params = [subledgerId];
  const where = ["l.subledger_id = $1"];
  if (q) {
    params.push(`%${String(q).toLowerCase()}%`);
    params.push(normDoc(q) || "~none~");
    params.push(normDocDigits(q) || "~none~");
    where.push(
      `(lower(l.counterparty_name) LIKE $${params.length - 2} OR l.norm_doc_number = $${params.length - 1} OR l.norm_doc_digits = $${params.length} OR lower(COALESCE(l.doc_number,'')) LIKE $${params.length - 2})`
    );
  }
  if (filter === "likely") where.push("l.likely_selected = TRUE");
  else if (filter === "unsupported") where.push("NOT EXISTS (SELECT 1 FROM ngtf_audit_subledger_support sp WHERE sp.line_id = l.id)");
  else if (filter === "contra") where.push("l.open_amount < 0");
  else if (filter === "over_90") where.push("l.aging_bucket = 'over_90'");
  else if (filter === "related") where.push("'related_party' = ANY(l.risk_flags)");
  else if (filter === "after_period") where.push("'dated_after_period_end' = ANY(l.risk_flags)");

  params.push(limit, offset);
  const r = await db.query(
    `SELECT l.*,
            COALESCE(ARRAY(SELECT DISTINCT sp.support_type FROM ngtf_audit_subledger_support sp WHERE sp.line_id=l.id), '{}') AS support_types,
            (SELECT COUNT(*) FROM ngtf_audit_subledger_support sp WHERE sp.line_id=l.id)::int AS support_count
       FROM ngtf_audit_subledger_lines l
      WHERE ${where.join(" AND ")}
      ORDER BY ABS(l.open_amount) DESC, l.line_no
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  const count = await db.query(
    `SELECT COUNT(*)::int AS n, COALESCE(SUM(ABS(l.open_amount)),0)::numeric(18,2) AS amt
       FROM ngtf_audit_subledger_lines l WHERE ${where.join(" AND ")}`,
    params.slice(0, params.length - 2)
  );
  return { lines: r.rows, total: count.rows[0].n, totalAmount: Number(count.rows[0].amt) };
}

/** One invoice and everything behind it. The bot's lookup. */
async function lookup({ kind = null, docNumber = null, counterparty = null, asOfDate = null, limit = 25 } = {}) {
  if (!docNumber && !counterparty) throw new Error("Give an invoice number or a counterparty name to look up.");
  const params = [];
  const where = ["s.status = 'active'"];
  if (kind) {
    params.push(kind);
    where.push(`s.kind = $${params.length}`);
  }
  if (asOfDate) {
    params.push(parseDate(asOfDate));
    where.push(`s.as_of_date = $${params.length}`);
  }
  if (docNumber) {
    params.push(normDoc(docNumber) || "~none~", normDocDigits(docNumber) || "~none~");
    where.push(`(l.norm_doc_number = $${params.length - 1} OR l.norm_doc_digits = $${params.length})`);
  }
  if (counterparty) {
    params.push(normName(counterparty) || "~none~");
    where.push(`l.norm_counterparty = $${params.length}`);
  }
  params.push(limit);
  const r = await db.query(
    `SELECT l.id, l.counterparty_name, l.doc_number, l.doc_date, l.due_date, l.open_amount,
            l.aging_bucket, l.risk_flags, s.kind, s.as_of_date, s.id AS subledger_id, s.tied_out
       FROM ngtf_audit_subledger_lines l
       JOIN ngtf_audit_subledgers s ON s.id = l.subledger_id
      WHERE ${where.join(" AND ")}
      ORDER BY s.as_of_date DESC, ABS(l.open_amount) DESC
      LIMIT $${params.length}`,
    params
  );
  const out = [];
  for (const l of r.rows) out.push(Object.assign({}, l, { support: await supportFor(l.id) }));
  return out;
}

async function supportFor(lineId) {
  const r = await db.query(
    `SELECT sp.id, sp.support_type, sp.note, sp.added_at, sp.document_id,
            d.filename, d.size_bytes, d.sha256, u.name AS added_by_name
       FROM ngtf_audit_subledger_support sp
       JOIN ngtf_audit_documents d ON d.id = sp.document_id
       LEFT JOIN ngtf_audit_users u ON u.id = sp.added_by
      WHERE sp.line_id = $1 ORDER BY sp.support_type, sp.added_at`,
    [lineId]
  );
  return r.rows;
}

// ── Attaching support ───────────────────────────────────────

async function attachSupport({ lineId, documentId, supportType, note = null, actor = null, req = null }) {
  if (COMPANY_FORBIDDEN_SUPPORT[supportType]) throw new Error(COMPANY_FORBIDDEN_SUPPORT[supportType]);
  if (!SUPPORT_TYPES[supportType]) {
    throw new Error(`Unknown support type "${supportType}". One of: ${Object.keys(SUPPORT_TYPES).join(", ")}.`);
  }
  const line = await db.query(
    `SELECT l.*, s.kind, s.id AS subledger_id, s.engagement_id
       FROM ngtf_audit_subledger_lines l JOIN ngtf_audit_subledgers s ON s.id=l.subledger_id
      WHERE l.id=$1`,
    [lineId]
  );
  if (!line.rows.length) throw new Error("No such subledger line.");
  const kinds = SUPPORT_TYPES[supportType].kinds;
  if (!kinds.includes(line.rows[0].kind)) {
    throw new Error(
      `"${SUPPORT_TYPES[supportType].label}" is not a ${line.rows[0].kind === "ar" ? "receivables" : "payables"} support type. It applies to: ${kinds.join(", ")}.`
    );
  }
  const doc = await db.query(`SELECT id, filename FROM ngtf_audit_documents WHERE id=$1`, [documentId]);
  if (!doc.rows.length) throw new Error("No such document.");

  const r = await db.query(
    `INSERT INTO ngtf_audit_subledger_support (line_id, document_id, support_type, note, added_by)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (line_id, document_id, support_type) DO NOTHING
     RETURNING *`,
    [lineId, documentId, supportType, note || null, actor ? actor.id : null]
  );
  if (r.rows.length) {
    await schema.logEvent({
      subledgerId: line.rows[0].subledger_id,
      documentId,
      engagementId: line.rows[0].engagement_id,
      event: "subledger_support_attached",
      actor,
      ip: reqIp(req),
      detail: {
        line: line.rows[0].line_no,
        counterparty: line.rows[0].counterparty_name,
        doc_number: line.rows[0].doc_number,
        support_type: supportType,
        filename: doc.rows[0].filename,
      },
    });
  }
  // Any selection pointing at this line may now be complete.
  await refreshSelectionsForLine(lineId);
  return r.rows[0] || { already: true };
}

async function detachSupport({ supportId, actor = null, req = null }) {
  const r = await db.query(
    `DELETE FROM ngtf_audit_subledger_support WHERE id=$1
      RETURNING line_id, document_id, support_type`,
    [supportId]
  );
  if (!r.rows.length) throw new Error("No such support link.");
  await schema.logEvent({
    event: "subledger_support_detached",
    documentId: r.rows[0].document_id,
    actor,
    ip: reqIp(req),
    detail: { line_id: r.rows[0].line_id, support_type: r.rows[0].support_type },
  });
  await refreshSelectionsForLine(r.rows[0].line_id);
  return r.rows[0];
}

// ── Readiness, in dollars first ─────────────────────────────
//
// 95% of lines covered while the three largest invoices are missing is
// not 95% ready — it is zero, because they sample by dollars. So every
// figure is reported both ways and the dollar figure leads.

async function readiness({ subledgerId, requiredSupport = null, onlyLikely = false } = {}) {
  const head = await db.query(`SELECT kind, key_item_threshold FROM ngtf_audit_subledgers WHERE id=$1`, [subledgerId]);
  if (!head.rows.length) throw new Error("No such subledger snapshot.");
  const kind = head.rows[0].kind;
  const required = (requiredSupport && requiredSupport.length
    ? requiredSupport
    : kind === "ar"
    ? ["invoice", "proof_of_delivery"]
    : ["invoice", "receiving_report"]
  ).filter((t) => SUPPORT_TYPES[t]);

  const r = await db.query(
    `SELECT l.id, ABS(l.open_amount) AS amt,
            COALESCE(ARRAY(SELECT DISTINCT sp.support_type FROM ngtf_audit_subledger_support sp WHERE sp.line_id=l.id), '{}') AS have
       FROM ngtf_audit_subledger_lines l
      WHERE l.subledger_id = $1 ${onlyLikely ? "AND l.likely_selected = TRUE" : ""}`,
    [subledgerId]
  );

  let lines = 0, complete = 0, dollars = 0, dollarsComplete = 0;
  const missingByType = {};
  for (const t of required) missingByType[t] = { lines: 0, dollars: 0 };
  for (const l of r.rows) {
    const amt = Number(l.amt) || 0;
    lines++;
    dollars += amt;
    let ok = true;
    for (const t of required) {
      if (!l.have.includes(t)) {
        ok = false;
        missingByType[t].lines++;
        missingByType[t].dollars += amt;
      }
    }
    if (ok) {
      complete++;
      dollarsComplete += amt;
    }
  }
  const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : 100);
  return {
    kind,
    required,
    onlyLikely,
    lines,
    linesComplete: complete,
    linesPct: pct(complete, lines),
    dollars: round2(dollars),
    dollarsComplete: round2(dollarsComplete),
    dollarsPct: pct(dollarsComplete, dollars),
    missingByType: Object.fromEntries(
      Object.entries(missingByType).map(([k, v]) => [k, { lines: v.lines, dollars: round2(v.dollars), label: SUPPORT_TYPES[k].label }])
    ),
  };
}

// ════════════════════════════════════════════════════════════
//  THE SELECTION LIST
// ════════════════════════════════════════════════════════════
//
// What arrives is an Excel file or a paragraph in an email: forty rows
// of selection number, customer, invoice number, date, amount. What has
// to come back is a labelled package of support for each one.
//
// MATCHING IS TRIED IN DESCENDING ORDER OF CERTAINTY and stops at the
// first method that identifies exactly ONE line. Ambiguity is never
// resolved by guessing — two candidate invoices for the same number is a
// question for a person, because a confidently wrong match is worse than
// an honest gap: the gap gets filled, the wrong match gets delivered.

const AMOUNT_TOLERANCE = 0.02;

function amountsAgree(a, b) {
  if (a == null || b == null) return false;
  const x = Math.abs(Number(a));
  const y = Math.abs(Number(b));
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
  return Math.abs(x - y) <= Math.max(AMOUNT_TOLERANCE, x * 0.001);
}

/**
 * Match a list of auditor selections against a frozen population.
 *
 * Returns a decision per selection WITHOUT writing anything, so a person
 * can see what it did before it is committed.
 */
async function matchSelections({ subledgerId, selections }) {
  const r = await db.query(
    `SELECT id, line_no, counterparty_name, norm_counterparty, doc_number, norm_doc_number,
            norm_doc_digits, doc_date, open_amount, amount
       FROM ngtf_audit_subledger_lines WHERE subledger_id=$1`,
    [subledgerId]
  );
  const lines = r.rows;

  const byDoc = new Map();
  const byDigits = new Map();
  const byParty = new Map();
  const push = (m, k, v) => {
    if (!k) return;
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(v);
  };
  for (const l of lines) {
    push(byDoc, l.norm_doc_number, l);
    push(byDigits, l.norm_doc_digits, l);
    push(byParty, l.norm_counterparty, l);
  }

  const out = [];
  for (const sel of selections) {
    const nd = normDoc(sel.doc_number);
    const ndd = normDocDigits(sel.doc_number);
    const np = normName(sel.counterparty);
    const amt = parseAmount(sel.amount);
    const dt = parseDate(sel.doc_date);

    let line = null;
    let method = null;
    let note = null;

    const pick = (cands, m, requireAmount) => {
      if (line || !cands || !cands.length) return;
      let c = cands;
      if (requireAmount && amt != null) c = c.filter((l) => amountsAgree(l.open_amount, amt) || amountsAgree(l.amount, amt));
      if (c.length === 1) {
        line = c[0];
        method = m;
      } else if (c.length > 1 && !line) {
        note = `${c.length} lines match on ${m.replace(/_/g, " ")} — a person has to choose, because picking one here would be a guess presented as a fact.`;
      }
    };

    // 1. The invoice number as written, with the amount agreeing.
    pick(byDoc.get(nd), "doc_number_and_amount", true);
    // 2. The invoice number alone, if it is unique in the population.
    pick(byDoc.get(nd), "doc_number", false);
    // 3. Digits only — "INV-0001234" against "1234".
    pick(byDigits.get(ndd), "doc_digits_and_amount", true);
    pick(byDigits.get(ndd), "doc_digits", false);
    // 4. No usable number: counterparty plus amount, then plus date.
    if (!line && np && amt != null) {
      const cands = (byParty.get(np) || []).filter((l) => amountsAgree(l.open_amount, amt) || amountsAgree(l.amount, amt));
      if (cands.length === 1) {
        line = cands[0];
        method = "counterparty_and_amount";
      } else if (cands.length > 1 && dt) {
        const onDate = cands.filter((l) => cal.dstr(l.doc_date) === dt);
        if (onDate.length === 1) {
          line = onDate[0];
          method = "counterparty_amount_and_date";
        }
      }
    }

    // An unmatched selection is a FINDING. Either they sampled from a
    // population other than the one they were given, or the invoice is
    // not in the aging that was handed over. Both are worth knowing in
    // week one rather than week six, so the reason says which it is.
    if (!line && !note) {
      const partyExists = np && byParty.has(np);
      note = partyExists
        ? "The counterparty is in this aging but that invoice and amount are not. Check whether the selection came from a different aging, or whether the invoice was settled or credited before the as-of date."
        : "Neither the counterparty nor the invoice is in this aging. Most often this means the selection was made from a different population than the one provided — confirm which aging they are working from before chasing documents.";
    }

    out.push({
      given: {
        selection_no: String(sel.selection_no == null ? "" : sel.selection_no).trim() || null,
        counterparty: sel.counterparty == null ? null : String(sel.counterparty).trim(),
        doc_number: sel.doc_number == null ? null : String(sel.doc_number).trim(),
        doc_date: dt,
        amount: amt,
        note: sel.note == null ? null : String(sel.note).trim(),
      },
      line_id: line ? line.id : null,
      line: line
        ? {
            line_no: line.line_no,
            counterparty_name: line.counterparty_name,
            doc_number: line.doc_number,
            doc_date: cal.dstr(line.doc_date),
            open_amount: Number(line.open_amount),
          }
        : null,
      match_method: method,
      match_note: note,
      amountDisagrees:
        line && amt != null && !amountsAgree(line.open_amount, amt) && !amountsAgree(line.amount, amt)
          ? `Matched on the invoice number, but the auditor has ${fmtMoney(amt)} and the aging has ${fmtMoney(line.open_amount)}. Reconcile that difference before delivering — it is exactly what they are testing for.`
          : null,
    });
  }

  const matched = out.filter((x) => x.line_id).length;
  return {
    subledgerId,
    total: out.length,
    matched,
    unmatched: out.length - matched,
    selections: out,
  };
}

/**
 * Parse a pasted selection list.
 *
 * Accepts what people actually paste: a block copied out of Excel (tab
 * separated), a CSV, or a few lines typed by hand. Column order is
 * detected from a header row when there is one, and guessed from the
 * shape of the data when there is not — a column that parses as money
 * everywhere is the amount, one that parses as a date is the date.
 */
function parseSelectionList(text) {
  const raw = String(text || "").replace(/\r/g, "").trim();
  if (!raw) throw new Error("Paste the selection list, or upload the file the auditor sent.");
  const rows = raw
    .split("\n")
    .map((l) => (l.includes("\t") ? l.split("\t") : l.split(",")))
    .map((cells) => cells.map((c) => c.trim().replace(/^"|"$/g, "")))
    .filter((cells) => cells.some((c) => c !== ""));
  if (!rows.length) throw new Error("Nothing readable in that list.");

  const SEL_SYNONYMS = {
    selection_no: ["selection", "selection no", "selection #", "sel", "sel no", "item", "item no", "#", "no", "no.", "ref", "sample", "sample no"],
    counterparty: FIELD_SYNONYMS.counterparty_name,
    doc_number: FIELD_SYNONYMS.doc_number,
    doc_date: FIELD_SYNONYMS.doc_date,
    amount: [].concat(FIELD_SYNONYMS.amount, FIELD_SYNONYMS.open_amount),
    note: ["note", "notes", "comment", "comments", "remark", "procedure", "request"],
  };

  // Is the first row a header? Only if several cells are recognisable
  // AND the row does not itself parse as data.
  const keys = rows[0].map(headerKey);
  let map = {};
  let hits = 0;
  for (const field of Object.keys(SEL_SYNONYMS)) {
    for (let i = 0; i < keys.length; i++) {
      if (!keys[i] || Object.values(map).includes(i)) continue;
      if (SEL_SYNONYMS[field].some((syn) => keys[i] === syn || (syn.length > 3 && keys[i].includes(syn)))) {
        map[field] = i;
        hits++;
        break;
      }
    }
  }
  let body = rows;
  if (hits >= 2) body = rows.slice(1);
  else {
    // No header. Infer by column shape across the body.
    map = {};
    const cols = Math.max(...rows.map((r) => r.length));
    const isMoney = [];
    const isDate = [];
    for (let i = 0; i < cols; i++) {
      let m = 0, d = 0, n = 0;
      for (const r of rows) {
        const v = r[i];
        if (v == null || v === "") continue;
        n++;
        if (parseDate(v)) d++;
        else if (parseAmount(v) != null) m++;
      }
      isMoney[i] = n && m / n > 0.7;
      isDate[i] = n && d / n > 0.7;
    }
    for (let i = 0; i < cols; i++) {
      if (map.doc_date == null && isDate[i]) map.doc_date = i;
      else if (isMoney[i]) {
        // The LAST money column is the amount; an earlier one is usually
        // the selection number.
        if (map.selection_no == null && map.amount == null) map.selection_no = i;
        map.amount = i;
      } else if (map.counterparty == null) map.counterparty = i;
      else if (map.doc_number == null) map.doc_number = i;
    }
    if (map.amount != null && map.selection_no === map.amount) delete map.selection_no;
  }

  const out = [];
  body.forEach((cells, i) => {
    const at = (f) => (map[f] == null ? null : cells[map[f]]);
    const sel = {
      selection_no: at("selection_no") || String(i + 1),
      counterparty: at("counterparty"),
      doc_number: at("doc_number"),
      doc_date: at("doc_date"),
      amount: at("amount"),
      note: at("note"),
    };
    if (!sel.counterparty && !sel.doc_number && sel.amount == null) return;
    out.push(sel);
  });
  if (!out.length) throw new Error("Could not read any selections out of that. A header row of Selection, Customer, Invoice, Date, Amount is the surest format.");
  // De-duplicate selection numbers, which collide when the auditor's
  // list restarts numbering per section.
  const seen = new Map();
  for (const s of out) {
    const k = String(s.selection_no);
    if (seen.has(k)) {
      const n = seen.get(k) + 1;
      seen.set(k, n);
      s.selection_no = `${k}.${n}`;
    } else seen.set(k, 1);
  }
  return { selections: out, columnMap: map, headerDetected: hits >= 2 };
}

const SAMPLE_LOCK_KEY = 738104232;

/** Record a selection list and match it. */
async function createSampleRequest({
  kind,
  procedure,
  subledgerId,
  label = null,
  instructions = null,
  requiredSupport = null,
  requestedByFirm = null,
  requestedByName = null,
  selectionsSource = "transcribed_from_auditor",
  sourceDocumentId = null,
  receivedOn = null,
  dueOn = null,
  selections = [],
  actor = null,
  req = null,
}) {
  if (!["ar", "ap"].includes(kind)) throw new Error(`Sample kind must be 'ar' or 'ap'.`);
  const proc = PROCEDURES[procedure];
  if (!proc) throw new Error(`Unknown procedure "${procedure}". One of: ${Object.keys(PROCEDURES).join(", ")}.`);
  if (proc.kind && proc.kind !== kind) {
    throw new Error(`"${proc.label}" is a ${proc.kind.toUpperCase()} procedure and cannot be run against the ${kind.toUpperCase()} subledger.`);
  }
  if (!["auditor_entered", "transcribed_from_auditor", "auditor_uploaded_file"].includes(selectionsSource)) {
    throw new Error(`Unknown selections source "${selectionsSource}".`);
  }
  // The company may transcribe the auditor's list, but the auditor's own
  // file has to be on the record as the authority. Without it there is
  // nothing distinguishing a transcription from the company choosing its
  // own audit sample, which is both false and reads very badly later.
  if (selectionsSource === "transcribed_from_auditor" && !sourceDocumentId && !requestedByFirm) {
    throw new Error(
      "Say which firm sent this selection list, and attach their file if you have it. A transcribed list with no source on the record is indistinguishable from the company selecting its own audit sample."
    );
  }
  const sub = await db.query(`SELECT * FROM ngtf_audit_subledgers WHERE id=$1`, [subledgerId]);
  if (!sub.rows.length) throw new Error("Pick the aging the selections were made from.");
  if (sub.rows[0].kind !== kind) throw new Error("That aging is not the subledger this request is for.");
  if (!selections.length) throw new Error("A sample request needs at least one selection.");

  const required = (requiredSupport && requiredSupport.length ? requiredSupport : proc.requires).filter((t) => SUPPORT_TYPES[t]);
  const matchResult = await matchSelections({ subledgerId, selections });

  const client = await db.connect();
  let head;
  try {
    await client.query("BEGIN");
    await client.query(`SELECT pg_advisory_xact_lock($1)`, [SAMPLE_LOCK_KEY]);
    const seqRow = await client.query(`SELECT COALESCE(MAX(seq),0)+1 AS n FROM ngtf_audit_sample_requests`);
    const seq = Number(seqRow.rows[0].n);
    const ins = await client.query(
      `INSERT INTO ngtf_audit_sample_requests
         (ref, seq, kind, procedure, subledger_id, engagement_id, label, instructions, required_support,
          requested_by_firm, requested_by_name, selections_source, source_document_id, entered_by,
          received_on, due_on)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *`,
      [
        `S-${String(seq).padStart(4, "0")}`,
        seq,
        kind,
        procedure,
        subledgerId,
        sub.rows[0].engagement_id,
        label || `${proc.label} — ${selections.length} selection${selections.length === 1 ? "" : "s"}`,
        instructions || null,
        required,
        requestedByFirm || null,
        requestedByName || null,
        selectionsSource,
        sourceDocumentId || null,
        actor ? actor.id : null,
        parseDate(receivedOn),
        parseDate(dueOn),
      ]
    );
    head = ins.rows[0];

    for (const m of matchResult.selections) {
      await client.query(
        `INSERT INTO ngtf_audit_sample_selections
           (request_id, selection_no, given_counterparty, given_doc_number, given_doc_date, given_amount,
            given_note, line_id, match_method, match_note, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [
          head.id,
          m.given.selection_no,
          m.given.counterparty,
          m.given.doc_number,
          m.given.doc_date,
          m.given.amount,
          [m.given.note, m.amountDisagrees].filter(Boolean).join(" ") || null,
          m.line_id,
          m.match_method,
          m.match_note,
          m.line_id ? "open" : "unmatched",
        ]
      );
    }
    await client.query("COMMIT");
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* discarded */
    }
    throw err;
  } finally {
    client.release();
  }

  await schema.logEvent({
    sampleRequestId: head.id,
    subledgerId,
    engagementId: head.engagement_id,
    event: "sample_request_recorded",
    actor,
    ip: reqIp(req),
    detail: {
      ref: head.ref,
      procedure,
      kind,
      selections: matchResult.total,
      matched: matchResult.matched,
      unmatched: matchResult.unmatched,
      requestedByFirm: requestedByFirm || null,
      selectionsSource,
      requiredSupport: required,
    },
  });

  await recomputeSelections(head.id);
  return await getSampleRequest(head.id);
}

/** Recompute every selection's status against the required support. */
async function recomputeSelections(requestId) {
  const head = await db.query(`SELECT id, required_support, status FROM ngtf_audit_sample_requests WHERE id=$1`, [
    requestId,
  ]);
  if (!head.rows.length) return null;
  const required = head.rows[0].required_support || [];

  const sels = await db.query(
    `SELECT s.id, s.line_id, s.status,
            COALESCE(ARRAY(SELECT DISTINCT sp.support_type FROM ngtf_audit_subledger_support sp WHERE sp.line_id=s.line_id), '{}') AS have
       FROM ngtf_audit_sample_selections s WHERE s.request_id=$1`,
    [requestId]
  );
  for (const s of sels.rows) {
    if (s.status === "waived") continue;
    let status;
    if (!s.line_id) status = "unmatched";
    else {
      const missing = required.filter((t) => !s.have.includes(t));
      status = missing.length === 0 ? "complete" : s.have.length ? "partial" : "open";
    }
    if (status !== s.status) {
      await db.query(`UPDATE ngtf_audit_sample_selections SET status=$2 WHERE id=$1`, [s.id, status]);
    }
  }

  // The request is complete when nothing is outstanding. An unmatched
  // selection blocks completion on purpose: delivering a package that
  // silently omits three of forty selections is how the round trip
  // happens twice.
  const n = await db.query(
    `SELECT COUNT(*) FILTER (WHERE status NOT IN ('complete','waived'))::int AS outstanding,
            COUNT(*)::int AS total
       FROM ngtf_audit_sample_selections WHERE request_id=$1`,
    [requestId]
  );
  const done = n.rows[0].outstanding === 0 && n.rows[0].total > 0;
  if (done && head.rows[0].status === "open") {
    await db.query(`UPDATE ngtf_audit_sample_requests SET status='complete', completed_at=NOW() WHERE id=$1 AND status='open'`, [
      requestId,
    ]);
    await schema.logEvent({
      sampleRequestId: requestId,
      event: "sample_request_complete",
      detail: { selections: n.rows[0].total },
    });
  }
  return n.rows[0];
}

async function refreshSelectionsForLine(lineId) {
  const r = await db.query(`SELECT DISTINCT request_id FROM ngtf_audit_sample_selections WHERE line_id=$1`, [lineId]);
  for (const row of r.rows) await recomputeSelections(row.request_id);
}

async function getSampleRequest(id) {
  const r = await db.query(
    `SELECT q.*, s.kind AS sub_kind, s.as_of_date, s.tied_out, s.total_amount AS sub_total,
            e.period_label, u.name AS entered_by_name, d.filename AS source_filename
       FROM ngtf_audit_sample_requests q
       LEFT JOIN ngtf_audit_subledgers s ON s.id = q.subledger_id
       LEFT JOIN ngtf_audit_engagements e ON e.id = q.engagement_id
       LEFT JOIN ngtf_audit_users u ON u.id = q.entered_by
       LEFT JOIN ngtf_audit_documents d ON d.id = q.source_document_id
      WHERE q.id = $1`,
    [id]
  );
  if (!r.rows.length) return null;
  const request = r.rows[0];
  const sels = await db.query(
    `SELECT s.*, l.line_no, l.counterparty_name, l.doc_number, l.doc_date AS line_doc_date,
            l.open_amount, l.aging_bucket, l.risk_flags, u.name AS assigned_to_name
       FROM ngtf_audit_sample_selections s
       LEFT JOIN ngtf_audit_subledger_lines l ON l.id = s.line_id
       LEFT JOIN ngtf_audit_users u ON u.id = s.assigned_to
      WHERE s.request_id=$1
      ORDER BY s.status = 'complete', s.selection_no`,
    [id]
  );
  const required = request.required_support || [];
  const selections = [];
  for (const s of sels.rows) {
    const support = s.line_id ? await supportFor(s.line_id) : [];
    const have = Array.from(new Set(support.map((x) => x.support_type)));
    selections.push(
      Object.assign({}, s, {
        support,
        have,
        missing: required.filter((t) => !have.includes(t)),
      })
    );
  }
  const counts = {
    total: selections.length,
    complete: selections.filter((s) => s.status === "complete").length,
    partial: selections.filter((s) => s.status === "partial").length,
    open: selections.filter((s) => s.status === "open").length,
    unmatched: selections.filter((s) => s.status === "unmatched").length,
    waived: selections.filter((s) => s.status === "waived").length,
  };
  const dollars = selections.reduce((a, s) => a + Math.abs(Number(s.given_amount || s.open_amount) || 0), 0);
  const dollarsComplete = selections
    .filter((s) => s.status === "complete" || s.status === "waived")
    .reduce((a, s) => a + Math.abs(Number(s.given_amount || s.open_amount) || 0), 0);
  return {
    request,
    procedure: PROCEDURES[request.procedure] || PROCEDURES.other,
    selections,
    counts,
    dollars: round2(dollars),
    dollarsComplete: round2(dollarsComplete),
    dollarsPct: dollars ? Math.round((dollarsComplete / dollars) * 1000) / 10 : 100,
  };
}

async function listSampleRequests({ status = "open", kind = null, limit = 100 } = {}) {
  const params = [];
  const where = [];
  if (status && status !== "all") {
    params.push(status);
    where.push(`q.status = $${params.length}`);
  }
  if (kind) {
    params.push(kind);
    where.push(`q.kind = $${params.length}`);
  }
  params.push(limit);
  const r = await db.query(
    `SELECT q.*, e.period_label, s.as_of_date,
            (SELECT COUNT(*) FROM ngtf_audit_sample_selections x WHERE x.request_id=q.id)::int AS total,
            (SELECT COUNT(*) FROM ngtf_audit_sample_selections x WHERE x.request_id=q.id AND x.status='complete')::int AS complete,
            (SELECT COUNT(*) FROM ngtf_audit_sample_selections x WHERE x.request_id=q.id AND x.status='unmatched')::int AS unmatched
       FROM ngtf_audit_sample_requests q
       LEFT JOIN ngtf_audit_engagements e ON e.id = q.engagement_id
       LEFT JOIN ngtf_audit_subledgers s ON s.id = q.subledger_id
      ${where.length ? "WHERE " + where.join(" AND ") : ""}
      ORDER BY q.seq DESC LIMIT $${params.length}`,
    params
  );
  return r.rows;
}

async function assignSelection({ selectionId, userId = null, note = null, actor = null }) {
  const r = await db.query(
    `UPDATE ngtf_audit_sample_selections SET assigned_to=$2, note=COALESCE($3, note) WHERE id=$1 RETURNING *`,
    [selectionId, userId, note]
  );
  if (!r.rows.length) throw new Error("No such selection.");
  return r.rows[0];
}

/**
 * Waive a selection. Needs a reason, because "we could not find it" is
 * an answer the auditor is entitled to have in writing — and it is one
 * they will follow up, which is better than a silent omission.
 */
async function waiveSelection({ selectionId, reason, actor = null, req = null }) {
  if (!reason || String(reason).trim().length < 10) {
    throw new Error(
      "Give a reason of at least ten characters. A selection that cannot be supported is a real answer and the auditor is entitled to it in writing — but it has to say why."
    );
  }
  const r = await db.query(
    `UPDATE ngtf_audit_sample_selections SET status='waived', waiver_reason=$2 WHERE id=$1 RETURNING *`,
    [selectionId, String(reason).trim()]
  );
  if (!r.rows.length) throw new Error("No such selection.");
  await schema.logEvent({
    sampleRequestId: r.rows[0].request_id,
    event: "sample_selection_waived",
    actor,
    ip: reqIp(req),
    detail: { selection: r.rows[0].selection_no, reason: String(reason).trim() },
  });
  await recomputeSelections(r.rows[0].request_id);
  return r.rows[0];
}

/** Re-point a selection at the right line when matching was ambiguous. */
async function matchSelectionManually({ selectionId, lineId, note = null, actor = null, req = null }) {
  const sel = await db.query(`SELECT * FROM ngtf_audit_sample_selections WHERE id=$1`, [selectionId]);
  if (!sel.rows.length) throw new Error("No such selection.");
  const line = await db.query(
    `SELECT l.*, s.id AS subledger_id FROM ngtf_audit_subledger_lines l
       JOIN ngtf_audit_subledgers s ON s.id=l.subledger_id WHERE l.id=$1`,
    [lineId]
  );
  if (!line.rows.length) throw new Error("No such subledger line.");
  const req0 = await db.query(`SELECT subledger_id FROM ngtf_audit_sample_requests WHERE id=$1`, [sel.rows[0].request_id]);
  if (Number(req0.rows[0].subledger_id) !== Number(line.rows[0].subledger_id)) {
    throw new Error("That line is in a different aging than this request was made against.");
  }
  const r = await db.query(
    `UPDATE ngtf_audit_sample_selections
        SET line_id=$2, match_method='manual', match_note=$3 WHERE id=$1 RETURNING *`,
    [selectionId, lineId, note || "Matched by hand."]
  );
  await schema.logEvent({
    sampleRequestId: sel.rows[0].request_id,
    subledgerId: line.rows[0].subledger_id,
    event: "sample_selection_matched_by_hand",
    actor,
    ip: reqIp(req),
    detail: {
      selection: sel.rows[0].selection_no,
      auditorWrote: { counterparty: sel.rows[0].given_counterparty, doc: sel.rows[0].given_doc_number, amount: Number(sel.rows[0].given_amount) },
      matchedTo: { line_no: line.rows[0].line_no, counterparty: line.rows[0].counterparty_name, doc: line.rows[0].doc_number },
      note: note || null,
    },
  });
  await recomputeSelections(sel.rows[0].request_id);
  return r.rows[0];
}

/**
 * Hand a completed request over as a numbered transmittal.
 *
 * This is why the delivery ledger exists. A sample response that is
 * emailed as attachments has no receipt, so three weeks later nobody can
 * say whether it arrived — which is the other half of the same problem
 * this whole portal is built around.
 */
async function deliverSampleRequest({ requestId, message = null, actor = null, req = null }) {
  const full = await getSampleRequest(requestId);
  if (!full) throw new Error("No such sample request.");
  if (full.counts.unmatched) {
    throw new Error(
      `${full.counts.unmatched} selection(s) are still unmatched. Resolve or waive them first — delivering a package that silently omits selections is what makes the round trip happen twice.`
    );
  }
  if (full.counts.open || full.counts.partial) {
    throw new Error(
      `${full.counts.open + full.counts.partial} selection(s) are still missing required support. Waive them with a reason if they cannot be produced.`
    );
  }

  const docIds = new Set();
  for (const s of full.selections) for (const sp of s.support) docIds.add(sp.document_id);
  if (full.request.source_document_id) docIds.delete(full.request.source_document_id);
  if (!docIds.size) throw new Error("There are no documents to deliver — every selection was waived.");

  const delivery = require("./audit-delivery");
  const tx = await delivery.createTransmittal({
    direction: "to_auditor",
    engagementId: full.request.engagement_id,
    documentIds: Array.from(docIds),
    subject: `${full.request.ref} — ${full.procedure.label} (${full.counts.total} selection${full.counts.total === 1 ? "" : "s"})`,
    message:
      message ||
      `Support for the ${full.counts.total} selections on ${full.request.ref}. ${
        full.counts.waived ? `${full.counts.waived} selection(s) could not be supported and carry a written reason. ` : ""
      }The aging these were drawn from is as of ${cal.dstr(full.request.as_of_date)}.`,
    actor,
    req,
  });

  await db.query(
    `UPDATE ngtf_audit_sample_requests SET status='delivered', transmittal_id=$2 WHERE id=$1`,
    [requestId, tx.transmittal.id]
  );
  await schema.logEvent({
    sampleRequestId: requestId,
    transmittalId: tx.transmittal.id,
    engagementId: full.request.engagement_id,
    event: "sample_request_delivered",
    actor,
    ip: reqIp(req),
    detail: {
      ref: full.request.ref,
      transmittal: tx.transmittal.number,
      documents: docIds.size,
      selections: full.counts.total,
      waived: full.counts.waived,
    },
  });
  return { transmittal: tx.transmittal, documents: docIds.size };
}

/**
 * The package, as a foldered manifest the caller can stream into a zip.
 *
 * One folder per selection, named with the selection number, so the
 * auditor does not have to work out which of forty PDFs belongs to
 * selection 23. That naming is most of the perceived quality of a sample
 * response, and it costs nothing.
 */
async function samplePackageManifest(requestId) {
  const full = await getSampleRequest(requestId);
  if (!full) throw new Error("No such sample request.");
  const entries = [];
  const index = [];
  for (const s of full.selections) {
    const folder = `${String(s.selection_no).replace(/[^A-Za-z0-9._-]/g, "_")}`;
    const who = String(s.counterparty_name || s.given_counterparty || "unknown").replace(/[^A-Za-z0-9._ -]/g, "").trim().slice(0, 40);
    const dir = `${full.request.ref}/${folder} ${who}`.replace(/\s+/g, " ");
    index.push({
      selection: s.selection_no,
      status: s.status,
      auditor_counterparty: s.given_counterparty,
      auditor_doc_number: s.given_doc_number,
      auditor_amount: s.given_amount == null ? null : Number(s.given_amount),
      matched_counterparty: s.counterparty_name,
      matched_doc_number: s.doc_number,
      matched_amount: s.open_amount == null ? null : Number(s.open_amount),
      match_method: s.match_method,
      waiver_reason: s.waiver_reason,
      documents: s.support.map((x) => ({ support_type: x.support_type, filename: x.filename, sha256: x.sha256 })),
    });
    for (const sp of s.support) {
      entries.push({
        path: `${dir}/${SUPPORT_TYPES[sp.support_type] ? SUPPORT_TYPES[sp.support_type].short : "DOC"} ${sp.filename}`,
        documentId: sp.document_id,
      });
    }
  }
  return {
    request: full.request,
    procedure: full.procedure,
    entries,
    index,
    counts: full.counts,
  };
}

// ── Completeness checks ─────────────────────────────────────
//
// The part that makes this a control rather than a filing cabinet. Each
// of these is something an auditor will raise, and every one is cheaper
// to find now than in a review note.

async function completenessChecks({ subledgerId }) {
  const sub = await getSubledger(subledgerId);
  if (!sub) throw new Error("No such subledger snapshot.");
  const s = sub.subledger;
  const kind = s.kind;
  const asOf = cal.dstr(s.as_of_date);
  const out = [];
  const add = (o) => out.push(o);

  if (!s.tied_out) {
    add({
      id: "not_tied_out",
      severity: "high",
      title: "This aging has not been agreed to the general ledger",
      detail:
        "Agreeing the subledger to the control account is the first thing the auditor does with it, and until it is done nothing built on this population can be relied on — including any sample drawn from it.",
      authority: ["PCAOB AS 2301"],
      fix: "Enter the general-ledger balance for this account as of " + asOf + " and record the tie-out.",
    });
  } else if (Math.abs(Number(s.variance) || 0) > 0.5) {
    add({
      id: "variance",
      severity: "high",
      title: `The aging and the general ledger differ by ${fmtMoney(s.variance)}`,
      detail:
        (s.tie_out_note ? `Recorded explanation: "${s.tie_out_note}". ` : "") +
        "An explained variance is normal; the risk is that the explanation is not carried forward and has to be reconstructed months later. It is on the record here.",
      authority: ["PCAOB AS 2301"],
      fix: "Clear the difference in the next close if it is a real posting error, or carry the explanation into the next snapshot.",
    });
  }

  if (Number(s.debit_count) > 0) {
    add({
      id: "contra_balances",
      severity: "medium",
      title:
        kind === "ar"
          ? `${s.debit_count} credit balance${Number(s.debit_count) === 1 ? "" : "s"} sitting in receivables (${fmtMoney(s.debit_amount)})`
          : `${s.debit_count} debit balance${Number(s.debit_count) === 1 ? "" : "s"} sitting in payables (${fmtMoney(s.debit_amount)})`,
      detail:
        kind === "ar"
          ? "A customer credit is a liability — a refund owed or a deposit held — not a negative asset. Netting it against receivables overstates neither total by much but misstates both captions, and it is the sort of thing a reviewer finds immediately."
          : "A debit in payables is usually a prepayment or an unapplied credit from a vendor, and belongs in assets rather than reducing the payable.",
      authority: ["Reg S-X Rule 5-02", "ASC 210-20-45-1"],
      fix: "Reclassify them, or document why the offset is appropriate.",
    });
  }

  const after = await db.query(
    `SELECT COUNT(*)::int AS n, COALESCE(SUM(ABS(open_amount)),0)::numeric(18,2) AS amt
       FROM ngtf_audit_subledger_lines WHERE subledger_id=$1 AND doc_date > $2`,
    [subledgerId, asOf]
  );
  if (after.rows[0].n > 0) {
    add({
      id: "dated_after_period_end",
      severity: "high",
      title: `${after.rows[0].n} line${after.rows[0].n === 1 ? "" : "s"} dated after ${asOf} (${fmtMoney(after.rows[0].amt)})`,
      detail:
        "A transaction dated after the as-of date should not be in an aging as of that date. Either the aging was run on the wrong date, or the dates in the ledger are wrong — and both come straight back as a cutoff question.",
      authority: ["ASC 606-10-25-23", "PCAOB AS 2301"],
      fix: "Re-run the aging as of " + asOf + " and import it again, or explain the dates.",
    });
  }

  const conc = sub.concentration[0];
  if (conc && conc.pct >= 10) {
    add({
      id: "concentration",
      severity: "low",
      title: `${conc.counterparty_name} is ${conc.pct}% of the ${kind.toUpperCase()} balance`,
      detail:
        kind === "ar"
          ? "A concentration of credit risk at this level is a disclosure question, separately from whether the balance is collectible. If one customer is also 10% or more of revenue, the major-customer disclosure applies too."
          : "Worth knowing for the related-party and going-concern discussion even where no disclosure follows.",
      authority: kind === "ar" ? ["ASC 275-10-50-20", "ASC 280-10-50-42"] : ["ASC 275-10-50-20"],
      fix: "Check the concentration disclosure in the notes against this.",
    });
  }

  // Is the supporting population actually on file? A check that fires
  // whether or not the thing has been done is noise, and noise is how a
  // checklist gets skimmed.
  //
  // The import's OWN source file is excluded. J-090 is "Accounts Payable
  // Aging & Vendor Statements" — one category covering two different
  // documents — so importing the aging filed a document under J-090 and
  // silenced the vendor-statement check, which is the opposite of what
  // should happen. Excluding the file this snapshot came from fixes it
  // without splitting a category that already has history behind it.
  const onFile = async (code) => {
    const r = await db.query(
      `SELECT 1 FROM ngtf_audit_documents
        WHERE category_code = $1 AND status = 'active'
          AND ($2::int IS NULL OR engagement_id = $2)
          AND ($3::int IS NULL OR id <> $3)
          AND COALESCE(source, '') <> 'subledger_import'
        LIMIT 1`,
      [code, s.engagement_id || null, s.document_id || null]
    );
    return r.rows.length > 0;
  };

  if (kind === "ar") {
    const old = Number(s.bucket_over_90) || 0;
    if (old > 0 && !(await onFile("D-020"))) {
      const pct = Number(s.total_amount) ? Math.round((old / Number(s.total_amount)) * 1000) / 10 : 0;
      add({
        id: "over_90_allowance",
        severity: pct >= 15 ? "medium" : "low",
        title: `${fmtMoney(old)} (${pct}%) is over 90 days`,
        detail:
          "Under ASC 326-20 the allowance is a current expected credit loss over the life of the receivable, estimated from historical loss experience adjusted for current conditions — not an incurred-loss judgment made invoice by invoice. The auditor will want the loss-rate history behind the rate applied to this bucket.",
        authority: ["ASC 326-20-30-1", "ASC 326-20-30-7"],
        fix: "Upload the CECL rollforward and loss-rate history (D-020) for this period.",
      });
    }
    if (!(await onFile("D-130"))) add({
      id: "ar_alternatives_population",
      severity: "medium",
      title: "Subsequent cash receipts listing is not on file — needed before confirmations come back empty",
      detail:
        "AS 2310 applies to fiscal years ending on or after 15 June 2025, so it is already in force for a June year end. Paragraph .24 requires the auditor to confirm receivables or get equivalent evidence directly from an external source; when a confirmation does not come back, Appendix C sends them to subsequent cash receipts first. Having that listing ready turns a three-week non-response problem into an afternoon.",
      authority: ["PCAOB AS 2310.23", "AS 2310.24", "Appendix C"],
      fix: "Upload the cash applied to these receivables after " + asOf + " (category D-130).",
    });
    if (!(await onFile("D-120"))) add({
      id: "ar_confirmation_contacts",
      severity: "low",
      title: "Verified customer contact detail is not on file",
      detail:
        "AS 2310.24 requires the auditor to confirm receivables or obtain the equivalent directly from an external source, and AS 2310.15 makes selecting, sending and receiving the auditor's job. What the company provides is verified contact detail, and an address taken from the customer master without checking is exactly the weak point the standard is aimed at.",
      authority: ["PCAOB AS 2310.15", "AS 2310.24"],
      fix: "Upload the verified names, billing addresses and AP contacts for the largest customers (category D-120). Do not collect responses.",
    });
  } else {
    if (!(await onFile("C-090"))) add({
      id: "ap_unrecorded_liabilities",
      severity: "high",
      title: "Subsequent-period disbursement register is not on file — the search for unrecorded liabilities cannot be done without it",
      detail:
        "This is the procedure that finds the understatement in a company short of accounting staff. The auditor takes payments made AFTER the period end above a threshold and asks, for each, whether the liability belonged in the period just closed. The test turns on when the service was performed or the goods received, not the invoice date — so the invoices behind those payments have to show the service period.",
      authority: ["PCAOB AS 2301", "AS 2810"],
      fix: "Upload the cheque, ACH and wire register for the period after " + asOf + " (category C-090), and be ready to produce the invoice behind any payment above their threshold.",
    });
    if (!(await onFile("J-090"))) add({
      id: "ap_vendor_statements",
      severity: "medium",
      title: "No vendor statements on file for the largest vendors",
      detail:
        "What the vendor says is owed is third-party evidence, and under AS 1105.08 evidence from outside the company carries more weight than the company's own ledger. For the largest few vendors it is the cheapest comfort available on completeness.",
      authority: ["PCAOB AS 1105.08"],
      fix: "Request statements from the top vendors by balance and file them against those lines.",
    });
  }

  const unsupported = await db.query(
    `SELECT COUNT(*)::int AS n, COALESCE(SUM(ABS(l.open_amount)),0)::numeric(18,2) AS amt
       FROM ngtf_audit_subledger_lines l
      WHERE l.subledger_id=$1 AND l.likely_selected = TRUE
        AND NOT EXISTS (SELECT 1 FROM ngtf_audit_subledger_support sp WHERE sp.line_id=l.id)`,
    [subledgerId]
  );
  if (unsupported.rows[0].n > 0) {
    add({
      id: "likely_unsupported",
      severity: "medium",
      title: `${unsupported.rows[0].n} likely-selected line${unsupported.rows[0].n === 1 ? "" : "s"} have no support attached (${fmtMoney(unsupported.rows[0].amt)})`,
      detail:
        "These are the large items and the ones carrying risk markers — the lines most likely to be picked. Attaching their support before the selection list arrives is the difference between answering it in a morning and answering it in a fortnight." +
        (s.key_item_threshold == null
          ? " No threshold has been shared by the auditor, so this list is the largest items plus risk markers rather than a prediction of their sample."
          : ""),
      authority: [],
      fix: "Work the likely-selections list.",
    });
  }
  return { subledger: s, checks: out };
}

// ── Dashboard ───────────────────────────────────────────────
async function subledgerStats() {
  const r = await db.query(
    `SELECT
       (SELECT COUNT(*) FROM ngtf_audit_subledgers WHERE status='active')::int AS snapshots,
       (SELECT COUNT(*) FROM ngtf_audit_subledgers WHERE status='active' AND NOT tied_out)::int AS untied,
       (SELECT COUNT(*) FROM ngtf_audit_sample_requests WHERE status='open')::int AS open_requests,
       (SELECT COUNT(*) FROM ngtf_audit_sample_selections x
          JOIN ngtf_audit_sample_requests q ON q.id=x.request_id
         WHERE q.status='open' AND x.status NOT IN ('complete','waived'))::int AS outstanding_selections,
       (SELECT COUNT(*) FROM ngtf_audit_sample_selections x
          JOIN ngtf_audit_sample_requests q ON q.id=x.request_id
         WHERE q.status='open' AND x.status='unmatched')::int AS unmatched_selections,
       (SELECT COUNT(*) FROM ngtf_audit_sample_requests WHERE status='complete')::int AS ready_to_deliver`
  );
  const stats = r.rows[0];
  const latest = await db.query(
    `SELECT DISTINCT ON (kind) id, kind, as_of_date, tied_out, variance, row_count, total_amount, key_item_threshold
       FROM ngtf_audit_subledgers WHERE status='active' ORDER BY kind, as_of_date DESC`
  );
  const byKind = {};
  for (const row of latest.rows) {
    const un = await db.query(
      `SELECT COUNT(*)::int AS n, COALESCE(SUM(ABS(l.open_amount)),0)::numeric(18,2) AS amt
         FROM ngtf_audit_subledger_lines l
        WHERE l.subledger_id=$1 AND l.likely_selected
          AND NOT EXISTS (SELECT 1 FROM ngtf_audit_subledger_support sp WHERE sp.line_id=l.id)`,
      [row.id]
    );
    byKind[row.kind] = Object.assign({}, row, {
      likelyUnsupported: un.rows[0].n,
      likelyUnsupportedAmount: Number(un.rows[0].amt),
    });
  }
  const dueSoon = await db.query(
    `SELECT ref, due_on, label FROM ngtf_audit_sample_requests
      WHERE status='open' AND due_on IS NOT NULL AND due_on <= CURRENT_DATE + INTERVAL '5 days'
      ORDER BY due_on LIMIT 5`
  );
  return Object.assign({}, stats, { latest: byKind, dueSoon: dueSoon.rows });
}

module.exports = {
  SUPPORT_TYPES,
  COMPANY_FORBIDDEN_SUPPORT,
  PROCEDURES,
  RISK_FLAG_LABELS,
  // parsing helpers, exported for tests and for the column-mapping screen
  normDoc,
  normDocDigits,
  normName,
  parseAmount,
  parseDate,
  parseCsv,
  sheetToRows,
  detectHeader,
  mapHeaderRow,
  parseSubledger,
  bucketOf,
  fmtMoney,
  round2,
  // snapshots
  importSubledger,
  tieOut,
  computeRisk,
  getSubledger,
  listSubledgers,
  topCounterparties,
  searchLines,
  lookup,
  supportFor,
  attachSupport,
  detachSupport,
  readiness,
  completenessChecks,
  subledgerStats,
  // sampling
  amountsAgree,
  matchSelections,
  parseSelectionList,
  createSampleRequest,
  getSampleRequest,
  listSampleRequests,
  recomputeSelections,
  refreshSelectionsForLine,
  assignSelection,
  waiveSelection,
  matchSelectionManually,
  deliverSampleRequest,
  samplePackageManifest,
};
