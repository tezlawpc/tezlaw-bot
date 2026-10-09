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
//  One document, one audience. The margin notes that used to tell
//  the drafter which rule each clause satisfies are gone from the
//  rendered agreement -- "do not include the explanations in the
//  fee agreement" (JJ, 2026-10-07). The reasons themselves are not
//  lost: they stay on the clause as `because` in retainer.js, where
//  the drafting screen and check-retainer.js read them. `forClient`
//  is still accepted so existing callers keep working, and both
//  values now render the identical document.
// ============================================================

const R = require("./retainer");

const esc = (s) => String(s == null ? "" : s)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

const FIRM = {
  name: "TEZ Law Firm",          // public copy
  entity: "Tez Law P.C.",        // legal lines, signatures of record, fee agreements
  dba: "Tez Law P.C., doing business as TEZ Law Firm",
  subtitle: "A Professional Corporation",
  tagline: { en: "Protect your rights, we'll lead the fight.",
             zh: "守护您的权益，我们为您据理力争。" },
  attorney: "JJ Zhang, Esq.",
  phone: "626-678-8677",
  fax: "626-808-4994",
  email: "jj@tezlawfirm.com",
  web: "www.tezlawfirm.com",
  offices: [
    { city: "West Covina", lines: ["4141 S. Nogales St., Suite C102", "West Covina, CA 91792"] },
    { city: "City of Industry", lines: ["17800 Castleton St., Suite 234", "City of Industry, CA 91748"] },
    { city: "Newport Beach", lines: ["4343 Von Karman Ave., Suite 100 K", "Newport Beach, CA 92660"] },
    { city: "Flushing", lines: ["39-15 Main Street, Suite 418", "Flushing, NY 11354"], note: "immigration matters only" },
  ],
};

/**
 * The date printed on the paper.
 *
 * A stored "YYYY-MM-DD" is a calendar date, not an instant -- the same
 * contract court-calendar.js states at the top. `new Date("2026-10-07")`
 * is midnight UTC, which is 5pm on the 6th in Los Angeles, so formatting
 * it in Pacific printed the day before and the agreement was dated a day
 * early. Parse the three numbers and name the month; never convert.
 */
const MONTHS = ["January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"];

/**
 * What goes on the "Matter" line.
 *
 * It was blank on every agreement: the cover reads `matter_label` and the
 * form only ever collected `matter_type`, a code. A drafter can now write a
 * matter of their own, and when they do not, the matter type's own label
 * stands in -- a cover that says "Immigration: removal defense" is right,
 * and one that says nothing is not.
 */
function matterOf(a) {
  const written = String(a.matter_label || "").trim();
  if (written) return written;
  return (R.MATTER_LABELS && R.MATTER_LABELS[a.matter_type]) || "";
}

const longDate = (d) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(d || ""));
  if (m) return `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}, ${m[1]}`;
  const now = d ? new Date(d) : new Date();
  return now.toLocaleDateString("en-US", {
    timeZone: "America/Los_Angeles", year: "numeric", month: "long", day: "numeric",
  });
};

/**
 * The cover, from 03-Print-Pack/04-Client-Folder/TEZ-Fee-Agreement-Cover.
 *
 * The brand set includes a first page built for this exact document, so
 * this is that page with the blanks filled rather than a design decision
 * of mine. Its wording is the source of the document's title in both
 * languages and of the entity line at the foot.
 */
function coverPage(a) {
  const field = (label, value) => `
    <div class="cv-field">
      <div class="cv-rule"></div>
      <div class="cv-label">${esc(label)}</div>
      <div class="cv-value">${esc(value || "")}</div>
    </div>`;

  // The cover owns page one outright: it is positioned over the whole
  // sheet, letterhead artwork and all, so the firm's mark appears once
  // rather than twice. `.cover-slot` is the in-flow block that reserves
  // the page for it -- exactly one text box tall, so the letter starts
  // on page two whatever the cover contains.
  return `
    <div class="cover-slot">
    <section class="cover">
      <div class="cv-bars"><span class="cv-bar-orange"></span><span class="cv-bar-dark"></span></div>
      <img class="cv-logo" src="/brand/logo-light.svg" alt="TEZ Law">
      <div class="cv-eyebrow">Confidential &nbsp;·&nbsp; Privileged Attorney Communication</div>
      <h1 class="cv-title">Agreement for<br>Legal Services</h1>
      <div class="cv-title-zh">律师与客户委托收费协议</div>
      <div class="cv-fields">
        ${field("Client", a.client_name)}
        ${field("Matter", matterOf(a))}
        ${field("Responsible attorney", FIRM.attorney)}
        ${field("Date", longDate(a.agreement_date || a.date))}
      </div>
      <div class="cv-foot">
        <div>
          ${esc(FIRM.dba)}<br>
          ${esc(FIRM.offices[0].lines.join(", "))}<br>
          ${esc(FIRM.phone)} &nbsp;·&nbsp; ${esc(FIRM.email)}
        </div>
        <div class="cv-foot-right">
          Please read the full agreement<br>before signing. Keep a copy<br>for your records.
        </div>
      </div>
    </section>
    </div>`;
}

/**
 * The letterhead at the head of the letter.
 *
 * This used to be the firm's full-page 2550x3300 artwork dropped in as an
 * image, and that is what JJ was looking at when he said the alignment was
 * off. Three things were wrong with it at once. The image was scaled to the
 * 7.5in text column, so an 8.5in sheet lost 12% and the logo no longer sat
 * on the text's left margin. It was absolutely positioned against the whole
 * document, so it landed on the COVER and collided with the cover's own
 * mark -- two shields, two footers, overlapping. And nothing put it on page
 * two onwards, while the body still reserved 2.1in at the top of every page
 * for a header that was not there.
 *
 * So: the mark is set in HTML, in the text column, which makes it aligned
 * by construction rather than by a number that has to be kept in step with
 * the artwork. The rule is a border, not a background, so it prints whether
 * or not "Background graphics" is ticked. The firm's real sheet still goes
 * on every page of the Word export, which is where a per-page letterhead
 * actually works -- CSS cannot put one behind every printed page in Chrome,
 * and the fixed-position version of this was painting it once, mid-document.
 */
function letterhead(a) {
  void a;
  return `
    <div class="sheet-head">
    <div class="lh">
      <img class="lh-mark" src="/brand/logo-light.svg" alt="TEZ Law Firm">
      <div class="lh-tag">${esc(FIRM.tagline.en)}</div>
    </div>
    </div>`;
}

// The firm profile page is NOT part of the fee agreement.
//
// "i only meant to delete it from the retainer agreement." (JJ,
// 2026-10-09) It used to print at the back of every agreement. A fee
// agreement is a contract, and marketing copy bound into one is a second
// place to keep in step with Rules 7.1-7.3 every time the deck changes.
//
// The page itself is kept and is still the approved deck's own wording.
// It renders on its own at /admin/retainer/firm-profile, to print or
// attach when the firm wants it, so it stays something a person chooses
// to send rather than something every client signs.

/**
 * The firm profile page, from the firm's own deck.
 *
 * Verbatim from Tez-Law-Firm-Profile-EN_6 / -ZH_6. Advertising copy is
 * governed by Rules 7.1 to 7.3 and B&P 6157.2, and the firm has an open
 * State Bar matter, so nothing on this page is written here: it is the
 * approved deck's own wording, cut to one page.
 */
const PROFILE = {
  heading: { en: "About the firm", zh: "关于本所" },
  lead: {
    en: "Protecting your rights and your business, and helping it grow",
    zh: "守护您的权益与企业，助力企业成长",
  },
  body: {
    en: [
      "Tez Law P.C. protects people's rights and businesses and helps businesses grow. Our attorneys, case managers and paralegals work as one team for individuals, families, investors and companies. When a matter needs a fight, we will lead it.",
      "Our work covers immigration, disputes and litigation, real estate and construction, private client matters, intellectual property, and compliance for public companies.",
      "We litigate in the Los Angeles Superior Court and in the U.S. District Courts for the Central, Southern and Northern Districts of California and the District of Arizona, and take appeals to the U.S. Courts of Appeals for the Fifth and Ninth Circuits.",
      "We serve clients in English, Mandarin and Shanghainese, with Spanish support, from offices in West Covina, City of Industry and Newport Beach, and an immigration office in Flushing, New York.",
    ],
    zh: [
      "Tez Law P.C. 致力于守护个人权益与企业利益，并助力企业发展壮大。本所律师、案件经理及律师助理团队协同工作，为个人、家庭、投资人及企业提供服务。需要据理力争时，我们为您挺身而出。",
      "本所业务涵盖移民、诉讼与争议解决、房地产及工程、私人客户、知识产权，以及上市公司合规事务。",
      "本所律师在洛杉矶县高等法院，以及加州中区、南区、北区和亚利桑那州联邦地区法院出庭，并办理向联邦第五及第九巡回上诉法院提出的上诉。",
      "本所在西科维纳、工业市及纽波特比奇设有办公室，并在纽约法拉盛设有移民业务办公室，以英语、普通话和上海话提供服务，并可提供西班牙语协助。",
    ],
  },
  apart: {
    en: "What clients get from Tez Law",
    zh: "客户在 Tez Law 可以得到的服务",
  },
  points: [
    { en: ["Experienced litigators",
           "In state and federal courts: business, real estate and landlord tenant cases in Superior Court, and mandamus, APA and habeas actions in the U.S. District Courts."],
      zh: ["经验丰富的诉讼律师",
           "州法院与联邦法院均可出庭：在加州高等法院办理商业、房地产及房东租客案件，在联邦地区法院提起强制令、APA 及人身保护令诉讼。"] },
    { en: ["Business and property fluency",
           "Before law, the founding attorney ran hotels, ran a galvanized wire mill in China with U.S. distribution, built real estate projects and founded a mortgage lender."],
      zh: ["熟悉商业与房地产",
           "执业前，创始律师曾经营酒店、在中国经营镀锌线材厂并在美国分销、开发房地产项目，并创办房贷公司。"] },
    { en: ["Immigration at every stage",
           "USCIS filings, Immigration Court hearings, BIA appeals and petitions for review in the Fifth and Ninth Circuits, handled by one team."],
      zh: ["移民案件全程代理",
           "从移民局申请、移民法庭出庭、向移民上诉委员会（BIA）上诉，到向联邦第五及第九巡回上诉法院申请复审，均由同一团队负责。"] },
    { en: ["Technology enabled service",
           "Zara, the firm's digital assistant, takes messages and intake on WhatsApp, WeChat, Telegram and web chat."],
      zh: ["科技辅助的服务",
           "本所数字助理 Zara 可通过 WhatsApp、微信、Telegram 及网站在线接收留言和登记咨询。"] },
    { en: ["Bilingual, bicultural counsel",
           "Advice in English, Mandarin or Shanghainese, and written explanations of filings in Simplified Chinese."],
      zh: ["双语及跨文化的法律服务",
           "以英语、普通话或上海话提供咨询，并以简体中文书面解释各项申请文件。"] },
  ],
};

function firmProfilePage(a) {
  const zh = !!a.bilingual;
  const P = PROFILE;
  const paras = P.body.en.map((t, i) => `
    <p>${esc(t)}</p>
    ${zh ? `<p class="zh">${esc(P.body.zh[i])}</p>` : ""}`).join("");

  const points = P.points.map((p) => `
    <div class="fp-point">
      <div class="fp-point-t">${esc(p.en[0])}${zh ? ` · ${esc(p.zh[0])}` : ""}</div>
      <p>${esc(p.en[1])}</p>
      ${zh ? `<p class="zh">${esc(p.zh[1])}</p>` : ""}
    </div>`).join("");

  return `
    <section class="firm-profile">
      <h2 class="fp-h">${esc(P.heading.en)}${zh ? ` · ${esc(P.heading.zh)}` : ""}</h2>
      <p class="fp-lead">${esc(P.lead.en)}</p>
      ${zh ? `<p class="fp-lead zh">${esc(P.lead.zh)}</p>` : ""}
      ${paras}
      <div class="fp-apart">${esc(P.apart.en)}${zh ? ` · ${esc(P.apart.zh)}` : ""}</div>
      <div class="fp-points">${points}</div>
    </section>`;
}

// ── The fee section, which is where the statutes bite ────────

// A clause rendered inside the fee section. Bilingual drafts get the Chinese
// here too -- the fee terms are the last thing that should quietly appear in
// English only, because they are what the client is agreeing to pay.
function inlineClause(k, bilingual) {
  const c = R.CLAUSES[k];
  if (!c) return "";
  const zh = !bilingual ? ""
    : c.zh ? `<p class="zh">${esc(c.zh)}</p>`
    : `<p class="zh missing">[中文待律師撰寫: Chinese for this clause has not been written. Civ. Code § 1632: the client is held to the version in their own language.]</p>`;
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
      <p>You may be required to pay, out of your share of any recovery, amounts claimed by others, including
        medical providers, health plans and insurers asserting a lien or a right of subrogation.</p>
      <p><strong>The fee stated above is not set by law. It is negotiable between you and the firm.</strong></p>
      ${a.micra ? `<p>Because this is a claim against a health care provider, Business and Professions Code
        section 6146 limits the contingency fee that may be charged, and the fee above is subject to those limits.</p>` : ""}`);
  }

  // § 6148(a)(1) also wants the other charges, whatever the structure.
  parts.push(`
    <p>Costs and expenses (filing and government fees, service of process, translation, interpreters,
      couriers, records, experts, depositions and travel) are in addition to the fee${
      a.structure === "contingency" ? "" : " and are billed to you as they are incurred"}.
      We will tell you before incurring any single cost over ${R.money(a.cost_approval_threshold || 500)}.</p>`);

  return parts.join("\n");
}

/**
 * How to pay, and how not to be defrauded doing it.
 *
 * The account details come from the environment through firm-payment.js;
 * nothing here is in the repository. When they are not set the page prints
 * the warning and the methods and tells the client to call -- never a
 * placeholder that could be mistaken for an account number.
 */
function paymentPage(a) {
  const PAY = require("./firm-payment");
  const d = PAY.paymentDetails();
  const ready = PAY.isConfigured(d);
  const acct = PAY.accountFor(a, d);
  const zh = !!a.bilingual;

  const row = (label, value, labelZh) => value ? `
    <tr><th>${esc(label)}${zh && labelZh ? `<br><span class="zh">${esc(labelZh)}</span>` : ""}</th>
        <td>${esc(value)}</td></tr>` : "";

  return `
    <section class="payment">
      <h2 class="pay-h">Paying the firm${zh ? " · 付款方式" : ""}</h2>

      <div class="pay-warn">
        <div class="pay-warn-t">These are the only payment details we will ever send you.</div>
        <p>Wire fraud is common in legal matters. Someone who is reading email may send you a
          revised set of instructions from an address that is one character different from ours.
          <strong>We will never email you changed payment instructions.</strong> If you receive any,
          do not act on them, and telephone us on 626-678-8677, the number on our letterhead and
          on our website.</p>
        ${zh ? `<p class="zh">法律事務中的電匯詐騙十分常見：他人可能以與本所僅差一字的電郵地址，
          向您發送所謂「更新後」的付款指示。<strong>本事務所絕不會以電郵方式通知您變更付款資料。</strong>
          如收到此類訊息，請勿依其辦理，並請撥打 626-678-8677 與本所聯繫；該號碼印於本所信箋並載於本所網站。</p>` : ""}
      </div>

      ${ready ? `
      <p>${acct.kind === "trust"
        ? "Money you send before it is earned is held in the firm's client trust account."
        : "You have agreed in this Agreement that the flat fee may be deposited into the firm's operating account. Your right to a refund of any unearned part of it is not affected."}</p>
      ${zh ? `<p class="zh">${acct.kind === "trust"
        ? "您於費用賺取前所支付之款項，存放於本事務所之客戶信託帳戶。"
        : "您已於本協議中同意本事務所得將固定費用存入其營運帳戶；此不影響您就尚未賺取部分請求退還之權利。"}</p>` : ""}

      <table class="pay">
        ${row("Bank", d.bank, "銀行")}
        ${row("Account name", acct.name, "帳戶名稱")}
        ${row("Account number", acct.number, "帳號")}
        ${row("Routing number, wire", d.routing_wire, "電匯路由號碼")}
        ${row("Routing number, ACH and direct deposit", d.routing_ach, "ACH 及直接存款路由號碼")}
        ${row("Reference", PAY.referenceFor(a, d), "匯款備註")}
      </table>
      <p>The two routing numbers are different. Use the wire number for a wire and the ACH number
        for a direct deposit or an automatic payment; the wrong one will be returned.</p>
      ${zh ? `<p class="zh">上列兩組路由號碼並不相同：電匯請使用電匯號碼，直接存款或自動扣款請使用 ACH 號碼；
        使用錯誤者，款項將被退回。</p>` : ""}

      ${(d.swift_usd || d.swift_fx) ? `
      <p>From outside the United States:</p>
      <table class="pay">
        ${row("SWIFT, sending US dollars", d.swift_usd, "SWIFT 代碼（美元）")}
        ${row("Bank address", d.bank_address_usd, "銀行地址")}
        ${row("SWIFT, sending another currency", d.swift_fx, "SWIFT 代碼（外幣）")}
        ${row("Bank address", d.bank_address_fx, "銀行地址")}
      </table>
      <p>Your own bank may charge a fee for sending, and a bank in between may deduct one. Those
        charges are yours; the firm credits you with the amount it actually receives.</p>
      ${zh ? `<p class="zh">您的銀行可能收取匯費，中間行亦可能扣收費用；該等費用由您負擔，
        本事務所以實際收到之金額入帳。</p>` : ""}
      ` : ""}
      ` : `
      <p>Please telephone the office on 626-678-8677 for the account details. They are given by
        telephone rather than printed here.</p>
      ${zh ? `<p class="zh">請致電本所 626-678-8677 索取帳戶資料。該資料以電話提供，不印於本文件。</p>` : ""}
      `}

      <p>We also take ${d.zelle ? `Zelle to ${esc(d.zelle)}, ` : ""}a check payable to Tez Law P.C.
        at any of the firm's offices, which are on the letterhead, and a card in the office or by a
        payment link we send you. We do not take payment in cryptocurrency, by gift card, or in cash
        above $5,000.</p>
      ${zh ? `<p class="zh">本事務所亦接受${d.zelle ? `Zelle（${esc(d.zelle)}）、` : ""}支票（抬頭請寫 Tez Law P.C.，
        可送交本所任一辦公室（地址見本所信箋）），以及於辦公室刷卡或使用本所提供之付款連結。
        本事務所不接受加密貨幣、禮品卡，亦不接受超過 5,000 美元之現金。</p>` : ""}
    </section>`;
}

// ── The document ─────────────────────────────────────────────

// withLetterhead:false returns the agreement without the cover and
// without the letter's head. The Word exporter builds both natively -- a
// real cover page and a real first-page header -- so it asks for the body
// alone; passing it the whole thing printed the date, the Re line and the
// salutation twice.
function body(a, { forClient = true, withLetterhead = true } = {}) {
  const keys = R.clausesFor(a);
  const scope = (a.scope || []).filter(Boolean);
  const bilingual = !!a.bilingual;

  const clause = (k, n) => {
    const c = R.CLAUSES[k];
    if (!c) return "";
    const zh = bilingual && c.zh
      ? `<p class="zh">${esc(c.zh)}</p>`
      : bilingual
        ? `<p class="zh missing">[中文待律師撰寫: Chinese for this clause has not been written. Civ. Code § 1632: the client is held to the version in their own language, so this may not go out until a lawyer writes it.]</p>`
        : "";
    return `
      <section class="clause">
        <h2>${n}. ${esc(c.title.en)}${bilingual && c.title.zh ? ` · ${esc(c.title.zh)}` : ""}</h2>
        <p>${esc(c.en)}</p>
        ${zh}
      </section>`;
  };

  let n = 0;
  return `
    ${withLetterhead ? coverPage(a) : ""}

    ${withLetterhead ? letterhead(a) : ""}

    <h1>Agreement for Legal Services${bilingual ? " · 律师与客户委托收费协议" : ""}</h1>

    <p>This Agreement is between <strong>${esc(a.client_name)}</strong> ("you") and
      <strong>${esc(FIRM.entity)}</strong>, doing business as ${esc(FIRM.name)} ("we", "us" or "the firm").
      It sets out what we will do for you, what it will cost,
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
    </section>

    <section class="clause">
      <h2>${++n}. Fees and Costs${bilingual ? " · 費用" : ""}</h2>
      ${feeSection(a)}
    </section>

    <section class="clause">
      <h2>${++n}. What the Firm Will Do${bilingual ? " · 本事務所的責任" : ""}</h2>
      <p>We will provide the services described above with the care and skill the matter requires, keep you
        informed of significant developments, respond to your reasonable enquiries, and tell you promptly of any
        offer of settlement or any decision from a court or agency.</p>
      <p>We cannot and do not guarantee any particular result. No one can. Nothing said by anyone at the firm
        is a promise about the outcome of your matter.</p>
    </section>

    ${keys.map((k) => clause(k, ++n)).join("")}

    ${bilingual ? `<section class="clause">
      <h2>${++n}. ${esc(R.CLAUSES.language.title.en)} · ${esc(R.CLAUSES.language.title.zh)}</h2>
      <p>${esc(R.CLAUSES.language.en)}</p>
      <p class="zh">${esc(R.CLAUSES.language.zh)}</p>
    </section>` : ""}

    <section class="signatures">
      <h2>Agreed${bilingual ? " · 同意並簽署" : ""}</h2>
      <p>The firm signs first. Your signature below means you have read this Agreement, you understand it,
        and you agree to it.</p>
      <div class="sigs">
        <div class="sig">
          <div class="rule"></div>
          <!-- The P.C. alone: the dba is stated in the opening paragraph, and
               the full line wrapped to two, knocking the firm's date rule out
               of line with the client's. -->
          <div class="who">${esc(FIRM.entity)}</div>
          <div class="when">Date: <span class="rule short"></span></div>
        </div>
        <div class="sig">
          <div class="rule"></div>
          <div class="who">${esc(a.client_name)}</div>
          <div class="when">Date: <span class="rule short"></span></div>
        </div>
      </div>
    </section>

    ${paymentPage(a)}

`;
    // "office locations and phone numbers should just be in the firm's
    // profile. does not have to be a separate information." (JJ,
    // 2026-10-09) The footer that used to sit here repeated all four
    // offices and the phone, fax, email and web a third time: they are on
    // the letterhead at the head of the letter, and again in the profile
    // page at the back. Three copies of an address is three places to
    // correct when one of them moves.
}

const CSS = `
  /* The brand faces, served by this app. The Google Fonts link in the head
     stays as a fallback for a browser that cannot reach /brand-fonts, but
     these come first so the document is on the firm's letterhead even
     offline -- which is the case inside a print-to-PDF pipeline. */
  @font-face { font-family:"Cormorant Garamond"; font-weight:600;
    src:url("/brand-fonts/Brand-Cormorant-Bold.ttf") format("truetype"); font-display:swap; }
  @font-face { font-family:"Brand Sans"; font-weight:400;
    src:url("/brand-fonts/Brand-Montserrat-Regular.ttf") format("truetype"); font-display:swap; }
  @font-face { font-family:"Brand Sans"; font-weight:600;
    src:url("/brand-fonts/Brand-Montserrat-Bold.ttf") format("truetype"); font-display:swap; }
  @font-face { font-family:"Noto Serif SC"; font-weight:400;
    src:url("/brand-fonts/TezSerif-Regular.ttf") format("truetype"); font-display:swap; }
  @font-face { font-family:"Noto Serif SC"; font-weight:600;
    src:url("/brand-fonts/TezSerif-Bold.ttf") format("truetype"); font-display:swap; }

  /* ── Page geometry ──────────────────────────────────────────
     Measured off the artwork rather than guessed. The continuation
     sheet carries ink from 0.50in to 0.85in at the head and a rule at
     10.47in; the text box is set clear of both. The old 1.3in/1.0in
     came from the Word template's FIRST-page sheet, whose office block
     starts at 9.35in -- which is why body text was printing straight
     through the addresses. */
  @page { size: letter; margin: 1.15in 0.75in 0.8in; }

  /* Straight from the brand board. --orange is the Seal Orange of the logo
     and the rules; --ember is orange TEXT on light, which is a different
     colour and was being used for both. */
  :root { --ink:#1E1B1A; --charcoal:#2B2523; --orange:#FF7B00; --ember:#A34C00;
          --stone:#5E5854; --travertine:#E8E3DC; --marble:#FAF8F5;
          --pad-t:1.15in; --pad-x:0.75in; --pad-b:0.8in; }
  * { box-sizing: border-box; }

  /* ── The document's type ────────────────────────────────────
     "the font should be times new roman and 11 font." Times New Roman
     11pt throughout the agreement, headings included -- bold and, for
     the title, a little tracking, which is how a fee agreement is set.
     The cover keeps the brand faces: it is the brand's own artwork, not
     body text. Chinese pairs SimSun/Songti with Times, which is the
     pairing the firm's bilingual filings already use. */
  body { margin:0; background:var(--marble); color:var(--ink);
    font-family:"Times New Roman",Times,serif; font-size:11pt; line-height:1.45; }
  /* Justified, the way a contract is set. Hyphenation on, or justifying
     an 11pt serif in a 7in column opens rivers between the words. */
  p, li { text-align:justify; hyphens:auto; -webkit-hyphens:auto; }

  .sheet { width:8.5in; margin:0 auto; background:#FFFFFF; position:relative;
    padding:var(--pad-t) var(--pad-x) var(--pad-b); }

  /* The letterhead, set in the text column so it lines up with the body by
     construction. The rule is a border rather than a background so it
     survives a print with "Background graphics" unticked. */
  .lh { display:flex; align-items:flex-end; justify-content:space-between; gap:0.4in;
    border-bottom:1.5pt solid var(--orange); padding-bottom:9px; margin-bottom:0.42in; }
  .lh-mark { height:0.78in; width:auto; display:block; }
  .lh-tag { font-family:"Cormorant Garamond",Georgia,serif; font-size:11pt; font-style:italic;
    color:var(--ember); text-align:right; line-height:1.25; padding-bottom:2px; }

  /* ── The cover ──────────────────────────────────────────────
     Page one outright: .cover-slot is one text box tall, so the letter
     always begins on page two, and the cover itself is laid over the
     whole sheet so the firm's mark appears once instead of twice. */
  .cover-slot { page-break-after:always; break-after:page; }
  .cover { height:9.05in; overflow:hidden; display:flex; flex-direction:column;
    font-family:"Brand Sans",Montserrat,"Helvetica Neue",Arial,sans-serif; }
  /* Borders, not filled divs: a background does not print unless the person
     ticks "Background graphics", and these two bars are the brand's. */
  .cv-bars { border-top:7px solid var(--orange); border-bottom:16px solid var(--charcoal);
    height:0; margin-bottom:0.75in; }
  .cv-bar-orange, .cv-bar-dark { display:none; }
  .cv-logo { width:1.35in; height:auto; display:block; margin-bottom:0.9in; }
  .cv-eyebrow { font-size:8.5pt; letter-spacing:.18em; text-transform:uppercase;
    color:var(--ember); font-weight:600; margin-bottom:10px; }
  /* .cv-title is an h1, so it has to put back everything the body h1 rule
     sets -- the cover is the brand's artwork, not a section heading. */
  .cv-title { font-family:"Cormorant Garamond",Georgia,serif; font-weight:600; font-size:34pt;
    line-height:1.08; color:var(--charcoal); margin:0 0 6px;
    text-align:left; text-transform:none; letter-spacing:0; }
  .cv-title-zh { font-family:"Noto Serif SC",serif; font-size:19pt; color:var(--ember);
    margin-bottom:0.55in; }
  .cv-fields { display:grid; grid-template-columns:1fr 1fr; gap:24px 40px; }
  .cv-rule { border-top:1px solid var(--charcoal); margin-bottom:7px; }
  .cv-label { font-size:8pt; letter-spacing:.14em; text-transform:uppercase; color:var(--charcoal);
    font-weight:600; }
  .cv-value { font-size:11pt; color:var(--ink); margin-top:4px; min-height:1.2em; }
  .cv-foot { display:flex; justify-content:space-between; gap:30px; font-size:9pt;
    color:var(--stone); border-top:1px solid var(--travertine); padding-top:12px;
    margin-top:auto; }
  .cv-foot-right { text-align:right; }

  /* ── The firm profile, from the firm's own deck ─────────────  */

  .firm-profile { page-break-before:always; break-before:page; }
  .firm-profile .zh { margin-bottom:8px; }
  .fp-point p, .fp-point p, .pay-warn p, .cv-value, .siglet { text-align:left; hyphens:manual; }
  .fp-h { font-size:11pt; font-weight:bold; letter-spacing:.06em; text-transform:uppercase;
    text-align:center; margin:0 0 16px; }
  .fp-lead { font-weight:bold; margin:0 0 10px; }
  .fp-apart { font-weight:bold; margin:18px 0 8px; }
  .fp-points { display:grid; grid-template-columns:1fr 1fr; gap:10px 26px; }
  .fp-point p { margin:0 0 4px; }
  .fp-point-t { font-weight:bold; }

  /* ── Paying the firm ────────────────────────────────────────
     The warning is bordered rather than shaded: a background does not
     print unless the person ticks "Background graphics", and a warning
     that disappears when the document is printed is not a warning. */
  .payment { page-break-before:always; break-before:page; page-break-inside:auto; }
  .pay-h { font-size:11pt; font-weight:bold; letter-spacing:.06em; text-transform:uppercase;
    text-align:center; margin:0 0 16px; }
  .pay-warn { border:2pt solid var(--orange); padding:12px 14px; margin:0 0 16px;
    page-break-inside:avoid; break-inside:avoid; }
  .pay-warn-t { font-weight:bold; margin-bottom:7px; }
  .pay-warn p { margin:0 0 6px; }
  table.pay { width:100%; border-collapse:collapse; margin:0 0 12px;
    page-break-inside:avoid; break-inside:avoid; }
  table.pay th { text-align:left; width:2.2in; font-weight:bold; vertical-align:top;
    padding:5px 10px 5px 0; border-bottom:1px solid var(--travertine); }
  table.pay td { padding:5px 0; border-bottom:1px solid var(--travertine); }

  /* ── The letter ─────────────────────────────────────────────
     No top padding any more: the page box already clears the artwork,
     and the 2.1in that used to sit here was reserving room for a header
     that had been pushed onto the cover. */
  .letter { padding-top:0; }
  .letter p { margin:0 0 6px; }
  .letter .date { margin-bottom:14px; }
  .letter .re { margin-top:12px; }
  .letter .dear { margin-top:12px; }

  h1 { font-family:"Times New Roman",Times,serif; font-size:11pt; font-weight:bold;
    letter-spacing:.06em; text-transform:uppercase; text-align:center;
    color:var(--ink); margin:26px 0 18px; }
  h2 { font-family:"Times New Roman",Times,serif; font-size:11pt; font-weight:bold;
    color:var(--ink); margin:16px 0 5px; page-break-after:avoid; break-after:avoid; }
  p, li { margin:0 0 8px; }
  ul { margin:0 0 9px; padding-left:24px; }
  .clause { page-break-inside:auto; }
  .zh { font-family:"Noto Serif SC","Songti SC","STSong",SimSun,serif;
    font-size:10.5pt; line-height:1.6; color:var(--ink); }
  .zh.missing { color:var(--ember); font-style:italic; }
  table.fees { width:100%; border-collapse:collapse; margin:8px 0 12px; font-size:10.5pt;
    page-break-inside:avoid; break-inside:avoid; }
  table.fees th { text-align:left; font-size:10pt; font-weight:bold;
    border-bottom:1px solid var(--charcoal); padding:5px 8px 4px; }
  table.fees td { padding:5px 8px; border-bottom:1px solid var(--travertine); vertical-align:top; }
  .consent { border:1px solid var(--charcoal); padding:9px 12px; margin:10px 0; }
  .siglet { font-size:10.5pt; }
  /* A signature's width, not half the page. */
  .rule { border-bottom:1px solid var(--charcoal); height:1.6em; width:2.6in; }
  .rule.short { display:inline-block; width:1.6in; border-bottom:1px solid var(--charcoal); height:1em; }
  .signatures { margin-top:28px; page-break-inside:avoid; break-inside:avoid; }
  .sigs { display:flex; gap:0.7in; margin-top:20px; }
  .sig { width:2.6in; }
  .sig .who { font-size:10pt; margin-top:5px; white-space:nowrap; }
  .sig .when { font-size:10pt; margin-top:12px; }
  /* Ran off the bottom of the last page and lost the New York office.
     Kept together, and allowed its own page if that is what it takes. */
  /* A footer, not a section. Four stacked columns of addresses were as
     loud as the agreement; this is one quiet line under a hairline. */

  /* ── Screen only ────────────────────────────────────────────  */
  .actions { width:8.5in; margin:0 auto; padding:14px 0 10px; display:flex; gap:10px;
    align-items:center; flex-wrap:wrap; }
  .actions form { margin:0; }
  .btn { display:inline-block; background:#F3EFE9; color:var(--charcoal); border:1px solid var(--travertine);
    padding:9px 16px; border-radius:6px; text-decoration:none; font-size:10pt; font-weight:600; cursor:pointer;
    font-family:"Brand Sans",Montserrat,sans-serif; }
  .btn.primary { background:var(--ember); color:#FFFFFF; border-color:var(--ember); }
  .btn.dark { background:var(--charcoal); color:#FFFFFF; border-color:var(--charcoal); }
  .btn.plain { background:transparent; border-color:transparent; color:var(--stone); font-weight:400; }
  .actions .hint { font-size:9pt; color:var(--stone); font-style:italic;
    font-family:"Brand Sans",Montserrat,sans-serif; }
  @media screen {
    .sheet { box-shadow:0 1px 3px rgba(43,37,35,.14), 0 10px 30px rgba(43,37,35,.07);
      margin-bottom:0.4in; }
  }

  @media print {
    body { background:#FFFFFF; }
    /* @page supplies the margins now, so the sheet is the bare paper. */
    .sheet { width:auto; padding:0; box-shadow:none; margin:0; }
    .no-print { display:none !important; }
  }
`;

/**
 * The bar across the top of the print view.
 *
 * "after clicking open and print at the end, there is no button to send for
 *  esign or print or export as word or pdf."
 *
 * It was a dead end: the buttons were all on the review page behind it.
 * Four plain links and one form, screen-only.
 *
 * On PDF: this prints to one through the browser's own dialog, which is
 * what the firm already does. The URL and timestamp across the top of the
 * copy JJ sent back are the browser's "Headers and footers" setting, not
 * something a stylesheet can turn off -- untick it in the print dialog and
 * the page is clean.
 *
 * THE PRINT BUTTON IS A BUTTON, NOT A javascript: LINK. It was
 * href="javascript:window.print()", which Safari treats as a navigation:
 * it starts replacing the document, and the dialog prints the
 * replacement. The copy JJ sent on 2026-10-09 was one blank page, 901
 * bytes, Creator "Safari". public/print-view.js wires the button instead.
 */
function actionBar(id) {
  if (!id) return "";
  return `
    <div class="actions no-print">
      <button type="button" id="print-this" class="btn primary">Print &nbsp;/&nbsp; Save as PDF</button>
      <a class="btn" href="/admin/retainer/${encodeURIComponent(id)}/word">Download Word</a>
      <form method="POST" action="/admin/retainer/${encodeURIComponent(id)}/send">
        <button type="submit" class="btn dark">Send for signature</button>
      </form>
      <a class="btn plain" href="/admin/retainer/${encodeURIComponent(id)}">Back to the draft</a>
      <span class="hint">In the print dialog, untick <em>Headers and footers</em> to drop the URL and date.
        This view puts the firm's mark at the head of the letter; the Word file puts the full
        letterhead sheet on every page, which is what to send when that matters.</span>
    </div>`;
}

/** The whole document as its own page, ready to read or print. */
function render(a, { forClient = true, id = null } = {}) {
  return `<!DOCTYPE html>
<html lang="${a.bilingual ? "en" : "en"}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Agreement for Legal Services: ${esc(a.client_name || "draft")}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@400;600&family=Montserrat:wght@400;600&family=Noto+Serif+SC:wght@400;600&display=swap" rel="stylesheet">
<style>${CSS}</style>
</head>
<body>${actionBar(id)}<div class="sheet">${body(a, { forClient })}</div>${
  id ? require("./client-script").clientScriptTag("print-view.js") : ""}</body>
</html>`;
}

module.exports = { render, body, feeSection, letterhead, coverPage, actionBar, firmProfilePage, paymentPage, matterOf, FIRM, PROFILE, CSS };
