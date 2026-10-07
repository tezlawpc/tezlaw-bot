// ============================================================
//  retainer-doc.js — the agreement itself
//  TEZ Law Firm (Tez Law P.C.)
//  ─────────────────────────────────────────────────────────
//  Renders one engagement into the finished document: the fee
//  terms the structure requires, the scope as written, and the
//  clauses retainer.js says that structure needs.
//
//  HTML rather than .docx. The repo has no docx writer and no
//  CJK-capable PDF font, and the browser has both: Chinese
//  renders, the drafter reads the real thing before anyone
//  signs, and print-to-PDF produces the file the e-signature
//  packet is built from. No new dependency, and the review step
//  is the page itself rather than a preview of a preview.
//
//  Two audiences, one document. `forClient` strips the margin
//  notes that tell the drafter which rule a clause is there to
//  satisfy; the client's copy carries none of them.
// ============================================================

const R = require("./retainer");

const esc = (s) => String(s == null ? "" : s)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

const FIRM = {
  name: "TEZ Law Firm",
  entity: "Tez Law P.C.",
  phone: "626-678-8677",
  email: "jj@tezlawfirm.com",
  offices: [
    { city: "West Covina", lines: ["4141 S. Nogales St., Suite C102", "West Covina, CA 91792"] },
    { city: "City of Industry", lines: ["17800 Castleton St., Suite 234", "City of Industry, CA 91748"] },
    { city: "Newport Beach", lines: ["4343 Von Karman Ave., Suite 100 K", "Newport Beach, CA 92660"] },
    { city: "Flushing", lines: ["39-15 Main Street, Suite 418", "Flushing, NY 11354"], note: "immigration matters only" },
  ],
};

const longDate = (d) => new Date(d || Date.now()).toLocaleDateString("en-US", {
  timeZone: "America/Los_Angeles", year: "numeric", month: "long", day: "numeric",
});

// ── The fee section, which is where the statutes bite ────────

// A clause rendered inside the fee section. Bilingual drafts get the Chinese
// here too -- the fee terms are the last thing that should quietly appear in
// English only, because they are what the client is agreeing to pay.
function inlineClause(k, bilingual) {
  const c = R.CLAUSES[k];
  if (!c) return "";
  const zh = !bilingual ? ""
    : c.zh ? `<p class="zh">${esc(c.zh)}</p>`
    : `<p class="zh missing">[中文待律師撰寫 — Chinese for this clause has not been written. Civ. Code § 1632: the client is held to the version in their own language.]</p>`;
  return `<p>${esc(c.en)}</p>${zh}`;
}

function feeSection(a) {
  const fee = Number(a.total_fee || 0);
  const bilingual = !!a.bilingual;
  const parts = [];

  if (a.structure === "flat" || a.structure === "hybrid") {
    parts.push(`<p>The fee for the work described above is a flat fee of <strong>${R.money(fee)}</strong>.</p>`);

    // Rule 1.5(d): earned by doing the work, never by signing.
    const ms = (a.milestones || []).filter((m) => m && m.work);
    parts.push(`
      ${inlineClause("flat_fee_earning", bilingual)}
      <table class="fees">
        <thead><tr><th>Portion of the fee</th><th>Earned when this is done</th><th>Amount</th></tr></thead>
        <tbody>${ms.map((m) => `
          <tr><td>${Number(m.pct)}%</td><td>${esc(m.work)}</td><td>${R.money(fee * Number(m.pct) / 100)}</td></tr>`).join("")}
        </tbody>
      </table>`);

    // Rule 1.15(b): the disclosure, and the consent it needs above $1,000.
    parts.push(inlineClause("flat_fee_deposit", bilingual));
    if (a.operating_account_consent) {
      parts.push(`
        <p class="consent"><strong>You agree</strong> that the flat fee may be deposited into the firm's operating
        account rather than its client trust account, on the terms stated in the paragraph above. Your right to a
        refund of any unearned portion is not affected.</p>
        <p class="siglet">Client's initials: <span class="rule short"></span></p>`);
    } else {
      parts.push(`<p>The flat fee will be deposited into the firm's client trust account and withdrawn only as it is earned.</p>`);
    }
  }

  if (a.structure === "hourly" || a.structure === "hybrid") {
    const tks = (a.timekeepers || [])
      .map((n) => R.RATES.find((t) => t.name === n))
      .filter(Boolean);
    // § 6148(a)(1): the hourly rates and other standard charges.
    parts.push(`
      <p>${a.structure === "hybrid"
        ? "Work outside the scope described above, if you ask for it and we agree to do it, is billed by the hour at these rates:"
        : "Our fees are charged by the hour at these rates:"}</p>
      <table class="fees">
        <thead><tr><th>Who</th><th>Role</th><th>Rate</th></tr></thead>
        <tbody>${tks.map((t) => `
          <tr><td>${esc(t.name)}</td><td>${esc(t.role)}</td><td>${R.money(t.rate)} per hour</td></tr>`).join("")}
        </tbody>
      </table>
      <p>Time is recorded in tenths of an hour. ${a.deposit
        ? `A deposit of <strong>${R.money(a.deposit)}</strong> is payable on signing. It is held in the firm's client trust account and applied to your invoices as they are issued; any part of it not used is returned to you.`
        : "No deposit is required."}</p>`);
  }

  if (a.structure === "contingency") {
    const pct = Number(a.contingency_pct || 0);
    // § 6147(a)(1)–(4). The negotiability sentence is required in terms.
    parts.push(`
      <p>Our fee is contingent on recovery. If there is no recovery, you owe no attorney's fee.</p>
      <p>If there is a recovery, our fee is <strong>${pct}%</strong> of the gross recovery${
        a.costs_borne_by === "firm_then_reimbursed"
          ? ", and costs we have advanced are reimbursed to the firm out of the recovery after our fee is calculated"
          : a.costs_borne_by === "off_the_top"
            ? ", calculated after costs we have advanced are first deducted from the recovery"
            : ""}.</p>
      <p>Costs and expenses are separate from the attorney's fee. ${
        a.costs_borne_by === "client" ? "You are responsible for them as they are incurred." :
        "The firm will advance them and be reimbursed out of any recovery."}
        You remain responsible for costs and expenses whether or not there is a recovery, except as any other
        provision of this Agreement states otherwise.</p>
      <p>You may be required to pay, out of your share of any recovery, amounts claimed by others — including
        medical providers, health plans and insurers asserting a lien or a right of subrogation.</p>
      <p><strong>The fee stated above is not set by law. It is negotiable between you and the firm.</strong></p>
      ${a.micra ? `<p>Because this is a claim against a health care provider, Business and Professions Code
        section 6146 limits the contingency fee that may be charged, and the fee above is subject to those limits.</p>` : ""}`);
  }

  // § 6148(a)(1) also wants the other charges, whatever the structure.
  parts.push(`
    <p>Costs and expenses — filing and government fees, service of process, translation, interpreters, couriers,
      records, experts, depositions, travel — are in addition to the fee${
      a.structure === "contingency" ? "" : " and are billed to you as they are incurred"}.
      We will tell you before incurring any single cost over ${R.money(a.cost_approval_threshold || 500)}.</p>`);

  return parts.join("\n");
}

// ── The document ─────────────────────────────────────────────

function body(a, { forClient = true } = {}) {
  const keys = R.clausesFor(a);
  const scope = (a.scope || []).filter(Boolean);
  const bilingual = !!a.bilingual;

  const clause = (k, n) => {
    const c = R.CLAUSES[k];
    if (!c) return "";
    const note = !forClient && c.because
      ? `<p class="why">Why this is here: ${esc(c.because)}</p>` : "";
    const zh = bilingual && c.zh
      ? `<p class="zh">${esc(c.zh)}</p>`
      : bilingual
        ? `<p class="zh missing">[中文待律師撰寫 — Chinese for this clause has not been written. Civ. Code § 1632: the client is held to the version in their own language, so this may not go out until a lawyer writes it.]</p>`
        : "";
    return `
      <section class="clause">
        <h2>${n}. ${esc(c.title.en)}${bilingual && c.title.zh ? ` · ${esc(c.title.zh)}` : ""}</h2>
        <p>${esc(c.en)}</p>
        ${zh}
        ${note}
      </section>`;
  };

  let n = 0;
  return `
    <header class="doc-head">
      <div class="mark">${esc(FIRM.name)}</div>
      <div class="sub">${esc(FIRM.entity)} · ${esc(FIRM.phone)} · ${esc(FIRM.email)}</div>
    </header>

    <h1>Agreement for Legal Services${bilingual ? " · 法律服務協議" : ""}</h1>
    <p class="meta">${esc(longDate(a.agreement_date))}</p>

    <p>This Agreement is between <strong>${esc(a.client_name)}</strong> ("you") and
      ${esc(FIRM.name)} ("we", "us" or "the firm"). It sets out what we will do for you, what it will cost,
      and what each of us is responsible for. It takes effect when it is signed${
      a.work_already_begun ? ", and it covers work the firm has already begun or completed on this matter at your request" : ""}.</p>

    <section class="clause">
      <h2>${++n}. Scope of Services${bilingual ? " · 服務範圍" : ""}</h2>
      <p>We will represent you in the following, and only the following:</p>
      <ul>${scope.map((s) => `<li>${esc(s)}</li>`).join("")}</ul>
      <p>Anything not listed above is outside this Agreement. ${
        a.structure === "hybrid"
          ? "If you ask us to do work outside it and we agree, that work is billed by the hour at the rates below."
          : "If you want us to take on additional work, we will agree that separately, in writing."}</p>
      ${!forClient ? `<p class="why">Why this is here: § 6148(a)(2) — the general nature of the services must be stated, or the agreement is voidable by the client.</p>` : ""}
    </section>

    <section class="clause">
      <h2>${++n}. Fees and Costs${bilingual ? " · 費用" : ""}</h2>
      ${feeSection(a)}
      ${!forClient ? `<p class="why">Why this is here: § 6148(a)(1) — the rates and other charges. For a contingency, § 6147(a).</p>` : ""}
    </section>

    <section class="clause">
      <h2>${++n}. What the Firm Will Do${bilingual ? " · 本事務所的責任" : ""}</h2>
      <p>We will provide the services described above with the care and skill the matter requires, keep you
        informed of significant developments, respond to your reasonable enquiries, and tell you promptly of any
        offer of settlement or any decision from a court or agency.</p>
      <p>We cannot and do not guarantee any particular result. No one can. Nothing said by anyone at the firm
        is a promise about the outcome of your matter.</p>
      ${!forClient ? `<p class="why">Why this is here: § 6148(a)(3) — each party's responsibilities.</p>` : ""}
    </section>

    ${keys.map((k) => clause(k, ++n)).join("")}

    ${bilingual ? `<section class="clause">
      <h2>${++n}. ${esc(R.CLAUSES.language.title.en)} · ${esc(R.CLAUSES.language.title.zh)}</h2>
      <p>${esc(R.CLAUSES.language.en)}</p>
      <p class="zh">${esc(R.CLAUSES.language.zh)}</p>
      ${!forClient ? `<p class="why">Why this is here: Civ. Code § 1632(b)(6) and (j) — legal services negotiated mainly in Chinese require a translation delivered before execution, and the English controls on conflict.</p>` : ""}
    </section>` : ""}

    <section class="signatures">
      <h2>Agreed${bilingual ? " · 同意並簽署" : ""}</h2>
      <p>The firm signs first. Your signature below means you have read this Agreement, you understand it,
        and you agree to it.</p>
      <div class="sigs">
        <div class="sig">
          <div class="rule"></div>
          <div class="who">${esc(FIRM.name)}</div>
          <div class="when">Date: <span class="rule short"></span></div>
        </div>
        <div class="sig">
          <div class="rule"></div>
          <div class="who">${esc(a.client_name)}</div>
          <div class="when">Date: <span class="rule short"></span></div>
        </div>
      </div>
    </section>

    <footer class="offices">
      <div class="t">${esc(FIRM.name)}</div>
      ${FIRM.offices.map((o) => `<div class="o"><strong>${esc(o.city)}</strong>${
        o.lines.map((l) => `<div>${esc(l)}</div>`).join("")}${
        o.note ? `<div class="n">${esc(o.note)}</div>` : ""}</div>`).join("")}
    </footer>`;
}

const CSS = `
  @page { size: letter; margin: 1in 1in 0.9in; }
  :root { --ink:#1E1B1A; --charcoal:#2B2523; --ember:#A34C00; --stone:#5E5854; --travertine:#E8E3DC; }
  * { box-sizing: border-box; }
  body { margin:0; background:#FAF8F5; color:var(--ink);
    font-family:Montserrat,"Helvetica Neue",Arial,sans-serif; font-size:11pt; line-height:1.55; }
  .sheet { max-width:7.5in; margin:0 auto; padding:0.5in 0; background:#FFFFFF; }
  .doc-head { border-bottom:2px solid var(--ember); padding-bottom:10px; margin-bottom:26px; }
  .mark { font-family:"Cormorant Garamond",Georgia,serif; font-size:22pt; letter-spacing:.14em;
    text-transform:uppercase; color:var(--charcoal); }
  .doc-head .sub { font-size:8.5pt; letter-spacing:.06em; color:var(--stone); margin-top:3px; }
  h1 { font-family:"Cormorant Garamond",Georgia,serif; font-size:19pt; font-weight:600;
    color:var(--charcoal); margin:0 0 2px; }
  .meta { color:var(--stone); font-size:9.5pt; margin:0 0 22px; }
  h2 { font-family:"Cormorant Garamond",Georgia,serif; font-size:13pt; font-weight:600;
    color:var(--charcoal); margin:22px 0 7px; page-break-after:avoid; }
  p, li { margin:0 0 9px; }
  ul { margin:0 0 10px; padding-left:22px; }
  .clause { page-break-inside:auto; }
  .zh { font-family:"Noto Serif SC","Songti SC","STSong",SimSun,serif; font-size:10.5pt; color:var(--charcoal); }
  .zh.missing { color:var(--ember); background:#FFF4E8; border-left:3px solid #FF7B00;
    padding:8px 11px; font-family:Montserrat,sans-serif; font-size:9.5pt; }
  .why { font-size:9pt; color:var(--ember); background:#FAF8F5; border-left:3px solid var(--travertine);
    padding:6px 10px; margin:4px 0 12px; }
  table.fees { width:100%; border-collapse:collapse; margin:8px 0 14px; font-size:10.5pt; }
  table.fees th { text-align:left; font-size:8.5pt; letter-spacing:.06em; text-transform:uppercase;
    color:var(--stone); border-bottom:1px solid var(--travertine); padding:5px 8px; }
  table.fees td { padding:6px 8px; border-bottom:1px solid #F3EFE9; vertical-align:top; }
  .consent { background:#FFF4E8; border-left:3px solid #FF7B00; padding:10px 13px; }
  .siglet { font-size:10pt; color:var(--stone); }
  .rule { border-bottom:1px solid var(--charcoal); height:1.6em; }
  .rule.short { display:inline-block; width:1.6in; border-bottom:1px solid var(--charcoal); height:1em; }
  .signatures { margin-top:30px; page-break-inside:avoid; }
  .sigs { display:flex; gap:40px; margin-top:22px; }
  .sig { flex:1; }
  .sig .who { font-size:9.5pt; color:var(--stone); margin-top:5px; }
  .sig .when { font-size:9.5pt; color:var(--stone); margin-top:12px; }
  .offices { margin-top:36px; padding-top:14px; border-top:1px solid var(--travertine);
    font-size:8.5pt; color:var(--stone); display:flex; gap:22px; flex-wrap:wrap; }
  .offices .t { width:100%; font-family:"Cormorant Garamond",Georgia,serif; font-size:11pt;
    letter-spacing:.12em; text-transform:uppercase; color:var(--charcoal); margin-bottom:6px; }
  .offices .o { min-width:1.6in; }
  .offices .n { font-style:italic; }
  @media print {
    body { background:#FFFFFF; }
    .sheet { padding:0; max-width:none; }
    .why { display:none; }
  }
`;

/** The whole document as its own page, ready to read or print. */
function render(a, { forClient = true } = {}) {
  return `<!DOCTYPE html>
<html lang="${a.bilingual ? "en" : "en"}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Agreement for Legal Services — ${esc(a.client_name || "draft")}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@400;600&family=Montserrat:wght@400;600&family=Noto+Serif+SC:wght@400;600&display=swap" rel="stylesheet">
<style>${CSS}</style>
</head>
<body><div class="sheet">${body(a, { forClient })}</div></body>
</html>`;
}

module.exports = { render, body, feeSection, FIRM, CSS };
