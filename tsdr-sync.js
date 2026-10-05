// ============================================================
//  TEZ LAW P.C. — USPTO TSDR STATUS CHECK (Trademark matters)
//  ─────────────────────────────────────────────────────────
//  Once a day, looks up every active Trademark matter in Matter
//  Manager that has a USPTO serial number (8 digits) or registration
//  number (7 digits), using the USPTO's TSDR API (Trademark Status &
//  Document Retrieval).
//
//  When the USPTO record changes it:
//    • sends JJ a Telegram alert with the new status and the new
//      prosecution-history entries,
//    • turns the entries that start a clock (office action, suspension
//      inquiry, publication, notice of allowance, registration, renewal,
//      abandonment, post-registration action) into deadlines on the
//      matter, using the SAME rules as the IP lifecycle buttons
//      (lifecycleDeadlines in matter-manager.js),
//    • ticks off the "Check TSDR" reminder deadlines that fall due in the
//      next 35 days, because the check has just been done.
//
//  What it does NOT do: read the documents themselves, calendar TTAB
//  proceeding dates (oppositions, cancellations), or act on entries it
//  does not recognise. Those are listed in the alert so a person reads
//  them. It is a second set of eyes, not a replacement for reading USPTO
//  mail.
//
//  Failure handling: a lookup that cannot be read is recorded as a
//  failure, never as "no change". Failures are reported on Telegram
//  (the same run for a rejected key, a wrong number, a mark that does not
//  match, or any failure on a matter that was reading fine; after about a
//  day for a matter never read before) and again every few days while
//  they last. Every Monday a one-line summary says how many matters are
//  being checked and which are not.
//
//  Environment:
//    USPTO_API_KEY     required. Free key from
//                      https://account.uspto.gov/api-manager/
//    TSDR_AUTO_ADD     optional. Default "true": deadlines are written
//                      straight onto the matter. "false" sends them to the
//                      proposal inbox for approval instead.
//    TSDR_BASE_URL     optional. Override for testing.
//
//  USPTO limit: 60 requests per key per minute. Requests here are spaced
//  at least 1.1 seconds apart; a matter normally takes one request.
//
//  Commands (JJ mode):  /tsdr   /tsdr check   /tsdr test <number>
//  CLI:                 node tsdr-sync.js --test <number>
// ============================================================

const axios = require("axios");
const crypto = require("crypto");
const db = require("./db");

const DEFAULT_BASE = "https://tsdrapi.uspto.gov/ts/cd";
const ADMIN_URL = (process.env.PUBLIC_BASE_URL || process.env.RENDER_EXTERNAL_URL || "https://tezlaw-bot.onrender.com").replace(/\/$/, "") + "/admin/matters/";

function tsdrBase() { return (process.env.TSDR_BASE_URL || DEFAULT_BASE).replace(/\/$/, ""); }
function apiKey() { return (process.env.USPTO_API_KEY || process.env.USPTO_TSDR_API_KEY || process.env.TSDR_API_KEY || "").trim(); }
function autoAdd() { return String(process.env.TSDR_AUTO_ADD || "true").toLowerCase() !== "false"; }
function requestGapMs() { return Number(process.env.TSDR_DELAY_MS || 1100); }

class TsdrError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

// ── Case numbers ─────────────────────────────────────────
// 8 digits = serial number ("sn"), 7 digits = registration number ("rn").
// Slashes, commas and spaces are ignored: "99/123,456" → sn99123456.

function caseId(raw) {
  const digits = String(raw || "").replace(/\D/g, "");
  if (digits.length === 8) return { kind: "sn", num: digits, id: "sn" + digits, label: "Serial " + digits };
  if (digits.length === 7) return { kind: "rn", num: digits, id: "rn" + digits, label: "Reg. No. " + digits };
  return null;
}

function tsdrLink(cid) {
  const type = cid.kind === "rn" ? "US_REGISTRATION_NO" : "SERIAL_NO";
  return `https://tsdr.uspto.gov/#caseNumber=${cid.num}&caseType=${type}&searchType=statusSearch`;
}

// ── Date helpers (pure) ──────────────────────────────────

function todayPT() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
}

function weekdayPT() {
  return new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", weekday: "short" }).format(new Date());
}

// Same month arithmetic as matter-manager.js: Nov 30 + 3 months = Feb 28.
function addMonths(yyyymmdd, months) {
  const [y, m, d] = yyyymmdd.split("-").map(Number);
  const base = new Date(Date.UTC(y, m - 1, d));
  const targetMonth = base.getUTCMonth() + months;
  const target = new Date(Date.UTC(base.getUTCFullYear(), targetMonth, base.getUTCDate()));
  if (target.getUTCMonth() !== ((targetMonth % 12) + 12) % 12) target.setUTCDate(0);
  return target.toISOString().slice(0, 10);
}
function addYears(yyyymmdd, years) { return addMonths(yyyymmdd, years * 12); }

function addDays(yyyymmdd, days) {
  const [y, m, d] = yyyymmdd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

function daysApart(a, b) {
  const t = s => { const [y, m, d] = s.split("-").map(Number); return Date.UTC(y, m - 1, d); };
  return Math.round((t(b) - t(a)) / 86400000);
}

// Accepts "2026-12-01", "2026-12-01-05:00", "2026-12-01T05:00:00.000+0000"
// (TSDR writes midnight Eastern as a UTC time, so the first ten characters
// are the Eastern calendar date), "20261201", epoch milliseconds, or
// "Dec. 1, 2026". Returns YYYY-MM-DD or null.
function normDate(v) {
  if (v == null || v === "") return null;
  if (typeof v === "number" && isFinite(v)) {
    if (v > 1e11) return new Date(v).toISOString().slice(0, 10);
    if (v > 19000101 && v < 21000101) return normDate(String(v));
    return null;
  }
  const s = String(v).trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  if (/^\d{12,13}$/.test(s)) return new Date(Number(s)).toISOString().slice(0, 10);
  const t = Date.parse(s.replace(/\./g, "") + " UTC");
  if (!isNaN(t)) return new Date(t).toISOString().slice(0, 10);
  return null;
}

function isRealDate(s) {
  return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && addDays(s, 0) === s;
}

// ── Reading the TSDR response ────────────────────────────
// The record comes back as JSON or as WIPO ST.96 XML depending on the
// address and the Accept header. Whatever arrives is recognised by its
// first character.
//
// JSON is read from its documented places first
// (trademarks[0].status, .prosecutionHistory, .publication). Only if those
// are missing does a looser by-name search run, and that search never
// supplies a registration number, because registration numbers of OTHER
// marks appear elsewhere in the record.
//
// A record with no prosecution history is treated as unreadable.

function numOrNull(v) { return v != null && v !== "" && isFinite(Number(v)) ? Number(v) : null; }
function strOrNull(v) { return v == null ? null : (String(v).trim() || null); }

function parseJsonRecord(data) {
  const tm = data && Array.isArray(data.trademarks) ? data.trademarks[0] : null;
  if (tm && tm.status && typeof tm.status === "object" && Array.isArray(tm.prosecutionHistory)) {
    const st = tm.status;
    const events = tm.prosecutionHistory
      .filter(e => e && e.entryDesc != null && String(e.entryDesc).trim() !== "")
      .map(e => ({ n: numOrNull(e.entryNumber), date: normDate(e.entryDate), desc: String(e.entryDesc).trim(), code: strOrNull(e.entryCode) }));
    return finishRecord({
      statusDesc: strOrNull(st.extStatusDesc) || strOrNull(st.tm5StatusDesc),
      statusDate: st.statusDate, filingDate: st.filingDate,
      regNumber: st.usRegistrationNumber, regDate: st.usRegistrationDate,
      pubDate: tm.publication ? tm.publication.datePublished : null,
      mark: st.markElement,
    }, events);
  }
  return looseJsonRecord(data);
}

const LOOSE_KEYS = {
  statusDesc: /^(extstatusdesc|markcurrentstatusexternaldescriptiontext)$/,
  statusDate: /^(statusdate|markcurrentstatusdate)$/,
  filingDate: /^(filingdate|applicationdate)$/,
  mark:       /^(markelement|markverbalelementtext)$/,
};
const EVENT_KEYS = {
  desc: /^(entrydesc|entrydescription|markeventdescriptiontext)$/,
  date: /^(entrydate|markeventdate)$/,
  num:  /^(entrynumber|markevententrynumber)$/,
  code: /^(entrycode|markeventcode)$/,
};
function isPrimitive(v) { return v != null && (typeof v === "string" || typeof v === "number"); }

function findInObject(obj, re, depth = 0) {
  if (obj == null || typeof obj !== "object" || depth > 3) return null;
  for (const [k, v] of Object.entries(obj)) {
    if (re.test(k.toLowerCase()) && isPrimitive(v) && String(v).trim() !== "") return v;
  }
  for (const v of Object.values(obj)) {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const hit = findInObject(v, re, depth + 1);
      if (hit != null) return hit;
    }
  }
  return null;
}

function looseJsonRecord(data) {
  const info = {};
  let best = [];
  (function walk(node, depth) {
    if (node == null || depth > 14) return;
    if (Array.isArray(node)) {
      const evs = [];
      for (const item of node) {
        if (!item || typeof item !== "object" || Array.isArray(item)) continue;
        const desc = findInObject(item, EVENT_KEYS.desc);
        const date = findInObject(item, EVENT_KEYS.date);
        if (desc == null || date == null) continue;
        evs.push({ n: numOrNull(findInObject(item, EVENT_KEYS.num)), date: normDate(date), desc: String(desc).trim(), code: strOrNull(findInObject(item, EVENT_KEYS.code)) });
      }
      if (evs.length > best.length) best = evs;
      for (const x of node) walk(x, depth + 1);
      return;
    }
    if (typeof node === "object") {
      for (const [k, v] of Object.entries(node)) {
        const lk = k.toLowerCase();
        if (isPrimitive(v) && String(v).trim() !== "") {
          for (const [field, re] of Object.entries(LOOSE_KEYS)) if (info[field] == null && re.test(lk)) info[field] = v;
        }
        walk(v, depth + 1);
      }
    }
  })(data, 0);
  return finishRecord(info, best);
}

function decodeEntities(s) {
  return String(s)
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&#39;/g, "'").replace(/&amp;/g, "&");
}

function xmlFirst(xml, names) {
  for (const name of names) {
    const m = xml.match(new RegExp(`<(?:[\\w.-]+:)?${name}(?:\\s[^>]*)?>([^<]*)</`, "i"));
    if (m && m[1].trim()) return decodeEntities(m[1].trim());
  }
  return null;
}

function parseXmlRecord(xml) {
  const events = [];
  // "<ns2:MarkEvent>" but not "<ns2:MarkEventBag>" or "<ns2:MarkEventDate>"
  const re = /<(?:[\w.-]+:)?MarkEvent(?:\s[^>]*)?>([\s\S]*?)<\/(?:[\w.-]+:)?MarkEvent>/gi;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const block = m[1];
    const desc = xmlFirst(block, ["MarkEventDescriptionText"]);
    if (!desc) continue;
    events.push({ n: numOrNull(xmlFirst(block, ["MarkEventEntryNumber"])), date: normDate(xmlFirst(block, ["MarkEventDate"])), desc, code: xmlFirst(block, ["MarkEventCode"]) });
  }
  return finishRecord({
    statusDesc: xmlFirst(xml, ["MarkCurrentStatusExternalDescriptionText", "NationalStatusExternalDescriptionText"]),
    statusDate: xmlFirst(xml, ["MarkCurrentStatusDate"]),
    filingDate: xmlFirst(xml, ["ApplicationDate"]),
    regNumber:  xmlFirst(xml, ["RegistrationNumber"]),
    regDate:    xmlFirst(xml, ["RegistrationDate"]),
    pubDate:    xmlFirst(xml, ["PublicationDate"]),
    mark:       xmlFirst(xml, ["MarkVerbalElementText"]),
  }, events);
}

function finishRecord(info, events) {
  const allNumbered = events.length > 0 && events.every(e => e.n != null);
  const sorted = events.slice().sort((a, b) => allNumbered ? a.n - b.n : String(a.date || "").localeCompare(String(b.date || "")));
  const regDigits = info.regNumber != null ? String(info.regNumber).replace(/\D/g, "").replace(/^0+/, "") : "";
  return {
    statusDesc: strOrNull(info.statusDesc) ? String(info.statusDesc).replace(/\s+/g, " ").trim() : null,
    statusDate: normDate(info.statusDate),
    filingDate: normDate(info.filingDate),
    regNumber:  regDigits || null,
    regDate:    normDate(info.regDate),
    pubDate:    normDate(info.pubDate),
    mark:       strOrNull(info.mark),
    events: sorted,
  };
}

function parseBody(body) {
  const text = String(body || "").replace(/^﻿/, "").trimStart();
  if (!text) return { rec: null, format: null, problem: "empty response" };
  if (text[0] === "{" || text[0] === "[") {
    let data;
    try { data = JSON.parse(text); } catch (_) { return { rec: null, format: "json", problem: "response was not valid JSON" }; }
    const rec = parseJsonRecord(data);
    if (rec.events.length) return { rec, format: "json", problem: null };
    const keys = data && typeof data === "object" ? Object.keys(data).slice(0, 10).join(", ") : typeof data;
    return { rec: null, format: "json", problem: `JSON had no prosecution history this reader recognises (top-level keys: ${keys || "none"})` };
  }
  if (text[0] === "<") {
    const rec = parseXmlRecord(text);
    if (rec.events.length) return { rec, format: "xml", problem: null };
    return { rec: null, format: "xml", problem: "XML had no MarkEvent history this reader recognises" };
  }
  return { rec: null, format: null, problem: "response was neither JSON nor XML" };
}

// Requests go out one at a time, spaced by requestGapMs(), even when a
// manual test runs during the daily check.
let _lastRequestAt = 0;
let _queue = Promise.resolve();
function takeTurn() {
  const turn = _queue.then(async () => {
    const wait = _lastRequestAt + requestGapMs() - Date.now();
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    _lastRequestAt = Date.now();
  });
  _queue = turn.catch(() => {});
  return turn;
}

async function httpGet(url, accept) {
  const key = apiKey();
  if (!key) throw new TsdrError("NO_KEY", "USPTO_API_KEY is not set");
  await takeTurn();
  let res;
  try {
    res = await axios.get(url, {
      headers: { "USPTO-API-KEY": key, "User-Agent": "TezLaw-Tara/1.0", Accept: accept },
      timeout: 30000, responseType: "text", transformResponse: [d => d], validateStatus: () => true,
    });
  } catch (e) {
    throw new TsdrError("NETWORK", `Could not reach the USPTO (${e.message})`);
  }
  if (res.status === 401 || res.status === 403) throw new TsdrError("KEY_REJECTED", `The USPTO rejected the API key (HTTP ${res.status})`);
  if (res.status === 404) throw new TsdrError("NOT_FOUND", "not found (HTTP 404)");
  if (res.status === 429) throw new TsdrError("RATE_LIMITED", "USPTO rate limit reached (HTTP 429)");
  if (res.status < 200 || res.status >= 300) throw new TsdrError("HTTP", `USPTO returned HTTP ${res.status}`);
  return typeof res.data === "string" ? res.data : String(res.data || "");
}

// Three ways to ask for the same record. "/info" with an Accept header is
// the address in the USPTO's own API definition; ".json" and ".xml" are
// accepted too. Whichever worked last is tried first next time.
const ATTEMPTS = [
  { path: "info",      accept: "application/json" },
  { path: "info.json", accept: "application/json" },
  { path: "info.xml",  accept: "application/xml"  },
];
let _preferred = 0;

async function fetchRecord(raw) {
  const cid = typeof raw === "object" && raw && raw.id ? raw : caseId(raw);
  if (!cid) throw new TsdrError("BAD_NUMBER", "The number on the matter must be an 8-digit serial number or a 7-digit registration number");

  const order = [_preferred, ...ATTEMPTS.map((_, i) => i).filter(i => i !== _preferred)];
  const problems = [];
  let notFound = 0;
  for (const i of order) {
    const a = ATTEMPTS[i];
    try {
      const body = await httpGet(`${tsdrBase()}/casestatus/${cid.id}/${a.path}`, a.accept);
      const parsed = parseBody(body);
      if (parsed.rec) { _preferred = i; return { ...parsed.rec, cid, format: parsed.format }; }
      problems.push(`${a.path}: ${parsed.problem}`);
    } catch (e) {
      // Key, rate-limit and network trouble will not be cured by another address.
      if (e instanceof TsdrError && ["NO_KEY", "KEY_REJECTED", "RATE_LIMITED", "NETWORK"].includes(e.code)) throw e;
      if (e instanceof TsdrError && e.code === "NOT_FOUND") notFound++;
      problems.push(`${a.path}: ${e.message}`);
    }
  }
  if (notFound === ATTEMPTS.length) {
    throw new TsdrError("NOT_FOUND", `${cid.label} was not found in TSDR. A new application can take several days to appear; otherwise check the number.`);
  }
  throw new TsdrError("UNREADABLE", `The record for ${cid.label} could not be read from TSDR (${problems.join("; ")}).`);
}

// ── Classifying prosecution-history entries ──────────────
// Matching is on the entry's description as TSDR prints it, e.g.
//   NON-FINAL ACTION E-MAILED · FINAL REFUSAL E-MAILED
//   EXAMINER'S AMENDMENT/PRIORITY ACTION E-MAILED
//   INQUIRY TO SUSPENSION E-MAILED
//   PUBLISHED FOR OPPOSITION
//   NOA E-MAILED - SOU REQUIRED FROM APPLICANT
//   REGISTERED-PRINCIPAL REGISTER · REGISTERED AND RENEWED
//   ABANDONMENT - FAILURE TO RESPOND OR LATE RESPONSE

function normDesc(desc) { return String(desc || "").toUpperCase().replace(/\s+/g, " ").trim(); }

function classifyEvent(desc) {
  const d = normDesc(desc);
  if (!d) return { type: "other" };

  if (/\bABANDON/.test(d) && !/PETITION|REVIV|REINSTAT|WITHDRAW|PARTIAL/.test(d)) {
    // Abandonment after an appeal or by the applicant's own request is not cured by a petition to revive.
    return { type: "abandoned", noPetition: /EXPRESS|APPEAL|INTER PARTES/.test(d) };
  }
  if (/POST[ -]?REG(ISTRATION)?\.? (OFFICE )?ACTION.*MAILED/.test(d)) return { type: "postreg_action" };
  // A suspension INQUIRY requires a response like any office action.
  // A suspension LETTER / notice of suspension does not.
  if (/(INQUIRY (TO|AS TO|ON|RE) SUSPENSION|SUSPENSION INQUIRY)/.test(d) && /MAILED/.test(d) && !/RESPONSE/.test(d)) {
    return { type: "office_action", final: false, what: "Suspension inquiry" };
  }
  if (/(NON-?FINAL ACTION|FINAL REFUSAL|PRIORITY ACTION|SUBSEQUENT FINAL)/.test(d) && /MAILED/.test(d) && !/RESPONSE|CONTINUING/.test(d)) {
    const final = /FINAL REFUSAL|SUBSEQUENT FINAL/.test(d) && !/NON-?FINAL/.test(d);
    return { type: "office_action", final, what: final ? "FINAL office action" : "Office action" };
  }
  if (/^PUBLISHED FOR OPPOSITION/.test(d)) return { type: "published" };
  if (/^NOA (E-?MAILED|MAILED)/.test(d) || /^NOTICE OF ALLOWANCE.*MAILED/.test(d)) return { type: "noa" };
  if (/^REGISTERED AND RENEWED/.test(d)) return { type: "renewed" };
  if (/^REGISTERED ?- ?(PRINCIPAL|SUPPLEMENTAL) REGISTER/.test(d)) return { type: "registered" };
  if (/^REGISTERED ?- ?SEC(TION|\.)? ?8.*ACCEPT/.test(d)) return { type: "sec8_accepted" };
  // The registration itself has ended. (Not "cancellation": a cancellation
  // PROCEEDING leaves the registration alive.)
  if (/^(CANCELL?ED|EXPIRED)\b/.test(d)) return { type: "dead" };
  if (/OPPOSITION (INSTITUTED|FILED|PAPERS? RECEIVED|SUSTAINED)|EXTENSION OF TIME TO OPPOSE/.test(d)) return { type: "opposition" };
  if (/CANCELL?ATION (INSTITUTED|PETITION|FILED|GRANTED)/.test(d)) return { type: "cancellation" };
  if (/(LETTER OF SUSPENSION|SUSPENSION LETTER|NOTICE OF SUSPENSION).*MAILED/.test(d)) return { type: "suspension" };
  return { type: "other" };
}

// Entries that mean an earlier office action has been dealt with. A request
// for reconsideration is deliberately NOT here: it does not extend the time
// to appeal a final refusal.
const ANSWERS_OFFICE_ACTION = /RESPONSE TO OFFICE ACTION|RESPONSE TO .*(ACTION|INQUIRY).*(RECEIVED|ENTERED)|APPROVED FOR PUB|PUBLISHED FOR OPPOSITION|^REGISTERED|NOTICE OF APPEAL|EX ?PARTE APPEAL|ALLOWED .*REGISTER/;
// Entries that mean the statement-of-use clock has stopped.
const ENDS_SOU_CLOCK = /SOU ACCEPTED|STATEMENT OF USE.*(ACCEPT|APPROV)|ACCEPTANCE OF STATEMENT OF USE|ALLOWED .*REGISTER|^REGISTERED/;
// An abandonment or cancellation has been undone. A petition that was only
// received, or was denied or dismissed, has undone nothing.
const REVIVED = /(REVIVE|REVIVAL|REINSTAT)(?!.*(RECEIVED|DENIED|DISMISSED))/;

function eventKey(e) { return `${e.date || ""}|${normDesc(e.desc)}`; }

// Decide which entries call for deadlines.
//   baseline = the first time this number is read: the whole history is
//              looked at and only clocks that are still running are acted on.
//   otherwise: entries not seen on an earlier run are acted on.
function planActions(rec, { baseline, seenKeys, today }) {
  const typed = rec.events.map((e, idx) => ({ ...e, idx, descU: normDesc(e.desc), ...classifyEvent(e.desc) }));
  // A request for an EXTENSION of time is never an answer, whatever its wording.
  const hit = (x, re) => re.test(x.descU) && !(re === ANSWERS_OFFICE_ACTION && /EXTENSION/.test(x.descU));
  const laterMatches = (e, re) => typed.slice(e.idx + 1).some(x => hit(x, re));
  const laterOfType = (e, types) => typed.slice(e.idx + 1).some(x => types.includes(x.type));
  const between = (a, b, re) => typed.slice(a.idx + 1, b.idx).some(x => hit(x, re));
  const actions = [];
  const push = (e, extra = {}) => {
    // An explicit date (even null) replaces the entry's own date: a renewal
    // must be counted from the REGISTRATION date and never from its own.
    const date = Object.prototype.hasOwnProperty.call(extra, "date") ? extra.date : e.date;
    if (actions.some(a => a.type === e.type && a.date === date)) return;
    actions.push({ type: e.type, date, entryDate: e.date, desc: e.desc, final: !!(extra.final != null ? extra.final : e.final), what: e.what || null, noPetition: !!e.noPetition });
  };

  // One office action is logged as several entries ("…WRITTEN", "…E-MAILED",
  // "NOTIFICATION OF … E-MAILED"), sometimes a day apart. The clock runs from
  // the EARLIEST mailed entry of the group.
  const rootOf = (e) => {
    let root = e, final = !!e.final;
    for (let i = e.idx - 1; i >= 0; i--) {
      const p = typed[i];
      if (p.type !== "office_action" || !p.date || !root.date) continue;
      const gap = daysApart(p.date, root.date);
      if (gap < 0 || gap > 5 || between(p, root, ANSWERS_OFFICE_ACTION)) break;
      root = p; final = final || !!p.final;
    }
    return { root, final };
  };

  const last = t => [...typed].reverse().find(e => e.type === t);
  const regEvent = last("registered");
  // Older records can open with post-registration entries and carry no
  // "REGISTERED-PRINCIPAL REGISTER" entry at all; the status block's
  // registration date is then the only source.
  const regDate = rec.regDate || (regEvent ? regEvent.date : null);
  const isRegistered = !!regEvent || !!last("renewed") || !!last("sec8_accepted") || !!(rec.regDate && rec.regNumber);

  if (!baseline) {
    for (const e of typed) {
      if (seenKeys.has(eventKey(e))) continue;
      if (e.type === "office_action") {
        const { root, final } = rootOf(e);
        if (root !== e && seenKeys.has(eventKey(root))) continue;   // a later echo of an action already handled
        push(root, { final });
      } else if (e.type === "registered") push(e, { date: regDate || e.date });
      else if (e.type === "renewed") push(e, { date: regDate });
      else if (["published", "noa", "abandoned", "postreg_action", "opposition", "cancellation", "suspension", "sec8_accepted", "dead"].includes(e.type)) push(e);
    }
    return actions;
  }

  if (isRegistered) {
    const deadEv = last("dead");
    if (deadEv && !laterMatches(deadEv, REVIVED)) { push(deadEv); return actions; }
    const ren = last("renewed");
    if (ren) push(ren, { date: regDate });
    else push(regEvent || { type: "registered", date: regDate, desc: "Registration date in the TSDR status" }, { date: regDate });
    const s8 = last("sec8_accepted");
    if (s8 && !ren) { const ra = actions.find(a => a.type === "registered"); if (ra) ra.sec8Done = true; }
    const pr = last("postreg_action");
    if (pr && pr.date && addMonths(pr.date, 6) >= today && !laterMatches(pr, /RESPONSE|ACCEPT/)) push(pr);
    const canc = last("cancellation");
    if (canc && canc.date && addYears(canc.date, 3) >= today && !laterMatches(canc, /CANCELL?ATION (TERMINATED|DISMISSED|DENIED|WITHDRAWN)/)) push(canc);
    return actions;
  }
  // An abandonment is in force only if nothing later shows the application
  // moving again (a revival, or any later action, publication or allowance).
  const ab = last("abandoned");
  if (ab && !laterMatches(ab, REVIVED) && !laterOfType(ab, ["office_action", "published", "noa"])) {
    const first = typed.find(e => e.type === "abandoned" && !laterMatches(e, REVIVED) && !laterOfType(e, ["office_action", "published", "noa"])) || ab;
    push(first);
    return actions;
  }
  const oa = last("office_action");
  if (oa && oa.date) {
    const { root, final } = rootOf(oa);
    if (!laterMatches(oa, ANSWERS_OFFICE_ACTION) && addMonths(root.date, 6) >= today) push(root, { final });
  }
  const noa = last("noa");
  if (noa && noa.date && !laterMatches(noa, ENDS_SOU_CLOCK) && addMonths(noa.date, 36) >= today) push(noa);
  const pub = last("published");
  if (pub && pub.date && !noa && addDays(pub.date, 120) >= today) push(pub);
  const opp = last("opposition");
  if (opp && opp.date && addYears(opp.date, 3) >= today && !laterMatches(opp, /OPPOSITION (TERMINATED|DISMISSED|WITHDRAWN)/)) push(opp);
  return actions;
}

const ET_NOTE = " USPTO deadlines close at 11:59 p.m. Eastern (8:59 p.m. Pacific) on the due date.";

// Titles of the maintenance rows, so finished ones can be ticked off.
const SEC8_TITLES = [
  "TM: Section 8 affidavit of continued use — window opens",
  "TM: Section 8 affidavit — window CLOSES",
  "TM: Section 8 affidavit — GRACE PERIOD ENDS (registration cancelled after this)",
];
const YEAR10_TITLES = [
  "TM: Combined § 8 & § 9 renewal — window opens",
  "TM: Combined § 8 & § 9 renewal — window CLOSES",
  "TM: Combined § 8 & § 9 renewal — GRACE PERIOD ENDS (registration expires after this)",
];
function cycleTitles(yr) {
  return [
    `TM: § 8 & § 9 renewal (year ${yr}) — window opens`,
    `TM: § 8 & § 9 renewal (year ${yr}) — window CLOSES`,
    `TM: § 8 & § 9 renewal (year ${yr}) — GRACE PERIOD ENDS (registration expires after this)`,
  ];
}

// Renewal cycle k covers the (10k)th anniversary: window opens at year
// 10k − 1, closes at year 10k, grace ends six months later. k = 1 is in the
// lifecycle rules (matter-manager.js); this builds k >= 2.
function renewalCycle(regDate, k) {
  const yr = 10 * k, close = addYears(regDate, yr), titles = cycleTitles(yr);
  return [
    { title: titles[0], citation: "15 U.S.C. § 1058 + § 1059", due_date: addYears(regDate, yr - 1), party: "us",
      note: `Filing window: between the ${yr - 1}th and ${yr}th anniversary of registration. $650/class combined. Gather a current specimen for each class.` },
    { title: titles[1], citation: "15 U.S.C. § 1058 + § 1059", due_date: close, party: "us",
      note: `Last day to file the regular renewal (${yr}th anniversary). After this date the filing costs an extra $200/class in grace-period fees.` + ET_NOTE },
    { title: titles[2], citation: "15 U.S.C. § 1059(a)", due_date: addMonths(close, 6), party: "us",
      note: `6 months after the ${yr}th anniversary. ABSOLUTE DEADLINE. If the renewal is not on file by this date the registration is CANCELLED/EXPIRED.` + ET_NOTE },
  ];
}

// No renewal on record: the first cycle (k >= 2) whose grace period has not ended.
function nextRenewalCycle(regDate, today) {
  for (let k = 2; k <= 30; k++) if (addMonths(addYears(regDate, 10 * k), 6) >= today) return renewalCycle(regDate, k);
  return [];
}

// A renewal was accepted on `renewedOn`: the cycle that renewal belonged to
// is finished, so the next one is the first whose window opens AFTER it.
function cycleAfterRenewal(regDate, renewedOn) {
  for (let k = 2; k <= 30; k++) if (addYears(regDate, 10 * k - 1) > renewedOn) return { k, templates: renewalCycle(regDate, k) };
  return { k: null, templates: [] };
}

// Turn one action into deadline templates. Office action, publication, NOA
// and registration use the lifecycle rules in matter-manager.js, the same
// rules the buttons use. (One difference: this job treats a 79-series serial
// number as a Madrid application even when the matter's filing basis is blank.)
// Returns { templates, finished } where `finished` lists titles of rows this
// event has made moot, to be ticked off.
function templatesFor(action, matter, lifecycleDeadlines, today) {
  const none = { templates: [], finished: [] };
  if (action.type === "sec8_accepted") return { templates: [], finished: SEC8_TITLES };
  if (action.type === "opposition" || action.type === "cancellation") {
    // TTAB dates are not in TSDR. Leave a task on the matter so the
    // proceeding is not known only from a Telegram message.
    const when = action.date && isRealDate(action.date) ? action.date : today;
    return { finished: [], templates: [{
      title: `TM: TTAB activity (${when}) — open TTABVUE and calendar the dates by hand`,
      citation: "TTAB institution order",
      due_date: addDays(today, 3),
      party: "us",
      note: `TSDR shows "${action.desc}". The daily USPTO check does not read TTAB dates. Open the proceeding in TTABVUE, read the institution order, and enter the answer and other dates on this matter. Mark this complete when that is done.`,
    }] };
  }
  if (!isRealDate(action.date)) return none;
  switch (action.type) {
    case "office_action":  return { templates: lifecycleDeadlines("tm_office_action", action.date, matter) || [], finished: [] };
    case "published":      return { templates: lifecycleDeadlines("tm_publication", action.date, matter) || [], finished: [] };
    case "noa":            return { templates: lifecycleDeadlines("tm_noa", action.date, matter) || [], finished: [] };
    case "registered": {
      let first = lifecycleDeadlines("tm_registration", action.date, matter) || [];
      if (action.sec8Done) first = first.filter(t => !SEC8_TITLES.includes(t.title));
      // An old registration whose year-10 grace period is over needs the NEXT cycle instead.
      const year10Over = addMonths(addYears(action.date, 10), 6) < today;
      return { templates: year10Over ? first.concat(nextRenewalCycle(action.date, today)) : first, finished: [] };
    }
    case "renewed": {
      // action.date is the REGISTRATION date; action.entryDate is when the renewal was accepted.
      const renewedOn = isRealDate(action.entryDate) ? action.entryDate : today;
      const { k, templates } = cycleAfterRenewal(action.date, renewedOn);
      const finished = SEC8_TITLES.concat(YEAR10_TITLES);
      for (let j = 2; k && j < k; j++) finished.push(...cycleTitles(10 * j));
      // The last renewal on record is old enough that the cycle after it has
      // ended too: report those dates as passed and calendar the cycle that
      // is still open.
      const ended = templates.length && templates[2].due_date < today;
      return { templates: ended ? templates.concat(nextRenewalCycle(action.date, today)) : templates, finished };
    }
    case "abandoned":
      if (action.noPetition) return none;
      return { finished: [], templates: [{
        title: `TM: Petition to revive due (abandonment dated ${action.date})`,
        citation: "37 C.F.R. § 2.66(a)",
        due_date: addMonths(action.date, 2),
        party: "us",
        note: "TSDR shows this application as ABANDONED. A petition to revive is due 2 months after the issue date of the notice of abandonment ($250), filed with the missing response or statement of use. If the notice was never received: 2 months from actual knowledge, and no later than 6 months after TSDR shows the abandonment. This date is counted from the TSDR entry; confirm the notice date in TSDR." + ET_NOTE,
      }] };
    case "postreg_action":
      return { finished: [], templates: [{
        title: `TM: Post-registration Office Action (issued ${action.date}) — response due`,
        citation: "37 C.F.R. §§ 2.163(b), 2.184(b)",
        due_date: addMonths(action.date, 6),
        party: "us",
        note: "6 months from the issue date, or the end of the statutory filing period if that is later. No extension is available. If no response is filed the registration is cancelled or expires." + ET_NOTE,
      }] };
    default: return none;
  }
}

// Compare the mark TSDR returns with the mark typed on the matter, so a
// mistyped number cannot quietly track someone else's application.
// Returns true / false, or null when either side is blank (design marks).
function marksAgree(a, b) {
  // Accents are folded (CAFÉ = CAFE); letters and digits of any script are kept.
  const n = s => String(s || "").normalize("NFD").replace(/\p{M}/gu, "").toUpperCase().replace(/[^\p{L}\p{N}]/gu, "");
  const x = n(a), y = n(b);
  if (!x || !y) return null;
  if (x === y) return true;
  const [shorter, longer] = x.length <= y.length ? [x, y] : [y, x];
  return shorter.length >= 3 && longer.includes(shorter);
}

// ── Schema ───────────────────────────────────────────────

let _initDone = false;
async function init() {
  if (_initDone) return;
  await db.query(`
    CREATE TABLE IF NOT EXISTS tm_tsdr_status (
      matter_id           INTEGER PRIMARY KEY REFERENCES matters(id) ON DELETE CASCADE,
      serial_number       VARCHAR(40),
      status_desc         TEXT,
      status_date         VARCHAR(10),
      filing_date         VARCHAR(10),
      publication_date    VARCHAR(10),
      registration_number VARCHAR(20),
      registration_date   VARCHAR(10),
      mark_text           TEXT,
      seen_events         JSONB NOT NULL DEFAULT '[]'::jsonb,
      source_format       VARCHAR(10),
      last_checked_at     TIMESTAMPTZ,
      last_ok_at          TIMESTAMPTZ,
      last_error          TEXT,
      last_error_code     VARCHAR(20),
      consecutive_errors  INTEGER NOT NULL DEFAULT 0,
      created_at          TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  for (const [col, type] of [["pending_alert", "TEXT"], ["first_error_at", "TIMESTAMPTZ"], ["last_alerted_at", "TIMESTAMPTZ"], ["last_alerted_code", "VARCHAR(20)"]]) {
    await db.query(`ALTER TABLE tm_tsdr_status ADD COLUMN IF NOT EXISTS ${col} ${type}`);
  }
  _initDone = true;
}

// ── Writing deadlines ────────────────────────────────────

async function applyTemplates(matter, templates, action, today, { skipPastDue }) {
  const out = { added: [], proposed: [], skipped: [], passed: [], mismatches: [] };
  if (!templates.length) return out;

  const existing = await db.query(
    `SELECT LOWER(title) AS lt, to_char(due_date, 'YYYY-MM-DD') AS d, completed FROM matter_deadlines WHERE matter_id = $1`,
    [matter.id]
  );
  const have = new Map(existing.rows.map(r => [r.lt, r]));
  const stamp = `\n[From the daily TSDR check on ${today}: "${action.desc}" dated ${action.date}. Confirm against the document in TSDR.]`;

  const write = async (t) => {
    const note = (t.note || "") + stamp;
    if (autoAdd()) {
      await db.query(
        `INSERT INTO matter_deadlines (matter_id, title, citation, due_date, party, note) VALUES ($1, $2, $3, $4, $5, $6)`,
        [matter.id, t.title.substring(0, 300), t.citation ? t.citation.substring(0, 200) : null, t.due_date, t.party, note]
      );
      have.set(t.title.toLowerCase(), { lt: t.title.toLowerCase(), d: t.due_date, completed: false });
      out.added.push({ title: t.title, due_date: t.due_date, party: t.party });
    } else {
      const ref = "tsdr:" + matter.cid.id + ":" + crypto.createHash("sha1").update(t.title + "|" + t.due_date).digest("hex").slice(0, 16);
      const dup = await db.query(`SELECT 1 FROM matter_proposals WHERE source_ref = $1 AND matter_id = $2 LIMIT 1`, [ref, matter.id]);
      if (dup.rows.length) { out.skipped.push({ title: t.title, reason: "already proposed" }); return; }
      await db.query(
        `INSERT INTO matter_proposals (user_id, matter_id, kind, source, source_ref, proposed_data, raw_excerpt, status, confidence)
         VALUES ($1, $2, 'deadline', 'api', $3, $4, $5, 'pending', 'high')`,
        [matter.user_id, matter.id, ref,
         JSON.stringify({ title: t.title, citation: t.citation, due_date: t.due_date, party: t.party,
                          source_excerpt: note.substring(0, 1000), matter_ref: matter.matter_ref || matter.cid.num }),
         `TSDR ${matter.cid.label}: ${action.desc} (${action.date})`]
      );
      out.proposed.push({ title: t.title, due_date: t.due_date, party: t.party });
    }
  };

  for (const t of templates) {
    if (skipPastDue && t.due_date < today) { out.passed.push({ title: t.title, due_date: t.due_date }); continue; }
    const ex = have.get(t.title.toLowerCase());
    if (!ex) { await write(t); continue; }
    if (ex.d === t.due_date || ex.completed) { out.skipped.push({ title: t.title, reason: "already on the matter" }); continue; }
    // Same deadline is on the matter with a DIFFERENT date (for example the
    // button was clicked with a mistyped date). Never overwrite what a person
    // entered; say so, and if TSDR's date is the EARLIER one, add it as well
    // so the earlier date is the one that sends reminders.
    out.mismatches.push({ title: t.title, on_matter: ex.d, per_tsdr: t.due_date });
    if (t.due_date < ex.d) {
      const alt = { ...t, title: `${t.title} — per TSDR (${action.date})`.substring(0, 300) };
      if (!have.has(alt.title.toLowerCase())) await write(alt);
    }
  }
  if (out.added.length) {
    try {
      await db.logAudit("tsdr-sync", "auto_add_deadlines", `matter:${matter.id}`, null,
        out.added.map(a => `${a.due_date} ${a.title}`).join(" | "));
    } catch (_) {}
  }
  return out;
}

// The check has just been done by this job, so the reminders that Filing
// Watch and Published created for doing it by hand are ticked off: the ones
// due within the next 35 days, and all of them once the mark is registered.
// Only titles those buttons generate are touched, never a hand-written one.
const CHECK_STATUS_RE = "^TM: Check TSDR status — month (3|6|9|12) after filing$";
const CHECK_STAGE_RE  = "^TM: Check TSDR — (registration expected|Notice of Allowance expected|NOA or registration expected) \\(published [0-9]{4}-[0-9]{2}-[0-9]{2}\\)$";

async function completeCheckReminders(matterId, today, statusDesc, { registered, noaOrRegistered }) {
  const stamp = `\n[Checked automatically via TSDR on ${today}: ${statusDesc || "status read"}]`;
  const clauses = [`(title ~ $4 AND due_date <= ($2::date + 35))`];
  if (noaOrRegistered) clauses.push(`(title ~ $5)`);
  if (registered) clauses.push(`(title ~ $4)`);
  const r = await db.query(
    `UPDATE matter_deadlines
        SET completed = TRUE, note = COALESCE(note, '') || $3, updated_at = NOW()
      WHERE matter_id = $1 AND completed = FALSE AND (${clauses.join(" OR ")})`,
    noaOrRegistered ? [matterId, today, stamp, CHECK_STATUS_RE, CHECK_STAGE_RE] : [matterId, today, stamp, CHECK_STATUS_RE]
  );
  return r.rowCount || 0;
}

// ── One matter ───────────────────────────────────────────

function displayName(matter, cid) {
  return `${matter.mark || matter.client_name || "Trademark matter"} (${cid.label})`;
}

function getLifecycle() {
  // Lazy: matter-manager.js also requires this file for its endpoints.
  const mm = require("./matter-manager");
  if (typeof mm.lifecycleDeadlines !== "function") throw new Error("matter-manager.js does not export lifecycleDeadlines; deploy the updated matter-manager.js with this file");
  return mm.lifecycleDeadlines;
}

async function syncMatter(matter) {
  const today = todayPT();
  const cid = caseId(matter.serial_number);
  if (!cid) throw new TsdrError("BAD_NUMBER", `"${String(matter.serial_number).substring(0, 40)}" is not an 8-digit serial number or a 7-digit registration number`);

  const prev = (await db.query(`SELECT * FROM tm_tsdr_status WHERE matter_id = $1`, [matter.id])).rows[0] || null;
  const baseline = !prev || !prev.last_ok_at || prev.serial_number !== cid.id;

  const rec = await fetchRecord(cid);   // throws TsdrError

  if (marksAgree(rec.mark, matter.mark) === false) {
    throw new TsdrError("MARK_MISMATCH", `TSDR shows ${cid.label} as the mark "${rec.mark}", but this matter's mark is "${matter.mark}". Nothing was added. Correct the number or the mark on the matter.`);
  }

  // Serial numbers beginning 79 are Madrid Protocol (Section 66(a)) applications.
  const basis = matter.filing_basis || (cid.kind === "sn" && cid.num.startsWith("79") ? "66(a)" : null);
  const m = { ...matter, cid, filing_basis: basis };

  const seenKeys = new Set(baseline ? [] : (Array.isArray(prev.seen_events) ? prev.seen_events : []));
  const newEvents = baseline ? [] : rec.events.filter(e => !seenKeys.has(eventKey(e)));
  const statusChanged = !baseline &&
    ((prev.status_desc || "") !== (rec.statusDesc || "") || (prev.status_date || "") !== (rec.statusDate || ""));

  const kinds = rec.events.map(e => classifyEvent(e.desc).type);
  const hasRegistered = kinds.some(k => ["registered", "renewed", "sec8_accepted"].includes(k)) || !!(rec.regDate && rec.regNumber);

  const actions = planActions(rec, { baseline, seenKeys, today });
  // The registration has ended (a "CANCELLED…" or "EXPIRED…" history entry):
  // no maintenance dates. A cancellation PROCEEDING does not count.
  const dead = actions.some(a => a.type === "dead");
  const lifecycleDeadlines = getLifecycle();

  const added = [], proposed = [], skipped = [], passed = [], mismatches = [], unreadableDates = [];
  let finishedRows = 0;
  for (const a of actions) {
    const needsDate = ["office_action", "published", "noa", "registered", "renewed", "abandoned", "postreg_action"].includes(a.type);
    if (needsDate && !isRealDate(a.date)) { unreadableDates.push(a); continue; }
    if (dead && ["registered", "renewed", "sec8_accepted"].includes(a.type)) continue;
    const { templates, finished } = templatesFor(a, m, lifecycleDeadlines, today);
    if (finished.length) finishedRows += await completeFinished(matter.id, finished, today, a.desc);
    if (!templates.length) continue;
    const r = await applyTemplates(m, templates, a, today, { skipPastDue: baseline });
    added.push(...r.added); proposed.push(...r.proposed); skipped.push(...r.skipped); passed.push(...r.passed); mismatches.push(...r.mismatches);
  }

  const types = new Set(actions.map(a => a.type));
  const completedChecks = await completeCheckReminders(matter.id, today, rec.statusDesc, {
    registered: hasRegistered,
    noaOrRegistered: hasRegistered || types.has("noa"),
  });

  const result = {
    ok: true, matterId: matter.id, cid, name: displayName(matter, cid), baseline, statusChanged, dead,
    statusDesc: rec.statusDesc, statusDate: rec.statusDate, prevStatusDesc: prev ? prev.status_desc : null,
    tsdrMark: rec.mark, markCompared: marksAgree(rec.mark, matter.mark) === true, matterMark: matter.mark || null,
    regNumber: hasRegistered ? rec.regNumber : null, regDate: hasRegistered ? rec.regDate : null,
    madrid: basis === "66(a)", newEvents, actions, added, proposed, skipped, passed, mismatches, unreadableDates,
    completedChecks, finishedRows, format: rec.format, eventCount: rec.events.length,
    lastEntries: rec.events.slice(-5),
  };
  result.alertText = alertFor(result);

  // The alert is saved WITH the new state, as one more item in a list. If
  // Telegram is down it stays there and goes out on the next run.
  const pending = readPending(prev && prev.pending_alert);
  if (result.alertText) pending.push(result.alertText);
  await db.query(
    `INSERT INTO tm_tsdr_status
       (matter_id, serial_number, status_desc, status_date, filing_date, publication_date,
        registration_number, registration_date, mark_text, seen_events, source_format,
        last_checked_at, last_ok_at, last_error, last_error_code, consecutive_errors,
        first_error_at, last_alerted_at, last_alerted_code, pending_alert)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11, NOW(), NOW(), NULL, NULL, 0, NULL, NULL, NULL, $12)
     ON CONFLICT (matter_id) DO UPDATE SET
       serial_number = EXCLUDED.serial_number, status_desc = EXCLUDED.status_desc,
       status_date = EXCLUDED.status_date, filing_date = EXCLUDED.filing_date,
       publication_date = EXCLUDED.publication_date, registration_number = EXCLUDED.registration_number,
       registration_date = EXCLUDED.registration_date, mark_text = EXCLUDED.mark_text,
       seen_events = EXCLUDED.seen_events, source_format = EXCLUDED.source_format,
       last_checked_at = NOW(), last_ok_at = NOW(), last_error = NULL, last_error_code = NULL,
       consecutive_errors = 0, first_error_at = NULL, last_alerted_at = NULL, last_alerted_code = NULL,
       pending_alert = EXCLUDED.pending_alert`,
    [matter.id, cid.id, rec.statusDesc, rec.statusDate, rec.filingDate, rec.pubDate,
     result.regNumber ? String(result.regNumber).substring(0, 20) : null, result.regDate, rec.mark,
     JSON.stringify(rec.events.map(eventKey)), rec.format, pending.length ? JSON.stringify(pending) : null]
  );
  return result;
}

// pending_alert holds a JSON list of messages not yet delivered.
function readPending(raw) {
  if (!raw) return [];
  try { const v = JSON.parse(raw); if (Array.isArray(v)) return v.filter(x => typeof x === "string" && x); } catch (_) {}
  return [String(raw)];
}

// Tick off rows that a USPTO acceptance has made moot (exact generated titles only).
async function completeFinished(matterId, titles, today, why) {
  const r = await db.query(
    `UPDATE matter_deadlines
        SET completed = TRUE, note = COALESCE(note, '') || $3, updated_at = NOW()
      WHERE matter_id = $1 AND completed = FALSE AND title = ANY($2::text[])`,
    [matterId, titles, `\n[Marked done automatically on ${today}: TSDR shows "${why}".]`]
  );
  return r.rowCount || 0;
}

async function recordFailure(matter, err) {
  const cid = caseId(matter.serial_number);
  const ident = cid ? cid.id : String(matter.serial_number || "").substring(0, 40);
  const code = err instanceof TsdrError ? err.code : "ERROR";
  const r = await db.query(
    `INSERT INTO tm_tsdr_status (matter_id, serial_number, last_checked_at, last_error, last_error_code, consecutive_errors, first_error_at)
     VALUES ($1, $2, NOW(), $3, $4, 1, NOW())
     ON CONFLICT (matter_id) DO UPDATE SET
       last_checked_at = NOW(), last_error = EXCLUDED.last_error, last_error_code = EXCLUDED.last_error_code,
       consecutive_errors = tm_tsdr_status.consecutive_errors + 1,
       first_error_at = COALESCE(tm_tsdr_status.first_error_at, NOW())
     RETURNING consecutive_errors, first_error_at, last_alerted_at, last_alerted_code, last_ok_at, serial_number`,
    [matter.id, ident, String(err.message || err).substring(0, 1000), code]
  );
  const row = r.rows[0];
  return { code, count: row.consecutive_errors, firstErrorAt: row.first_error_at, lastAlertedAt: row.last_alerted_at,
           lastAlertedCode: row.last_alerted_code, hadSuccess: !!row.last_ok_at && row.serial_number === ident,
           isRegNumber: !!cid && cid.kind === "rn" };
}

// When is a failing matter reported?
//   the same run   rejected key, rate limit, wrong number, mark mismatch, a
//                  registration number that is not found, and any failure on
//                  a matter that was reading fine before
//   after 20 h     network / format trouble on a matter never read before
//   after 10 d     "not found" on a SERIAL number never read before (new
//                  filings take days to appear)
// and then again about every 2 days (key / rate limit) or 7 days while it
// lasts. A failure of a DIFFERENT kind from the one last reported is new
// news. Time-based, so extra manual runs do not change when an alert goes out.
function shouldAlertFailure(f, now = Date.now()) {
  const sameAsLast = !f.lastAlertedCode || f.lastAlertedCode === f.code;
  const sinceAlert = f.lastAlertedAt && sameAsLast ? now - new Date(f.lastAlertedAt).getTime() : Infinity;
  const slack = 2 * 3600000;   // the daily run does not start at the same second each day
  const repeatEvery = (["KEY_REJECTED", "RATE_LIMITED"].includes(f.code) ? 2 : 7) * 86400000 - slack;
  if (sinceAlert < repeatEvery) return false;
  const age = f.firstErrorAt ? now - new Date(f.firstErrorAt).getTime() : 0;
  if (["KEY_REJECTED", "RATE_LIMITED", "BAD_NUMBER", "MARK_MISMATCH"].includes(f.code)) return true;
  if (f.hadSuccess) return true;
  if (f.code === "NOT_FOUND") return f.isRegNumber || age >= 10 * 86400000 - slack;
  return age >= 20 * 3600000;
}

// ── Alert text ───────────────────────────────────────────

function fmtDeadlines(list) { return list.map(d => `• ${d.due_date} — ${d.title}`).join("\n"); }

function alertFor(r) {
  const hasNews = r.baseline || r.statusChanged || r.newEvents.length > 0 || r.added.length > 0 || r.proposed.length > 0 || r.mismatches.length > 0;
  if (!hasNews) return null;
  const urgent = r.actions.some(a => ["office_action", "abandoned", "opposition", "cancellation", "postreg_action", "dead"].includes(a.type)) || r.mismatches.length > 0;

  const lines = [];
  lines.push(`${urgent ? "⚠️" : "™️"} USPTO ${r.baseline ? "tracking started" : "update"} — ${r.name}`);
  if (r.baseline) {
    lines.push(`TSDR mark: ${r.tsdrMark || "(no wording — design mark)"}${r.regNumber ? ` · Reg. No. ${r.regNumber}` : ""}`);
    if (!r.markCompared) lines.push(r.matterMark ? "The mark on the matter could not be compared with TSDR. Confirm this is the right record." : "No mark is typed on the matter, so it was not compared with TSDR. Confirm this is the right record.");
  }
  lines.push(`Status: ${r.statusDesc || "(not stated)"}${r.statusDate ? ` (as of ${r.statusDate})` : ""}`);
  if (r.statusChanged && r.prevStatusDesc && r.prevStatusDesc !== r.statusDesc) lines.push(`Was: ${r.prevStatusDesc}`);

  if (r.baseline && r.lastEntries && r.lastEntries.length) {
    lines.push("", "Latest entries in TSDR:");
    for (const e of r.lastEntries) lines.push(`• ${e.date || "no date"} ${e.desc}`);
  }
  if (r.newEvents.length) {
    lines.push("", "New in TSDR:");
    for (const e of r.newEvents.slice(-12)) lines.push(`• ${e.date || "no date"} ${e.desc}`);
  }
  for (const a of r.actions) {
    if (a.type === "office_action") lines.push("", `${a.what || "Office action"} issued ${a.date}. A response is required${r.madrid ? " (Madrid application: 6 months, no extension)" : ""}.${a.final ? " A request for reconsideration does not extend the time to appeal." : ""}`);
    if (a.type === "postreg_action") lines.push("", `Post-registration office action issued ${a.date}. Response due in 6 months, no extension.`);
    if (a.type === "abandoned") lines.push("", `ABANDONED (${a.date}). ${a.noPetition ? "No petition-to-revive date was added for this kind of abandonment; read the record." : "A petition to revive is due 2 months after the notice of abandonment."}`);
    if (a.type === "opposition") lines.push("", `Opposition activity (${a.date || "no date"}): ${a.desc}. TTAB dates are NOT read by this check. A task to open TTABVUE and calendar them was put on the matter.`);
    if (a.type === "cancellation") lines.push("", `Cancellation proceeding (${a.date || "no date"}): ${a.desc}. TTAB dates are NOT read by this check. A task to open TTABVUE and calendar them was put on the matter.`);
    if (a.type === "dead") lines.push("", `TSDR history shows the registration has ended (${a.date || "no date"}: ${a.desc}). No maintenance deadlines were added. Read the record.`);
    if (a.type === "suspension") lines.push("", `Suspension notice (${a.date}). No response deadline was added; read the letter for any requirement.`);
    if (a.type === "published") lines.push("", `Published for opposition ${a.date}.`);
    if (a.type === "noa") lines.push("", `Notice of allowance issued ${a.date}. The statement of use and extension dates are counted from that date.`);
    if (a.type === "registered") lines.push("", `REGISTERED ${a.date}.`);
    if (a.type === "renewed") lines.push("", `Renewal accepted${a.entryDate ? ` (${a.entryDate})` : ""}.${r.finishedRows ? ` ${r.finishedRows} deadline(s) of the finished cycle were marked done.` : ""}`);
    if (a.type === "sec8_accepted") lines.push("", `Section 8 declaration accepted${a.entryDate ? ` (${a.entryDate})` : ""}.${r.finishedRows ? ` ${r.finishedRows} Section 8 deadline(s) were marked done.` : ""}`);
  }
  if (r.added.length) lines.push("", "Added to the matter:", fmtDeadlines(r.added));
  if (r.proposed.length) lines.push("", "Waiting in the proposal inbox for approval:", fmtDeadlines(r.proposed));
  if (r.mismatches.length) {
    lines.push("", "⚠️ Date on the matter differs from the date counted from TSDR:");
    for (const x of r.mismatches) lines.push(`• ${x.title}: matter has ${x.on_matter}, TSDR gives ${x.per_tsdr}`);
    lines.push("The date on the matter was left alone. Where TSDR's date is earlier it was added as a second deadline. Check which is right.");
  }
  if (r.passed.length) lines.push("", "Already passed, so NOT added (check that each was dealt with):", fmtDeadlines(r.passed));
  if (r.unreadableDates.length) {
    lines.push("", "⚠️ No deadline could be added because a date was missing from the record. Enter by hand:");
    for (const a of r.unreadableDates) lines.push(`• ${a.desc}`);
  }
  const acted = r.added.length || r.proposed.length || r.finishedRows || r.mismatches.length || r.passed.length;
  if (!r.baseline && r.newEvents.length && !acted) lines.push("", "No deadline was added for these entries. Read them in TSDR.");
  if (r.baseline && !acted) lines.push("", "No running deadline was found in this record. Read the latest entries above to confirm.");
  lines.push("", `TSDR: ${tsdrLink(r.cid)}`, `Matter: ${ADMIN_URL}`);
  return lines.join("\n").substring(0, 3900);
}

// ── Running ──────────────────────────────────────────────

let _notify = null;
let _running = false;

// Returns true only if the message was handed to Telegram without error.
async function deliver(text, notify) {
  const fn = notify === undefined ? _notify : notify;
  if (!fn || !text) return false;
  try { await fn(String(text).substring(0, 3900)); return true; }
  catch (e) { console.error("[tsdr] notify failed:", e.message); return false; }
}

// Telegram refuses a message over 4,096 characters. Split a long text into
// parts of at most `limit`, cutting between lines and never inside one
// (a single line longer than the limit is shortened). Pure.
function splitMessage(text, limit = 3900) {
  const parts = [];
  let cur = "";
  for (const line of String(text == null ? "" : text).split("\n")) {
    const l = line.length > limit ? line.slice(0, limit - 1) + "…" : line;
    if (cur !== "" && (cur.length + 1 + l.length) > limit) { parts.push(cur); cur = l; }
    else cur = cur === "" ? l : cur + "\n" + l;
  }
  if (cur.trim() !== "") parts.push(cur);
  return parts;
}

// Send a list of lines as one or more messages. True only if every part was delivered.
async function deliverLines(lines, notify) {
  const parts = splitMessage(lines.join("\n"));
  for (const part of parts) if (!(await deliver(part, notify))) return false;
  return parts.length > 0;
}

// Alerts saved on an earlier run that never reached Telegram. Each is sent
// as its own message; only the ones actually delivered are removed.
async function flushPending(notify, onlyMatterId) {
  const r = await db.query(
    `SELECT matter_id, pending_alert FROM tm_tsdr_status WHERE pending_alert IS NOT NULL${onlyMatterId ? " AND matter_id = $1" : ""} ORDER BY matter_id`,
    onlyMatterId ? [onlyMatterId] : []
  );
  let sent = 0;
  for (const row of r.rows) {
    const list = readPending(row.pending_alert);
    let i = 0;
    for (; i < list.length; i++) { if (!(await deliver(list[i], notify))) break; sent++; }
    if (i === 0) continue;
    const rest = list.slice(i);
    await db.query(`UPDATE tm_tsdr_status SET pending_alert = $2 WHERE matter_id = $1`, [row.matter_id, rest.length ? JSON.stringify(rest) : null]);
  }
  return sent;
}

async function listTrackable() {
  const r = await db.query(
    `SELECT id, user_id, client_name, matter_ref, serial_number, mark, filing_basis
       FROM matters
      WHERE case_type = 'Trademark' AND status = 'active'
        AND serial_number IS NOT NULL AND TRIM(serial_number) <> ''
      ORDER BY id ASC`
  );
  return r.rows;
}

async function listWithoutNumber() {
  const r = await db.query(
    `SELECT id, client_name, mark FROM matters
      WHERE case_type = 'Trademark' AND status = 'active'
        AND (serial_number IS NULL OR TRIM(serial_number) = '')
      ORDER BY id ASC`
  );
  return r.rows;
}

// options: { notify?: fn|null, scheduled?: bool, matterId?: number }
//   notify omitted → the Telegram sender given to startScheduler
//   notify null    → nothing is sent now; alerts stay saved and go out on the next run
async function runAll(options = {}) {
  const notify = options.notify;
  const stats = { checked: 0, ok: 0, changed: 0, errors: 0, deadlinesAdded: 0, alertsSent: 0, skippedNoKey: false, results: [], failures: [] };
  if (_running) { stats.busy = true; return stats; }
  _running = true;
  try {
    await init();
    let matters = await listTrackable();
    if (options.matterId) matters = matters.filter(m => m.id === options.matterId);

    if (!apiKey()) {
      stats.skippedNoKey = true;
      if (options.scheduled && weekdayPT() === "Mon") {
        const all = matters.length + (await listWithoutNumber()).length;
        if (all) await deliver(`⚠️ The daily USPTO status check is OFF: USPTO_API_KEY is not set on the server. ${all} active trademark matter(s) are not being checked. Get a free key at https://account.uspto.gov/api-manager/ and add it in Render.`, notify);
      }
      return stats;
    }

    stats.alertsSent += await flushPending(notify, options.matterId);

    for (let i = 0; i < matters.length; i++) {
      const matter = matters[i];
      stats.checked++;
      try {
        const result = await syncMatter(matter);
        stats.ok++;
        stats.deadlinesAdded += result.added.length;
        if (result.baseline || result.statusChanged || result.newEvents.length) stats.changed++;
        stats.results.push(result);
        if (result.alertText) stats.alertsSent += await flushPending(notify, matter.id);
      } catch (err) {
        stats.errors++;
        let fail = { code: err instanceof TsdrError ? err.code : "ERROR", count: 0, firstErrorAt: null, lastAlertedAt: null, lastAlertedCode: null, hadSuccess: false };
        try { fail = await recordFailure(matter, err); } catch (e2) { console.error("[tsdr] could not record failure:", e2.message); }
        const label = `${matter.mark || matter.client_name || "matter " + matter.id} (${String(matter.serial_number).substring(0, 20)})`;
        stats.failures.push({ matterId: matter.id, label, message: err.message, ...fail });
        console.error(`[tsdr] ${label}: ${err.message}`);
        // A rejected key or a rate limit applies to every matter: stop the run.
        if (fail.code === "KEY_REJECTED" || fail.code === "RATE_LIMITED") {
          stats.stoppedEarly = fail.code;
          stats.notChecked = matters.length - (i + 1);
          break;
        }
      }
    }

    const toReport = stats.failures.filter(f => shouldAlertFailure(f));
    if (toReport.length) {
      const lines = ["⚠️ The USPTO status check is failing:"];
      for (const f of toReport) lines.push(`• ${f.label}: ${f.message}${f.count > 1 ? ` (${f.count} checks in a row)` : ""}`);
      if (stats.stoppedEarly) lines.push(`The run stopped early; ${stats.notChecked} other matter(s) were not checked.`);
      lines.push("Until this is fixed, check these in TSDR by hand.");
      if (await deliverLines(lines, notify)) {
        stats.alertsSent++;
        await db.query(`UPDATE tm_tsdr_status SET last_alerted_at = NOW(), last_alerted_code = last_error_code WHERE matter_id = ANY($1::int[])`, [toReport.map(f => f.matterId)]);
      }
    }

    // Monday summary: proof the job is alive, and the list of what it is NOT checking.
    if (options.scheduled && !options.matterId && weekdayPT() === "Mon") {
      const noNumber = await listWithoutNumber();
      if (matters.length || noNumber.length) {
        const lines = [`™️ Weekly USPTO check: ${stats.ok} of ${matters.length} trademark matter(s) read from TSDR today${stats.errors ? `, ${stats.errors} failed` : ""}${stats.stoppedEarly ? `, ${stats.notChecked} not attempted because the run stopped early` : ""}.`];
        for (const f of stats.failures) lines.push(`• Failed: ${f.label} — ${f.message}`);
        if (noNumber.length) lines.push(`Not checked (no serial or registration number on the matter): ${noNumber.map(x => x.mark || x.client_name || "matter " + x.id).join("; ")}`);
        await deliverLines(lines, notify);
      }
    }

    console.log(`[tsdr] checked ${stats.checked}, ok ${stats.ok}, changed ${stats.changed}, errors ${stats.errors}, deadlines added ${stats.deadlinesAdded}, alerts sent ${stats.alertsSent}`);
    return stats;
  } finally {
    _running = false;
  }
}

async function scheduledRun() {
  try {
    let stats = await runAll({ scheduled: true });
    if (stats.busy) {   // a manual check was running; try once more in 10 minutes
      await new Promise(r => setTimeout(r, 10 * 60 * 1000));
      stats = await runAll({ scheduled: true });
      if (stats.busy) await deliver("⚠️ Today's scheduled USPTO status check did not run: another check was still in progress after 10 minutes. Send /tsdr check to run it.");
    }
  } catch (e) {
    console.error("[tsdr-cron] failed:", e.message);
    await deliver(`⚠️ The daily USPTO status check stopped with an error and did not finish: ${e.message}`);
  }
}

function startScheduler({ notify } = {}) {
  _notify = notify || null;
  const cron = require("node-cron");
  // 6:40 AM Pacific, before the 7:00 AM deadline summary.
  cron.schedule("40 6 * * *", scheduledRun, { timezone: "America/Los_Angeles" });

  // Catch-up: if the server was restarting at 6:40 (a deploy, a crash) the
  // day's check would be skipped. Five minutes after start, run it if no
  // matter has been checked in the last 26 hours.
  const t = setTimeout(async () => {
    try {
      if (!apiKey()) return;
      await init();
      const r = await db.query(
        `SELECT COUNT(*)::int AS trackable,
                MAX(s.last_checked_at) AS last_checked
           FROM matters m LEFT JOIN tm_tsdr_status s ON s.matter_id = m.id
          WHERE m.case_type = 'Trademark' AND m.status = 'active'
            AND m.serial_number IS NOT NULL AND TRIM(m.serial_number) <> ''`
      );
      const row = r.rows[0];
      const stale = !row.last_checked || (Date.now() - new Date(row.last_checked).getTime()) > 26 * 3600000;
      if (row.trackable > 0 && stale) { console.log("[tsdr] no check in the last 26 hours — running a catch-up check"); await scheduledRun(); }
    } catch (e) { console.error("[tsdr] catch-up check failed:", e.message); }
  }, Number(process.env.TSDR_CATCHUP_DELAY_MS || 5 * 60 * 1000));
  if (t.unref) t.unref();

  console.log(`™️  TSDR status check scheduled (daily 6:40 AM PT). API key ${apiKey() ? "present" : "MISSING — checks are off"}; deadlines are ${autoAdd() ? "added automatically" : "sent to the proposal inbox"}.`);
}

// ── Read-only helpers for the page and the commands ──────

async function getStatusForMatter(matterId) {
  await init();
  const r = await db.query(`SELECT * FROM tm_tsdr_status WHERE matter_id = $1`, [matterId]);
  return { enabled: !!apiKey(), auto_add: autoAdd(), status: r.rows[0] || null };
}

async function listStatus() {
  await init();
  const r = await db.query(
    `SELECT m.id, m.client_name, m.mark, m.serial_number,
            s.status_desc, s.status_date, s.registration_number, s.last_ok_at, s.last_error, s.consecutive_errors
       FROM matters m
       LEFT JOIN tm_tsdr_status s ON s.matter_id = m.id
      WHERE m.case_type = 'Trademark' AND m.status = 'active'
      ORDER BY m.id ASC`
  );
  return r.rows;
}

// Fetch and interpret one number WITHOUT writing anything. Used to confirm
// the key works and the record is being read correctly.
async function testSerial(raw) {
  const rec = await fetchRecord(raw);
  const today = todayPT();
  const actions = planActions(rec, { baseline: true, seenKeys: new Set(), today });
  const basis = rec.cid.kind === "sn" && rec.cid.num.startsWith("79") ? "66(a)" : null;
  let wouldAdd = [];
  try {
    const lifecycleDeadlines = getLifecycle();
    for (const a of actions) wouldAdd.push(...templatesFor(a, { filing_basis: basis }, lifecycleDeadlines, today).templates.filter(t => t.due_date >= today));
  } catch (e) { wouldAdd = [{ title: "(deadline rules not loaded: " + e.message + ")", due_date: "" }]; }
  const registered = rec.events.some(e => ["registered", "renewed", "sec8_accepted"].includes(classifyEvent(e.desc).type)) || !!(rec.regDate && rec.regNumber);
  return {
    cid: rec.cid, format: rec.format, mark: rec.mark,
    statusDesc: rec.statusDesc, statusDate: rec.statusDate, filingDate: rec.filingDate,
    pubDate: rec.pubDate, regNumber: registered ? rec.regNumber : null, regDate: registered ? rec.regDate : null,
    eventCount: rec.events.length,
    lastEvents: rec.events.slice(-10).map(e => ({ ...e, type: classifyEvent(e.desc).type })),
    liveActions: actions,
    wouldAdd: wouldAdd.map(t => ({ due_date: t.due_date, title: t.title })),
  };
}

function formatTest(t) {
  const lines = [
    `™️ TSDR test — ${t.cid.label} (read as ${t.format})`,
    `Mark: ${t.mark || "(no wording — design mark)"}`,
    `Status: ${t.statusDesc || "(not stated)"}${t.statusDate ? ` (as of ${t.statusDate})` : ""}`,
    `Filed: ${t.filingDate || "—"}  Published: ${t.pubDate || "—"}  Registered: ${t.regDate || "—"}${t.regNumber ? ` (Reg. No. ${t.regNumber})` : ""}`,
    "", `History: ${t.eventCount} entries. Latest:`,
    ...t.lastEvents.map(e => `• ${e.date || "no date"} ${e.desc}${e.type !== "other" ? `  [${e.type}]` : ""}`),
  ];
  if (t.wouldAdd.length) lines.push("", "Deadlines this would add on a new matter:", ...t.wouldAdd.map(d => `• ${d.due_date} — ${d.title}`));
  else lines.push("", "No live deadlines from this record.");
  lines.push("", "Nothing was saved. Compare with " + tsdrLink(t.cid));
  return lines.join("\n").substring(0, 3900);
}

module.exports = {
  init, startScheduler, runAll, syncMatter, testSerial, formatTest,
  getStatusForMatter, listStatus, alertFor, caseId, splitMessage,
  // exported for tests
  _internal: { parseBody, parseJsonRecord, parseXmlRecord, classifyEvent, planActions, templatesFor, nextRenewalCycle, cycleAfterRenewal, readPending,
               normDate, addMonths, addYears, addDays, eventKey, shouldAlertFailure, fetchRecord, marksAgree, flushPending },
};

// CLI:  node tsdr-sync.js --test 97123456
if (require.main === module) {
  (async () => {
    const args = process.argv.slice(2);
    const i = args.indexOf("--test");
    if (i >= 0 && args[i + 1]) {
      console.log(formatTest(await testSerial(args[i + 1])));
      process.exit(0);
    }
    if (args.includes("--run")) {
      const stats = await runAll({ notify: async text => console.log("\n--- alert ---\n" + text) });
      console.log(JSON.stringify({ ...stats, results: undefined }, null, 2));
      process.exit(0);
    }
    console.log("Usage: node tsdr-sync.js --test <8-digit serial or 7-digit registration number> | --run");
    process.exit(0);
  })().catch(e => { console.error(e.message); process.exit(1); });
}
