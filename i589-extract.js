// ============================================================
//  i589-extract.js — READING PART A.I ITEM 8 FROM AN I-589
//  Tez Law P.C.
//  ─────────────────────────────────────────────────────────
//  JJ: "update all client's phone number and address in
//  accordance of the most recent 589 application page 1 and
//  question 8. do not use info in question 9."
//
//  WHY ITEM 9 IS EXCLUDED, written down so nobody re-adds it:
//  Item 8 is "Residence in the U.S." — where the person actually
//  lives. Item 9 is "Mailing Address in the U.S. (if different)",
//  and on a represented case that is very often THIS FIRM'S OWN
//  OFFICE, or a relative's. Harvesting item 9 would overwrite
//  every asylum client's home address with Tez Law's address.
//
//  WHY THIS MODULE REFUSES RATHER THAN GUESSES:
//  A wrong address on a client in removal proceedings means they
//  do not receive the hearing notice, which means an in absentia
//  order. That is the actual cost of a parsing error here, so
//  every ambiguous read returns `ok: false` with a reason instead
//  of a best guess. A row a human has to check is cheap; a
//  confidently wrong address is not.
//
//  TWO READING METHODS, in order of trust:
//   1. "fields" — the PDF's own AcroForm fields. A fillable I-589
//      names them, so the value is read rather than inferred.
//      Trustworthy.
//   2. "text"   — extracted page text, anchored BETWEEN the item 8
//      and item 9 headings. Used only when there are no form
//      fields (a flattened or scanned file). Worth checking by
//      hand; the report says which method produced each row.
// ============================================================

// Item 8 and item 9 headings, as they appear on the form.
const ITEM8 = /(?:^|\n)\s*8\.?\s*(?:Residence|Present\s+address)[^\n]*/i;
const ITEM9 = /(?:^|\n)\s*9\.?\s*Mailing\s+Address[^\n]*/i;

// AcroForm field names on the official fillable I-589 look like
// "Pt1Line8_StreetNumberName[0]". Matched by pattern rather than exact
// string, because the names differ between form editions — and every name
// actually used is reported, so a wrong guess is visible on the first run
// instead of silently producing rubbish.
const FIELD8 = {
  street: /Line8[_\W]*(Street|Address)/i,
  apt:    /Line8[_\W]*(Apt|Unit|Suite)/i,
  city:   /Line8[_\W]*City/i,
  state:  /Line8[_\W]*State/i,
  zip:    /Line8[_\W]*(Zip|Postal)/i,
  phone:  /Line8[_\W]*(Tele|Phone)/i,
};
// Anything naming item 9 is a disqualifier, never a source.
const FIELD9 = /Line9[_\W]/i;

function clean(v) {
  const s = String(v == null ? "" : v).replace(/\s+/g, " ").trim();
  return s && !/^(n\/?a|none|same)$/i.test(s) ? s : "";
}

/** Digits-only sanity check: a US number is 10 digits, or 11 starting with 1. */
function normalizePhone(v) {
  const d = String(v || "").replace(/\D/g, "");
  if (d.length === 11 && d.startsWith("1")) return d.slice(1);
  return d.length === 10 ? d : "";
}

function formatPhone(d) {
  return d && d.length === 10 ? `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}` : "";
}

function joinAddress({ street, apt, city, state, zip }) {
  const line1 = [street, apt ? `Apt ${apt.replace(/^apt\.?\s*/i, "")}` : ""].filter(Boolean).join(", ");
  const line2 = [city, [state, zip].filter(Boolean).join(" ")].filter(Boolean).join(", ");
  return [line1, line2].filter(Boolean).join(", ");
}

/**
 * Read item 8 from the PDF's form fields.
 * Returns null when the document has no usable fields, so the caller can fall
 * back to text.
 */
function fromFields(fields) {
  if (!fields || !fields.length) return null;
  const used = {}, got = {};
  for (const key of Object.keys(FIELD8)) {
    const hit = fields.find(f =>
      FIELD8[key].test(f.name) && !FIELD9.test(f.name) && clean(f.value));
    if (hit) { got[key] = clean(hit.value); used[key] = hit.name; }
  }
  if (!got.street && !got.phone) return null;      // nothing worth having
  return { got, used };
}

/**
 * Read item 8 from page text, strictly between the item 8 and item 9
 * headings. If either anchor is missing the answer is "cannot tell" — which
 * is the whole point, because without the item 9 anchor there is no way to
 * know the text found belongs to item 8 rather than the mailing address.
 */
function fromText(text) {
  const t = String(text || "").replace(/\r/g, "");
  const m8 = t.match(ITEM8);
  if (!m8) return { error: "item 8 heading not found on the page" };
  const after = t.slice(m8.index + m8[0].length);
  const m9 = after.match(ITEM9);
  if (!m9) return { error: "item 9 heading not found, so the end of item 8 is unknown" };

  const block = after.slice(0, m9.index);
  const lines = block.split("\n").map(l => l.trim()).filter(Boolean);

  // Read by LABEL, not by position.
  //
  // The first version guessed: first line starting with a number is the
  // street, any two capitals before five digits is the state. On a real page
  // that produced "1425 Cameron Avenue, 91790" — no apartment, no city, no
  // state — because "State  CA   Zip Code  91790" puts the words "Zip Code"
  // between the state and the digits. The form prints its own labels; using
  // them is both simpler and right.
  const labelled = (re) => {
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(re);
      if (!m) continue;
      // Value on the same line, after the label...
      const rest = lines[i].slice(m.index + m[0].length).trim();
      // ...but stop at the next label on that line ("State  CA   Zip Code 91790").
      const cut = rest.split(/\s{2,}(?=[A-Z][a-z]|Zip|Apt|Telephone|State|City)/)[0].trim();
      if (cut) return cut;
      // ...or on the next line.
      if (lines[i + 1] && !/^(Street|Apt|City|State|Zip|Telephone|In Care)/i.test(lines[i + 1])) {
        return lines[i + 1].trim();
      }
    }
    return "";
  };

  const got = {};
  const street = labelled(/^Street\s+Number\s+and\s+Name/i);
  if (street) got.street = clean(street);
  const apt = labelled(/^Apt\.?\s*(Number|No\.?)?/i);
  if (apt) got.apt = clean(apt);
  const city = labelled(/^City(\s+or\s+Town)?/i);
  if (city) got.city = clean(city);
  const state = labelled(/^State/i);
  if (state && /^[A-Za-z]{2}$/.test(state.trim())) got.state = state.trim().toUpperCase();
  const zip = labelled(/^Zip\s*Code/i) || (block.match(/\b(\d{5}(?:-\d{4})?)\b/) || [])[1] || "";
  if (zip) got.zip = clean(zip);
  const phone = normalizePhone(labelled(/^Telephone\s*(Number)?/i)
    || (block.match(/(\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4})/) || [])[1]);
  if (phone) got.phone = phone;

  return { got, block };
}

/**
 * Everything known about one I-589's item 8.
 * `fields` and `text` are supplied by the caller so this module never has to
 * open a PDF itself — which is what makes it testable without one.
 */
function extract({ fields = null, text = "" } = {}) {
  const byField = fromFields(fields);
  if (byField) {
    const phone = normalizePhone(byField.got.phone);
    const address = joinAddress(byField.got);
    return {
      ok: !!(address || phone),
      method: "fields",
      address, phone: formatPhone(phone),
      fieldsUsed: byField.used,
      notes: address ? [] : ["no street address in the form fields"],
    };
  }

  const byText = fromText(text);
  if (byText.error) {
    return { ok: false, method: "text", address: "", phone: "", notes: [byText.error] };
  }
  const phone = normalizePhone(byText.got.phone);
  const g = byText.got;
  const notes = [];

  // A street with no city and no state is not a usable address — posting a
  // hearing notice to it would fail — so an incomplete read is reported as a
  // read that did not work, rather than written to a client record.
  const complete = !!(g.street && g.city && g.state);
  if (g.street && !g.city) notes.push("city could not be read from item 8");
  if (g.street && !g.state) notes.push("state could not be read from item 8");
  if (!g.street) notes.push("no street address could be read from item 8");

  const address = complete ? joinAddress(g) : "";
  return {
    ok: !!(address || phone),
    method: "text",
    address, phone: formatPhone(phone),
    partial: !complete && !!g.street ? joinAddress(g) : "",
    notes,
  };
}

/**
 * Which file is "the most recent 589"?
 *
 * Filename first, because a folder holds drafts, exhibits and scans of other
 * people's forms. Anything that merely mentions 589 inside a bundle is NOT
 * treated as an I-589 — a supporting-document PDF that quotes the form would
 * otherwise win on date.
 */
/**
 * Rank the files in a client folder by how likely each is to BE the form.
 *
 * This used to return one file: the newest PDF with "i589" in its name. Two
 * things went wrong with that, and the vision reader found both by reading
 * the pages and saying what it saw.
 *
 *   · "updated I-589 and Statement.pdf" is the most recent match in several
 *     folders, and it is not the form. The model reported "only Form I-589
 *     Supplement B (continuation pages) and a translation certificate; the
 *     main Form I-589 with Part A.I. Item 8 is not present". The base form
 *     was sitting in the same folder under a different name, and there was no
 *     way to reach it.
 *   · A folder whose form is called "asylum application" matched nothing at
 *     all, which is a large part of why 180 clients came back "no I-589".
 *
 * So: score every PDF, return an ordered list, and let the caller try the
 * next one when a file turns out not to contain item 8. Supplements,
 * statements and translation certificates still score above zero — they ARE
 * usually in the right folder — they simply rank below a plain form.
 */
function scoreCandidate(file) {
  const n = String(file.name || "");
  if (!/\.pdf$/i.test(n)) return 0;
  let s = 0;

  if (/\bi[\s._-]?589\b/i.test(n)) s += 10;
  if (/asylum[\s._-]*(application|app|form)/i.test(n)) s += 7;
  if (/\b589\b/.test(n)) s += 3;                       // bare number, weaker

  // The things that travel WITH the form rather than being it. The evidence
  // for each of these is a row that said so in its own words.
  if (/supplement|continuation|addend|amend/i.test(n)) s -= 6;
  if (/statement|declaration|affidavit/i.test(n)) s -= 5;
  if (/translat|certificat/i.test(n)) s -= 5;
  if (/cover|index|tab\b|exhibit|evidence/i.test(n)) s -= 5;

  if (/draft|sample|template|blank|unsigned/i.test(n)) s -= 8;
  if (/sign|final|filed|complete/i.test(n)) s += 2;

  return s;
}

function rankCandidates(files = [], { limit = 3 } = {}) {
  return files
    .map(f => ({ file: f, score: scoreCandidate(f) }))
    .filter(x => x.score > 0)
    .sort((a, b) =>
      b.score - a.score ||
      new Date(b.file.modified || b.file.server_modified || 0) -
      new Date(a.file.modified || a.file.server_modified || 0))
    .slice(0, limit)
    .map(x => x.file);
}

/** The single best guess. Kept because plenty of callers only want one. */
function pickMostRecent(files = []) {
  return rankCandidates(files, { limit: 1 })[0] || null;
}

/**
 * What to do about one client, given what the form says and what is on file.
 * Fills blanks; never silently overwrites. A difference is reported for a
 * human, because a 589 can easily be older than the last time somebody rang.
 */
function decide({ current = {}, found = {} } = {}) {
  const out = { phone: null, address: null, conflicts: [] };
  const samePhone = normalizePhone(current.phone) === normalizePhone(found.phone);
  const sameAddr = String(current.address || "").replace(/\W+/g, "").toLowerCase()
                === String(found.address || "").replace(/\W+/g, "").toLowerCase();

  if (found.phone) {
    if (!clean(current.phone)) out.phone = found.phone;
    else if (!samePhone) out.conflicts.push({ field: "phone", on_file: current.phone, on_589: found.phone });
  }
  if (found.address) {
    if (!clean(current.address)) out.address = found.address;
    else if (!sameAddr) out.conflicts.push({ field: "address", on_file: current.address, on_589: found.address });
  }
  return out;
}

module.exports = {
  rankCandidates, scoreCandidate,
  ITEM8, ITEM9, FIELD8, FIELD9,
  clean, normalizePhone, formatPhone, joinAddress,
  fromFields, fromText, extract, pickMostRecent, decide,
};
