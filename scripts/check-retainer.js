/**
 * check-retainer.js
 *
 * "let me upload all the templates and the tara allows enter name, scope of
 *  the work, fee then it will generate the agreement."
 *
 * Seventeen templates became one generator. What a generator changes is the
 * blast radius: a clause that is wrong is now wrong on every agreement the
 * firm signs, and three of the rules below make an agreement VOIDABLE by the
 * client, with the firm held to a reasonable fee instead of its own.
 *
 * So these checks guard the statutory content rather than the layout:
 *
 *   § 6148(a)  the rates, the nature of the services, each side's
 *              responsibilities — all three, or the client can void it
 *   § 6147(a)  the five contingency disclosures, including, in terms, that
 *              the fee is not set by law and is negotiable
 *   1.5(d)     a fee may NOT be denominated earned-on-receipt or
 *              non-refundable (State Bar Formal Opinion 2026-210)
 *   1.15(b)    a flat fee reaches the operating account only with the
 *              disclosure, and above $1,000 the client's signed agreement
 *   1.16(e)(2) unearned fees are refunded on termination regardless
 *   § 1632     the Chinese is the version the client is held to have
 *              understood, so it may not be machine-written or missing
 *
 * JJ asked for flat fees "earned upon signing". That is the one instruction
 * in this build that was not implemented, because 1.5(d) forbids it. The
 * check below is what stops it coming back in by accident.
 */

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");

const R = require(path.join(ROOT, "retainer.js"));
const DOC = require(path.join(ROOT, "retainer-doc.js"));
const PAGE = require(path.join(ROOT, "retainer-page.js"));
const server = read("server.js");
const nav = read("hearing-notes.js");

let passed = 0;
function check(name, fn) { fn(); passed++; console.log(`  ok  ${name}`); }

// A complete, compliant flat-fee engagement, used throughout.
const flat = {
  client_name: "Chen, Wei", matter_type: "immigration_removal", structure: "flat",
  total_fee: 6500, milestones: R.FLAT_MILESTONES.immigration,
  operating_account_consent: true, scope: ["File and attend a bond hearing"],
};
const plain = (h) => h.replace(/<[^>]+>/g, " ").replace(/&#39;/g, "'").replace(/\s+/g, " ");

console.log("\nFee agreements: what the statutes require\n");

// ── Rule 1.5(d) — the instruction that was refused ──────────

check("a flat fee is never denominated earned-on-receipt or non-refundable", () => {
  const t = plain(DOC.render(flat));
  assert.ok(!/\bearned (on|upon) (receipt|signing|execution)\b/i.test(t),
    "rule 1.5(d) forbids this wording, and Formal Opinion 2026-210 calls it deceit under 8.4(c)");
  // "non-refundable" may appear only inside a denial of it.
  for (const m of t.match(/[^.]*non-refundable[^.]*/gi) || []) {
    assert.ok(/not non-refundable/i.test(m), `a bare non-refundable claim: ${m.trim()}`);
  }
});

check("and the document says plainly that signing does not earn it", () => {
  const t = plain(DOC.render(flat));
  assert.ok(/not earned merely because this Agreement has been signed/.test(t));
  assert.ok(/entitled to a prompt refund of the portion of the fee that has not been earned/.test(t),
    "1.16(e)(2): the refund right is not waivable and has to be stated");
});

check("the fee is earned against work, in stated proportions", () => {
  const t = plain(DOC.render(flat));
  assert.ok(/Earned when this is done/.test(t), "no milestone table");
  for (const m of R.FLAT_MILESTONES.immigration) {
    assert.ok(t.includes(m.work), `milestone missing: ${m.work}`);
  }
  // Front-loaded, which is what makes "most of it early" legitimate.
  assert.strictEqual(R.FLAT_MILESTONES.immigration[0].pct, 40);
  assert.strictEqual(R.FLAT_MILESTONES.immigration.reduce((n, m) => n + m.pct, 0), 100);
});

check("milestones that do not add up to 100% stop the draft", () => {
  const bad = R.problemsWith({ ...flat, milestones: [{ pct: 60, work: "x" }] });
  assert.ok(bad.some((p) => /add up to 60%/.test(p)));
});

// ── Rule 1.15(b) ────────────────────────────────────────────

check("the trust-or-operating choice is disclosed either way", () => {
  const t = plain(DOC.render(flat));
  assert.ok(/right to require that the flat fee be deposited into the firm's client trust account/.test(t));
  assert.ok(/entitled to a refund of any amount of the fee that has not been earned/.test(t));
  // Without consent the document must say it is held in trust, not stay silent.
  const noConsent = plain(DOC.render({ ...flat, operating_account_consent: false }));
  assert.ok(/will be deposited into the firm's client trust account and withdrawn only as it is earned/.test(noConsent));
  assert.ok(!/You agree that the flat fee may be deposited into the firm's operating/.test(noConsent));
});

check("over $1,000 the consent must be in the signed writing", () => {
  const bad = R.problemsWith({ ...flat, operating_account_consent: false });
  assert.ok(bad.some((p) => /1\.15\(b\)\(2\)/.test(p)), "nothing stops an unconsented operating-account deposit");
  // Under $1,000 the signed agreement is not required, so it must not block.
  const small = R.problemsWith({ ...flat, total_fee: 400, operating_account_consent: false });
  assert.ok(!small.some((p) => /1\.15\(b\)\(2\)/.test(p)), "the threshold is $1,000, not every flat fee");
});

check("and when consented, the client initials it", () => {
  const t = plain(DOC.render(flat));
  assert.ok(/You agree that the flat fee may be deposited into the firm's operating account/.test(t));
  assert.ok(/Client's initials/.test(t));
});

// ── § 6148 ──────────────────────────────────────────────────

check("§ 6148(a): rates, nature of the services, and responsibilities", () => {
  const hourly = { ...flat, structure: "hourly", timekeepers: ["JJ Zhang", "Lin Mei"] };
  const t = plain(DOC.render(hourly));
  assert.ok(/\$650 per hour/.test(t) && /\$200 per hour/.test(t), "(a)(1) the rates");
  assert.ok(/File and attend a bond hearing/.test(t), "(a)(2) the nature of the services");
  assert.ok(/What the Firm Will Do/.test(t) && /cannot and do not guarantee any particular result/.test(t),
    "(a)(3) the responsibilities of each party");
  assert.ok(/Costs and expenses/.test(t), "(a)(1) also wants the other charges");
});

check("an hourly matter with no rate stated is refused", () => {
  const bad = R.problemsWith({ ...flat, structure: "hourly", timekeepers: [] });
  assert.ok(bad.some((p) => /6148\(a\)\(1\)/.test(p)));
});

check("an empty scope is refused", () => {
  const bad = R.problemsWith({ ...flat, scope: [] });
  assert.ok(bad.some((p) => /6148\(a\)\(2\)/.test(p)));
});

check("the rate card is only the people who bill by the hour", () => {
  assert.deepStrictEqual(R.RATES.map((t) => [t.name, t.rate]), [
    ["JJ Zhang", 650],
    ["Chujun (Chandler) Jin", 350],
    ["Lin Mei", 200],
  ], "JJ: $650 now, Chandler $350, Lin Mei $200, 'other does not have fee structure on it'");
});

// ── § 6147 ──────────────────────────────────────────────────

check("§ 6147(a)(4): the negotiability sentence appears in terms", () => {
  const t = plain(DOC.render({
    ...flat, structure: "contingency", contingency_pct: 33,
    costs_borne_by: "firm_then_reimbursed",
  }));
  assert.ok(/The fee stated above is not set by law\. It is negotiable between you and the firm\./.test(t),
    "this sentence is required, and its absence makes the agreement voidable");
});

check("and the rest of § 6147(a): rate, costs, other claims, MICRA", () => {
  const a = { ...flat, structure: "contingency", contingency_pct: 33, costs_borne_by: "firm_then_reimbursed" };
  const t = plain(DOC.render(a));
  assert.ok(/33% of the gross recovery/.test(t), "(a)(1) the rate");
  assert.ok(/Costs and expenses are separate from the attorney's fee/.test(t), "(a)(2) how costs affect it");
  assert.ok(/medical providers, health plans and insurers asserting a lien/.test(t), "(a)(3) other claims");
  assert.ok(!/section 6146/.test(t), "MICRA should not appear unless it applies");
  assert.ok(/section 6146 limits the contingency fee/.test(plain(DOC.render({ ...a, micra: true }))), "(a)(5)");
});

check("a contingency with no costs treatment is refused", () => {
  const bad = R.problemsWith({ ...flat, structure: "contingency", contingency_pct: 33, costs_borne_by: "" });
  assert.ok(bad.some((p) => /6147\(a\)\(2\)/.test(p)));
});

// ── Civ. Code § 1632 ────────────────────────────────────────

check("the § 1632 guard still bites when a clause has no Chinese", () => {
  // Every clause has Chinese now (JJ, 2026-10-07), so this can no longer be
  // shown with the real data -- and a check that passes only because the
  // data happens to be incomplete stops being a check the moment it is
  // completed. The guard is exercised directly instead: take one clause's
  // Chinese away and confirm the draft is refused.
  const key = "trust_account";
  const keep = R.CLAUSES[key].zh;
  try {
    R.CLAUSES[key].zh = null;
    const bad = R.problemsWith({ ...flat, bilingual: true });
    assert.ok(bad.some((p) => /1632/.test(p)), "a clause with no Chinese no longer blocks a bilingual draft");
    assert.ok(bad.some((p) => /not something to machine-translate/.test(p)),
      "the point is that nobody should be tempted to generate it");
  } finally {
    R.CLAUSES[key].zh = keep;
  }
});

check("the guard reaches the fee section, not just the numbered clauses", () => {
  // The flat-fee clauses render inside the fee section. An earlier version
  // looked only at the numbered list and so missed exactly the clauses that
  // say what the client is paying.
  const all = R.allClausesFor({ ...flat, bilingual: true });
  assert.ok(all.includes("flat_fee_earning") && all.includes("flat_fee_deposit"),
    "the fee clauses are outside what the § 1632 check looks at");
  const key = "flat_fee_earning";
  const keep = R.CLAUSES[key].zh;
  try {
    R.CLAUSES[key].zh = null;
    assert.ok(R.problemsWith({ ...flat, bilingual: true }).some((p) => /1632/.test(p)),
      "a fee clause with no Chinese would go out unnoticed");
  } finally {
    R.CLAUSES[key].zh = keep;
  }
});

check("every clause now carries Chinese, title and body", () => {
  const gaps = Object.entries(R.CLAUSES)
    .filter(([, c]) => !c.zh || !c.title.zh)
    .map(([k]) => k);
  assert.deepStrictEqual(gaps, [], "these clauses have no Chinese: " + gaps.join(", "));
});

const SIMPLIFIED_ONLY = /[协议务师应费后圆单据办问题这现实证对马]/;

const simplifiedClauses = () => {
  const out = [];
  for (const [k, c] of Object.entries(R.CLAUSES)) {
    const m = `${c.title.zh || ""}${c.zh || ""}`.match(SIMPLIFIED_ONLY);
    if (m) out.push(k);
  }
  return out.sort();
};

check("the Chinese written for this generator is Traditional", () => {
  // Scoped to `zh_from` unset -- the clauses whose Chinese was written
  // here. The firm's own executed Chinese is the next check's business.
  const bad = simplifiedClauses().filter((k) => !R.CLAUSES[k].zh_from);
  assert.deepStrictEqual(bad, [],
    "simplified characters in Chinese written for this generator: " + bad.join(", "));
});

check("the firm's executed Chinese is in two scripts, and these are the five", () => {
  // NOT a failure to fix here. The I-526E template is Simplified and the
  // original agreement is Traditional, so a bilingual agreement prints
  // both. This pins which five are Simplified: edit one of them, or add
  // a sixth, and this check says so rather than letting the mix drift.
  //
  // To settle it: convert these five to Traditional (then delete this
  // check -- the one above will cover them), or convert the other five
  // to Simplified and flip the rule above. Either is a lawyer's call on
  // executed wording.
  assert.deepStrictEqual(simplifiedClauses(), [
    "client_duties",
    "delegation",
    "electronic_communications",
    "governing_law",
    "no_guarantee",
  ], "the set of Simplified clauses changed");

  for (const k of simplifiedClauses()) {
    assert.strictEqual(R.CLAUSES[k].zh_from, "firm",
      `${k} is Simplified but is not marked as the firm's own text — if its Chinese was written here, write it in Traditional`);
  }
});

check("a bilingual agreement actually prints the Chinese", () => {
  const t = DOC.render({ ...flat, bilingual: true });
  assert.ok(/客戶配合/.test(t) && /終止服務/.test(t), "the executed templates' Chinese should appear");
  assert.ok(/客戶信託帳戶/.test(t), "the new Chinese should appear");
  assert.ok(!/中文待律師撰寫/.test(t), "a gap marker is still being printed");
});

check("English-only drafts are not held up by the Chinese gap", () => {
  assert.strictEqual(R.problemsWith(flat).length, 0, "an English agreement is complete and may go out");
});

// ── No clause says the same thing twice ─────────────────────

check("no clause is rendered twice", () => {
  const t = plain(DOC.render(flat));
  for (const phrase of [
    "not earned merely because this Agreement has been signed",
    "right to require that the flat fee be deposited",
  ]) {
    assert.strictEqual(t.split(phrase).length - 1, 1,
      `"${phrase}" appears more than once — a fee agreement that states its terms twice invites an argument about which governs`);
  }
});

// ── Who sees what ───────────────────────────────────────────

check("an admin or manager sees every draft; everyone else their own", () => {
  assert.strictEqual(PAGE.scope({ r: "admin", uid: 1 }).where, "");
  assert.strictEqual(PAGE.scope({ r: "manager", uid: 2 }).where, "");
  const s = PAGE.scope({ r: "attorney", uid: 9 });
  assert.ok(/created_by_uid = \$1/.test(s.where) && s.params[0] === 9);
});

check("an unidentified user sees nothing, never everything", () => {
  // Failing open here would show one person's client's fee terms to another.
  assert.strictEqual(PAGE.scope({ r: "attorney" }).where, "WHERE FALSE");
  assert.strictEqual(PAGE.scope(null).where, "WHERE FALSE");
});

check("the scoping is in one function, so a call site cannot forget it", () => {
  const src = read("retainer-page.js");
  for (const fn of ["async function listDrafts", "async function getDraft"]) {
    const i = src.indexOf(fn);
    const body = src.slice(i, i + 700);
    assert.ok(/scope\(user/.test(body), `${fn} does not go through scope()`);
  }
});

// ── Sending ─────────────────────────────────────────────────

check("a draft with problems cannot be sent, even by keeping the URL", () => {
  const src = read("retainer-page.js");
  const i = src.indexOf('app.post(PAGE + "/:id/send"');
  const body = src.slice(i, i + 900);
  assert.ok(/problemsWith/.test(body) && /status\(400\)/.test(body),
    "hiding the button is not enough; the route has to refuse");
});

check("it is mounted, on the menu, and gated", () => {
  assert.ok(/require\("\.\/retainer-page"\)\.mount\(app, auth\)/.test(server));
  assert.ok(/\/admin\/retainer" class="nav-link/.test(nav));
  assert.deepStrictEqual(PAGE.ROLES, ["admin", "manager", "attorney"]);
});

check("the page contributes no script of its own", () => {
  const code = read("retainer-page.js").split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
  assert.ok(!/<script/i.test(code),
    "notify-admin.js's rule; a page that sets fee terms is the last one to let break");
});

check("the agreement carries no internal notes, in either view", () => {
  // "do not include the explanations in the fee agreement" (JJ, 2026-10-07).
  // They used to be on the attorney's view, one print setting away from a
  // client's copy. Both views now render the identical document.
  const asClient = DOC.render(flat, { forClient: true });
  const asDrafter = DOC.render(flat, { forClient: false });
  assert.ok(!/Why this is here/.test(asClient), "a note reached the client's copy");
  assert.ok(!/Why this is here/.test(asDrafter), "a note is still rendered for the drafter");
  assert.ok(!/class="why"/.test(asDrafter), "the note element is still in the document");
  assert.strictEqual(asClient, asDrafter, "the two views have drifted apart again");
  // The reasons are not lost -- they stay on the clause, where the drafting
  // screen and this file read them.
  assert.ok(R.CLAUSES.scope_limits.because, "the clause lost the reason it is there");
});

check("the firm signs first, and the offices are on it", () => {
  const t = plain(DOC.render(flat));
  assert.ok(/The firm signs first/.test(t), "JJ: 'ok firm signs first'");
  for (const city of ["West Covina", "City of Industry", "Newport Beach", "Flushing"]) {
    assert.ok(t.includes(city), `${city} is missing from the footer`);
  }
});

check("work done before signing is covered when it was", () => {
  // JJ: "in immigration mostly alot of time we do work before signing the
  // agreement and sometimes we finish the work before signing".
  assert.ok(/already begun or completed/.test(plain(DOC.render({ ...flat, work_already_begun: true }))));
  assert.ok(!/already begun or completed/.test(plain(DOC.render(flat))));
});

check("the reason is written next to the code", () => {
  const src = read("retainer.js");
  assert.ok(/1\.5\(d\)/.test(src) && /2026-210/.test(src),
    "the next person has to know why earned-on-signing was not built");
  assert.ok(/6148/.test(src) && /6147/.test(src) && /1632/.test(src));
});

// ── "i still do not see retainer agreement tab" ───────────
//
// It was there, sixth of nine links inside "Intake & Pipeline", between
// Drip Campaigns and Conflict Check — and gated on matters.access, which
// is JJ alone. It now sits in Overview next to E-Signature, which is what
// happens to an agreement once it is drafted.

check("the link is in Overview, next to E-Signature", () => {
  const chrome = fs.readFileSync(path.join(ROOT, "hearing-notes.js"), "utf8");
  const nav = chrome.slice(chrome.indexOf("<span>Overview</span>"),
                           chrome.indexOf("<span>Immigration</span>"));
  assert.ok(/href="\/admin\/retainer"/.test(nav),
    "Fee Agreements is not in Overview, which is where JJ looked for it");
  const retainerAt = nav.indexOf('href="/admin/retainer"');
  const esignAt = nav.indexOf('href="/admin/esign"');
  assert.ok(retainerAt > -1 && esignAt > retainerAt,
    "draft it, then send it — the order should read that way");
  // And nowhere else: two copies of a nav link is how one of them goes stale.
  assert.strictEqual((chrome.match(/href="\/admin\/retainer"/g) || []).length, 1,
    "the link is in the sidebar twice");
});

check("its permission admits everyone the page admits", () => {
  const chrome = fs.readFileSync(path.join(ROOT, "hearing-notes.js"), "utf8");
  const auth = fs.readFileSync(path.join(ROOT, "auth.js"), "utf8");
  const link = chrome.slice(chrome.indexOf('href="/admin/retainer"'));
  const perm = (link.match(/data-perm="([^"]+)"/) || [])[1];
  assert.ok(perm, "the link has no permission key at all");
  assert.notStrictEqual(perm, "matters.access",
    "matters.access is admin-only and means the Matters Manager links");

  const row = auth.match(new RegExp('"' + perm.replace(".", "\\.") + '":\\s*\\[([^\\]]*)\\]'));
  assert.ok(row, `${perm} is not defined in auth.js — an undefined key hides the link from everybody`);
  const roles = row[1].split(",").map((r) => r.trim().replace(/"/g, "")).filter(Boolean).sort();
  const page = require(path.join(ROOT, "retainer-page.js"));
  assert.deepStrictEqual(roles, [...page.ROLES].sort(),
    "the sidebar shows the link to a different set of people than the page lets in");
});

// ── "the agreement is generated not in accordance with our TEZ brand
//     and letter head" ───────────────────────────────────────

const sample = {
  client_name: "O'Brien & Sons, LLC", matter_type: "estate_planning",
  matter_label: "Revocable living trust", structure: "flat", total_fee: 5000,
  agreement_date: "2026-10-07", scope: ["Prepare a revocable living trust."],
  milestones: [{ pct: 40, work: "Assessment" }, { pct: 60, work: "Drafting and execution" }],
  operating_account_consent: true,
};

check("the letterhead sits in the text column, and the mark appears once", () => {
  const html = DOC.render(sample, { forClient: true, id: 7 });
  // "alignment is off." Three faults at once, and this is the guard on all
  // three. (a) The full-page 8.5in sheet was scaled into the 7.5in text
  // column, so the logo no longer sat on the text's left margin. (b) It was
  // positioned against the whole document, so it landed on the COVER and
  // collided with the cover's own mark. (c) Nothing put it on page two
  // onward, while the body still reserved 2.1in at the top of every page
  // for it.
  assert.ok(/<img class="lh-mark" src="\/brand\/logo-light\.svg"/.test(html),
    "the letter has no letterhead mark");
  assert.ok(!/class="sheet-art"/.test(html) && !/class="page-art"/.test(html),
    "the full-page sheet is back in the HTML, where it cannot be made to align");
  assert.ok(!/letterhead-first-(en|zh)\.png/.test(html),
    "a first-page sheet would print on top of the cover's own mark");
  assert.ok(!/padding-top:2\.1in/.test(DOC.CSS.replace(/\s+/g, "")),
    "the letter still reserves room for a header that is not there");
  assert.ok(/\.lh\{[^}]*border-bottom:1\.5ptsolidvar\(--orange\)/.test(DOC.CSS.replace(/\s+/g, "")),
    "the rule under the mark is not a border, so it vanishes when Background graphics is off");
  for (const f of ["letterhead-first-en.png", "letterhead-first-zh.png",
                   "letterhead-continuation.png", "logo-light.svg"]) {
    assert.ok(fs.existsSync(path.join(ROOT, "assets", "brand", f)), `assets/brand/${f} is missing`);
  }
  const server = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
  assert.ok(/express\.static\(require\("path"\)\.join\(__dirname, "assets", "brand"\)/.test(server),
    "nothing serves assets/brand");
});

check("a bilingual agreement is bilingual on the page, not just on the sheet", () => {
  // The HTML no longer picks a letterhead by language, because it no longer
  // uses a full-page sheet at all -- what makes a draft Chinese is the
  // Chinese in it. The per-page letterhead lives in the Word file.
  const zh = DOC.render({ ...sample, bilingual: true }, { forClient: true, id: 7 });
  const en = DOC.render(sample, { forClient: true, id: 7 });
  assert.ok(zh.includes("客戶信託帳戶") || zh.includes("服務範圍"),
    "a bilingual draft has no Chinese in it");
  assert.ok(!/[一-龥]/.test(plain(en).replace(/律师与客户委托收费协议/g, "")),
    "an English-only draft is carrying Chinese");
  assert.ok(/SimSun|Songti/.test(DOC.CSS), "no Chinese face is specified, so Word substitutes one");
});

check("the cover is the brand's fee-agreement cover", () => {
  const html = DOC.render(sample, { forClient: true, id: 7 });
  // Wording from 03-Print-Pack/04-Client-Folder/TEZ-Fee-Agreement-Cover.
  // The firm's own executed agreement is called "Agreement for Legal
  // Services", and it carries no dash -- "try to avoid having '-' in the
  // agreement" (JJ, 2026-10-07).
  assert.ok(/Agreement for<br>Legal Services/.test(html), "wrong title");
  assert.ok(html.includes("律师与客户委托收费协议"), "the Chinese title is missing");
  assert.ok(/Confidential[\s\S]{0,30}Privileged Attorney Communication/.test(html), "no eyebrow");
  assert.ok(html.includes("JJ Zhang, Esq."), "the responsible attorney is not named");
  assert.ok(html.includes("Tez Law P.C., doing business as TEZ Law Firm"),
    "the entity line at the foot of the cover is wrong");
  assert.ok(html.includes("/brand/logo-light.svg"), "the cover has no logo");
});

check("every matter type the code branches on is one the form can produce", () => {
  // The waiver was keyed to "eb5", "business" and "corporate". The form
  // emits MATTER_LABELS keys and nothing else, so the waiver never appeared
  // on an EB-5 agreement -- and the check that was meant to catch that
  // called clausesFor({matter_type:"eb5"}) directly, inventing the input it
  // was testing. This compares the two lists instead.
  const real = Object.keys(R.MATTER_LABELS);
  const unreachable = R.CONFLICT_WAIVER_MATTERS.filter((k) => !real.includes(k));
  assert.deepStrictEqual(unreachable, [],
    "clausesFor branches on matter types the form cannot emit: " + unreachable.join(", "));

  // And no fixture in this file may use one either, or the checks drift
  // away from the system again.
  const src = fs.readFileSync(__filename, "utf8");
  const used = [...src.matchAll(/matter_type:\s*"([a-z_]+)"/g)].map((m) => m[1]);
  const bogus = [...new Set(used)].filter((k) => !real.includes(k));
  assert.deepStrictEqual(bogus, [],
    "a check uses a matter type the form cannot emit: " + bogus.join(", "));
});

check("the Matter line is never blank on the cover", () => {
  // It was blank on every agreement: the cover reads matter_label, the form
  // only ever collected matter_type, and nothing joined the two.
  const DOCX = require(path.join(ROOT, "retainer-docx.js"));
  const PizZip = require(path.join(ROOT, "node_modules", "pizzip"));

  const written = DOC.render({ ...sample, matter_label: "I-526E petition, Smith RC" });
  assert.ok(plain(written).includes("I-526E petition, Smith RC"),
    "a matter the drafter wrote does not reach the cover");

  const bare = { ...sample };
  delete bare.matter_label;
  assert.ok(bare.matter_type, "the fixture has no matter type to fall back to");
  const fallback = R.MATTER_LABELS[bare.matter_type];
  assert.ok(fallback, "the matter type has no label of its own");
  assert.ok(plain(DOC.render(bare)).includes(fallback),
    "with no matter written, the cover prints nothing instead of the matter type");

  // And the same in Word, which builds its cover separately.
  const docXml = new PizZip(DOCX.build(bare, DOC)).file("word/document.xml").asText();
  assert.ok(docXml.includes(fallback), "the Word cover's Matter line is blank");
});

check("the agreement uses no dash as punctuation", () => {
  // "try to avoid having '-' in the agreement." Hyphens inside a word are
  // spelling and stay -- non-refundable, source-of-funds, I-526E. An em or
  // en dash is punctuation, and there should be none.
  for (const a of [sample, { ...sample, bilingual: true }, { ...sample, structure: "contingency", contingency_pct: 33 }]) {
    const t = plain(DOC.body(a, { forClient: true, withLetterhead: false }));
    const found = (t.match(/[^\s]*[—–][^\s]*/g) || []);
    assert.deepStrictEqual(found, [], "a dash is being used as punctuation: " + found.join(" | "));
  }
  // The cover and the letter's head too.
  assert.deepStrictEqual(
    (plain(DOC.render(sample)).match(/[^\s]*[—–][^\s]*/g) || []), [],
    "a dash survives on the cover or the letterhead");
});

check("the date stored for a new draft is the firm's calendar date", () => {
  const src = fs.readFileSync(path.join(ROOT, "retainer-page.js"), "utf8");
  // new Date().toISOString().slice(0,10) is the UTC date: from 5pm Pacific
  // onward it is tomorrow, and the draft was dated the next day.
  assert.ok(!/agreement_date:\s*new Date\(\)\.toISOString\(\)/.test(src),
    "a new draft is dated by the UTC clock again");
  assert.ok(/agreement_date:[\s\S]{0,200}America\/Los_Angeles/.test(src),
    "the draft date is not taken in the firm's own zone");
});

check("the firm profile is the firm's own copy, not mine", () => {
  // Advertising copy: Rules 7.1 to 7.3 and B&P 6157.2, with an open State
  // Bar matter. Every sentence here is lifted from the approved deck, so
  // the guard is that the page says what the deck says and claims nothing.
  // Scoped to the profile page, not the whole document: "guarantee"
  // appears in the NO-guarantee clause, which is the opposite of a claim.
  // Same error as the earned-on-receipt scan -- matching the word rather
  // than the meaning.
  assert.ok(plain(DOC.render(sample)).includes("About the firm"), "the profile page is missing");
  const t = plain(DOC.firmProfilePage(sample));
  assert.ok(t.includes("Tez Law P.C. protects people's rights and businesses"),
    "the firm paragraph is not the deck's");
  assert.ok(t.includes("Fifth and Ninth Circuits"), "the courts line is missing");
  // Nothing that reads as a claim about results.
  for (const banned of [/\bbest\b/i, /\bleading\b/i, /\btop[- ]rated\b/i, /success rate/i,
                        /\bguarantee/i, /\bwon\b/i, /\bno\.? ?1\b/i, /\bexpert\b/i]) {
    assert.ok(!banned.test(t), "the profile page makes a claim the rules do not allow: " + banned);
  }
  // And it is bilingual when the agreement is.
  const zh = plain(DOC.firmProfilePage({ ...sample, bilingual: true }));
  assert.ok(zh.includes("关于本所"), "the Chinese profile is missing from a bilingual packet");
});

check("the payment page warns before it tells", () => {
  const html = DOC.render(sample);
  const t = plain(html);
  assert.ok(t.includes("Paying the firm"), "the payment page is missing");
  // The warning is the page's reason for existing, so it comes first.
  const warn = t.indexOf("telephone us on 626-678-8677");
  // "We also take a check" became "We also take Zelle to ..., a check ..."
  // once the real instruction sheet was wired in.
  const methods = t.indexOf("We also take");
  assert.ok(warn > -1, "the fraud warning is not on the page");
  assert.ok(warn < methods, "the warning comes after the payment methods");
  assert.ok(t.includes("never email you changed payment instructions"),
    "the one sentence that defeats the attack is missing");
  // A border, not a background: a warning that vanishes when Background
  // graphics is unticked is not a warning.
  const css = DOC.CSS.replace(/\s+/g, "");
  assert.ok(/\.pay-warn\{[^}]*border:2ptsolidvar\(--orange\)/.test(css),
    "the warning box is drawn with a background, so it may not print");
});

check("no account number is in the repository", () => {
  // The repo is on GitHub. An account number committed here is in the
  // history for good. firm-payment.js reads them from the environment and
  // knows only their names.
  const pay = fs.readFileSync(path.join(ROOT, "firm-payment.js"), "utf8");
  const code = pay.replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");
  assert.ok(!/\b\d{9}\b/.test(code), "something that looks like a routing number is in the file");
  assert.ok(!/\b\d{8,17}\b/.test(code), "something that looks like an account number is in the file");
  assert.ok(/process\.env\[env\]/.test(code), "the details are not read from the environment");
});

check("with nothing configured the page gives no numbers and no placeholders", () => {
  const PAY = require(path.join(ROOT, "firm-payment.js"));
  const keep = {};
  for (const env of Object.values(PAY.FIELDS)) { keep[env] = process.env[env]; delete process.env[env]; }
  const seen = PAY.paymentDetails();
  const stash = { ...seen };
  for (const k of Object.keys(seen)) seen[k] = "";
  try {
    const t = plain(DOC.render(sample));
    assert.ok(/telephone the office on 626-678-8677 for the account details/.test(t),
      "an unconfigured page does not tell the client what to do");
    assert.ok(!/Routing number/.test(t), "an empty details table is being printed");
    assert.ok(!/X{4,}|0{6,}|_{4,}/.test(t),
      "a placeholder that could be mistaken for an account number is on the page");
    assert.ok(/never email you changed payment instructions/.test(t), "the warning vanished");
  } finally {
    Object.assign(seen, stash);
    for (const [env, v] of Object.entries(keep)) if (v !== undefined) process.env[env] = v;
  }
});

check("a retainer goes to the trust account unless the client agreed otherwise", () => {
  // Rule 1.15(a): client funds go to trust. Rule 1.15(b): a flat fee may
  // go to operating, but only with the client's written agreement, signed
  // above $1,000 -- which is the box this agreement already collects. The
  // page follows that box, so the two cannot drift apart.
  const PAY = require(path.join(ROOT, "firm-payment.js"));
  const flatNoConsent = { ...sample, structure: "flat", operating_account_consent: false };
  const flatConsent = { ...sample, structure: "flat", operating_account_consent: true };
  const hourlyConsent = { ...sample, structure: "hourly", operating_account_consent: true };

  assert.strictEqual(PAY.accountFor(flatNoConsent).kind, "trust",
    "a flat fee with no consent is being sent to the operating account");
  assert.strictEqual(PAY.accountFor(flatConsent).kind, "operating",
    "the consent the client signed is being ignored");
  assert.strictEqual(PAY.accountFor({}).kind, "trust", "the default is not trust");
  // A consent box ticked on an hourly matter is not a 1.15(b) flat-fee
  // agreement, so it does not move the money.
  assert.strictEqual(PAY.accountFor(hourlyConsent).kind, "trust",
    "an hourly deposit is being sent to the operating account");
});

check("only one of the two accounts is on any one agreement", () => {
  const PAY = require(path.join(ROOT, "firm-payment.js"));
  const d = PAY.paymentDetails();
  if (!PAY.isConfigured(d)) return;   // nothing set on this machine
  const t = plain(DOC.render({ ...sample, structure: "flat", operating_account_consent: false }));
  assert.ok(t.includes(d.trust_account), "the trust account is not on a trust agreement");
  assert.ok(!t.includes(d.operating_account),
    "both accounts are printed, so a client can pay into the wrong one");
});

check("both routing numbers are given, and labelled apart", () => {
  const PAY = require(path.join(ROOT, "firm-payment.js"));
  const d = PAY.paymentDetails();
  if (!PAY.isConfigured(d)) return;
  // Bank of America uses a different routing number for ACH than for
  // wires. One printed where the other belongs is a returned payment.
  assert.notStrictEqual(d.routing_wire, d.routing_ach,
    "the two routing numbers are the same, which is almost certainly a mis-read sheet");
  const t = plain(DOC.render(sample));
  assert.ok(/Routing number, wire/.test(t), "the wire routing number is not labelled as one");
  assert.ok(/Routing number, ACH/.test(t), "the ACH routing number is not labelled as one");
  assert.ok(/The two routing numbers are different/.test(t),
    "nothing tells the client the numbers are not interchangeable");
});

check("the drafting screen can say which payment settings are unset", () => {
  const PAY = require(path.join(ROOT, "firm-payment.js"));
  const seen = PAY.paymentDetails();
  const stash = { ...seen };
  for (const k of Object.keys(seen)) seen[k] = "";
  try {
    assert.ok(!PAY.isConfigured(), "an empty configuration reads as configured");
    const missing = PAY.missingFields();
    for (const env of ["TEZ_PAY_BANK", "TEZ_PAY_TRUST_NAME", "TEZ_PAY_TRUST_ACCOUNT",
                       "TEZ_PAY_ROUTING_WIRE", "TEZ_PAY_ROUTING_ACH"]) {
      assert.ok(missing.includes(env), `${env} is not reported as missing`);
    }
    // Optional ones are not nagged about.
    assert.ok(!missing.includes("TEZ_PAY_ZELLE"), "an optional setting is reported as missing");
  } finally {
    Object.assign(seen, stash);
  }
});

check("no account number is in the repository", () => {
  // The repo is on GitHub. Anything committed here is in the history for
  // good. firm-payment.js knows only the names of the settings.
  const pay = fs.readFileSync(path.join(ROOT, "firm-payment.js"), "utf8");
  const code = pay.replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");
  assert.ok(!/\b\d{9}\b/.test(code), "something that looks like a routing number is in the file");
  assert.ok(!/\b\d{8,17}\b/.test(code), "something that looks like an account number is in the file");
  assert.ok(/process\.env\[env\]/.test(code), "the details are not read from the environment");
  // And the file that does hold them is ignored by git.
  const ignore = fs.readFileSync(path.join(ROOT, ".gitignore"), "utf8");
  assert.ok(/^firm-payment\.local\.json$/m.test(ignore),
    "firm-payment.local.json is not in .gitignore, so the numbers can be committed");
});

check("the contracting party is the P.C., not the trade name", () => {
  // Brand board: "TEZ Law Firm" in public copy; "Tez Law P.C." in legal
  // lines, signatures of record and fee agreements. The letterhead footer
  // says the same -- TEZ Law Firm is a trade name.
  const html = DOC.render(sample, { forClient: true, id: 7 });
  assert.ok(/\("you"\) and\s*<strong>Tez Law P\.C\.<\/strong>, doing business as/.test(html),
    "the agreement still names the trade name as the contracting party");
});

check("the page geometry is measured off the artwork, not off the old template", () => {
  // letterhead-continuation.png is 2550x3300 at 300dpi. Its ink runs
  // 0.50-0.85in at the head and its rule sits at 10.47in, so the text box
  // is 1.15in down and 0.80in up. The old 1.3in/1.0in came from the
  // FIRST-page sheet, whose office block starts at 9.35in -- which is why
  // body text was printing through the addresses.
  assert.ok(/@page \{ size: letter; margin: 1\.15in 0\.75in 0\.8in; \}/.test(DOC.CSS),
    "the margins no longer match the sheet the document actually prints on");
  const px = (inches) => Math.round(inches * 300);
  const png = fs.readFileSync(path.join(ROOT, "assets", "brand", "letterhead-continuation.png"));
  assert.strictEqual(png.readUInt32BE(16), px(8.5), "the sheet is not 8.5in wide at 300dpi");
  assert.strictEqual(png.readUInt32BE(20), px(11), "the sheet is not 11in tall at 300dpi");
});

check("the agreement is set in Times New Roman 11pt", () => {
  // "the font should be times new roman and 11 font."
  const css = DOC.CSS.replace(/\s+/g, "");
  assert.ok(/body\{[^}]*font-family:"TimesNewRoman",Times,serif;font-size:11pt/.test(css),
    "the body is not Times New Roman 11pt");
  for (const sel of ["h1", "h2"]) {
    const m = new RegExp(sel + "\\{[^}]*font-family:\"TimesNewRoman\"[^}]*font-size:11pt").test(css);
    assert.ok(m, `${sel} is not Times New Roman 11pt`);
  }
  // The cover is the brand's own artwork and keeps the brand faces.
  assert.ok(/\.cv-title\{[^}]*font-family:"CormorantGaramond"/.test(css),
    "the cover lost the brand face");
  // And the Word file is set the same way: 22 half-points is 11pt.
  const src = fs.readFileSync(path.join(ROOT, "retainer-docx.js"), "utf8");
  assert.ok(/const BODY_FONT = "Times New Roman"/.test(src), "the Word body is not Times New Roman");
  assert.ok(/const HEAD_FONT = "Times New Roman"/.test(src), "the Word headings are not Times New Roman");
  assert.ok(/size = 22/.test(src), "the Word default is no longer 11pt");
});

check("the date printed is the date stored, not the day before", () => {
  // court-calendar.js's contract: a date with no zone is the date on the
  // paper and is never converted. new Date("2026-10-07") is midnight UTC,
  // which is 5pm on the 6th in Los Angeles -- the agreement was coming out
  // dated a day early. Same bug as the Word filename, twice before.
  const t = plain(DOC.render({ ...sample, agreement_date: "2026-10-07" }));
  assert.ok(t.includes("October 7, 2026"), "the printed date is not the stored date");
  assert.ok(!t.includes("October 6, 2026"), "the date slipped a day on the way to the page");
  const jan = plain(DOC.render({ ...sample, agreement_date: "2026-01-01" }));
  assert.ok(jan.includes("January 1, 2026"), "a new-year date slipped into the previous year");
});

check("Seal Orange and Ember are two different colours again", () => {
  // The board: #FF7B00 is the logo and the rules; #A34C00 is orange TEXT on
  // light. Both were coming out of one variable.
  assert.ok(/--orange:#FF7B00/.test(DOC.CSS.replace(/\s+/g, "")), "Seal Orange is not defined");
  assert.ok(/--ember:#A34C00/.test(DOC.CSS.replace(/\s+/g, "")), "Ember is not defined");
});

check("the Word file carries the letterhead on every page", () => {
  const DOCX = require(path.join(ROOT, "retainer-docx.js"));
  const PizZip = require(path.join(ROOT, "node_modules", "pizzip"));
  const z = new PizZip(DOCX.build(sample, DOC));
  const doc = z.file("word/document.xml").asText();
  // The same split the firm's own letterhead .docx uses.
  assert.ok(doc.includes("<w:titlePg/>"), "Word would use one header for every page");
  assert.ok(/w:type="first" r:id="rIdH2"/.test(doc), "no first-page header");
  assert.ok(/w:type="default" r:id="rIdH1"/.test(doc), "no continuation header");
  assert.ok(z.file("word/media/letterhead-continuation.png"), "the continuation sheet is not embedded");
  // header2 is the first page, which is the cover; it is empty on purpose.
  // See "the Word file's cover page has no letterhead behind it".
  assert.ok(/behindDoc="1"/.test(z.file("word/header1.xml").asText()),
    "the artwork would print on top of the text");
  // 1.15in top = 1656 twips; 0.80in bottom = 1152; 0.75in sides = 1080.
  assert.ok(/w:top="1656"/.test(doc) && /w:bottom="1152"/.test(doc) && /w:left="1080"/.test(doc),
    "the Word margins do not match the sheet: 1.15in top, 0.80in bottom, 0.75in sides");
});

check("the Word file's cover page has no letterhead behind it", () => {
  const DOCX = require(path.join(ROOT, "retainer-docx.js"));
  const PizZip = require(path.join(ROOT, "node_modules", "pizzip"));
  const z = new PizZip(DOCX.build(sample, DOC));
  // header2 is the first page, and the first page is the cover, which
  // carries the firm's mark itself. It used to hold the full first-page
  // sheet: a second shield and a second footer on top of the cover's own.
  const first = z.file("word/header2.xml").asText();
  assert.ok(!/<w:drawing>/.test(first), "the cover page still has artwork behind it");
  assert.strictEqual(z.file("word/media/letterhead-first.png"), null,
    "the first-page sheet is still being embedded");
  // And the continuation sheet is still on every page after it.
  const rest = z.file("word/header1.xml").asText();
  assert.ok(/<w:drawing>/.test(rest), "no letterhead on the pages after the cover");
  assert.ok(z.file("word/media/letterhead-continuation.png"), "the continuation sheet is not embedded");
  const doc = z.file("word/document.xml").asText();
  assert.ok(/<w:titlePg\/>/.test(doc), "without titlePg Word puts one header on every page");
});

check("the brand faces are served by this app, not only by Google", () => {
  for (const f of ["Brand-Cormorant-Bold", "Brand-Montserrat-Regular", "TezSerif-Regular"]) {
    assert.ok(DOC.CSS.includes(`/brand-fonts/${f}.ttf`), `${f} is not served locally`);
  }
  const server = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
  assert.ok(/express\.static\(require\("path"\)\.join\(__dirname, "assets", "fonts"\)/.test(server),
    "nothing serves assets/fonts");
});

// ── "there is no button to send for esign or print or export as
//     word or pdf" ───────────────────────────────────────────

check("the print view is not a dead end", () => {
  const html = DOC.render(sample, { forClient: true, id: 7 });
  for (const label of ["Save as PDF", "Download Word", "Send for signature", "Back to the draft"]) {
    assert.ok(html.includes(label), `no ${label} control`);
  }
  assert.ok(/action="\/admin\/retainer\/7\/send"/.test(html), "send posts nowhere");
  assert.ok(html.includes("/admin/retainer/7/word"), "the Word link does not carry the draft");
  // And none of it prints.
  assert.ok(/\.no-print \{ display:none !important; \}/.test(DOC.CSS.replace(/\s+/g, " ")),
    "the button bar would print on the agreement");
});

check("a draft with no id gets no buttons rather than broken ones", () => {
  const html = DOC.render(sample, { forClient: true });
  assert.ok(!html.includes("Download Word"), "a link to /undefined/word");
});

check("the Word file is a real .docx, and it is built FROM the page", () => {
  const DOCX = require(path.join(ROOT, "retainer-docx.js"));
  const buf = DOCX.build(sample, DOC);
  assert.ok(Buffer.isBuffer(buf) && buf.length > 3000, "nothing came out");
  assert.strictEqual(buf.slice(0, 2).toString("latin1"), "PK", "not a zip, so not a .docx");
  // Converted, not restated: the builder reads retainer-doc's own markup.
  const src = fs.readFileSync(path.join(ROOT, "retainer-docx.js"), "utf8");
  assert.ok(/doc\.body\(a, \{ forClient: true, withLetterhead: false \}\)/.test(src),
    "the Word exporter reasons about the agreement a second time instead of converting it");
  assert.ok(!/§ 614[78]|contingen/i.test(src.replace(/^\s*(\/\/|\*).*$/gm, "")),
    "fee logic has been duplicated into the Word exporter");
});

check("the drafter's notes never reach the Word file", () => {
  const DOCX = require(path.join(ROOT, "retainer-docx.js"));
  // Nothing renders them any more, so the real assertion is that the
  // document has none. The stripper stays and is tested on an injected
  // note, so re-adding one anywhere cannot carry it into a client's copy.
  assert.ok(!/class="why"/.test(DOC.body(sample, { forClient: false })),
    "a note is being rendered again");
  const injected = `<p>Real text.</p><p class="why">Why this is here: § 6148(a)(1).</p>`;
  assert.ok(!/Why this is here/.test(DOCX.fromHtml(injected)),
    "a 'why this clause is here' note would go out to the client");
  assert.ok(/Real text\./.test(DOCX.fromHtml(injected)), "the stripper ate the agreement too");
});

check("the Word file has somewhere to sign", () => {
  const DOCX = require(path.join(ROOT, "retainer-docx.js"));
  const PizZip = require(path.join(ROOT, "node_modules", "pizzip"));
  const doc = new PizZip(DOCX.build(sample, DOC)).file("word/document.xml").asText();
  // fromHtml reads block tags, and the signature lines are divs, so they
  // were being dropped in silence: every Word copy of this agreement went
  // out with no rule, no names and no date lines.
  assert.ok(doc.includes("Tez Law P.C., doing business as TEZ Law Firm"),
    "the firm does not sign the Word copy");
  const asXml = (t) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/'/g, "&apos;");
  assert.ok(doc.includes(asXml(sample.client_name)), "the client does not sign the Word copy");
  assert.ok(!doc.includes("&amp;amp;"), "the client's name was escaped twice on its way to Word");
  assert.ok((doc.match(/Date: _+/g) || []).length === 2, "both date lines are not there");
  assert.ok(/<w:bottom w:val="single" w:sz="6" w:color="2B2523"\/>/.test(doc),
    "there is no rule to sign on");
});

check("the cover and the letterhead are in the Word file once each", () => {
  const DOCX = require(path.join(ROOT, "retainer-docx.js"));
  const PizZip = require(path.join(ROOT, "node_modules", "pizzip"));
  const doc = new PizZip(DOCX.build(sample, DOC)).file("word/document.xml").asText();
  // build() prepends its own cover and letterhead, so the body it converts
  // must not carry a second copy: the date, the Re line and the salutation
  // were each printing twice, and the cover's title leaked into the letter.
  assert.strictEqual((doc.match(/Agreement for Legal Services \(/g) || []).length, 1,
    "the Re line is in the document twice");
  assert.strictEqual((doc.match(/Dear /g) || []).length, 1, "the salutation is in the document twice");
  assert.ok(!/Attorney–ClientFee Agreement/.test(doc), "the cover's title leaked into the letter");
});

check("Word does not print the source file's line wrapping as gaps", () => {
  const DOCX = require(path.join(ROOT, "retainer-docx.js"));
  // Runs carry xml:space="preserve", so a newline and six spaces of
  // indentation in retainer-doc.js came out as six spaces mid-sentence.
  const xml = DOCX.fromHtml("<p>One sentence,\n      and its second half.</p>");
  assert.ok(!/ {2}/.test(xml.replace(/<[^>]*>/g, "")), "a run still carries collapsed whitespace");
  assert.ok(/One sentence, and its second half\./.test(xml.replace(/<[^>]*>/g, "")),
    "the sentence did not survive the collapse");
});

check("an apostrophe in a client name survives into Word as itself", () => {
  const DOCX = require(path.join(ROOT, "retainer-docx.js"));
  const xml = DOCX.fromHtml(`<p>Agreement with <strong>O&#39;Brien &amp; Sons</strong>.</p>`);
  assert.ok(xml.includes("O&apos;Brien &amp; Sons"), "the name was mangled: " + xml.slice(0, 200));
  assert.ok(/<w:b\/>/.test(xml), "bold was dropped");
});

check("the fee table becomes a Word table, not a run-on paragraph", () => {
  const DOCX = require(path.join(ROOT, "retainer-docx.js"));
  const html = DOC.body(sample, { forClient: true });
  const xml = DOCX.fromHtml(html);
  assert.ok(/<w:tbl>/.test(xml), "the milestone table flattened");
  assert.ok((xml.match(/<w:tr>/g) || []).length >= 3, "the table lost its rows");
});

check("the filename names the client and the date", () => {
  const DOCX = require(path.join(ROOT, "retainer-docx.js"));
  const n = DOCX.fileName(sample);
  assert.ok(n.startsWith("Attorney-Client Fee Agreement"), "the file is not named for the document: " + n);
  assert.ok(n.endsWith(".docx") && n.includes("2026-10-07"), n);
  assert.ok(!/[\\/:*?"<>|]/.test(n), "the filename carries a character a filesystem will refuse: " + n);
});

// ── The clause set, grown from the firm's own agreements ──

check("the agreement now says what the firm's robust ones say", () => {
  const keys = R.clausesFor({ structure: "flat", matter_type: "immigration_removal" });
  for (const k of ["scope_limits", "hourly_outside_scope", "client_duties", "no_guarantee",
                   "delegation", "trust_account", "records", "confidentiality",
                   "governing_law", "effective_date"]) {
    assert.ok(keys.includes(k), `${k} is not in the agreement`);
  }
  assert.ok(keys.indexOf("acknowledgment") === keys.length - 1,
    "the acknowledgment should sit last, above the signatures it refers to");
});

check("the conflict waiver appears where the firm acts for more than one party", () => {
  assert.ok(R.clausesFor({ matter_type: "immigration_business" }).includes("conflict_disclosure"),
    "EB-5 and investor work is exactly what the waiver is for");
  assert.ok(!R.clausesFor({ matter_type: "immigration_removal" }).includes("conflict_disclosure"),
    "a single-client matter should not carry a waiver describing a conflict that cannot arise");
});

check("the rate card is the firm's current one, by role", () => {
  const c = R.CLAUSES.hourly_outside_scope.en;
  assert.ok(/\$650 for the managing partner/.test(c), "the managing partner rate is wrong");
  assert.ok(/\$350 for an associate/.test(c) && /\$200 for a paralegal/.test(c));
  // The Wecare engagement's card was that engagement's, not the firm's.
  assert.ok(!/795|\$500 /.test(c), "the Wecare rates were carried over");
});

check("earned-on-signing did not come back in with the new clauses", () => {
  // The I-526E template says the full fee is earned once work commences.
  // Rule 1.5(d) and Formal Opinion 2026-210 say otherwise, and 25-O-27445
  // is open. Every clause is checked, not just the fee ones.
  for (const [k, c] of Object.entries(R.CLAUSES)) {
    // The compliant clauses say these phrases in order to DENY them --
    // "it is not non-refundable", "not earned merely because this Agreement
    // has been signed". Drop the denials before looking, or the clause that
    // exists to satisfy the rule is the one that trips the check.
    const t = `${c.en} ${c.zh || ""}`
      .replace(/\bis not\b[^.]*/gi, "")
      .replace(/\bnot earned\b[^.]*/gi, "")
      .replace(/\bnever\b[^.]*/gi, "");
    assert.ok(!/non-?refundable/i.test(t), `${k} calls a fee non-refundable`);
    assert.ok(!/earned (up)?on (receipt|signing|execution)/i.test(t), `${k} denominates a fee earned on receipt`);
    assert.ok(!/deemed earned/i.test(t), `${k} deems a fee earned`);
  }
  // And the rule still bites: a clause that really did say it would fail.
  assert.throws(() => {
    const t = "The full fee shall be deemed earned upon execution and is non-refundable.";
    assert.ok(!/deemed earned/i.test(t));
  }, /deemed earned|AssertionError/);
});

check("five clauses took their Chinese from the firm's own template", () => {
  for (const k of ["client_duties", "no_guarantee", "delegation",
                   "electronic_communications", "governing_law"]) {
    assert.ok(R.CLAUSES[k].zh, `${k} lost the Chinese it was given`);
  }
});

check("a clause with no Chinese still cannot go out bilingual", () => {
  // Every clause has Chinese now, so this has to make a gap to test the
  // guard rather than assert that one exists.
  const key = "records";
  const keep = R.CLAUSES[key].zh;
  try {
    R.CLAUSES[key].zh = null;
    const problems = R.problemsWith({ ...sample, bilingual: true });
    assert.ok(problems.some((p) => /中文|Chinese/i.test(p)),
      "the § 1632 guard stopped noticing an untranslated clause");
  } finally {
    R.CLAUSES[key].zh = keep;
  }
  assert.strictEqual(
    R.problemsWith({ ...sample, bilingual: true })
      .filter((p) => /中文|Chinese/i.test(p)).length, 0,
    "the gap was not put back");
});

console.log(`\n${passed} checks passed\n`);
