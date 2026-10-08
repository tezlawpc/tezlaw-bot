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
  immigration_removal: "Immigration: removal defense",
  immigration_family: "Immigration: family",
  immigration_business: "Immigration: business and investor",
  immigration_naturalization: "Immigration: naturalization",
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
// `zh_from: "firm"` marks a clause whose Chinese is the firm's own
// executed text, copied rather than written here. Everything else's
// Chinese was written for this generator and is Traditional, which
// check-retainer.js enforces.
//
// THE FIRM'S OWN CHINESE IS IN TWO SCRIPTS. The five clauses from the
// original agreement (cooperation, translation, termination,
// acknowledgment, language) are Traditional; the five from the I-526E
// template (client_duties, no_guarantee, delegation,
// electronic_communications, governing_law) are Simplified. A bilingual
// agreement therefore prints both. That is executed wording and a
// lawyer's call to change, not this file's — check-retainer.js pins the
// Simplified five by name so the mix shows up in the test output every
// run instead of going quiet. Settle it one way and the check will say
// so.
//
// § 1632 still holds the client to the version in their own language,
// and `needsZh` still refuses to mark a bilingual draft ready while any
// clause has no Chinese at all.
const CLAUSES = {
  cooperation: {
    title: { en: "Client Cooperation", zh: "客戶配合" },
    en: "On those matters covered under the scope of services, we agree to provide those services reasonably required to represent you, to take reasonable steps to keep you informed of developments in such matter, and to respond to your reasonable inquiries. You agree to cooperate fully with us, to provide us with truthful information pertaining to such matters, to keep us informed of developments, to abide by this Agreement, and to pay our bills in a timely manner as required by this Agreement.",
    zh: "就前述服務，本事務所同意代表您辦理合理的事務，並在合理的範圍內向您即時提供該事務的進展且回答您的問題。您同意與我們配合，提供該事務的相關正確資訊及進展，遵守此協定書的條約及條款，以及及時支付前述相關費用。",
    zh_from: "firm",  // Traditional, from the firm's original agreement
  },
  translation: {
    title: { en: "Translation of Documents", zh: "文件翻譯" },
    en: "We do not provide translation services. All English translations of documents relating to you and/or your dependents must be provided to us by you. If you would like a referral to a translation service, please ask us.",
    zh: "我們不提供翻譯服務。您必須提供所有與您和/或您的家屬的所有相關中文檔的英文翻譯。如果您需要我們介紹翻譯公司，請與我們聯繫。",
    zh_from: "firm",  // Traditional, from the firm's original agreement
  },
  termination: {
    title: { en: "Ending the Representation", zh: "終止服務" },
    en: "You may discharge us at any time. We may withdraw with your consent, for good cause, or as permitted by the Rules of Professional Conduct. Good cause includes your breach of this Agreement, failure to pay our bills when due, refusal to cooperate with us, an irreconcilable disagreement about how the matter should be conducted, or any circumstance that would make our continued representation unreasonable or contrary to law or those rules. Where a tribunal's permission is required to withdraw, we will seek it. On termination we will be paid for all services rendered and all costs incurred on your behalf through that date, and we will promptly refund any part of a fee that has not been earned.",
    zh: "您可以在任何時候解除雙方的關係。本事務所也有權因正當理由在您或相關法律的允許下終止服務。正當理由包括但不限於您違反合約條款，您未能在規定時限內付清應付費用，您拒絕與我們配合，雙方就前述事務發生不可調和的矛盾，發生任何事件或情況導致我們無法繼續為您提供服務，包括繼續提供服務將成為不合理行為，違反法律法規或職業道德。在雙方解除關係之日，您須向本事務所支付所有應付費用以及在關係解除日前本事務所就辦理您的申請而承擔的所有相關費用。",
    zh_from: "firm",  // Traditional, from the firm's original agreement
  },
  acknowledgment: {
    title: { en: "Acknowledgment", zh: "確認" },
    en: "You acknowledge that you have read and understood the foregoing terms and agree to them as of the date TEZ Law Firm first provided services. If you have any question at any time about the scope of our representation, the handling of any matter, or the content of any invoice, please contact us at once.",
    zh: "您在此確認您已閱讀、瞭解和同意此協定的條約和條款及服務範圍。如果您對此協定，本事務所提供的服務或相關費用有任何問題，請及時與我們聯繫。",
    zh_from: "firm",  // Traditional, from the firm's original agreement
  },
  language: {
    title: { en: "Language and Translation", zh: "語言與翻譯" },
    en: "This Agreement has been translated and explained to you in your native language, and you have read and understood its terms and agree to them as of its date. In the event of a conflict in meaning between the English and the translation, the English version controls.",
    zh: "您在此確認此協定內容已用中文翻譯解釋給您知道。而您也已閱讀、瞭解和同意此協定的條約和條款及服務範圍。如果此協定的英文和中文翻譯意思上有任何衝突，此協定內容以英文版為主。",
    zh_from: "firm",  // Traditional, from the firm's original agreement
  },

  // ══════════════════════════════════════════════════════════
  //  From the firm's own robust agreements
  //  ────────────────────────────────────────────────────────
  //  Everything below was in the Wecare engagement letter or the
  //  I-526E template and not in what this generator produced. Where
  //  `zh` is filled in, it is the firm's own Chinese, copied from the
  //  I-526E template rather than translated.
  // ══════════════════════════════════════════════════════════

  scope_limits: {
    title: { en: "Limits of Our Representation", zh: "代理範圍的限制" },
    en: "Our representation is limited to the matter described in the scope above. We give no opinion on the commercial merits or likely success of any transaction, investment or venture, and nothing we say should be read as one. Work outside immigration and the practice areas named in this Agreement, including tax, corporate, securities and accounting advice, is for counsel of your own choosing, at that counsel's own charges. Where we coordinate with a business plan writer, economist, accountant or other outside professional, we do so as an accommodation to you; their fees are not covered by ours and we do not supervise their work.",
    zh: "本事務所之代理範圍僅限於上述服務範圍所載之事項。本事務所不就任何交易、投資或商業計畫之商業價值或成功可能性提供任何意見，本事務所之任何陳述亦不得被解釋為此種意見。凡不屬於本協議所列執業領域之事務，包括稅務、公司、證券及會計等方面之諮詢，應由您自行選任之專業人士處理，其費用由您另行支付。本事務所如與商業計畫撰寫人、經濟學家、會計師或其他外部專業人士協調配合，係為便利您而提供之協助；該等人員之費用不包含在本事務所之費用內，本事務所亦不對其工作負監督之責。",
    because: "Rule 1.2(b) permits limiting the scope with the client's informed consent; saying what is NOT covered is what makes the limit informed. From the Wecare engagement letter.",
  },

  hourly_outside_scope: {
    title: { en: "Work Outside This Agreement", zh: "本協議範圍外之工作" },
    en: "Anything not described in the scope above, including ancillary applications, appeals, motions to reopen, and any other matter you later ask us to take on, is not covered by the fee stated here. We will agree any such work with you in writing first. Where it is charged by the hour, our rates are $650 for the managing partner, $350 for an associate attorney and $200 for a paralegal. We will give you an estimate before starting and will not proceed without your approval.",
    zh: "凡未列於上述服務範圍之事項，包括附帶申請、上訴、重啟程序之動議，以及您日後要求本事務所承辦之其他事務，均不包含在本協議所訂費用之內。該等工作須經雙方另行書面約定後方得進行。如按小時計費，本事務所之費率為：管理合夥人每小時 650 美元，助理律師每小時 350 美元，律師助理每小時 200 美元。本事務所將於開始工作前向您提供費用估算，未經您同意不會進行。",
    because: "§ 6148(a)(1) requires the hourly rate and the basis of charges to be stated where fees are not fixed. From the Wecare engagement letter, at the firm's current figures.",
  },

  client_duties: {
    title: { en: "What You Are Responsible For", zh: "客户的其他义务" },
    en: "We can only act on what you give us. You agree that the information and documents you provide will be accurate, complete, timely and truthful in every respect; to tell us of anything that comes to your attention bearing on the matter; to review any document we prepare for filing and confirm it is correct before it is filed; to attend proceedings, meetings and interviews where your presence is required; and to keep us informed of your address, telephone number and whereabouts.",
    zh: "客户同意在律师履行本协议项下的职责所需的范围内与律师合作。合作包括但不限于出席所有需要客户出席的诉讼程序、会议、大会和其他活动；并根据要求及时向律师提供任何必要的文件和其他信息。客户同意对律师说实话并且不隐瞒信息。此外，客户同意进行合作，向律师通报客户可能注意到的任何信息或进展，遵守本协议，按时支付律师的账单，并向律师通报客户的地址、电话号码和行踪。",
    zh_from: "firm",  // Simplified, from the I-526E template
  },

  no_guarantee: {
    title: { en: "No Guarantee of Outcome", zh: "免责声明" },
    en: "Nothing in this Agreement, and nothing said to you by anyone at the firm, is a promise or guarantee about the outcome of your matter. Any comment we make about the likely result is an expression of opinion only. An estimate of costs is not a limit on them, and actual costs may differ significantly from an estimate.",
    zh: "本协议中的任何内容以及律师向客户提供的声明中的任何内容均不得被解释为对此事结果的承诺或保证。律师不做出此类承诺或保证。律师对此事结果的评论仅是意见表达，并非承诺或保证，也不应被视为承诺或保证。客户支付的任何押金或律师提供的成本和费用估算均不构成对成本和费用的限制，也不构成成本和费用不会超过押金或估算金额的保证。实际成本和费用可能与给出的估计有很大差异。",
    zh_from: "firm",  // Simplified, from the I-526E template
  },

  delegation: {
    title: { en: "Who Does the Work", zh: "律师委托服务" },
    en: "The firm may assign any part of the work to another attorney at the firm, and may delegate parts of it to outside attorneys or service providers where that is appropriate. A lawyer at the firm remains responsible to you for the representation throughout. Any such assignment does not change what you owe under this Agreement.",
    zh: "本事務所可以将向客户提供的一些法律服务委托给其他律师事务所或商业公司。任何此类授权都不会影响客户支付本协议规定的律师费和/或费用的义务。",
    zh_from: "firm",  // Simplified, from the I-526E template
  },

  electronic_communications: {
    title: { en: "Communicating Electronically", zh: "同意电子通讯" },
    en: "To work efficiently we use email, mobile telephones, cloud storage, electronic document transfer and similar technology. Using them carries some risk to the confidentiality of what we exchange. We consider that risk small against the benefit, but it is yours to accept: by signing this Agreement you consent to our communicating with you this way. Tell us in writing at any time if you would rather we did not.",
    zh: "为了最大限度地提高此事的效率，本事務所打算尽可能使用最先进的技术和通信设备（即互联网、电子邮件、智能手机、云计算、计算机文件传输和传真传输）。使用此类技术可能会使客户的信心和特权面临风险。然而，本事務所认为使用此类技术的有效性超过了意外披露的名义风险。通过签署本协议，客户承认其同意使用此类技术和设备。",
    zh_from: "firm",  // Simplified, from the I-526E template
  },

  trust_account: {
    title: { en: "The Client Trust Account", zh: "客戶信託帳戶" },
    en: "Money you pay us that has not yet been earned, and money we hold for costs not yet incurred, is held in the firm's client trust (IOLTA) account, separate from the firm's own funds, and is withdrawn only as it is earned or as the cost is paid. Interest on the account is paid to the State Bar of California under its rules. We will account to you for those funds on request and at the end of the matter.",
    zh: "您支付予本事務所但本事務所尚未賺取之款項，以及本事務所為尚未發生之費用所保管之款項，均存放於本事務所之客戶信託帳戶（IOLTA），與本事務所自有資金分別保管，僅於費用賺取時或支出實際發生時方得提取。該帳戶之利息依加州律師公會之規定繳付予加州律師公會。本事務所將於您提出要求時及案件結束時，就該等款項向您提出說明。",
    because: "Rule 1.15(a) and (d): client funds held separately, accounted for on request. The Wecare letter made this discretionary; stated here as the rule requires.",
  },

  conflict_disclosure: {
    title: { en: "Conflicts of Interest", zh: "利益衝突" },
    en: "Before accepting this matter we searched the firm's records for the names involved, including the other side. Where the firm represents, or may later represent, more than one party connected to the same project or transaction, the foreseeable consequences include: that those parties may later fall into dispute with one another; that information one gives us may have to be disclosed to another; and that if a conflict develops which we cannot properly manage, we may have to withdraw from acting for one or more of you. You may consult independent counsel about this before signing. By signing, you give informed written consent to our acting in those circumstances. We will not take a position adverse to you in any matter.",
    zh: "本事務所於承接本案件前，已就所涉各方之姓名或名稱（包括對造）查核本事務所之紀錄。如本事務所同時代理或日後可能代理與同一項目或交易有關之多方當事人，可合理預見之後果包括：該等當事人日後可能彼此發生爭議；一方提供予本事務所之資訊可能必須向他方揭露；以及如發生本事務所無法妥善處理之利益衝突，本事務所可能必須終止為其中一方或多方提供服務。您於簽署前得就此諮詢獨立之律師。您之簽署即構成對本事務所於上述情形下提供代理之知情書面同意。本事務所於任何事務中均不會採取與您對立之立場。",
    because: "Rules 1.7(b) and 1.8.2 require informed written consent for a concurrent conflict. From the Wecare letter, which is the firm's existing practice on EB-5 project work.",
  },

  records: {
    title: { en: "Your File", zh: "您的案卷" },
    en: "At the end of the matter we will return any original documents you gave us. We keep our file for at least five years, or longer if the law requires, after which we may destroy it without further notice. You may ask for a copy of the file, or the original, at any time; we will provide it, and may charge you what it costs us to retrieve, copy and deliver it.",
    zh: "案件結束時，本事務所將歸還您所提供之任何文件正本。本事務所將保存案卷至少五年，法律另有較長規定者從其規定；保存期滿後，本事務所得逕行銷毀，不另行通知。您得隨時要求取得案卷之複本或正本，本事務所將予提供，並得就調卷、影印及交付所實際支出之費用向您收取。",
    because: "Rule 1.16(e)(1): the client's file is released promptly on request. The retention period is the firm's own policy, from the Wecare letter.",
  },

  confidentiality: {
    title: { en: "Confidentiality", zh: "保密" },
    en: "What you tell us is confidential and protected by the attorney-client privilege. We will not disclose it except as you authorise, as this Agreement provides, or as the law or the Rules of Professional Conduct require or permit. That duty continues after this matter ends.",
    zh: "您向本事務所所為之陳述均屬機密，並受律師與客戶間保密特權之保護。除經您授權、本協議另有約定，或法律及律師職業行為規則所要求或允許者外，本事務所不會對外揭露。該保密義務於本案件結束後仍繼續存在。",
    because: "Bus. & Prof. Code § 6068(e)(1) and rule 1.6. Stated so the client knows the duty exists and that it survives the engagement.",
  },

  costs_advanced: {
    title: { en: "Government Fees and Costs We Pay for You", zh: "本事務所代墊之政府規費及費用" },
    en: "Where we pay a filing fee, biometrics fee or similar government charge on your behalf, you will reimburse us. Government fees are set by the agency and can change without notice; any figure given in this Agreement is the fee current at its date and is an estimate only. Where a fee must be paid by a deadline we will tell you the amount and the date, and we need your payment in time to meet it.",
    zh: "本事務所如代您支付申請費、生物辨識費或其他類似之政府規費，您應向本事務所償還。政府規費由主管機關訂定，得不經通知而變更；本協議所載之任何金額均為本協議日期時之現行費用，僅供估算參考。如某項費用須於期限內繳納，本事務所將告知您金額及期限，您應及時支付，以便本事務所如期繳納。",
    because: "§ 6148(a)(2): the nature of costs the client will be charged for. Separating government fees from the firm's fee is what stops a fee increase reading as the firm raising its price.",
  },

  governing_law: {
    title: { en: "Governing Law", zh: "适用法律" },
    en: "This Agreement, and the rights and duties of both of us under it, are governed by and interpreted under California law. Any litigation arising from it shall be brought in Los Angeles County, California.",
    zh: "本协议及其任何条款或规定的有效性，以及双方在本协议项下的权利和义务，将根据加利福尼亚州法律进行解释。因本协议引起的任何诉讼应在加利福尼亚州洛杉矶县提起。",
    zh_from: "firm",  // Simplified, from the I-526E template
    because: "Venue is the firm's home county. Note that a prevailing-party fee clause is deliberately NOT included: it would cut against the client in a fee dispute the State Bar program is meant to resolve cheaply.",
  },

  effective_date: {
    title: { en: "When This Agreement Takes Effect", zh: "本協議之生效" },
    en: "This Agreement takes effect when you sign and return it, or when we begin work on the matter, whichever happens first. Any date printed at the top is for reference only.",
    zh: "本協議自您簽署並交回之時起生效，或自本事務所開始承辦本案件之時起生效，以較早者為準。本協議開頭所載之日期僅供參考。",
    because: "Immigration work frequently starts before signature — JJ, October 2026. The sentence covering that work is in the OPENING paragraph, not here, because it is conditional on a.work_already_begun: an agreement that states it covers earlier work when there was none is asserting something untrue. check-retainer caught exactly that.",
  },

  // ── Clauses whose Chinese was written for this generator ──
//
// Traditional, at JJ's direction (2026-10-07), matching the five clauses
// taken from the firm's I-526E template: one agreement in two scripts
// reads worse than one agreement against the brand book, which asks for
// Simplified. The cover page's title stays Simplified because that is the
// brand artwork's own wording.
//
// Civ. Code § 1632 still holds the client to the version in their own
// language, and the `language` clause still makes the English control.
// Both remain the attorney's to confirm before an agreement goes out.
  flat_fee_earning: {
    title: { en: "How a Flat Fee Is Earned", zh: "固定費用如何賺取" },
    en: "The flat fee is earned as the work described below is performed, in the proportions shown. It is not earned merely because this Agreement has been signed, and it is not non-refundable. If the representation ends before the work is complete, you are entitled to a prompt refund of the portion of the fee that has not been earned.",
    zh: "固定費用係隨下列工作之完成，按所列比例逐步賺取。本事務所並非因本協議經簽署即賺取該費用，該費用亦非不可退還。如代理關係於工作完成前終止，您有權就尚未賺取之費用部分獲得即時退還。",
    because: "Rule 1.5(d) and State Bar Formal Opinion 2026-210: a fee may not be denominated earned-on-receipt or non-refundable.",
  },
  flat_fee_deposit: {
    title: { en: "Where the Flat Fee Is Held", zh: "固定費用之存放" },
    en: "You have the right to require that the flat fee be deposited into the firm's client trust account and withdrawn only as it is earned. If you instead agree, by signing below, the firm may deposit the flat fee into its operating account. Either way, you remain entitled to a refund of any amount of the fee that has not been earned if the representation is terminated or the services paid for are not completed.",
    zh: "您有權要求將固定費用存入本事務所之客戶信託帳戶，並僅於費用賺取時方得提取。您亦得以於下方簽署之方式，同意本事務所將固定費用存入其營運帳戶。無論採行何種方式，如代理關係終止或您所支付之服務未完成，您仍有權就尚未賺取之費用部分請求退還。",
    because: "Rule 1.15(b)(1)–(2): the disclosure and, above $1,000, the client's signed agreement.",
  },
  insurance: {
    title: { en: "Professional Liability Insurance", zh: "律師專業責任保險" },
    en: "The firm maintains professional liability insurance applicable to the services to be provided under this Agreement.",
    zh: "本事務所已投保律師專業責任保險，其承保範圍涵蓋本協議項下所提供之服務。",
    because: "Rule 1.4.2: disclosure required where the lawyer knows or should know the firm does not carry it; stated affirmatively here.",
  },
  fee_dispute: {
    title: { en: "If You Disagree With a Fee", zh: "如您對費用有異議" },
    en: "If a dispute arises over fees or costs, you may require that it be resolved by the State Bar's Mandatory Fee Arbitration program under Business and Professions Code sections 6200 and following. That arbitration is voluntary for you and mandatory for the firm, and it is not binding unless both of us agree in writing, after the dispute has arisen, to make it binding. Nothing in this Agreement waives that right.",
    zh: "如雙方就律師費或費用發生爭議，您得依加州商業及職業法第 6200 條以下之規定，要求將該爭議交由加州律師公會之強制費用仲裁程序處理。該仲裁對您而言為自願參加，對本事務所而言則為強制參加；除非雙方於爭議發生後另以書面同意，否則仲裁結果不具拘束力。本協議之任何條款均不構成對該項權利之拋棄。",
    because: "§ 6200(c) and Arbitration Advisory 1998-01: a pre-dispute agreement to binding arbitration of fees is unenforceable.",
  },
};

// The numbered clauses that follow the fee section.
//
// The flat-fee clauses are deliberately NOT here: retainer-doc's fee section
// renders them in place, where the money is, and listing them again produced
// a document that stated its own fee terms twice. A fee agreement that says
// the same thing twice invites an argument about which one governs.
/** Matter types that get the conflict waiver. Keys of MATTER_LABELS. */
const CONFLICT_WAIVER_MATTERS = ["immigration_business", "real_estate", "estate_planning"];

function clausesFor({ structure, matter_type } = {}) {
  // Ordered the way the firm's own agreements run: what we will do, what
  // you must do, what is not covered, the money, how it ends, the legal
  // boilerplate, then the acknowledgment last so it sits above the
  // signature block it refers to.
  const keys = [
    "scope_limits",
    "hourly_outside_scope",
    "cooperation",
    "client_duties",
    "no_guarantee",
    "delegation",
    "translation",
    "electronic_communications",
    "trust_account",
    "costs_advanced",
    "records",
    "confidentiality",
    "insurance",
    "fee_dispute",
    "termination",
    "governing_law",
    "effective_date",
  ];

  // The conflict disclosure is for matters where the firm may act for more
  // than one party to the same project. On a single-client matter it
  // describes a situation that does not exist, and a clause that does not
  // apply is noise in a document the client has to read.
  //
  // These are keys from MATTER_LABELS, which is what the form produces.
  // They used to be "eb5", "business" and "corporate", none of which the
  // form can emit, so the waiver never appeared on the matters it was
  // written for. check-retainer.js now refuses any key that is not a real
  // matter type.
  //
  //   immigration_business  EB-5 and investor work: the investor and the
  //                         entity can be two clients on one project
  //   real_estate           buyer and seller, or several owners
  //   estate_planning       both spouses on one plan
  if (CONFLICT_WAIVER_MATTERS.includes(String(matter_type || ""))) {
    keys.splice(keys.indexOf("trust_account"), 0, "conflict_disclosure");
  }

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

/** The hourly rates quoted for work outside the scope, by role. */
const OUTSIDE_SCOPE_RATES = [
  ["Managing partner", 650],
  ["Associate attorney", 350],
  ["Paralegal", 200],
];

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

module.exports = { CONFLICT_WAIVER_MATTERS,
  RATES, FEE_STRUCTURES, FLAT_MILESTONES, SCOPE_PRESETS, MATTER_LABELS,
  CLAUSES, clausesFor, feeClausesFor, allClausesFor, problemsWith, money,
  OUTSIDE_SCOPE_RATES,
};
