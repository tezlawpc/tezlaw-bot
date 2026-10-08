// ============================================================
//  uscis-forms.js — which edition of each form is current,
//                   and whether ours is
//  ─────────────────────────────────────────────────────────
//  "also need to make sure all forms are up to date."
//
//  WHY THIS IS NOT AN API CALL
//  USCIS publishes exactly two APIs: Case Status and FOIA. There is no
//  forms API, no edition-date endpoint, and no third-party e-filing. The
//  Case Status API this firm already has (USCIS.js) takes a receipt
//  number and returns a status; it knows nothing about forms.
//
//  So the edition date is read off the form itself. Every USCIS form PDF
//  carries it in the page footer, in a fixed shape:
//
//      Form I-130   Edition 04/01/24
//      OMB No. 1615-0012   Expires 02/28/2027
//
//  This downloads each form the firm files, reads that line, and compares
//  it with what was last seen. A changed edition is the thing to know
//  about: USCIS rejects a filing on a superseded edition once the grace
//  period ends, and a rejected I-589 can mean a missed one-year deadline.
//
//  HOW IT RUNS
//  The same way uscis-times.json does: a weekly GitHub Action fetches and
//  commits uscis-forms.json, and the server reads the committed file.
//  Render's egress is open; this repo's own sandbox is not, which is why
//  the fetching lives in the Action rather than in the app.
//
//  WHAT IT DOES NOT DO
//  It does not download a new form and start using it. An edition change
//  usually moves fields, and a field map built for the old edition will
//  put the wrong answer in the wrong box. The report says what changed;
//  a person re-checks the map before the new edition is used.
// ============================================================

const https = require("https");

/**
 * The forms this firm files, by practice area.
 *
 * `url` is USCIS's own canonical path. `edition` is what we last saw, and
 * is filled in by the fetch rather than typed here: a hand-typed edition
 * date is a second source of truth that goes stale silently.
 */
const FORMS = [
  // ── Family ───────────────────────────────────────────────
  { id: "i-130",    name: "Petition for Alien Relative",                  area: "family" },
  { id: "i-130a",   name: "Supplemental Information for Spouse Beneficiary", area: "family" },
  { id: "i-485",    name: "Application to Register Permanent Residence",  area: "family" },
  { id: "i-864",    name: "Affidavit of Support",                         area: "family" },
  { id: "i-864a",   name: "Contract Between Sponsor and Household Member", area: "family" },
  { id: "i-129f",   name: "Petition for Alien Fiance(e)",                 area: "family" },
  { id: "i-751",    name: "Petition to Remove Conditions on Residence",   area: "family" },

  // ── Work and travel ──────────────────────────────────────
  { id: "i-765",    name: "Application for Employment Authorization",     area: "work" },
  { id: "i-131",    name: "Application for Travel Document",              area: "work" },
  { id: "i-140",    name: "Immigrant Petition for Alien Worker",          area: "business" },
  { id: "i-129",    name: "Petition for a Nonimmigrant Worker",           area: "business" },
  { id: "i-526e",   name: "Immigrant Petition by Regional Center Investor", area: "business" },

  // ── Asylum and removal ───────────────────────────────────
  { id: "i-589",    name: "Application for Asylum and for Withholding of Removal", area: "removal" },
  { id: "i-912",    name: "Request for Fee Waiver",                       area: "removal" },
  { id: "i-601",    name: "Application for Waiver of Grounds of Inadmissibility", area: "removal" },
  { id: "i-601a",   name: "Application for Provisional Unlawful Presence Waiver", area: "removal" },

  // ── Naturalization ───────────────────────────────────────
  { id: "n-400",    name: "Application for Naturalization",               area: "naturalization" },
  { id: "n-600",    name: "Application for Certificate of Citizenship",   area: "naturalization" },

  // ── Representation ───────────────────────────────────────
  { id: "g-28",     name: "Notice of Entry of Appearance as Attorney",    area: "all" },
  { id: "i-90",     name: "Application to Replace Permanent Resident Card", area: "family" },
];

const urlFor = (id) => `https://www.uscis.gov/sites/default/files/document/forms/${id}.pdf`;

// Two footer shapes, both real:
//   "Form I-130   Edition 04/01/24"            most forms
//   "Form G-28   09/17/18   Page 1 of 4"       no "Edition" word
// The spacing varies; the shapes do not.
const EDITION = /Form\s+([A-Z]+-\d+[A-Za-z]?)\s+Edition\s+(\d{2}\/\d{2}\/\d{2,4})/i;
const EDITION_BARE = /Form\s+([A-Z]+-\d+[A-Za-z]?)\s+(\d{2}\/\d{2}\/\d{2})\s+Page\s+\d+\s+of\s+\d+/i;
const EXPIRES = /Expires\s+(\d{2}\/\d{2}\/\d{4})/i;
const OMB     = /OMB\s+No\.?\s+(\d{4}-\d{4})/i;

/** Download one form. Returns a Buffer, or throws with the status. */
function download(url, redirects = 3) {
  return new Promise((resolve, reject) => {
    https.get(url, { timeout: 60000 }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirects) {
        res.resume();
        return download(new URL(res.headers.location, url).toString(), redirects - 1).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks)));
    }).on("error", reject).on("timeout", function () {
      this.destroy(new Error("timed out"));
    });
  });
}

/**
 * Read the edition line out of a form PDF.
 *
 * Through pdf-parse, which the repo already uses. The first version of
 * this scanned the raw bytes to avoid a dependency and found nothing: the
 * footer sits in a COMPRESSED content stream, so it is not in the file as
 * readable text. It has to be decompressed to be read.
 *
 * A form whose line cannot be read comes back `ok: false` and a person
 * looks. This decides whether a filing is accepted, so a guess is worse
 * than a question.
 */
async function readEdition(buffer) {
  let text;
  try {
    text = (await require("pdf-parse")(buffer)).text || "";
  } catch (err) {
    return { ok: false, reason: `could not be read as a PDF: ${err.message}` };
  }
  const ed = EDITION.exec(text) || EDITION_BARE.exec(text);
  if (!ed) return { ok: false, reason: "no edition line found in the PDF" };

  const expires = (EXPIRES.exec(text) || [])[1] || null;
  // An OMB control number that has already expired means the file at
  // USCIS's own URL is stale. The G-28 there expired 05/31/2021. Filing on
  // a form with a lapsed OMB number invites a rejection, so this is worth
  // seeing rather than quietly recording the old edition as current.
  let ombExpired = false;
  if (expires) {
    const [mm, dd, yyyy] = expires.split("/").map(Number);
    ombExpired = new Date(yyyy, mm - 1, dd) < new Date();
  }

  return {
    ok: true,
    form: ed[1].toUpperCase(),
    edition: ed[2],
    expires,
    omb_expired: ombExpired,
    omb: (OMB.exec(text) || [])[1] || null,
    bytes: buffer.length,
  };
}

/**
 * Check every form, or the ones named.
 *
 * `previous` is the last uscis-forms.json. Anything whose edition moved
 * comes back in `changed`, which is what the report is about.
 */
async function checkAll({ previous = {}, only = null, pause = 400 } = {}) {
  const forms = only ? FORMS.filter((f) => only.includes(f.id)) : FORMS;
  const now = new Date().toISOString().slice(0, 10);
  const out = { checked_on: now, forms: {}, changed: [], failed: [] };

  for (const f of forms) {
    try {
      const buf = await download(urlFor(f.id));
      const read = await readEdition(buf);
      if (!read.ok) {
        out.failed.push({ id: f.id, reason: read.reason });
        // Keep what we knew: a read failure is not evidence of a change.
        if (previous.forms && previous.forms[f.id]) out.forms[f.id] = previous.forms[f.id];
        continue;
      }
      const was = (previous.forms || {})[f.id];
      const row = {
        name: f.name, area: f.area, url: urlFor(f.id),
        edition: read.edition, expires: read.expires,
        omb: read.omb, omb_expired: read.omb_expired,
        first_seen: was && was.edition === read.edition ? was.first_seen : now,
      };
      out.forms[f.id] = row;
      if (was && was.edition !== read.edition) {
        out.changed.push({ id: f.id, name: f.name, from: was.edition, to: read.edition });
      }
    } catch (err) {
      out.failed.push({ id: f.id, reason: err.message });
      if (previous.forms && previous.forms[f.id]) out.forms[f.id] = previous.forms[f.id];
    }
    if (pause) await new Promise((r) => setTimeout(r, pause));
  }
  return out;
}

/** The report a person reads. Plain text: it goes to Telegram. */
function report(result) {
  const lines = [`USCIS forms checked ${result.checked_on}`, ""];
  if (result.changed.length) {
    lines.push("EDITION CHANGED — do not file on the old one, and re-check the field map:");
    for (const c of result.changed) lines.push(`  ${c.id.toUpperCase()}  ${c.from} -> ${c.to}  ${c.name}`);
    lines.push("");
  } else {
    lines.push("No edition changed.", "");
  }
  const stale = Object.entries(result.forms).filter(([, v]) => v.omb_expired);
  if (stale.length) {
    lines.push("OMB CONTROL NUMBER ALREADY EXPIRED — the file at the USCIS URL is stale.");
    lines.push("Check uscis.gov for the current edition before filing:");
    for (const [id, v] of stale) lines.push(`  ${id.toUpperCase()}  edition ${v.edition}, OMB expired ${v.expires}`);
    lines.push("");
  }
  if (result.failed.length) {
    lines.push("Could not be read (the last known edition was kept):");
    for (const f of result.failed) lines.push(`  ${f.id.toUpperCase()}  ${f.reason}`);
    lines.push("");
  }
  lines.push(`${Object.keys(result.forms).length} forms on file.`);
  return lines.join("\n");
}

module.exports = { FORMS, urlFor, readEdition, download, checkAll, report, EDITION, EDITION_BARE };
