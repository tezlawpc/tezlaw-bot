// ============================================================
//  retainer.js — the fee agreement, as data
//  TEZ Law Firm (Tez Law P.C.)
//  ─────────────────────────────────────────────────────────
//  "let me upload all the templates and the tara allows enter
//   name, scope of the work (AI generated after minimal info),
//   fee then it will generate the agreement, after view all good
//   can sent out for signature."
//
//  Seventeen templates went in; one comes out, with the fee
//  structure, the scope and the language chosen per engagement.
//
//  WHAT IS LOAD-BEARING HERE
//
//  § 6148 — any matter likely to exceed $1,000 in fees needs a
//  written agreement stating the hourly rates and other charges,
//  the general nature of the services, and what each side is
//  responsible for. Missing any of the three makes the agreement
//  voidable by the client, and the firm is then held to a
//  reasonable fee.
//
//  § 6147 — a contingency agreement needs five disclosures,
//  including, in these words, that the fee is not set by law and
//  is negotiable. Also voidable without them.
//
//  Rule 1.5(d) — a fee may NOT be denominated "earned on
//  receipt" or "non-refundable". State Bar Formal Opinion
//  2026-210 holds that such a clause violates 1.5(d) and may be
//  deceit under 8.4(c). So a flat fee here is earned against
//  milestones, never against the signature. JJ asked for "earned
//  upon signing"; this is the compliant form of the same intent
//  — the early milestones carry most of the fee, because in
//  immigration most of the work really is at the start.
//
//  Rule 1.15(b) — a flat fee may go to the operating account
//  only if the agreement discloses the client's right to require
//  trust deposit until earned AND the right to a refund of what
//  is unearned; over $1,000 both must be in a writing the client
//  signs. This agreement is that writing.
//
//  Rule 1.16(e)(2) — unearned fees are refunded promptly on
//  termination, whatever the agreement says.
//
//  Civ. Code § 1632 — where the deal is negotiated mainly in
//  Chinese, the client gets a translation BEFORE signing. The
//  Chinese is therefore the version the client is held to have
//  understood, which is why this file will not invent it: a
//  clause whose Chinese did not come from the firm's own signed
//  templates is emitted with a marker saying so, and the page
//  refuses to call such a draft ready to send.
// ============================================================

// ── The rate card ────────────────────────────────────────────
// § 6148(a)(1) wants the hourly rates stated. Only the people who
// bill by the hour are listed; JJ: "other does not have fee
// structure on it."
const RATES = [
  { name: "JJ Zhang", role: "Founding Attorney", rate: 650 },
  { name: "Chujun (Chandler) Jin", role: "Attorney", rate: 350 },
  { name: "Lin Mei", role: "Senior Paralegal", rate: 200 },
];

const FEE_STRUCTURES = ["flat", "hourly", "contingency", "hybrid"];

// ── How a flat fee is earned ─────────────────────────────────
//
// Front-loaded on purpose and editable per engagement ("for other
// cases, its different based on case and clients"). What makes it
// defensible is that each line names work that is actually done,
// so the fee is earned by doing it rather than by the client
// signing.
const FLAT_MILESTONES = {
  immigration: [
    { pct: 40, work: "Case assessment, eligibility analysis and filing strategy" },
    { pct: 30, work: "Collecting and reviewing documents, and preparing the forms and supporting package" },
    { pct: 20, work: "Filing, and responding to any request for evidence or notice of intent to deny" },
    { pct: 10, work: "Interview or hearing preparation and appearance, and closing the matter" },
  ],
  default: [
    { pct: 40, work: "Case assessment, analysis and strategy" },
    { pct: 40, work: "Preparing and filing the work described in the scope" },
    { pct: 20, work: "Completing the matter, including any follow-up required by the court or agency" },
  ],
};

// ── Scope presets ────────────────────────────────────────────
// The "prefixed description" JJ asked for: a starting line per
// matter type that the drafter edits, or hands to the model to
// expand from a few words. Nothing here is sent without being read.
const SCOPE_PRESETS = {
  immigration_removal: [
    "Represent you in removal proceedings before the Immigration Court, including master calendar hearings",
    "Prepare and file an application for asylum, withholding of removal and protection under the Convention Against Torture",
    "File and attend a bond redetermination hearing",
    "Prepare and file a motion to reopen or reconsider",
  ],
  immigration_family: [
    "Prepare and file a family-based immigrant petition and the accompanying application for adjustment of status",
    "Prepare and file a consular processing package through the National Visa Center",
    "Prepare and file an application for a waiver of inadmissibility",
  ],
  immigration_business: [
    "Prepare and file an employment-based immigrant petition, including the supporting evidence of the employer's ability to pay",
    "Prepare and file an EB-5 investor petition, including the source-of-funds documentation",
    "Prepare and file a nonimmigrant worker petition",
  ],
  immigration_naturalization: [
    "Prepare and file an application for naturalization, and represent you at the examination",
  ],
  federal_litigation: [
    "Prepare and file a petition for writ of habeas corpus in the United States District Court",
    "Prepare and file a complaint in mandamus to compel adjudication of a pending application",
  ],
  civil_litigation: [
    "Represent you as plaintiff in a civil action, through trial",
    "Represent you as defendant in a civil action, through trial",
    "Represent you in a business dispute, including pre-litigation demand and negotiation",
  ],
  landlord_tenant: [
    "Represent you as landlord in an unlawful detainer action, through trial",
    "Represent you as tenant in an unlawful detainer action",
  ],
  personal_injury: [
    "Represent you in a claim for personal injury arising out of the incident described below, including negotiation with the insurers and, if necessary, filing suit",
  ],
  real_estate: [
    "Represent you in a real property transaction, including review of the purchase agreement and closing documents",
  ],
  estate_planning: [
    "Prepare a revocable living trust, a will, powers of attorney and an advance health care directive",
  ],
  trademark: [
    "Prepare and file a trademark application with the USPTO, and respond to any office action",
  ],
};

const MATTER_LABELS = {
  immigration_removal: "Immigration — removal defense",
  immigration_family: "Immigration — family",
  immigration_business: "Immigration — business and investor",
  immigration_naturalization: "Immigration — naturalization",
  federal_litigation: "Federal litigation",
  civil_litigation: "Business and civil litigation",
  landlord_tenant: "Landlord / tenant",
  personal_injury: "Personal injury",
  real_estate: "Real estate",
  estate_planning: "Estate planning",
  trademark: "Trademarks",
};

// ── Clauses ──────────────────────────────────────────────────
//
// `zh` is present only where the Chinese came from the firm's own
// executed templates. Where it is null the clause is new and its
// Chinese has to be written by a lawyer before a bilingual draft
// goes to a client — see § 1632 above. `needsZh` is what the page
// reads to refuse to mark such a draft ready.
const CLAUSES = {
  cooperation: {
    title: { en: "Client Cooperation", zh: "客戶配合" },
    en: "On those matters covered under the scope of services, we agree to provide those services reasonably required to represent you, to take reasonable steps to keep you informed of developments in such matter, and to respond to your reasonable inquiries. You agree to cooperate fully with us, to provide us with truthful information pertaining to such matters, to keep us informed of developments, to abide by this Agreement, and to pay our bills in a timely manner as required by this Agreement.",
    zh: "就前述服務，本事務所同意代表您辦理合理的事務，並在合理的範圍內向您即時提供該事務的進展且回答您的問題。您同意與我們配合，提供該事務的相關正確資訊及進展，遵守此協定書的條約及條款，以及及時支付前述相關費用。",
  },
  translation: {
    title: { en: "Translation of Documents", zh: "文件翻譯" },
    en: "We do not provide translation services. All English translations of documents relating to you and/or your dependents must be provided to us by you. If you would like a referral to a translation service, please ask us.",
    zh: "我們不提供翻譯服務。您必須提供所有與您和/或您的家屬的所有相關中文檔的英文翻譯。如果您需要我們介紹翻譯公司，請與我們聯繫。",
  },
  termination: {
    title: { en: "Ending the Representation", zh: "終止服務" },
    en: "You may discharge us at any time. We may withdraw with your consent, for good cause, or as permitted by the Rules of Professional Conduct. Good cause includes your breach of this Agreement, failure to pay our bills when due, refusal to cooperate with us, an irreconcilable disagreement about how the matter should be conducted, or any circumstance that would make our continued representation unreasonable or contrary to law or those rules. Where a tribunal's permission is required to withdraw, we will seek it. On termination we will be paid for all services rendered and all costs incurred on your behalf through that date, and we will promptly refund any part of a fee that has not been earned.",
    zh: "您可以在任何時候解除雙方的關係。本事務所也有權因正當理由在您或相關法律的允許下終止服務。正當理由包括但不限於您違反合約條款，您未能在規定時限內付清應付費用，您拒絕與我們配合，雙方就前述事務發生不可調和的矛盾，發生任何事件或情況導致我們無法繼續為您提供服務，包括繼續提供服務將成為不合理行為，違反法律法規或職業道德。在雙方解除關係之日，您須向本事務所支付所有應付費用以及在關係解除日前本事務所就辦理您的申請而承擔的所有相關費用。",
  },
  acknowledgment: {
    title: { en: "Acknowledgment", zh: "確認" },
    en: "You acknowledge that you have read and understood the foregoing terms and agree to them as of the date TEZ Law Firm first provided services. If you have any question at any time about the scope of our representation, the handling of any matter, or the content of any invoice, please contact us at once.",
    zh: "您在此確認您已閱讀、瞭解和同意此協定的條約和條款及服務範圍。如果您對此協定，本事務所提供的服務或相關費用有任何問題，請及時與我們聯繫。",
  },
  language: {
    title: { en: "Language and Translation", zh: "語言與翻譯" },
    en: "This Agreement has been translated and explained to you in your native language, and you have read and understood its terms and agree to them as of its date. In the event of a conflict in meaning between the English and the translation, the English version controls.",
    zh: "您在此確認此協定內容已用中文翻譯解釋給您知道。而您也已閱讀、瞭解和同意此協定的條約和條款及服務範圍。如果此協定的英文和中文翻譯意思上有任何衝突，此協定內容以英文版為主。",
  },

  // ── New clauses. Chinese deliberately absent. ──
  flat_fee_earning: {
    title: { en: "How a Flat Fee Is Earned", zh: null },
    en: "The flat fee is earned as the work described below is performed, in the proportions shown. It is not earned merely because this Agreement has been signed, and it is not non-refundable. If the representation ends before the work is complete, you are entitled to a prompt refund of the portion of the fee that has not been earned.",
    zh: null,
    because: "Rule 1.5(d) and State Bar Formal Opinion 2026-210: a fee may not be denominated earned-on-receipt or non-refundable.",
  },
  flat_fee_deposit: {
    title: { en: "Where the Flat Fee Is Held", zh: null },
    en: "You have the right to require that the flat fee be deposited into the firm's client trust account and withdrawn only as it is earned. If you instead agree, by signing below, the firm may deposit the flat fee into its operating account. Either way, you remain entitled to a refund of any amount of the fee that has not been earned if the representation is terminated or the services paid for are not completed.",
    zh: null,
    because: "Rule 1.15(b)(1)–(2): the disclosure and, above $1,000, the client's signed agreement.",
  },
  insurance: {
    title: { en: "Professional Liability Insurance", zh: null },
    en: "The firm maintains professional liability insurance applicable to the services to be provided under this Agreement.",
    zh: null,
    because: "Rule 1.4.2: disclosure required where the lawyer knows or should know the firm does not carry it; stated affirmatively here.",
  },
  fee_dispute: {
    title: { en: "If You Disagree With a Fee", zh: null },
    en: "If a dispute arises over fees or costs, you may require that it be resolved by the State Bar's Mandatory Fee Arbitration program under Business and Professions Code sections 6200 and following. That arbitration is voluntary for you and mandatory for the firm, and it is not binding unless both of us agree in writing, after the dispute has arisen, to make it binding. Nothing in this Agreement waives that right.",
    zh: null,
    because: "§ 6200(c) and Arbitration Advisory 1998-01: a pre-dispute agreement to binding arbitration of fees is unenforceable.",
  },
};

// The numbered clauses that follow the fee section.
//
// The flat-fee clauses are deliberately NOT here: retainer-doc's fee section
// renders them in place, where the money is, and listing them again produced
// a document that stated its own fee terms twice. A fee agreement that says
// the same thing twice invites an argument about which one governs.
function clausesFor({ structure } = {}) {
  const keys = ["cooperation", "translation", "insurance", "fee_dispute", "termination"];
  keys.push("acknowledgment");
  return keys;
}

// The flat-fee clauses the fee section renders itself.
function feeClausesFor({ structure } = {}) {
  return (structure === "flat" || structure === "hybrid")
    ? ["flat_fee_earning", "flat_fee_deposit"] : [];
}

// Every clause in the finished document, wherever it is rendered. This is
// what the § 1632 check has to look at: a clause missing its Chinese is a
// problem whether it sits in the fee section or in the numbered list.
function allClausesFor(a = {}) {
  return [...feeClausesFor(a), ...clausesFor(a), ...(a.bilingual ? ["language"] : [])];
}

/**
 * Everything that would stop this draft going to a client.
 *
 * Returned rather than thrown: the drafter should see the whole
 * list at once, not discover them one at a time.
 */
function problemsWith(a = {}) {
  const out = [];
  const fee = Number(a.total_fee || 0);

  if (!a.client_name) out.push("The client's name is missing.");
  if (!a.matter_type) out.push("Pick a matter type.");
  if (!Array.isArray(a.scope) || !a.scope.filter(Boolean).length) {
    out.push("The scope of work is empty. § 6148(a)(2) requires the general nature of the services to be stated.");
  }
  if (!FEE_STRUCTURES.includes(a.structure)) out.push("Pick a fee structure.");

  if (a.structure === "flat" || a.structure === "hybrid") {
    if (!fee) out.push("State the flat fee.");
    const ms = Array.isArray(a.milestones) ? a.milestones : [];
    const total = ms.reduce((n, m) => n + Number(m.pct || 0), 0);
    if (!ms.length) out.push("A flat fee needs milestones saying how it is earned.");
    else if (total !== 100) out.push(`The milestones add up to ${total}%, not 100%.`);
    if (fee >= 1000 && !a.operating_account_consent) {
      out.push("Over $1,000, rule 1.15(b)(2) needs the client's signed agreement to the flat fee going into the operating account — tick it, or hold the fee in trust.");
    }
  }

  if (a.structure === "hourly" || a.structure === "hybrid") {
    if (!Array.isArray(a.timekeepers) || !a.timekeepers.length) {
      out.push("§ 6148(a)(1) requires the hourly rates to be stated — pick at least one timekeeper.");
    }
  }

  if (a.structure === "contingency") {
    if (!a.contingency_pct) out.push("State the contingency percentage.");
    if (!a.costs_borne_by) out.push("§ 6147(a)(2) requires saying how costs affect the fee and the recovery.");
  }

  // § 1632: a bilingual draft may not carry a clause whose Chinese
  // nobody has written. The English alone is not what the client is
  // held to have understood.
  if (a.bilingual) {
    const missing = allClausesFor(a).filter((k) => CLAUSES[k] && !CLAUSES[k].zh);
    if (missing.length) {
      out.push(
        `Chinese is missing for ${missing.length} clause${missing.length === 1 ? "" : "s"}: `
        + missing.map((k) => CLAUSES[k].title.en).join(", ")
        + ". Under Civ. Code § 1632 the Chinese is the version the client is held to have understood, "
        + "so a lawyer has to write it before this goes out. It is not something to machine-translate."
      );
    }
  }
  return out;
}

const money = (n) => "$" + Number(n || 0).toLocaleString("en-US", { minimumFractionDigits: 0 });

module.exports = {
  RATES, FEE_STRUCTURES, FLAT_MILESTONES, SCOPE_PRESETS, MATTER_LABELS,
  CLAUSES, clausesFor, feeClausesFor, allClausesFor, problemsWith, money,
};
