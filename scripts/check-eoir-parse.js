// scripts/check-eoir-parse.js
//
// Validates eoir-parse.js against real EOIR mail. Every fixture below is a verbatim
// body pulled from jj@tezlawfirm.com's EOIR folder, covering each template DOJ uses:
//
//   Entered/Orders     "Alien Name",      "Detained",            attachment
//   Entered/Notices    "Alien Name",      "Bond Requested Date", attachment
//   Accepted           "Alien Name",      "Other Information",   no attachment
//   Service            "Alien Name",      "Other Information",   no attachment
//   Rejected           "Noncitizen Name", rejection reasons,     attachment
//   pre-July-2024      Proofpoint-encrypted stub, no readable body
//
// The Rejected template renaming "Alien Name" to "Noncitizen Name" is the reason this
// file exists: a parser built from one sample silently drops the respondent's name on
// every rejection. Fixtures are kept verbatim so a future DOJ template change shows up
// as a test failure rather than as a quietly empty client profile.

const E = require("../eoir-parse");

let pass = 0;
let fail = 0;
function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; return; }
  fail++;
  console.log(`  FAIL ${label}\n       got:  ${JSON.stringify(got)}\n       want: ${JSON.stringify(want)}`);
}

const FIXTURES = [
  {
    name: "Entered / Orders (Alien Name, Detained, attachment)",
    msg: {
      subject: "EOIR - LU - 009 - Entered - Orders - RMV",
      sender: "eRop@usdoj.gov",
      receivedAt: "2026-09-25T23:28:06.000Z",
      attachments: [{ name: "2026092523270039_240996009.pdf", size: 447549, contentType: "application/octet-stream" }],
      html: '<div style="font-size:11pt;font-family:Tahoma,sans-serif"><p>The Executive Office for Immigration Review (EOIR) has uploaded the following document in the electronic Record of Proceedings (eROP).</p><ul style="column-count:2"><li>eFiled Document Name: Order_7264403.pdf<br /></li><li>Document Category: Orders<br /></li><li>Document Sub Category: Order - Motion Order Generic (MOG)<br /></li><li>Uploaded On: 09/25/2026<br /></li><li>Tracking Number: 000-063-747-716<br /></li></ul><ul><li>A-Number: 240-996-009<br /></li><li>Alien Name: LU, FUYING<br /></li><li>Charging Document Date: 06/13/2022<br /></li><li>Case Type: RMV<br /></li><li>Detained: No<br /></li></ul><p>Attorneys/Representatives may view the documents in the EOIR Case Portal at this <a href="https://urldefense.proofpoint.com/v2/url?u=https-3A__case-2Daccess.eoir.justice.gov_link-3FreturnUrl-3D_casedetails-26alien-3D240996009&amp;d=DwMFAg">link</a>.</p></div>',
    },
    want: {
      ok: true, source: "body", status: "Entered", kind: "court_document", docketable: true,
      a_number: "240-996-009", name_display: "LU, FUYING", name_last: "LU", name_first: "FUYING",
      category: "Orders", sub_category: "Order - Motion Order Generic (MOG)",
      case_type: "RMV", detained: false, tracking_number: "000-063-747-716",
      document_name: "Order_7264403.pdf", problems: [],
    },
  },
  {
    name: "Entered / Notices (Bond Requested Date, Windows path filename)",
    msg: {
      subject: "EOIR - HE - 950 - Entered - Notices - RMV",
      sender: "eRop@usdoj.gov",
      receivedAt: "2026-09-25T22:07:13.000Z",
      attachments: [{ name: "202609252206454_245133950.pdf", size: 58016, contentType: "application/octet-stream" }],
      html: '<div><p>The Executive Office for Immigration Review (EOIR) has uploaded the following document in the electronic Record of Proceedings (eROP).</p><ul><li>eFiled Document Name: F:\\Notices\\CASE\\Notices\\MartinJe_8A10C6F9-F22C-8903-FE666E199906A511_noticefile.pdf<br /></li><li>Document Category: Notices<br /></li><li>Document Sub Category: CASE Notice<br /></li><li>Uploaded On: 09/25/2026<br /></li><li>Tracking Number: 000-063-742-978<br /></li></ul><ul><li>A-Number: 245-133-950<br /></li><li>Alien Name: HE, XIAOLONG<br /></li><li>Bond Requested Date: 09/25/2026<br /></li><li>Case Type: RMV<br /><br /></li></ul><p>view at this <a href="/link?returnUrl=/casedetails&amp;alien=245133950">link</a>.</p></div>',
    },
    want: {
      ok: true, source: "body", status: "Entered", kind: "court_document", docketable: true,
      a_number: "245-133-950", name_display: "HE, XIAOLONG", name_last: "HE", name_first: "XIAOLONG",
      category: "Notices", sub_category: "CASE Notice",
      case_type: "RMV", detained: null, tracking_number: "000-063-742-978",
      document_name: "F:\\Notices\\CASE\\Notices\\MartinJe_8A10C6F9-F22C-8903-FE666E199906A511_noticefile.pdf",
      problems: [],
    },
  },
  {
    name: "Accepted (our filing approved, no attachment)",
    msg: {
      subject: "EOIR - ZHAO - 329 - Accepted - Supplemental Ev - RMV",
      sender: "eRop@usdoj.gov",
      receivedAt: "2026-09-25T23:48:10.000Z",
      attachments: [],
      html: '<div><p>The Executive Office for Immigration Review (EOIR) has reviewed and approved your uploaded document. The following document is now included in the electronic Record of Proceedings (eROP): </p><ul><li>eFiled Document Name: 208817329 ZHAO ZHIWEN Travel History.pdf<br /></li><li>Document Category: Supplemental Evidence<br /></li><li>Document Sub Category: Evidence Part 05 <br /></li><li>Uploaded On: 09/24/2026<br /></li><li>Tracking Number: 000-063-619-459<br /></li></ul><ul><li>A-Number: 208-817-329<br /></li><li>Alien Name: ZHAO, ZHIWEN<br /></li><li>Charging Document Date: 09/23/2025<br /></li><li>Case Type: RMV<br /><br /></li><li>Other Information: N/A<br /></li></ul><p>view at this <a href="/link?returnUrl=/casedetails&amp;alien=208817329">link</a>.</p></div>',
    },
    want: {
      ok: true, source: "body", status: "Accepted", kind: "filing_accepted", docketable: false,
      a_number: "208-817-329", name_display: "ZHAO, ZHIWEN", name_last: "ZHAO", name_first: "ZHIWEN",
      category: "Supplemental Evidence", sub_category: "Evidence Part 05",
      case_type: "RMV", detained: null, tracking_number: "000-063-619-459",
      document_name: "208817329 ZHAO ZHIWEN Travel History.pdf", problems: [],
    },
  },
  {
    name: "Service (DHS uploaded a document)",
    msg: {
      subject: "EOIR - LU - 009 - Service - Supplemental Ev - RMV",
      sender: "eFiling-DHSPortal@usdoj.gov",
      receivedAt: "2026-09-26T02:09:08.000Z",
      attachments: [],
      html: '<div><p>The Executive Office for Immigration Review (EOIR) has received an electronic upload of the document referenced below.</p><ul><li>eFiled Document Name: SUPPLEMENTAL EVIDENCE SET IV xinglong zheng et al.pdf<br /></li><li>Document Category: Supplemental Evidence<br /></li><li>Document Sub Category: Evidence Part 09 <br /></li><li>Uploaded On: 09/25/2026<br /></li><li>Tracking Number: 000-063-750-790<br /></li></ul><ul><li>A-Number: 240-996-009<br /></li><li>Alien Name: LU, FUYING<br /></li><li>Charging Document Date: 06/13/2022<br /></li><li>Case Type: RMV<br /></li><li>Other Information: N/A<br /></li></ul><p>view at this <a href="/link?returnUrl=/casedetails&amp;alien=240996009">link</a>.</p></div>',
    },
    want: {
      ok: true, source: "body", status: "Service", kind: "dhs_service", docketable: false,
      a_number: "240-996-009", name_display: "LU, FUYING", name_last: "LU", name_first: "FUYING",
      category: "Supplemental Evidence", sub_category: "Evidence Part 09",
      case_type: "RMV", detained: null, tracking_number: "000-063-750-790",
      document_name: "SUPPLEMENTAL EVIDENCE SET IV xinglong zheng et al.pdf", problems: [],
    },
  },
  {
    name: 'Rejected ("Noncitizen Name", rejection reasons on the following line)',
    msg: {
      subject: "EOIR - GAO - 502 - Rejected - Supplemental Ev - RMV",
      sender: "eRop@usdoj.gov",
      receivedAt: "2024-09-03T17:15:11.000Z",
      attachments: [{ name: "20240830161721162_246619502.pdf", size: 151079, contentType: "application/octet-stream" }],
      html: '<div><p>The Executive Office for Immigration Review (EOIR) has reviewed and rejected the document referenced below. This document will not be added to the electronic Record of Proceedings (eROP). Please refer to the Rejection Reasons listed below and in the attached Rejected Filing Notice, for detailed information.</p><ul><li>eFiled Document Name: GAO GUANXUN PROOF OF BIOMETRIC.docx.pdf<br /></li><li>Document Category: Supplemental Evidence<br /></li><li>Document Sub Category: Evidence Part 03 <br /></li><li>Uploaded On: 08/30/2024<br /></li><li>Additional Document(s) Name: N/A</li></ul><ul><li>A-Number: 246-619-502<br /></li><li>Noncitizen Name: GAO, GUANXUN<br /></li><li>Charging Document Date: 02/27/2023<br /></li><li>Case Type: RMV<br /></li><li>Other Information: N/A<br /></li></ul><p>Rejection Reasons: </p><ul><li>Duplicate Submission</li></ul><br /><p></p><p>Rejection Explanation: Duplicate submission. This Document was accepted on 01/23/2024<br /></p></div>',
    },
    want: {
      ok: true, source: "body", status: "Rejected", kind: "filing_rejected", docketable: true,
      a_number: "246-619-502", name_display: "GAO, GUANXUN", name_last: "GAO", name_first: "GUANXUN",
      category: "Supplemental Evidence", sub_category: "Evidence Part 03",
      case_type: "RMV", detained: null, tracking_number: null,
      document_name: "GAO GUANXUN PROOF OF BIOMETRIC.docx.pdf", problems: [],
    },
  },
];

console.log("EOIR parser — real-mail fixtures\n");
for (const f of FIXTURES) {
  console.log(`- ${f.name}`);
  const got = E.parseEoirEmail(f.msg);
  for (const [k, v] of Object.entries(f.want)) check(`${f.name} :: ${k}`, got[k], v);
}

// The Rejected fixture is the only one carrying rejection detail.
{
  const got = E.parseEoirEmail(FIXTURES[4].msg);
  check("Rejected :: rejection_reasons", got.rejection_reasons, "Duplicate Submission");
  check("Rejected :: rejection_explanation", got.rejection_explanation,
    "Duplicate submission. This Document was accepted on 01/23/2024");
  check("Rejected :: additional_documents", got.additional_documents, "N/A");
}
{
  const got = E.parseEoirEmail(FIXTURES[1].msg);
  check("Notices :: bond_requested_date", got.bond_requested_date, "09/25/2026");
}

// Proofpoint-encrypted era: no body to read, subject line still usable.
console.log("\n- Proofpoint-encrypted stub (pre-July-2024)");
{
  const got = E.parseEoirEmail({
    subject: "EOIR - MATEVOSYAN - 929 - Entered - Notices - RMV",
    sender: "eRop@usdoj.gov",
    receivedAt: "2023-05-09T17:55:20.000Z",
    text: "This is a secure message.\r\nClick here by 2023-05-14 17:55 UTC to read your message.\r\nAfter that, open the attachment.\r\nMore Info\r\nDisclaimer: This email and its content are confidential.",
  });
  check("encrypted :: ok", got.ok, false);
  check("encrypted :: source", got.source, "subject");
  check("encrypted :: encrypted", got.encrypted, true);
  check("encrypted :: name_last from subject", got.name_last, "MATEVOSYAN");
  check("encrypted :: a_last3 from subject", got.a_last3, "929");
  check("encrypted :: status from subject", got.status, "Entered");
  check("encrypted :: category from subject", got.category, "Notices");
  check("encrypted :: docketable", got.docketable, true);
  check("encrypted :: no fabricated A-number", got.a_number, null);
  check("encrypted :: no fabricated name", got.name_display, null);
}

// Subject-line shapes seen in the wild.
console.log("\n- subject parsing");
{
  // The BIA category contains a comma; the split is on " - " so it survives.
  const s = E.parseSubject("EOIR - CHEN - 382 - Accepted - EOIR-27, Appear - BIA");
  check("BIA :: surname", s.surname, "CHEN");
  check("BIA :: a_last3", s.a_last3, "382");
  check("BIA :: status", s.status, "Accepted");
  check("BIA :: category", s.subject_category, "EOIR-27, Appear");
  check("BIA :: case type", s.subject_case_type, "BIA");
}
check("non-EOIR subject rejected", E.parseSubject("Re: your case"), null);
check("truncated category kept as-is",
  E.parseSubject("EOIR - ZHANG - 293 - Service - Change of Addre - RMV").subject_category,
  "Change of Addre");

console.log("\n- A-number handling");
check("digits from dashed", E.aDigits("240-996-009"), "240996009");
check("format from digits", E.formatANumber("240996009"), "240-996-009");
check("filename witness", E.aNumberFromFilename("2026092523270039_240996009.pdf"), "240996009");
check("filename witness (15-digit stamp)", E.aNumberFromFilename("202609252206454_245133950.pdf"), "245133950");
check("filename witness ignores non-pdf", E.aNumberFromFilename("240996009.txt"), null);
check("body-link witnesses", E.aNumberFromBodyLinks('href="/link?returnUrl=/casedetails&alien=245133950"'), ["245133950"]);
check("proofpoint-mangled link witness", E.aNumberFromBodyLinks("alien-3D208817329&amp;d=DwMFAg"), ["208817329"]);

// A mismatch between the body and the attachment must NOT silently pick one.
console.log("\n- disagreement is flagged, not guessed");
{
  const got = E.parseEoirEmail({
    subject: "EOIR - LU - 009 - Entered - Orders - RMV",
    sender: "eRop@usdoj.gov",
    attachments: [{ name: "2026092523270039_111111111.pdf" }],
    html: "<ul><li>A-Number: 240-996-009</li><li>Alien Name: LU, FUYING</li></ul>",
  });
  check("mismatch :: not ok", got.ok, false);
  check("mismatch :: problem reported",
    got.problems.some((p) => /A-number disagreement/.test(p)), true);
}
{
  // Subject says 009, body says a different A-number: the subject is a cross-check.
  const got = E.parseEoirEmail({
    subject: "EOIR - LU - 777 - Entered - Orders - RMV",
    sender: "eRop@usdoj.gov",
    html: "<ul><li>A-Number: 240-996-009</li><li>Alien Name: LU, FUYING</li></ul>",
  });
  check("subject suffix mismatch flagged",
    got.problems.some((p) => /does not match/.test(p)), true);
}
{
  // An unrecognised label is surfaced so DOJ template drift cannot pass unnoticed.
  const got = E.parseEoirEmail({
    subject: "EOIR - LU - 009 - Entered - Orders - RMV",
    sender: "eRop@usdoj.gov",
    html: "<ul><li>A-Number: 240-996-009</li><li>Alien Name: LU, FUYING</li><li>Hearing Location: Denver</li></ul>",
  });
  check("unknown label surfaced",
    got.problems.some((p) => /unknown labels: Hearing Location/.test(p)), true);
}
check("sender allowlist", E.isEoirSender("eRop@USDOJ.gov"), true);
check("sender allowlist rejects", E.isEoirSender("phish@example.com"), false);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
