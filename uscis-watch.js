// ============================================================
//  uscis-watch.js — the daily look for a form or fee change
//  ─────────────────────────────────────────────────────────
//  "there should be daily search on immigration already scheduled. If
//   there is any indication of update to forms or fees. Update it asap
//   instead of waiting for weekly tracker." (JJ, 2026-10-08)
//
//  WHERE THE SIGNAL COMES FROM
//  USCIS has no forms API and no edition-date endpoint. But a form cannot
//  change without appearing in the Federal Register first: a revised form
//  needs OMB clearance under the Paperwork Reduction Act, which publishes
//  as an "Agency Information Collection Activities" notice, and a fee
//  change publishes as a Rule. Both carry the form number in the title.
//
//  The Federal Register API is free, needs no key, and is the government's
//  own record. It is a better signal than scraping the USCIS newsroom,
//  which is prose and reorganises.
//
//  The correlation is visible in the data: USCIS published information
//  collection notices on 2026-09-18, and the I-485 edition in hand is
//  dated 09/18/26.
//
//  WHAT IT DOES WITH A SIGNAL
//  Runs the full edition check straight away (uscis-forms.js) instead of
//  waiting for the weekly one, and reports what moved. A signal is a
//  reason to LOOK, never a reason to conclude: the Federal Register says
//  USCIS intends to revise a form, and the edition date on the PDF says
//  whether it has. Only the PDF is evidence.
//
//  QUIET WHEN THERE IS NOTHING
//  Most days there is nothing. A watcher that reports every day stops
//  being read, so this sends only on a hit, and the weekly run is what
//  confirms the silence was real.
// ============================================================

const https = require("https");

const FORMS = () => require("./uscis-forms");

const FR_BASE = "https://www.federalregister.gov/api/v1/documents.json";

// What makes a notice worth acting on. A form revision reaches the
// Register as an information-collection notice; a fee change as a rule.
const ABOUT_FORMS = /\b(form\s+[A-Z]{1,4}-\d+|information collection|revision of a currently approved|new collection)\b/i;
const ABOUT_FEES  = /\b(fee schedule|filing fee|fee review|adjustment of fees?|biometric services fee)\b/i;

// A notice that only extends an existing collection "without change" is
// explicitly not a revision. Ignoring these is most of what keeps this
// quiet: they are the bulk of USCIS's Register traffic.
const NO_CHANGE = /\bwithout change\b/i;

function getJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { timeout: 30000 }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (body += c));
      res.on("end", () => {
        try { resolve(JSON.parse(body)); } catch (err) { reject(err); }
      });
    }).on("error", reject).on("timeout", function () { this.destroy(new Error("timed out")); });
  });
}

// Words that carry no identity. "Petition To Remove the Conditions on
// Residence" and "Petition to Remove Conditions on Residence" are the same
// form; the difference is one article.
const STOPWORDS = new Set(["the", "of", "for", "a", "an", "to", "and", "on", "in", "by", "with", "as"]);
const tokens = (s) => String(s || "").toLowerCase()
  .replace(/[^a-z0-9\s-]/g, " ").split(/\s+/).filter((w) => w && !STOPWORDS.has(w));

/**
 * Which of the forms we track a title names, if any.
 *
 * By number AND by name. The Register titles its information-collection
 * notices with the form's NAME, not its number -- "Revision of a Currently
 * Approved Collection: Application for Waiver of Grounds of
 * Inadmissibility" is the I-601 -- so matching only on "I-601" finds
 * nothing, which is what the first version of this did.
 */
function formsNamedIn(title, tracked) {
  const t = String(title || "");
  return tracked.filter((f) => {
    if (new RegExp(`\\b${f.id.replace("-", "[- ]?")}\\b`, "i").test(t)) return true;
    // Subset alone is too loose: "Petition for CNMI-Only Nonimmigrant
    // Transitional Worker" contains every word of I-129's "Petition for a
    // Nonimmigrant Worker" and is a different form (I-129CW). So compare
    // against the COLLECTION NAME -- the part after the last colon, which
    // is where the Register puts it -- and allow it at most one extra
    // distinctive word.
    const tail = t.includes(":") ? t.slice(t.lastIndexOf(":") + 1) : t;
    const want = tokens(f.name);
    if (want.length < 3) return false;

    // The collection name can carry a suffix ("; Correction") or list two
    // forms ("Immigrant Petition by Standalone Investor, Immigrant
    // Petition by Regional Center Investor"), so each segment is tested on
    // its own and one must match EXACTLY.
    //
    // Allowing even a single extra word is too loose: "Application by
    // Refugee for Waiver of Inadmissibility Grounds" is the I-602, and it
    // differs from the I-601's name by the one word "Refugee".
    return tail.split(/[;,]/).some((seg) => {
      const have = tokens(seg);
      return have.length === want.length && want.every((w) => have.includes(w));
    });
  }).map((f) => f.id);
}

/**
 * USCIS documents published since `since` (YYYY-MM-DD) that indicate a
 * form or fee change.
 *
 * Returns every hit with the reason it was kept, so a false positive can
 * be read and the filter corrected rather than guessed at.
 */
async function signals({ since, tracked = null } = {}) {
  const forms = tracked || FORMS().FORMS;
  const from = since || new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 10);
  const url = `${FR_BASE}?per_page=100&order=newest` +
    `&conditions%5Bagencies%5D%5B%5D=u-s-citizenship-and-immigration-services` +
    `&conditions%5Bpublication_date%5D%5Bgte%5D=${encodeURIComponent(from)}` +
    ["title", "publication_date", "type", "document_number", "html_url", "abstract"]
      .map((f) => `&fields%5B%5D=${f}`).join("");

  const data = await getJson(url);
  const hits = [];
  for (const r of data.results || []) {
    const title = r.title || "";
    const fees = ABOUT_FEES.test(title) || ABOUT_FEES.test(r.abstract || "");
    const named = formsNamedIn(title, forms);
    const formish = ABOUT_FORMS.test(title) && !NO_CHANGE.test(title);

    if (!fees && !named.length && !formish) continue;
    // A "without change" extension that names no form and is not about
    // fees is routine paperwork, not a change.
    if (NO_CHANGE.test(title) && !fees && !named.length) continue;

    hits.push({
      date: r.publication_date, type: r.type, title,
      url: r.html_url, document_number: r.document_number,
      forms: named,
      why: fees ? "fees" : named.length ? "names a form we file" : "information collection revision",
    });
  }
  return { since: from, considered: (data.results || []).length, hits };
}

/**
 * The daily run.
 *
 * No signal, no message. A signal runs the full edition check at once and
 * reports both: what the Register said, and what the PDFs actually show.
 */
async function runDaily({ since = null, previous = null, send = null } = {}) {
  const F = FORMS();
  const prev = previous || safeRequire("./uscis-forms.json") || {};
  let found;
  try {
    found = await signals({ since });
  } catch (err) {
    // A watcher that cannot reach its source must say so: silence would
    // read as "nothing changed".
    const msg = `USCIS watch could not reach the Federal Register: ${err.message}`;
    if (send) await send(msg);
    return { ok: false, error: err.message, reported: !!send };
  }

  if (!found.hits.length) return { ok: true, hits: [], checked: false };

  // Something moved. Look at the forms themselves rather than trusting
  // the notice: the Register says what USCIS intends, the PDF says what
  // is published.
  const named = [...new Set(found.hits.flatMap((h) => h.forms))];
  const check = await F.checkAll({ previous: prev, only: named.length ? named : null });

  const lines = [
    `USCIS: ${found.hits.length} Federal Register item${found.hits.length === 1 ? "" : "s"} since ${found.since}`,
    "",
  ];
  for (const h of found.hits.slice(0, 8)) {
    lines.push(`${h.date}  ${h.type}  (${h.why})`);
    lines.push(`  ${h.title.slice(0, 140)}`);
    if (h.url) lines.push(`  ${h.url}`);
  }
  lines.push("", F.report(check));
  lines.push("", "The Register says what USCIS intends; the edition date on the PDF says what is published. Re-check the field map before filing on a new edition.");

  const message = lines.join("\n");
  if (send) await send(message);
  return { ok: true, hits: found.hits, check, message, reported: !!send };
}

function safeRequire(p) {
  try { return require(p); } catch { return null; }
}

module.exports = { signals, runDaily, formsNamedIn, ABOUT_FORMS, ABOUT_FEES, NO_CHANGE };
