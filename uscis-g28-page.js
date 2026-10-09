// ============================================================
//  uscis-g28-page.js — the page you read before the form exists
//  ─────────────────────────────────────────────────────────
//  Fill-and-review, not fill-and-trust. The G-28 is a filing; a wrong box
//  on it is a rejection or a misrepresentation, and the one thing a prefill
//  must never do is look finished.
//
//  So nothing is produced until a person has seen, on one page:
//    - every value that will be printed, and where it came from
//    - every box left blank, and why
//    - the two questions the client record cannot answer — which forms this
//      appearance covers, and the capacity the client appears in
//
//  No inline script, no onclick. See notify-admin.js:11: an apostrophe in
//  an attribute took client search down for five hours on 2026-09-28, and
//  these pages are JavaScript template literals.
// ============================================================

const G = require("./uscis-g28");
const FA = require("./firm-attorneys");

function esc(s) {
  if (s == null) return "";
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

const CARD = "background:#FFFFFF; border:1px solid #E8E3DC; border-radius:8px; padding:18px 20px; margin-bottom:14px;";
const LABEL = "font-size:11px; text-transform:uppercase; letter-spacing:0.5px; color:#A34C00; font-weight:700; margin:0 0 10px;";
const INPUT = "padding:8px 10px; border:1px solid #CFC8BE; border-radius:4px; font-size:14px; box-sizing:border-box;";

const NOTE_STYLE = {
  stop:  "background:#FBEDEA; border-left:4px solid #9C2B1E; color:#2B2523;",
  check: "background:#FAF8F5; border-left:4px solid #FF7B00; color:#2B2523;",
  yours: "background:#F3EFE9; border-left:4px solid #2B2523; color:#2B2523;",
  note:  "background:#F3EFE9; border-left:4px solid #E8E3DC; color:#5E5854;",
};
const NOTE_LEAD = {
  stop: "Cannot fill:",
  check: "Check this:",
  yours: "Yours to answer:",
  note: "",
};

/** Human names for the keys, so the page reads as the form does. */
const PRINTED = {
  "attorney.family_name": "Pt 1, 2.a  Attorney family name",
  "attorney.given_name": "Pt 1, 2.b  Attorney given name",
  "attorney.middle_name": "Pt 1, 2.c  Attorney middle name",
  "attorney.street": "Pt 1, 3.a  Attorney street",
  "attorney.unit_number": "Pt 1, 3.b  Attorney unit",
  "attorney.unit_apartment": "Pt 1, 3.b  Apartment",
  "attorney.unit_suite": "Pt 1, 3.b  Suite",
  "attorney.unit_floor": "Pt 1, 3.b  Floor",
  "attorney.city": "Pt 1, 3.c  Attorney city",
  "attorney.state": "Pt 1, 3.d  Attorney state",
  "attorney.zip": "Pt 1, 3.e  Attorney ZIP",
  "attorney.daytime_phone": "Pt 1, 4  Attorney daytime phone",
  "attorney.mobile_phone": "Pt 1, 5  Attorney mobile",
  "attorney.email": "Pt 1, 6  Attorney email",
  "attorney.fax": "Pt 1, 7  Attorney fax",
  "attorney.uscis_online_account": "Pt 1, 1  Attorney USCIS account",
  "attorney.is_attorney": "Pt 2, 1.a  I am an attorney eligible to practice",
  "attorney.licensing_authority": "Pt 2, 1.a  Licensing authority",
  "attorney.bar_number": "Pt 2, 1.b  Bar number",
  "attorney.firm_name": "Pt 2, 1.d  Firm",
  "matter.before_uscis": "Pt 3, 1.a  Before USCIS",
  "matter.form_numbers": "Pt 3, 1.b  Forms this covers",
  "matter.receipt_number": "Pt 3, 4  Receipt number",
  "matter.as_applicant": "Pt 3, 5  As Applicant",
  "matter.as_petitioner": "Pt 3, 5  As Petitioner",
  "matter.as_requestor": "Pt 3, 5  As Requestor",
  "matter.as_beneficiary": "Pt 3, 5  As Beneficiary/Derivative",
  "matter.as_respondent": "Pt 3, 5  As Respondent",
  "client.family_name": "Pt 3, 6.a  Client family name",
  "client.given_name": "Pt 3, 6.b  Client given name",
  "client.middle_name": "Pt 3, 6.c  Client middle name",
  "client.entity_name": "Pt 3, 7.a  Entity",
  "client.entity_title": "Pt 3, 7.b  Title at entity",
  "client.uscis_online_account": "Pt 3, 8  Client USCIS account",
  "client.a_number": "Pt 3, 9  A-Number",
  "client.daytime_phone": "Pt 3, 10  Client daytime phone",
  "client.mobile_phone": "Pt 3, 11  Client mobile",
  "client.email": "Pt 3, 12  Client email",
  "client.street": "Pt 3, 13.a  Client street",
  "client.unit_number": "Pt 3, 13.b  Client unit",
  "client.unit_apartment": "Pt 3, 13.b  Apartment",
  "client.unit_suite": "Pt 3, 13.b  Suite",
  "client.unit_floor": "Pt 3, 13.b  Floor",
  "client.city": "Pt 3, 13.c  Client city",
  "client.state": "Pt 3, 13.d  Client state",
  "client.zip": "Pt 3, 13.e  Client ZIP",
};

/**
 * One editable box per mapped field.
 *
 * Every field on the map gets a real input, prefilled with what the record
 * proposed and labelled with the item number it prints as. Where a value
 * came from is shown beside it, and switches to "you typed it" the moment
 * it is changed, so the page never claims the client file said something a
 * person wrote.
 *
 * `shown` collects the keys rendered. It rides along in a hidden field,
 * because a checkbox posts nothing when it is off and the server would
 * otherwise have no way to tell an unticked box from a field this page
 * never offered.
 */
function fieldInputs(proposal, prefix, { skip = [], blank = null, shown }) {
  const G2 = require("./uscis-g28");
  const info = G2.blankInfo();
  const byName = new Map((blank || info.fields).map((f) => [f.name, f]));
  const seen = new Set();

  const rows = G2.MAP.filter((e) => e.key.startsWith(prefix) && !skip.includes(e.key))
    .filter((e) => (seen.has(e.key) ? false : seen.add(e.key)))
    .map((e) => {
      const f = byName.get(e.field) || {};
      const v = proposal.values[e.key] || "";
      const src = proposal.sources[e.key];
      shown.push(e.key);
      const name = `f:${esc(e.key)}`;
      const label = esc(PRINTED[e.key] || e.key);
      const from = src
        ? `<span style="font-size:10px; color:${src === "you typed it" ? "#A34C00" : "#5E5854"};">${esc(src)}</span>`
        : "";

      if (e.checkbox) {
        return `
      <label style="display:flex; align-items:center; gap:8px; padding:6px 0; font-size:13px; color:#2B2523;">
        <input type="checkbox" name="${name}" value="on" ${v ? "checked" : ""}>
        <span>${label}</span> ${from}
      </label>`;
      }
      if (e.dropdown) {
        const opts = (f.options || []).map((o) =>
          `<option value="${esc(o)}" ${o === v ? "selected" : ""}>${esc(o.trim() || "—")}</option>`).join("");
        return `
      <div>
        <label style="font-size:11px; color:#5E5854; display:block; margin-bottom:3px;">${label} ${from}</label>
        <select name="${name}" style="${INPUT} width:100%;"><option value=""></option>${opts}</select>
      </div>`;
      }
      return `
      <div>
        <label style="font-size:11px; color:#5E5854; display:block; margin-bottom:3px;">${label} ${from}</label>
        <input type="text" name="${name}" value="${esc(v)}" style="${INPUT} width:100%;">
      </div>`;
    });

  const boxes = rows.filter((r) => r.includes('type="checkbox"')).join("");
  const fields = rows.filter((r) => !r.includes('type="checkbox"')).join("");

  return `
    <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(230px, 1fr)); gap:12px 18px;">${fields}</div>
    ${boxes ? `<div style="margin-top:12px; border-top:1px solid #F3EFE9; padding-top:10px;">${boxes}</div>` : ""}`;
}

/**
 * The review page.
 *
 * `proposal` is what uscis-g28.proposeG28 returned. The form at the bottom
 * posts back to the same URL; the PDF is produced only by that POST.
 */
function renderG28Page(client, proposal, { attorneyKey = null, matter = {}, pkg = null } = {}) {
  const blank = G.blankInfo();
  const notes = proposal.notes.map((n) => `
    <div style="${NOTE_STYLE[n.level] || NOTE_STYLE.note} padding:11px 14px; border-radius:4px; margin-bottom:8px; font-size:13px; line-height:1.5;">
      ${NOTE_LEAD[n.level] ? `<b>${esc(NOTE_LEAD[n.level])}</b> ` : ""}${esc(n.text)}
    </div>`).join("");

  const attorneyOptions = FA.list().map((a) => `
    <option value="${esc(a.key)}" ${a.key === (attorneyKey || "jj") ? "selected" : ""}>${esc(a.name)} — ${esc(a.bar)}</option>`).join("");

  const capacityOptions = ["", ...Object.keys(G.CAPACITIES)].map((c) => `
    <option value="${esc(c)}" ${c === (proposal.capacity || "") ? "selected" : ""}>${
      c ? esc(c[0].toUpperCase() + c.slice(1)) : "— choose —"}${
      c && c === proposal.suggested_capacity ? "  (looks like this one)" : ""}</option>`).join("");

  const input = INPUT + " width:100%;";
  // Collected as the inputs are built, then posted, so the server can tell
  // an unticked checkbox from a field this page never offered.
  const shown = [];

  // When the G-28 was opened from a filing package, say which one and keep
  // it on the form, so a re-render does not silently drop item 1.b back to
  // whatever the client record suggested.
  const packageBanner = pkg ? `
    <div style="background:#F3EFE9; border-left:4px solid #A34C00; padding:11px 14px; border-radius:4px;
                margin-bottom:12px; font-size:13px; color:#2B2523; line-height:1.55;">
      For the <b>${esc(pkg.name)}</b> package.
      <a href="/admin/clients/${encodeURIComponent(client.key)}/filing-package?package=${encodeURIComponent(pkg.id)}"
         style="color:#A34C00;">Back to the package</a>
    </div>` : "";
  const packageField = pkg ? `<input type="hidden" name="package" value="${esc(pkg.id)}">` : "";

  return `
  <div class="page-header" style="display:flex; justify-content:space-between; align-items:flex-start; gap:12px; flex-wrap:wrap;">
    <div>
      <h1 style="margin:0;">Form G-28</h1>
      <div style="font-size:13px; color:#5E5854; margin-top:4px;">${esc(client.client_name || client.key)}</div>
    </div>
    <a href="/admin/clients/${encodeURIComponent(client.key)}" style="background:#2B2523; color:#FFFFFF;
      padding:8px 14px; border-radius:6px; text-decoration:none; font-size:12px; font-weight:600;">Client record</a>
  </div>

  <div style="font-size:12px; color:#5E5854; margin:0 0 16px; line-height:1.6;">
    Edition ${esc(blank.edition)} · OMB ${esc(blank.omb)}, expires ${esc(blank.omb_expires)} ·
    this is what USCIS serves at its own address. Nothing is produced until you press the button at the
    bottom, and nothing here is signed.
  </div>

  ${packageBanner}
  ${notes}

  <form method="POST" action="/admin/clients/${encodeURIComponent(client.key)}/g28">
    ${packageField}
    <div style="${CARD}">
      <p style="${LABEL}">Who is appearing, and in what</p>
      <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(220px, 1fr)); gap:14px;">
        <div>
          <label style="font-size:12px; color:#5E5854; display:block; margin-bottom:4px;">Attorney</label>
          <select name="attorney" style="${input}">${attorneyOptions}</select>
        </div>
        <div>
          <label style="font-size:12px; color:#5E5854; display:block; margin-bottom:4px;">Item 5 — the client appears as</label>
          <select name="capacity" style="${input}">${capacityOptions}</select>
        </div>
        <div>
          <label style="font-size:12px; color:#5E5854; display:block; margin-bottom:4px;">Item 1.b — forms this covers</label>
          <input type="text" name="form_numbers" value="${esc(matter.form_numbers || "")}" placeholder="e.g. I-589, I-765" style="${input}">
        </div>
        <div>
          <label style="font-size:12px; color:#5E5854; display:block; margin-bottom:4px;">Item 4 — receipt number (if any)</label>
          <input type="text" name="receipt_number" value="${esc(matter.receipt_number || "")}" placeholder="IOE1234567890" style="${input}">
        </div>
      </div>
      <div style="margin-top:12px;">
        <button type="submit" name="action" value="refresh" style="background:#F3EFE9; color:#2B2523;
          border:1px solid #E8E3DC; padding:9px 16px; border-radius:6px; font-size:13px; cursor:pointer;">Update this page</button>
      </div>
    </div>

    <div style="${CARD}">
      <p style="${LABEL}">Parts 1 and 2 — the attorney</p>
      <div style="font-size:12px; color:#5E5854; margin:-4px 0 12px;">
        From the attorney record. A change here applies to this form only.
      </div>
      ${fieldInputs(proposal, "attorney.", { shown })}
    </div>

    <div style="${CARD}">
      <p style="${LABEL}">Part 3 — the client</p>
      <div style="font-size:12px; color:#5E5854; margin:-4px 0 12px;">
        Pulled from the client file where it could be read, and all of it editable: an address the
        file could not parse, or a name that came across the wrong way round, is typed in here.
      </div>
      ${fieldInputs(proposal, "client.", { shown })}
    </div>

    <div style="${CARD}">
      <p style="${LABEL}">Part 3 — the matter</p>
      ${fieldInputs(proposal, "matter.", { shown, skip: Object.values(G.CAPACITIES) })}
      <div style="font-size:12px; color:#5E5854; margin-top:10px;">
        Item 5, the capacity, is the picker at the top of this page: the form says select only one.
      </div>
    </div>

    <div style="${CARD} border-color:#CFC8BE;">
      <p style="${LABEL}">Left for a person</p>
      <ul style="margin:0; padding-left:20px; font-size:13px; color:#2B2523; line-height:1.8;">
        <li>Part 2, item 1.c — whether you are subject to an order suspending or restraining you from practice.</li>
        <li>Part 4 — the client's consent signature, and their choice of where USCIS sends notices.</li>
        <li>Part 5 — your signature and its date.</li>
      </ul>
      <div style="margin-top:12px; font-size:12px; color:#5E5854;">
        An appearance before an Immigration Judge or the BIA is Form EOIR-28, not this one.
      </div>
    </div>

    <input type="hidden" name="__shown" value="${esc(shown.join(","))}">

    <div style="display:flex; gap:10px; flex-wrap:wrap; margin-bottom:28px;">
      <button type="submit" name="action" value="download" style="background:#A34C00; color:#FFFFFF; border:none;
        padding:11px 20px; border-radius:6px; font-size:14px; font-weight:600; cursor:pointer;">Produce the G-28</button>
      <button type="submit" name="action" value="download_flat" style="background:#F3EFE9; color:#2B2523;
        border:1px solid #E8E3DC; padding:11px 20px; border-radius:6px; font-size:14px; cursor:pointer;">Produce it flattened</button>
    </div>
  </form>`;
}

module.exports = { renderG28Page };
