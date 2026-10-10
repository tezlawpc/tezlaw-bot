// ============================================================
//  uscis-form-page.js — pick a form, then answer it as questions
//  ─────────────────────────────────────────────────────────
//  Two screens, for two of JJ's complaints on 2026-10-09:
//
//  "in each client profile, it should be able to pick forms to file, not
//   just filing combo" and "its very weird how each form is being created
//   with each client. So each client portal should be able to pick its own
//   forms individually, not just combo."
//      -> renderPicker: every tracked form, startable on its own, with
//         the forms already on this client's file listed above them.
//
//  "when filling out the form, it should be questionaire format with
//   explanation on the side to assist client to fill out the form."
//      -> renderQuestionnaire: one question a row, the help beside it,
//         and every answer saved as it is given.
//
//  WHAT A BLANK BUYS. A form can only be ANSWERED if its blank PDF is
//  vendored in forms/ with its field dump. Today that is the G-28 alone.
//  The picker says so for the other nineteen rather than opening a
//  questionnaire whose answers have nowhere to be printed -- a form that
//  takes forty answers and then cannot produce a PDF is worse than a link
//  to USCIS's own copy.
//
//  No inline script, no onclick: these pages are JavaScript template
//  literals and an apostrophe in an attribute takes the whole script
//  down. See notify-admin.js:11. The autosave lives in
//  /static/form-draft.js and wires itself from data attributes.
// ============================================================

const F = require("./uscis-forms");
const Q = require("./uscis-questions");
const D = require("./uscis-drafts");

function esc(s) {
  if (s == null) return "";
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

const CARD = "background:#FFFFFF; border:1px solid #E8E3DC; border-radius:8px; padding:18px 20px; margin-bottom:14px;";
const LABEL = "font-size:11px; text-transform:uppercase; letter-spacing:0.5px; color:#A34C00; font-weight:700; margin:0 0 12px;";
const INPUT = "padding:8px 10px; border:1px solid #CFC8BE; border-radius:4px; font-size:14px; box-sizing:border-box; width:100%; max-width:380px; font-family:inherit;";
const BTN = "padding:8px 14px; background:#FF7B00; color:#1E1B1A; border:1px solid #9C2B1E; border-radius:4px; cursor:pointer; font-size:13px; font-weight:600;";
const BTN_QUIET = "padding:8px 14px; background:#F3EFE9; color:#2B2523; border:1px solid #E8E3DC; border-radius:4px; cursor:pointer; font-size:13px; text-decoration:none; display:inline-block;";

// A form in uscis-forms.js is { id, name, area }. There is no `number` and
// no `title`: the number IS the id, uppercased, which is how
// uscis-page.js prints it too. Reading f.number here put the string
// "undefined" on every row of the picker, which is what the check caught.
const numberOf = (f) => (f ? String(f.id).toUpperCase() : "");
const nameOf = (f) => (f && f.name) || "";

/** Which forms this app can actually fill in, as opposed to link to. */
function fillable(formId) {
  return Q.questionsFor(formId) !== null;
}

// ── Screen one: pick a form ─────────────────────────────────

function renderPicker(client, drafts = []) {
  const key = encodeURIComponent(client.key);
  const who = esc(client.client_name || client.key);

  const started = drafts.length ? drafts.map((d) => {
    const model = Q.questionsFor(d.form_id);
    const p = model ? D.progress(d, Q.flatten(model)) : { done: 0, total: 0, pct: 0 };
    const form = F.FORMS.find((f) => f.id === d.form_id);
    return `
      <div style="display:flex; justify-content:space-between; align-items:center; gap:12px;
                  padding:10px 0; border-bottom:1px solid #F3EFE9; flex-wrap:wrap;">
        <div style="min-width:220px;">
          <div style="font-weight:600; color:#2B2523;">
            ${esc(numberOf(form) || d.form_id.toUpperCase())}
            ${d.label ? `<span style="color:#5E5854; font-weight:normal;"> — ${esc(d.label)}</span>` : ""}
          </div>
          <div style="font-size:12px; color:#5E5854;">
            ${esc(String(p.done))} of ${esc(String(p.total))} answered
            · ${esc(d.status)}
            ${d.matter_id ? ` · matter ${esc(d.matter_id)}` : ""}
          </div>
        </div>
        <a href="/admin/clients/${key}/forms/${esc(String(d.id))}" style="${BTN_QUIET}">Open</a>
      </div>`;
  }).join("") : `<p style="color:#5E5854; margin:0;">No forms started for this client yet.</p>`;

  const rows = F.FORMS.map((f) => {
    const can = fillable(f.id);
    return `
      <div style="display:flex; justify-content:space-between; align-items:center; gap:12px;
                  padding:10px 0; border-bottom:1px solid #F3EFE9; flex-wrap:wrap;">
        <div style="min-width:260px; flex:1;">
          <div style="font-weight:600; color:#2B2523;">${esc(numberOf(f))}</div>
          <div style="font-size:12px; color:#5E5854;">${esc(nameOf(f))}</div>
        </div>
        <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap;">
          <a href="${esc(F.urlFor(f.id))}" rel="noopener" target="_blank" style="${BTN_QUIET}">USCIS copy</a>
          ${can ? `
          <form method="POST" action="/admin/clients/${key}/forms" style="margin:0;">
            <input type="hidden" name="form_id" value="${esc(f.id)}">
            <button type="submit" style="${BTN}">Start this form</button>
          </form>` : `
          <span style="font-size:12px; color:#5E5854; font-style:italic;">blank not on file yet</span>`}
        </div>
      </div>`;
  }).join("");

  return `
  <div style="max-width:960px;">
    <p style="margin:0 0 4px; font-size:13px; color:#5E5854;">
      <a href="/admin/clients/${key}" style="color:#A34C00;">&larr; ${who}</a>
    </p>
    <h1 style="margin:0 0 14px; font-size:24px; color:#2B2523;">Forms for ${who}</h1>

    <div style="${CARD}">
      <p style="${LABEL}">Already started</p>
      ${started}
    </div>

    <div style="${CARD}">
      <p style="${LABEL}">Start a single form</p>
      <p style="font-size:13px; color:#5E5854; margin:0 0 10px;">
        One form on its own. For a set that goes in one envelope, use
        <a href="/admin/clients/${key}/filing-package" style="color:#A34C00;">a filing package</a>
        instead, which lists what goes with what.
      </p>
      ${rows}
      <p style="font-size:12px; color:#5E5854; margin:12px 0 0;">
        A form marked <em>blank not on file yet</em> can be read at USCIS but not filled in here:
        this app fills a form from the blank PDF's own fields, and only the G-28's blank is
        vendored so far. Ask for the ones you file most and they can be added.
      </p>
    </div>
  </div>`;
}

// ── Screen two: answer it ───────────────────────────────────

function renderQuestionnaire(client, draft, model, { section = null, readOnlySections = [] } = {}) {
  const key = encodeURIComponent(client.key);
  const who = esc(client.client_name || client.key);
  const answers = draft.answers || {};
  const all = Q.flatten(model);
  const p = D.progress(draft, all);
  const form = F.FORMS.find((f) => f.id === draft.form_id);

  const current = section && model.sections.some((s) => s.id === section)
    ? section
    : model.sections[0].id;

  const tabs = model.sections.map((s) => {
    const on = s.id === current;
    const answered = s.questions.filter(
      (q) => String(answers[q.key] == null ? "" : answers[q.key]).trim() !== "").length;
    return `<a href="/admin/clients/${key}/forms/${esc(String(draft.id))}?section=${esc(s.id)}"
       style="padding:8px 14px; border-radius:6px; text-decoration:none; font-size:13px;
              ${on ? "background:#2B2523; color:#FFFFFF;" : "background:#F3EFE9; color:#2B2523;"}">
       ${esc(s.title)} <span style="opacity:0.7;">${esc(String(answered))}/${esc(String(s.questions.length))}</span></a>`;
  }).join("");

  const sec = model.sections.find((s) => s.id === current);
  const locked = readOnlySections.includes(sec.id);

  const rows = sec.questions.map((q) => {
    const v = answers[q.key] == null ? "" : String(answers[q.key]);
    const control = q.kind === "checkbox"
      ? `<label style="display:flex; align-items:center; gap:8px; font-size:14px;">
           <input type="checkbox" data-draft-field="${esc(q.key)}" ${v ? "checked" : ""} ${locked ? "disabled" : ""}
                  style="width:18px; height:18px;">
           <span style="color:#5E5854;">Tick if this applies</span>
         </label>`
      : q.kind === "select"
        ? `<select data-draft-field="${esc(q.key)}" ${locked ? "disabled" : ""} style="${INPUT}">
             ${(q.options || []).map((o) =>
               `<option value="${esc(o)}"${o === v ? " selected" : ""}>${esc(o || "—")}</option>`).join("")}
           </select>`
        : `<input type="text" data-draft-field="${esc(q.key)}" value="${esc(v)}" ${locked ? "disabled" : ""}
                  style="${INPUT}" autocomplete="off">`;

    return `
      <div data-draft-row style="display:grid; grid-template-columns:minmax(0,1fr) minmax(0,1fr);
            gap:16px; padding:14px 0 14px 12px; border-bottom:1px solid #F3EFE9; align-items:start;">
        <div>
          <label style="display:block; font-size:14px; font-weight:600; color:#2B2523; margin-bottom:6px;">
            ${esc(q.label)}
          </label>
          ${control}
          ${q.printed ? `<div style="font-size:11px; color:#8A827C; margin-top:6px;">On the form: ${esc(q.printed)}</div>` : ""}
        </div>
        <div style="font-size:13px; color:#5E5854; line-height:1.55; background:#FAF8F5;
                    border-left:3px solid #E8E3DC; padding:10px 12px; border-radius:4px;">
          ${esc(q.help) || "<span style=\"font-style:italic;\">No note for this box.</span>"}
        </div>
      </div>`;
  }).join("");

  return `
  <div style="max-width:1060px;">
    <p style="margin:0 0 4px; font-size:13px; color:#5E5854;">
      <a href="/admin/clients/${key}/forms" style="color:#A34C00;">&larr; Forms for ${who}</a>
    </p>
    <h1 style="margin:0 0 4px; font-size:24px; color:#2B2523;">
      ${esc(numberOf(form) || draft.form_id.toUpperCase())} — ${who}
    </h1>
    <p style="margin:0 0 14px; font-size:13px; color:#5E5854;">
      ${esc(nameOf(form))}${model.edition ? ` · edition ${esc(model.edition)}` : ""}
    </p>

    <div style="${CARD}">
      <div style="display:flex; justify-content:space-between; align-items:center; gap:12px; flex-wrap:wrap;">
        <div style="flex:1; min-width:240px;">
          <div style="height:8px; background:#F3EFE9; border-radius:4px; overflow:hidden;">
            <div id="draft-progress-bar" style="height:100%; width:${esc(String(p.pct))}%; background:#FF7B00;"></div>
          </div>
          <div id="draft-progress-text" style="font-size:12px; color:#5E5854; margin-top:6px;">
            ${esc(String(p.done))} of ${esc(String(p.total))} answered
          </div>
        </div>
        <div id="draft-status" style="font-size:12px; color:#5E5854; min-width:220px; text-align:right;">
          Every answer is saved as you give it.
        </div>
      </div>
    </div>

    <div style="display:flex; gap:8px; flex-wrap:wrap; margin-bottom:14px;">${tabs}</div>

    <form data-draft-url="/admin/clients/${key}/forms/${esc(String(draft.id))}/answer"
          onsubmit="return false;" style="${CARD}">
      <p style="${LABEL}">${esc(sec.title)}</p>
      ${sec.note ? `<p style="font-size:13px; color:#5E5854; margin:0 0 6px;">${esc(sec.note)}</p>` : ""}
      ${locked ? `<p style="font-size:13px; color:#9C2B1E; margin:0 0 10px;">
        Shown for checking. This section is the firm's own record and is filled in at the office.</p>` : ""}
      ${rows}
    </form>

    <div style="${CARD}">
      <p style="${LABEL}">When the answers are in</p>
      <p style="font-size:13px; color:#5E5854; margin:0 0 12px;">
        Nothing is produced from this page. The form is built on the review screen, where every
        value and where it came from is shown first, together with every box left blank and why.
      </p>
      <div style="display:flex; gap:10px; flex-wrap:wrap;">
        ${draft.form_id === "g-28" ? `<a href="/admin/clients/${key}/g28?draft=${esc(String(draft.id))}" style="${BTN_QUIET}">Review and build the G-28</a>` : ""}
        <a href="/admin/clients/${key}/forms" style="${BTN_QUIET}">All forms for this client</a>
      </div>
    </div>

    <script src="/static/form-draft.js"></script>
    <div style="margin-bottom:28px;"></div>
  </div>`;
}

module.exports = { renderPicker, renderQuestionnaire, fillable };
