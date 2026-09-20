// ============================================================
//  TEZ LAW P.C. — LITIGATION PHASE PLAYBOOKS
//  ─────────────────────────────────────────────────────────
//  What a large firm actually does at each phase of a matter,
//  expressed as data: a standard task checklist, who owns each
//  task, the UTBMS code it bills to, the gate criteria that
//  must be satisfied before the matter advances, the document
//  folder taxonomy, and the malpractice watch items.
//
//  Three ideas from legal project management drive the design:
//
//   1. TASK TEMPLATES. Entering a phase generates the phase's
//      standard tasks on the matter, assigned by role. Nobody
//      re-derives the checklist from memory.
//   2. STAGE GATES. A matter should not leave Intake without a
//      cleared conflict check and a signed engagement letter,
//      or leave Trial Prep without the pretrial order filed.
//      Gates are checked, and the ones that can be verified
//      from data are verified automatically.
//   3. ROLE SEPARATION. Sales/intake, attorney and case
//      manager see their own work. Large firms split these
//      sharply and the software should too.
//
//  Every task carries a UTBMS code so phase budgets reconcile
//  against the firm's time entries and against client e-billing.
// ============================================================

const db = require("./db");
const utbms = require("./civil-utbms");

// ── Roles ───────────────────────────────────────────────────
const ROLES = [
  { key: "sales",        label: "Sales / Intake",           color: "#0284C7",
    blurb: "Sources and qualifies the lead, captures adverse parties, chases the signature and the retainer." },
  { key: "attorney",     label: "Attorney",                 color: "#3E2818",
    blurb: "Owns strategy, the client decision, and every judgment call. Signs what has to be signed." },
  { key: "case_manager", label: "Case Manager / Paralegal", color: "#E0B44E",
    blurb: "Runs the file: records, chronology, e-filing, service, exhibits, productions." },
  { key: "docketing",    label: "Docketing",                color: "#7C3AED",
    blurb: "Calendars every deadline independently of the attorney. The second pair of eyes on the calendar." },
  { key: "billing",      label: "Billing",                  color: "#166534",
    blurb: "Trust accounting, budgets, invoices, outside counsel guideline compliance." },
];
const ROLE_KEYS = new Set(ROLES.map(r => r.key));

// ── Helpers for writing the templates compactly ─────────────
// t(key, label, role, utbmsCode, opts)
//   opts.days     — due this many days after the matter enters the phase
//   opts.critical — a task whose omission is a malpractice exposure
//   opts.gate     — this task backs a gate criterion of the same key
function t(key, label, role, code, opts = {}) {
  return Object.assign({ key, label, role, utbms: code, days: 7, critical: false }, opts);
}
// g(key, label, opts) — a gate criterion.
//   opts.task  — satisfied when that template task is completed
//   opts.field — satisfied when that civil_cases column is non-empty
//   opts.check — "deadline:<source_trigger>" satisfied when such a deadline exists
//   otherwise it is a manual attestation someone has to tick
function g(key, label, opts = {}) {
  return Object.assign({ key, label }, opts);
}

const PHASES = {
  // ══════════════════════════════════════════════════════════
  intake: {
    utbmsPhase: "L100",
    headline: "Qualify the matter, clear conflicts, and get it signed.",
    caution: "Conflicts are a top-three malpractice claim driver, and working before the engagement letter is signed is the classic way to lose the fee and the claim. The statute of limitations goes on the calendar on the prospect record, before anyone is engaged.",
    folder: "01_Intake_and_Engagement",
    tasks: [
      t("lead_record",      "Create the lead record — referral source, adverse parties, one-paragraph statement of the dispute", "sales", "L120", { days: 0 }),
      t("conflicts_search", "Run the conflicts search — client, ALL adverse parties, co-defendants, insurers, witnesses, experts, and the full corporate tree", "sales", "L120", { days: 1, critical: true, gate: true }),
      t("sanctions_screen", "Run OFAC / sanctions and PEP screening; AML questionnaire for entity clients", "sales", "L120", { days: 1 }),
      t("nbi_form",         "Complete the New Business Intake form — legal name, matter description, responsible and billing attorney, fee arrangement, estimated fees", "sales", "L120", { days: 2 }),
      t("calendar_sol",     "Calendar the outside statute of limitations NOW, on the prospect record, with 180/90/60/30-day tickles", "docketing", "L120", { days: 1, critical: true, gate: true }),
      t("conflicts_clear",  "Responsible attorney dispositions every conflict hit in writing and clears (or declines) the matter", "attorney", "L120", { days: 3, critical: true, gate: true }),
      t("conflict_waivers", "Obtain any conflict waivers with informed consent confirmed in writing", "attorney", "L120", { days: 5 }),
      t("credit_check",     "Financial / credit check; look for prior write-offs or AR aging on related matters", "billing", "L120", { days: 3 }),
      t("assessment_call",  "Case assessment interview — collect key documents, the contract or policy at issue, and a fact chronology", "attorney", "L110", { days: 4 }),
      t("evaluation_memo",  "Preliminary case evaluation memo — claims, defenses, exposure range, jurisdiction and venue, coverage, recovery prospects", "attorney", "L120", { days: 7 }),
      t("engagement_letter","Prepare the engagement letter — scope, exclusions, rates and rate-increase clause, retainer terms, e-discovery cost allocation, file retention", "attorney", "L120", { days: 5 }),
      t("engagement_signed","Obtain the SIGNED engagement letter (and contingency fee agreement where applicable)", "sales", "L120", { days: 10, critical: true, gate: true }),
      t("retainer_cleared", "Collect the retainer into trust and confirm cleared funds; open the client trust ledger", "billing", "L120", { days: 10, critical: true, gate: true }),
      t("open_matter",      "Open the matter — client and matter number, billing rates, UTBMS requirement, outside counsel guidelines loaded", "billing", "L140", { days: 11, gate: true }),
      t("ethical_wall",     "Erect any required ethical wall; issue the notice firmwide and collect acknowledgments", "attorney", "L120", { days: 11 }),
      t("matter_workspace", "Create the matter workspace and folder taxonomy; assign the team; schedule the kickoff", "case_manager", "L140", { days: 12 }),
      t("non_engagement",   "If DECLINED: send and retain the non-engagement letter — a high-frequency malpractice trap", "attorney", "L120", { days: 3, critical: true }),
    ],
    gates: [
      g("conflicts_search", "Conflicts searched against all parties and affiliates", { task: "conflicts_search" }),
      g("conflicts_clear",  "Every conflict hit dispositioned and cleared in writing by the responsible attorney", { task: "conflicts_clear" }),
      g("engagement_signed","Signed engagement letter on file, scope stated", { task: "engagement_signed" }),
      g("open_matter",      "Matter opened with rates, fee arrangement and billing guidelines loaded", { task: "open_matter" }),
      g("retainer_cleared", "Retainer received and cleared into trust, or credit approval documented", { task: "retainer_cleared" }),
      g("calendar_sol",     "Statute of limitations calendared and confirmed by a second person", { field: "statute_of_limitations" }),
      g("staffing",         "Responsible attorney, billing attorney and staffing plan assigned", { check: "team" }),
    ],
    kpis: ["Speed to lead", "Qualified to signed conversion", "Days to engagement letter", "Retainer collection rate"],
  },

  // ══════════════════════════════════════════════════════════
  pre_filing: {
    utbmsPhase: "L100",
    headline: "Hold the evidence, verify every deadline, and decide whether to file.",
    caution: "A late litigation hold is the highest-severity failure in this phase — it produces Rule 37(e) spoliation sanctions and an adverse-inference instruction. Notice-of-claim and administrative exhaustion deadlines kill more cases than the statute of limitations does.",
    folder: "02_Investigation",
    tasks: [
      t("litigation_hold",   "Issue the litigation hold notice to client custodians", "attorney", "L610", { days: 1, critical: true, gate: true }),
      t("hold_acknowledge",  "Track hold acknowledgments; instruct IT to suspend auto-delete, archiving and recycling; document all of it", "case_manager", "L612", { days: 7, critical: true }),
      t("custodian_map",     "Custodian interviews and the data map — email, file shares, laptops, phones, Slack or Teams, cloud, ERP, backups, vendor-held data", "case_manager", "L602", { days: 14 }),
      t("rule11_inquiry",    "Rule 11 reasonable pre-filing inquiry into facts AND law, documented in the file", "attorney", "L110", { days: 14, critical: true, gate: true }),
      t("verify_deadlines",  "Verify the SOL, statutes of repose, notice-of-claim deadlines and administrative exhaustion (EEOC right-to-sue, tort claims act notice, contractual notice and cure)", "attorney", "L110", { days: 7, critical: true, gate: true }),
      t("jurisdiction",      "Analyze jurisdiction, venue, removal exposure, arbitration and forum-selection clauses, and choice of law", "attorney", "L120", { days: 10, gate: true }),
      t("collectability",    "Asset and collectability check on the adverse party — corporate status, UCC filings, judgment search, insurance identification", "case_manager", "L110", { days: 14 }),
      t("tender_insurer",    "Tender to insurers / issue the coverage notice; log the reservation of rights and docket coverage deadlines", "attorney", "L120", { days: 7 }),
      t("witness_interviews","Identify witnesses and take non-privileged fact statements and declarations", "attorney", "L110", { days: 21 }),
      t("consulting_expert", "Retain consulting (non-testifying) experts under engagement letter to preserve their protected status", "attorney", "L130", { days: 21 }),
      t("preserve_evidence", "Preserve physical evidence; send third-party preservation and spoliation letters; arrange inspections", "case_manager", "L610", { days: 10, critical: true }),
      t("order_records",     "Order records — medical, employment, police and incident, regulatory, property, public filings", "case_manager", "L110", { days: 14 }),
      t("demand_letter",     "Draft and send the demand letter or pre-suit notice; open the settlement channel", "attorney", "L160", { days: 21 }),
      t("tolling_agreement", "Consider a tolling agreement where there is SOL pressure — it cannot revive a lapsed claim, only pause a live one", "attorney", "L120", { days: 21, critical: true }),
      t("ece_memo",          "Early case evaluation memo with a decision-tree damages model and a litigate-or-settle recommendation", "attorney", "L120", { days: 28, gate: true }),
      t("phase_budget",      "Build the litigation budget BY PHASE and obtain the client's written approval", "billing", "L150", { days: 28, gate: true }),
      t("kickoff",           "Matter kickoff — scope, exclusions, staffing plan, communication protocol, reporting cadence, phase gates", "attorney", "L120", { days: 30 }),
    ],
    gates: [
      g("litigation_hold",  "Litigation hold issued, acknowledged and documented; auto-deletion suspended", { task: "litigation_hold" }),
      g("rule11_inquiry",   "Rule 11 factual and legal investigation completed and documented", { task: "rule11_inquiry" }),
      g("verify_deadlines", "SOL, notice-of-claim and exhaustion deadlines verified and docketed", { task: "verify_deadlines" }),
      g("jurisdiction",     "Jurisdiction, venue and forum (including arbitration) determined", { field: "jurisdiction" }),
      g("phase_budget",     "Written client-approved budget and case strategy, go/no-go recorded", { task: "phase_budget" }),
      g("ece_memo",         "Early case evaluation complete; client has approved filing", { task: "ece_memo" }),
      g("settlement_auth",  "Written settlement authority from the client, or a documented decision to file", { manual: true }),
    ],
    kpis: ["Days from intake to hold issuance", "Custodian acknowledgment rate", "Investigation cycle time", "L100 budget vs actual"],
  },

  // ══════════════════════════════════════════════════════════
  pleadings: {
    utbmsPhase: "L200",
    headline: "File it, serve it, and settle the pleadings.",
    caution: "Affirmative defenses not pleaded are waived. Compulsory counterclaims not pleaded are lost. Removal is 30 days from service with a one-year outer limit. Docketing calendars the case schedule independently of the attorney — that redundancy is the control.",
    folder: "03_Pleadings",
    tasks: [
      t("finalize_pleading", "Finalize the complaint or answer — verify parties, capacity, standing, jurisdictional allegations, and that every element of each count is pleaded", "attorney", "L210", { days: 3 }),
      t("pleading_requirements", "Verify pleading-stage requirements — verification, certificate or affidavit of merit, pre-suit notice attachments, corporate disclosure, civil cover sheet", "case_manager", "L210", { days: 3, critical: true }),
      t("file_complaint",    "File and pay the fee; capture the file-stamped copy and the case number", "case_manager", "L210", { days: 5, gate: true }),
      t("docket_schedule",   "Docket the full case schedule off the filing date — service deadline, responsive pleading dates, conference triggers, standing-order deadlines", "docketing", "L210", { days: 6, critical: true, gate: true }),
      t("serve_process",     "Arrange service on every defendant (registered agent, long-arm, Hague for foreign parties); file proofs; docket each defendant's separate response date", "case_manager", "L210", { days: 14, critical: true, gate: true }),
      t("waiver_of_service", "Prepare waiver-of-service requests where appropriate", "case_manager", "L210", { days: 7 }),
      t("calendar_response", "Defense side: calendar the response deadline; obtain the client's or insurer's consent to any extension and file the stipulation", "docketing", "L210", { days: 2, critical: true }),
      t("response_strategy", "Decide the responsive pleading strategy — motion to dismiss, motion to strike, more definite statement, demurrer, anti-SLAPP, or answer", "attorney", "L210", { days: 10 }),
      t("draft_answer",      "Draft the answer — admit or deny each paragraph against the verified record and plead ALL affirmative defenses", "attorney", "L210", { days: 14, critical: true }),
      t("counterclaims",     "Evaluate counterclaims, crossclaims, third-party complaints and necessary-party joinder; docket the compulsory-counterclaim risk", "attorney", "L210", { days: 14, critical: true }),
      t("removal",           "Assess removal within 30 days of service (and the one-year outer limit), or evaluate remand", "attorney", "L210", { days: 20, critical: true }),
      t("pro_hac",           "Pro hac vice applications and local counsel; confirm local rules, standing orders and chambers procedures", "case_manager", "L210", { days: 14 }),
      t("appearance",        "File the notice of appearance and corporate disclosure statement", "case_manager", "L210", { days: 7 }),
      t("provisional",       "Evaluate provisional remedies — TRO, preliminary injunction, attachment, lis pendens, receivership", "attorney", "L220", { days: 10 }),
      t("budget_update",     "Confirm or update the client budget for the pleadings phase; log any scope change", "billing", "L150", { days: 21 }),
      t("status_report",     "Issue the new-matter status report to the client at the cadence the billing guidelines require", "attorney", "L120", { days: 30 }),
    ],
    gates: [
      g("file_complaint",  "Complaint filed and the case number captured", { field: "case_number" }),
      g("docket_schedule", "Full case schedule docketed off the filing date", { task: "docket_schedule" }),
      g("serve_process",   "All defendants served and proofs of service on file", { field: "service_date" }),
      g("pleadings_closed","Responsive pleadings filed; affirmative defenses and compulsory counterclaims pleaded", { task: "draft_answer" }),
      g("removal_decided", "Removal evaluated and the window documented", { task: "removal" }),
    ],
    kpis: ["Days filing to service", "Service success rate on first attempt", "Motion-to-dismiss success rate", "L200 budget vs actual"],
  },

  // ══════════════════════════════════════════════════════════
  discovery: {
    utbmsPhase: "L300",
    headline: "Propound, respond, produce, depose — and protect the motion-to-compel window.",
    caution: "Discovery is where the budget dies and where the motion-to-compel clock is unforgiving. Track what is served, what is due, and what is outstanding on one chart, and re-forecast the budget before you leave this phase.",
    folder: "04_Discovery",
    tasks: [
      t("meet_confer_plan",  "Prepare for and attend the discovery planning conference — ESI scope, custodians, date ranges, search terms or TAR, privilege log format, clawback", "attorney", "L601", { days: 7, gate: true }),
      t("scheduling_order",  "File the discovery plan; attend the scheduling conference; DOCKET EVERY DATE in the resulting order", "docketing", "L601", { days: 14, critical: true, gate: true }),
      t("initial_disclosures","Serve initial disclosures; calendar the supplementation obligation", "attorney", "L310", { days: 21, critical: true }),
      t("protective_order",  "Negotiate and enter the protective order, the ESI protocol, and a clawback order", "attorney", "L610", { days: 30, gate: true }),
      t("serve_written",     "Draft and serve written discovery; docket every response date and extension", "attorney", "L310", { days: 30 }),
      t("collect_esi",       "Collect ESI defensibly with chain of custody; process, deduplicate, thread and load; report search term hits", "case_manager", "L620", { days: 45 }),
      t("review_workspace",  "Build the review workspace — coding layout, review protocol memo, reviewer training", "case_manager", "L650", { days: 50 }),
      t("first_pass_review", "First-level review with daily throughput tracking; second-level QC by sampling; track the overturn rate", "case_manager", "L653", { days: 75 }),
      t("privilege_log",     "Privilege review, redactions (privilege plus PII and PHI), redaction QC, and the privilege log in the agreed format", "attorney", "L655", { days: 85, critical: true, gate: true }),
      t("productions",       "Build production sets — Bates numbering, confidentiality branding, agreed format, load file QC", "case_manager", "L670", { days: 90, gate: true }),
      t("respond_discovery", "Draft responses and objections to incoming discovery; obtain signed verifications; docket supplementation", "attorney", "L310", { days: 40, critical: true }),
      t("review_incoming",   "Review, index and issue-code incoming productions; run the deficiency analysis; send meet-and-confer deficiency letters", "case_manager", "L320", { days: 60 }),
      t("subpoenas",         "Issue third-party subpoenas; track compliance, objections and custodian productions", "case_manager", "L390", { days: 60 }),
      t("depositions",       "Plan and take depositions — witness priority, notices, reporters, kits, witness prep, summaries", "attorney", "L330", { days: 120, gate: true }),
      t("expert_discovery",  "Expert discovery — retain testifying experts, serve reports and rebuttals, depose opposing experts", "attorney", "L340", { days: 140, critical: true, gate: true }),
      t("discovery_motions", "Manage discovery motions; track the meet-and-confer certification requirement", "attorney", "L350", { days: 150 }),
      t("status_chart",      "Maintain the discovery status chart — served, due, received, outstanding", "case_manager", "L310", { days: 30 }),
      t("budget_burn",       "Run the budget burn review — discovery is where the budget dies", "billing", "L150", { days: 60, gate: true }),
      t("mediation",         "Early mediation or ADR if ordered or strategically indicated; prepare the mediation statement", "attorney", "L160", { days: 120 }),
    ],
    gates: [
      g("scheduling_order", "Scheduling order entered and every date docketed", { task: "scheduling_order" }),
      g("cutoff_passed",    "Fact discovery cutoff passed, or all outstanding discovery completed or waived", { field: "discovery_cutoff_date" }),
      g("privilege_log",    "All productions complete and a privilege log served in the agreed form", { task: "privilege_log" }),
      g("protective_order", "Protective order and ESI protocol entered; clawback order in place", { task: "protective_order" }),
      g("depositions",      "Necessary fact depositions taken and transcripts received", { task: "depositions" }),
      g("expert_discovery", "Expert reports and rebuttals served; expert depositions completed", { task: "expert_discovery" }),
      g("no_open_motions",  "No outstanding discovery motion that could reopen discovery", { manual: true }),
      g("budget_burn",      "Budget re-forecast for the motion and trial phases and approved by the client", { task: "budget_burn" }),
    ],
    kpis: ["Discovery cycle time", "Review cost per GB", "Documents reviewed per hour", "Overturn rate", "L300 budget vs actual"],
  },

  // ══════════════════════════════════════════════════════════
  motions: {
    utbmsPhase: "L200",
    headline: "Law and motion — dispositive motions, Daubert, and the notice math.",
    caution: "Summary judgment timing runs BACKWARD from the trial date, not forward from today, and in most jurisdictions the motion must be heard — not merely filed — by a date certain. Every fact in the separate statement needs a record cite that actually says what you claim it says.",
    folder: "05_Motions",
    tasks: [
      t("docket_msj",        "Docket the dispositive motion deadline and back-plan — research, outline, draft, partner review, cite-check, statement of facts, exhibits, file", "docketing", "L240", { days: 2, critical: true, gate: true }),
      t("msj_viability",     "Claim-by-claim and defense-by-defense summary judgment viability analysis; full or partial; client authorization and budget", "attorney", "L240", { days: 10, gate: true }),
      t("statement_facts",   "Prepare the statement of undisputed material facts with a record cite for EVERY fact", "attorney", "L240", { days: 21, critical: true, gate: true }),
      t("evidentiary_record","Assemble the evidentiary record — declarations, authenticated exhibits, deposition excerpts, expert declarations, business-records certifications", "case_manager", "L240", { days: 25 }),
      t("draft_memo",        "Draft the memorandum of points and authorities; verify page or word limits, formatting and the judge's standing orders", "attorney", "L240", { days: 28 }),
      t("motion_to_seal",    "Prepare any motion to seal or redacted public filing for protective-order material", "case_manager", "L250", { days: 28 }),
      t("cite_check",        "Cite-check every citation; verify each record cite against the actual page and line; run negative history on every authority", "case_manager", "L240", { days: 30, critical: true }),
      t("daubert",           "Prepare Daubert or expert-exclusion motions and the supporting record", "attorney", "L250", { days: 30, gate: true }),
      t("file_and_calendar", "File, serve, calendar the opposition and reply dates and the hearing, and prepare chambers copies", "case_manager", "L240", { days: 32, critical: true }),
      t("opposition",        "Draft the opposition to the adverse motion with the responsive statement of disputed facts and evidentiary objections", "attorney", "L240", { days: 45, critical: true }),
      t("reply",             "Draft the reply and any evidentiary objections or responses the jurisdiction requires", "attorney", "L240", { days: 55 }),
      t("oral_argument",     "Prepare for argument — bench memo, outline, anticipated questions, key-case binder, moot session", "attorney", "L240", { days: 60 }),
      t("docket_from_order", "Attend the hearing, record the ruling, and DOCKET EVERY DEADLINE FLOWING FROM THE ORDER", "docketing", "L240", { days: 70, critical: true, gate: true }),
      t("post_ruling_report","Client status report and revised case assessment based on the ruling; re-evaluate settlement posture", "attorney", "L120", { days: 75, gate: true }),
      t("interlocutory",     "Consider interlocutory appeal, certification or a writ petition on an adverse ruling — and docket that window immediately", "attorney", "L510", { days: 72, critical: true }),
      t("trial_budget",      "Prepare and obtain approval for the trial budget; staff the trial team", "billing", "L150", { days: 80, gate: true }),
    ],
    gates: [
      g("msj_resolved",     "Dispositive motions filed, briefed and ruled on, or the deadline passed with a documented decision", { task: "docket_from_order" }),
      g("daubert",          "Daubert and expert-exclusion motions resolved — you cannot build a trial plan without knowing which experts survive", { task: "daubert" }),
      g("statement_facts",  "Every fact supported by an admissible, verified record cite", { task: "statement_facts" }),
      g("docket_from_order","Every deadline flowing from the orders docketed", { task: "docket_from_order" }),
      g("post_ruling_report","Case assessment updated and the client informed in writing", { task: "post_ruling_report" }),
      g("trial_budget",     "Trial budget approved and the trial team staffed", { task: "trial_budget" }),
    ],
    kpis: ["MSJ win rate, full and partial", "Cost per dispositive motion", "Days filing to ruling", "L240 budget vs actual"],
  },

  // ══════════════════════════════════════════════════════════
  trial_prep: {
    utbmsPhase: "L400",
    headline: "Everything counts backwards from the trial date.",
    caution: "This phase is a countdown, not a list. A matter sitting here without a trial date has no deadlines at all, which is the dangerous state. Exhibits not pre-marked and designations not ruled on become evidentiary problems in front of the jury.",
    folder: "06_Trial_Prep",
    tasks: [
      t("read_trial_order",  "Read the trial-setting order, local rules, standing orders and courtroom technology rules; build and docket the pretrial deadline chain", "docketing", "L440", { days: 2, critical: true, gate: true }),
      t("lock_evidence",     "Complete any remaining discovery and lock the evidentiary universe", "attorney", "L440", { days: 7 }),
      t("witness_availability","Confirm witness availability; lock expert trial dates; build the witness order and the trial calendar", "case_manager", "L410", { days: 14, gate: true }),
      t("trial_logistics",   "Trial budget and staffing plan; book the war room, hotels, trial technician and vendors", "billing", "L150", { days: 14 }),
      t("trial_theme",       "Build the trial theme and case narrative; develop the opening framework", "attorney", "L440", { days: 21 }),
      t("pretrial_order",    "Prepare and exchange the joint pretrial order — stipulated facts, contested issues, witness list, exhibit list, deposition designations", "attorney", "L430", { days: 30, critical: true, gate: true }),
      t("trial_subpoenas",   "Issue trial subpoenas to all non-party witnesses, serve with witness fees, and track the returns", "case_manager", "L410", { days: 35, critical: true, gate: true }),
      t("designations",      "Prepare deposition designations, counter-designations and objections; prepare the video clip edits", "attorney", "L440", { days: 35, gate: true }),
      t("premark_exhibits",  "Pre-mark all trial exhibits in the required format; build the exhibit chart (number, description, sponsoring witness, objections, admitted date, Bates)", "case_manager", "L440", { days: 40, critical: true, gate: true }),
      t("motions_in_limine", "Draft motions in limine and oppositions; draft the trial brief", "attorney", "L430", { days: 40, critical: true, gate: true }),
      t("jury_instructions", "Draft proposed jury instructions, the verdict form and voir dire questions; research contested instructions", "attorney", "L430", { days: 45, gate: true }),
      t("witness_prep",      "Witness preparation sessions with client, fact witnesses and experts; build witness files", "attorney", "L410", { days: 55 }),
      t("exam_outlines",     "Direct and cross examination outlines for every witness; impeachment binders keyed to deposition page and line", "attorney", "L410", { days: 58 }),
      t("demonstratives",    "Prepare demonstratives — timelines, damages charts, animations, blow-ups; exchange per the pretrial order", "case_manager", "L440", { days: 55 }),
      t("final_pretrial",    "Attend the final pretrial conference; record every ruling; revise everything accordingly", "attorney", "L430", { days: 60, critical: true }),
      t("trial_notebook",    "Build the trial notebook — pleadings, pretrial order, in limine rulings, witness files, exhibit list, instructions, key law, contacts", "case_manager", "L440", { days: 62, gate: true }),
      t("tech_dry_run",      "Load exhibits and clips into the presentation system; run a full technology dry run in the courtroom if permitted", "case_manager", "L440", { days: 63, gate: true }),
      t("moot",              "Mock trial or focus group if budgeted; moot the opening and closing", "attorney", "L440", { days: 60 }),
      t("final_settlement",  "Final settlement push with updated written client authority; prepare the settlement decision memo", "attorney", "L160", { days: 58, gate: true }),
    ],
    gates: [
      g("pretrial_order",    "Joint pretrial order filed and entered; witness and exhibit lists exchanged", { task: "pretrial_order" }),
      g("motions_in_limine", "All motions in limine briefed and ruled on, and the rulings reflected in the outlines and the presentation database", { task: "motions_in_limine" }),
      g("trial_subpoenas",   "All witnesses confirmed and subpoenaed; expert availability locked", { task: "trial_subpoenas" }),
      g("premark_exhibits",  "All exhibits pre-marked, objections logged and loaded; exhibit chart complete", { task: "premark_exhibits" }),
      g("designations",      "Deposition designations and counters ruled on; clips cut to match", { task: "designations" }),
      g("jury_instructions", "Jury instructions, verdict form and voir dire submitted", { task: "jury_instructions" }),
      g("trial_notebook",    "Trial notebook complete and duplicated for each team member", { task: "trial_notebook" }),
      g("tech_dry_run",      "Trial technology tested in the courtroom or an equivalent setup", { task: "tech_dry_run" }),
      g("final_settlement",  "Written client settlement authority current; final demand or offer exchanged", { task: "final_settlement" }),
    ],
    kpis: ["Days to pretrial order", "Exhibits admitted vs offered", "In limine win rate", "Trial budget vs actual"],
  },

  // ══════════════════════════════════════════════════════════
  trial: {
    utbmsPhase: "L400",
    headline: "In trial. Make the record, and make it every day.",
    caution: "The Rule 50(a) motion must be made at the close of the plaintiff's case AND at the close of all evidence, on the record. Without it the renewed post-trial motion is waived. Every post-trial and appellate clock runs from the judgment entry date, so capture that date the day it happens.",
    folder: "07_Trial",
    tasks: [
      t("war_room",          "Set up the war room; verify courtroom technology, power, sightlines and the clerk's exhibit protocol on day one", "case_manager", "L450", { days: 0 }),
      t("voir_dire",         "Voir dire and jury selection; strike chart; track cause and peremptory challenges; preserve Batson objections", "attorney", "L450", { days: 1, critical: true }),
      t("opening",           "Deliver the opening statement", "attorney", "L450", { days: 1 }),
      t("case_in_chief",     "Run the case in chief — offer each exhibit, obtain rulings, preserve objections and offers of proof", "attorney", "L450", { days: 5, critical: true }),
      t("exhibit_chart",     "Maintain the daily exhibit chart — marked, offered, objected to, admitted or refused, with date and sponsoring witness", "case_manager", "L450", { days: 5, critical: true, gate: true }),
      t("daily_transcripts", "Order and review daily transcripts; issue-code overnight for next-day impeachment", "case_manager", "L450", { days: 3 }),
      t("nightly_meeting",   "Nightly team meeting — witness order, outline revisions, exhibits to pull, research assignments", "attorney", "L450", { days: 2 }),
      t("bench_memos",       "Nightly bench memos on the day's evidentiary issues, delivered to the court in the morning", "attorney", "L430", { days: 3 }),
      t("witness_logistics", "Daily witness logistics — arrival times, sequestration compliance, prep refreshers, travel", "case_manager", "L410", { days: 2 }),
      t("rule50a",           "Move for judgment as a matter of law at the close of the plaintiff's case AND at the close of all evidence — on the record", "attorney", "L450", { days: 7, critical: true, gate: true }),
      t("charge_conference", "Participate in the charge conference; object on the record to every instruction given or refused", "attorney", "L430", { days: 8, critical: true, gate: true }),
      t("closing",           "Deliver the closing argument and submit the verdict form", "attorney", "L450", { days: 9 }),
      t("deliberation",      "Manage deliberation — jury questions, read-backs, exhibits to the jury room, verdict watch", "attorney", "L450", { days: 10 }),
      t("take_verdict",      "Take the verdict, poll the jury, and move for any needed post-verdict relief on the record", "attorney", "L450", { days: 10, critical: true, gate: true }),
      t("client_reports",    "Daily client status reports; manage real-time settlement communications and authority", "attorney", "L120", { days: 2 }),
      t("reconcile_exhibits","Track costs and reconcile the exhibit inventory with the clerk", "case_manager", "L450", { days: 11, gate: true }),
      t("docket_post_trial", "Docket every post-trial and appellate deadline off the judgment entry date IMMEDIATELY", "docketing", "L460", { days: 11, critical: true, gate: true }),
    ],
    gates: [
      g("verdict",          "Verdict returned, judgment entered, mistrial declared, or settled on the record", { field: "verdict_date" }),
      g("rule50a",          "Rule 50(a) motions made at BOTH required points and on the record", { task: "rule50a" }),
      g("charge_conference","Objections and offers of proof preserved; charge-conference objections on the record", { task: "charge_conference" }),
      g("reconcile_exhibits","Exhibit record reconciled with the clerk; admitted exhibits accounted for", { task: "reconcile_exhibits" }),
      g("judgment_date",    "Judgment entered and the entry date recorded — every clock runs from it", { field: "judgment_date" }),
      g("docket_post_trial","All post-trial and appellate deadlines docketed off the judgment entry date", { task: "docket_post_trial" }),
    ],
    kpis: ["Trial days vs estimate", "Exhibits admitted vs offered", "Daily burn rate", "Outcome vs early case evaluation"],
  },

  // ══════════════════════════════════════════════════════════
  post_trial: {
    utbmsPhase: "L400",
    headline: "Post-trial motions, the appeal clock, collection, and the liens.",
    caution: "Post-trial windows are the shortest in litigation and mostly NOT extendable — 28 days federally, 15 in California and Arizona, 10 in Pennsylvania and Washington. When the validity of a post-trial motion is uncertain, file the notice of appeal protectively under the untolled deadline. No disbursement before every lien is resolved in writing.",
    folder: "08_Post_Trial",
    tasks: [
      t("docket_chain",      "Docket the post-trial deadline chain off the judgment entry date with redundant reminders", "docketing", "L460", { days: 0, critical: true, gate: true }),
      t("motion_assessment", "Post-trial motion assessment memo — which motions, the preservation status of each argument, cost and benefit", "attorney", "L460", { days: 5 }),
      t("post_trial_motions","File the renewed JMOL, new trial, alter or amend, or amended findings motions", "attorney", "L460", { days: 14, critical: true, gate: true }),
      t("oppose_motions",    "Oppose the other side's post-trial motions; calendar BOTH the tolled and the untolled appeal dates", "attorney", "L460", { days: 20, critical: true }),
      t("costs_and_fees",    "File the bill of costs and the motion for attorneys' fees with contemporaneous records", "case_manager", "L460", { days: 14, critical: true }),
      t("notice_of_appeal",  "File the notice of appeal or cross-appeal — protectively under the untolled deadline if validity is uncertain", "attorney", "L510", { days: 25, critical: true, gate: true }),
      t("record_on_appeal",  "Order the transcript, file the docketing statement, designate the record, prepare the appendix", "case_manager", "L510", { days: 40 }),
      t("supersedeas",       "Arrange a supersedeas bond or stay of execution if defending a money judgment; calculate the bond including post-judgment interest", "attorney", "L470", { days: 20, critical: true }),
      t("enforcement",       "Begin enforcement if prevailing — judgment lien, writ of execution, garnishment, debtor's exam, asset discovery, domestication out of state", "attorney", "L470", { days: 30 }),
      t("post_judgment_interest","Calculate and track post-judgment interest; issue the payoff statement", "billing", "L470", { days: 30 }),
      t("post_verdict_settlement","Negotiate post-verdict settlement while motions are pending; document with a settlement agreement and stipulated satisfaction", "attorney", "L160", { days: 35 }),
      t("satisfaction",      "On payment, obtain, file and serve the satisfaction of judgment and release any liens", "case_manager", "L470", { days: 60, gate: true }),
      t("appellate_briefing","Appellate briefing — opening, answering, reply, argument, mandate or remittitur", "attorney", "L520", { days: 120 }),
      t("trust_and_liens",   "Process proceeds through trust; resolve every lien — Medicare and MSP conditional payments, Medicaid, ERISA, provider, statutory", "billing", "L470", { days: 45, critical: true, gate: true }),
      t("closing_statement", "Client closing statement itemizing gross recovery, fees, costs advanced, each lien and its resolved amount, and the net", "billing", "L470", { days: 50, critical: true, gate: true }),
      t("after_action",      "After-action review — outcome vs the early evaluation, budget vs actual by phase, precedents worth banking", "attorney", "L120", { days: 60 }),
    ],
    gates: [
      g("post_trial_motions","Post-trial motions filed and ruled on, or the window expired with a documented decision", { task: "post_trial_motions" }),
      g("notice_of_appeal", "Notice of appeal filed, or the period expired with a written client decision not to appeal", { task: "notice_of_appeal" }),
      g("judgment_resolved","Judgment satisfied, settled, or determined uncollectible with the client advised in writing", { task: "satisfaction" }),
      g("trust_and_liens",  "Every lien resolved and released in writing — no disbursement before this", { task: "trust_and_liens" }),
      g("closing_statement","Funds cleared and disbursed per a client-signed closing statement", { task: "closing_statement" }),
      g("hold_released",    "Litigation hold formally released and documented", { manual: true }),
    ],
    kpis: ["Collection rate on judgments", "Days to satisfaction", "Appeal outcome rate", "Lien resolution cycle time"],
  },

  // ══════════════════════════════════════════════════════════
  closed: {
    utbmsPhase: "L100",
    headline: "Bill it out, zero the trust, return the file, and set the destruction date.",
    caution: "A trust balance that is not zero and a missing disengagement letter are both bar-discipline exposure. The disengagement letter must say the firm is no longer monitoring deadlines — otherwise the client's next missed deadline becomes the firm's problem.",
    folder: "09_Closing",
    tasks: [
      t("confirm_complete",  "Confirm the matter is substantively complete — all orders entered, all appeal and post-trial periods expired, no open deadlines", "attorney", "L140", { days: 0, critical: true, gate: true }),
      t("release_hold",      "Release the litigation hold in writing to all custodians; instruct IT to resume normal retention; document it", "attorney", "L612", { days: 3, critical: true, gate: true }),
      t("dispose_esi",       "Return or certify destruction of the opposing parties' productions as the protective order requires", "case_manager", "L620", { days: 30, gate: true }),
      t("final_bill",        "Generate the final pre-bill, write off unbillable WIP with approval, and issue the final invoice", "billing", "L150", { days: 14, gate: true }),
      t("zero_trust",        "Reconcile the client trust ledger to zero — apply earned fees, pay vendors, refund the unearned balance to the CLIENT", "billing", "L150", { days: 21, critical: true, gate: true }),
      t("three_way_recon",   "Final three-way reconciliation — bank balance, firm trust ledger, sum of client sub-ledgers — and confirm no negative balance ever occurred", "billing", "L150", { days: 21, critical: true }),
      t("resolve_ar",        "Resolve accounts receivable — collect, arrange a payment plan, or write off at the required approval level", "billing", "L150", { days: 45, gate: true }),
      t("return_property",   "Return client property and originals — exhibits, physical evidence, wills, deeds, certificates — and obtain a signed receipt", "case_manager", "L140", { days: 30, critical: true, gate: true }),
      t("closing_letter",    "Send the closing and disengagement letter stating the representation has ended and that the firm is NOT monitoring further deadlines", "attorney", "L120", { days: 30, critical: true, gate: true }),
      t("cull_file",         "Cull the file — remove duplicates, drafts and superseded copies, distinguishing client property from firm work product", "case_manager", "L140", { days: 45 }),
      t("index_archive",     "Index the file, finalize the folder taxonomy, migrate to records, and mark the workspace read-only", "case_manager", "L140", { days: 50, gate: true }),
      t("retention_date",    "Set the retention period and calendar the destruction date", "case_manager", "L140", { days: 50, critical: true, gate: true }),
      t("close_systems",     "Close the matter in accounting and practice management — stop time entry, accruals and recurring vendor charges", "billing", "L140", { days: 50 }),
      t("ethical_wall_final","Remove or maintain the ethical wall as required", "attorney", "L120", { days: 50 }),
      t("update_conflicts",  "Update the conflicts database with the FINAL party list so the matter is searchable forever, and set former-client status", "sales", "L120", { days: 50, critical: true, gate: true }),
      t("closing_form",      "Complete the matter closing form signed by the responsible attorney; run the after-action review and the client survey", "attorney", "L120", { days: 55, gate: true }),
    ],
    gates: [
      g("confirm_complete", "No open deadlines, no pending motions, all appeal periods expired", { task: "confirm_complete" }),
      g("zero_trust",       "Trust balance is zero and the client has a written accounting of every trust transaction", { task: "zero_trust" }),
      g("resolve_ar",       "Final bill issued and AR at zero or formally written off", { task: "resolve_ar" }),
      g("return_property",  "Client property returned with a signed receipt", { task: "return_property" }),
      g("closing_letter",   "Closing and disengagement letter sent and saved to the file", { task: "closing_letter" }),
      g("release_hold",     "Litigation hold released; protective-order data return or destruction certified", { task: "release_hold" }),
      g("retention_date",   "File culled, indexed and archived; retention class applied and destruction date calendared", { task: "retention_date" }),
      g("update_conflicts", "Conflicts database updated with the complete party list", { task: "update_conflicts" }),
      g("closing_form",     "Responsible attorney's signed matter closing form on file", { task: "closing_form" }),
    ],
    kpis: ["Days to close after final order", "Trust refunded within 30 days", "Realization rate", "Write-off percentage"],
  },
};

const PHASE_KEYS = Object.keys(PHASES);

// ── Document folder taxonomy ────────────────────────────────
// Mirrors how a large firm lays out a matter workspace. Used to
// map Dropbox contents to the phase that produced them, so each
// stage tab shows its own documents rather than the whole file.
const PHASE_FOLDERS = PHASE_KEYS.map(k => ({
  phase: k,
  folder: PHASES[k].folder,
  // Matched case-insensitively against the relative folder path.
  patterns: [
    new RegExp(PHASES[k].folder.replace(/_/g, "[ _-]?"), "i"),
  ],
}));

// Category keywords that place a loose file into a phase when
// the folder taxonomy has not been adopted yet — which is the
// normal state for a firm importing years of existing files.
const PHASE_FILE_HINTS = {
  // \bengagement\b deliberately does NOT match "disengagement" — there is no
  // word boundary inside it — which keeps a closing letter out of intake.
  intake:     [/\bengagement\b/i, /retainer/i, /conflict/i, /intake/i, /fee agreement/i, /non.?engagement/i],
  pre_filing: [/demand/i, /litigation hold/i, /preservation/i, /investigat/i, /tolling/i, /records?[ _-]request/i],
  pleadings:  [/complaint/i, /petition/i, /\banswer\b/i, /summons/i, /proof of service/i, /demurrer/i, /cross.?complaint/i, /counterclaim/i, /removal/i],
  discovery:  [/interrogator/i, /\brogs?\b/i, /\bsrogs?\b/i, /form rog/i, /request for production/i, /\brfp\b/i, /request for admission/i, /\brfa\b/i, /deposition/i, /transcript/i, /privilege log/i, /production/i, /subpoena/i, /protective order/i],
  motions:    [/\bmsj\b/i, /summary judgment/i, /daubert/i, /points and authorities/i,
               /separate statement/i, /motion to (compel|dismiss|strike)/i, /opposition/i, /\breply\b/i,
               // Generic "motion" last, and only after the trial-prep hints have
               // had their turn — a motion in limine is trial prep, not motion practice.
               /motion/i],
  trial_prep: [/pretrial/i, /pre.?trial/i, /in limine/i, /exhibit list/i, /witness list/i, /jury instruction/i, /trial brief/i, /designation/i],
  trial:      [/trial transcript/i, /verdict/i, /voir dire/i, /closing/i, /opening statement/i],
  post_trial: [/judgment/i, /notice of appeal/i, /appellate/i, /bill of costs/i, /satisfaction/i, /lien/i, /garnish/i, /writ of execution/i],
  closed:     [/closing (letter|statement)/i, /disengagement/i, /final invoice/i, /matter closing/i,
               /file (retention|destruction)/i, /satisfaction of judgment/i],
};

// Filename hints are first-match-wins, so the order matters. Work backwards
// through the lifecycle: later-phase documents have the more distinctive names,
// and a generic word like "motion" appears in several phases. "Motion in
// Limine" must be tested against trial prep before it reaches motion practice.
const PHASE_HINT_ORDER = [
  "closed", "post_trial", "trial", "trial_prep", "motions",
  "discovery", "pleadings", "pre_filing", "intake",
];

function phaseForFile(name, relativeFolder) {
  const folder = String(relativeFolder || "");
  // An explicit folder taxonomy beats any filename guess.
  for (const pf of PHASE_FOLDERS) {
    if (pf.patterns.some(p => p.test(folder))) return pf.phase;
  }
  const hay = folder + " " + String(name || "");
  for (const key of PHASE_HINT_ORDER) {
    const hints = PHASE_FILE_HINTS[key] || [];
    if (hints.some(p => p.test(hay))) return key;
  }
  return null;
}

// ── Schema ──────────────────────────────────────────────────
async function initTables() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS civil_phase_tasks (
      id            SERIAL PRIMARY KEY,
      case_id       INTEGER REFERENCES civil_cases(id) ON DELETE CASCADE,
      phase         TEXT NOT NULL,
      task_key      TEXT NOT NULL,
      label         TEXT NOT NULL,
      role          TEXT,
      utbms_code    TEXT,
      due_date      DATE,
      status        TEXT DEFAULT 'open',
      critical      BOOLEAN DEFAULT FALSE,
      sort_order    INTEGER DEFAULT 0,
      assignee_id   INTEGER,
      assignee_name TEXT,
      notes         TEXT,
      completed_at  TIMESTAMPTZ,
      completed_by  TEXT,
      created_at    TIMESTAMPTZ DEFAULT NOW(),
      created_by    TEXT,
      updated_at    TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  // One row per template task per matter, so re-applying a template is safe.
  await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_civil_phase_task
                  ON civil_phase_tasks (case_id, phase, task_key)`).catch(() => {});
  await db.query(`CREATE INDEX IF NOT EXISTS idx_civil_phase_tasks_case
                  ON civil_phase_tasks (case_id, phase)`).catch(() => {});
  await db.query(`CREATE INDEX IF NOT EXISTS idx_civil_phase_tasks_open
                  ON civil_phase_tasks (due_date) WHERE status = 'open'`).catch(() => {});

  // Manual gate attestations — the criteria no data can prove.
  await db.query(`
    CREATE TABLE IF NOT EXISTS civil_phase_gates (
      id          SERIAL PRIMARY KEY,
      case_id     INTEGER REFERENCES civil_cases(id) ON DELETE CASCADE,
      phase       TEXT NOT NULL,
      gate_key    TEXT NOT NULL,
      satisfied   BOOLEAN DEFAULT FALSE,
      note        TEXT,
      attested_by TEXT,
      attested_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_civil_phase_gate
                  ON civil_phase_gates (case_id, phase, gate_key)`).catch(() => {});

  // Phase budgets, in the UTBMS phases clients expect to see.
  await db.query(`
    CREATE TABLE IF NOT EXISTS civil_phase_budgets (
      id            SERIAL PRIMARY KEY,
      case_id       INTEGER REFERENCES civil_cases(id) ON DELETE CASCADE,
      utbms_phase   TEXT NOT NULL,
      budget_amount NUMERIC,
      budget_hours  NUMERIC,
      notes         TEXT,
      approved_by   TEXT,
      approved_at   TIMESTAMPTZ,
      updated_at    TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_civil_phase_budget
                  ON civil_phase_budgets (case_id, utbms_phase)`).catch(() => {});

  // Columns the multi-jurisdiction engine and the phase model need.
  const cols = [
    ["jurisdiction", "TEXT"],
    ["service_method", "TEXT"],
    ["judgment_date", "DATE"],
    ["judgment_notice_date", "DATE"],
    ["verdict_date", "DATE"],
    ["discovery_cutoff_date", "DATE"],
    ["rule26f_date", "DATE"],
    ["note_of_issue_date", "DATE"],
    ["track_notice_date", "DATE"],
    ["early_meeting_date", "DATE"],
    ["msj_hearing_date", "DATE"],
    ["phase_entered_at", "TIMESTAMPTZ"],
  ];
  for (const [name, type] of cols) {
    await db.query(`ALTER TABLE civil_cases ADD COLUMN IF NOT EXISTS ${name} ${type}`).catch(() => {});
  }
}

// ── Template application ────────────────────────────────────
function addDays(base, n) {
  const d = new Date(base);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * Generate a phase's standard tasks on a matter. Idempotent:
 * re-running adds only tasks that are missing, so a template
 * can be extended later without disturbing work in progress.
 */
async function applyPhaseTemplate(caseId, phase, opts = {}) {
  await initTables();
  const spec = PHASES[phase];
  if (!spec) throw new Error("Unknown phase: " + phase);
  const from = opts.from ? new Date(opts.from) : new Date();
  const by = opts.by || "system";

  let created = 0;
  for (let i = 0; i < spec.tasks.length; i++) {
    const task = spec.tasks[i];
    const r = await db.query(
      `INSERT INTO civil_phase_tasks
         (case_id, phase, task_key, label, role, utbms_code, due_date, critical, sort_order, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (case_id, phase, task_key) DO NOTHING
       RETURNING id`,
      [caseId, phase, task.key, task.label, task.role, task.utbms,
       addDays(from, task.days), !!task.critical, i, by]
    );
    if (r.rowCount) created++;
  }
  return { ok: true, phase, created, total: spec.tasks.length };
}

async function listPhaseTasks(caseId, filter = {}) {
  await initTables();
  const where = ["case_id = $1"];
  const vals = [caseId];
  let i = 2;
  if (filter.phase) { where.push(`phase = $${i++}`); vals.push(filter.phase); }
  if (filter.role) { where.push(`role = $${i++}`); vals.push(filter.role); }
  if (filter.status) { where.push(`status = $${i++}`); vals.push(filter.status); }
  const r = await db.query(
    `SELECT * FROM civil_phase_tasks WHERE ${where.join(" AND ")}
      ORDER BY phase, sort_order, id`,
    vals
  );
  return r.rows;
}

async function updateTask(taskId, data = {}, by = null) {
  await initTables();
  const allowed = new Set(["status", "due_date", "assignee_id", "assignee_name", "notes", "label", "role", "utbms_code"]);
  const sets = [];
  const vals = [];
  let i = 1;
  for (const k of Object.keys(data)) {
    if (!allowed.has(k)) continue;
    sets.push(`${k} = $${i++}`);
    vals.push(data[k] === "" ? null : data[k]);
  }
  if (!sets.length) throw new Error("No editable task fields provided");
  if (data.status === "done") {
    sets.push(`completed_at = NOW()`, `completed_by = $${i++}`);
    vals.push(by || "web");
  } else if (data.status && data.status !== "done") {
    sets.push(`completed_at = NULL`, `completed_by = NULL`);
  }
  sets.push("updated_at = NOW()");
  vals.push(taskId);
  const r = await db.query(
    `UPDATE civil_phase_tasks SET ${sets.join(", ")} WHERE id = $${i} RETURNING *`, vals);
  if (!r.rows.length) throw new Error("Task not found");
  return r.rows[0];
}

// ── Gates ───────────────────────────────────────────────────
/**
 * Evaluate a phase's gate criteria for a matter.
 *
 * Criteria backed by a template task are satisfied when that
 * task is done. Criteria backed by a matter field are satisfied
 * when the field is populated. The rest are manual attestations
 * someone has to tick, and they are recorded with who ticked them.
 */
async function gateStatus(caseId, phase) {
  await initTables();
  const spec = PHASES[phase];
  if (!spec) throw new Error("Unknown phase: " + phase);

  const [tasksR, gatesR, caseR, teamR] = await Promise.all([
    db.query(`SELECT task_key, status FROM civil_phase_tasks WHERE case_id = $1 AND phase = $2`, [caseId, phase]),
    db.query(`SELECT gate_key, satisfied, note, attested_by, attested_at FROM civil_phase_gates WHERE case_id = $1 AND phase = $2`, [caseId, phase]),
    db.query(`SELECT * FROM civil_cases WHERE id = $1`, [caseId]),
    db.query(`SELECT COUNT(*)::int AS n FROM civil_case_team WHERE case_id = $1 AND (is_active IS NULL OR is_active = TRUE)`, [caseId]).catch(() => ({ rows: [{ n: 0 }] })),
  ]);

  const taskDone = new Map(tasksR.rows.map(r => [r.task_key, r.status === "done"]));
  const manual = new Map(gatesR.rows.map(r => [r.gate_key, r]));
  const c = caseR.rows[0] || {};
  const teamCount = (teamR.rows[0] || {}).n || 0;

  const gates = spec.gates.map(gate => {
    let ok = false;
    let how = "manual";
    if (gate.task) {
      ok = taskDone.get(gate.task) === true;
      how = "task";
    } else if (gate.field) {
      ok = !!c[gate.field];
      how = "field";
    } else if (gate.check === "team") {
      ok = teamCount > 0;
      how = "team";
    }
    // A manual attestation can also satisfy a data-backed gate — the
    // attorney is allowed to say "this is done, the data just does not
    // show it" — but it is recorded with their name against it.
    const att = manual.get(gate.key);
    if (!ok && att && att.satisfied) { ok = true; how = "attested"; }
    return {
      key: gate.key, label: gate.label, ok, how,
      attested_by: att ? att.attested_by : null,
      attested_at: att ? att.attested_at : null,
      note: att ? att.note : null,
    };
  });

  const open = gates.filter(g2 => !g2.ok);
  return {
    phase, ready: open.length === 0,
    gates, open_count: open.length, total: gates.length,
  };
}

async function attestGate(caseId, phase, gateKey, { satisfied = true, note = null, by = null } = {}) {
  await initTables();
  const spec = PHASES[phase];
  if (!spec) throw new Error("Unknown phase: " + phase);
  if (!spec.gates.some(g2 => g2.key === gateKey)) throw new Error("Unknown gate: " + gateKey);
  const r = await db.query(
    `INSERT INTO civil_phase_gates (case_id, phase, gate_key, satisfied, note, attested_by)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (case_id, phase, gate_key) DO UPDATE
       SET satisfied = EXCLUDED.satisfied, note = EXCLUDED.note,
           attested_by = EXCLUDED.attested_by, attested_at = NOW()
     RETURNING *`,
    [caseId, phase, gateKey, !!satisfied, note, by]
  );
  return r.rows[0];
}

/** Task completion per phase, for a progress bar on the board. */
async function phaseProgress(caseId) {
  await initTables();
  const r = await db.query(
    `SELECT phase,
            COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE status = 'done')::int AS done,
            COUNT(*) FILTER (WHERE status <> 'done' AND critical)::int AS critical_open,
            COUNT(*) FILTER (WHERE status <> 'done' AND due_date < CURRENT_DATE)::int AS overdue
       FROM civil_phase_tasks WHERE case_id = $1 GROUP BY phase`,
    [caseId]
  );
  const out = {};
  for (const row of r.rows) {
    out[row.phase] = {
      total: row.total, done: row.done,
      pct: row.total ? Math.round((row.done / row.total) * 100) : 0,
      critical_open: row.critical_open, overdue: row.overdue,
    };
  }
  return out;
}

/** Everything on one person's plate across every matter in a phase. */
async function roleQueue(role, { phase = null, limit = 200 } = {}) {
  await initTables();
  const where = ["t.status <> 'done'"];
  const vals = [];
  let i = 1;
  if (role) { where.push(`t.role = $${i++}`); vals.push(role); }
  if (phase) { where.push(`t.phase = $${i++}`); vals.push(phase); }
  vals.push(Math.min(Number(limit) || 200, 500));
  const r = await db.query(
    `SELECT t.*, c.case_name, c.client_key, c.stage, c.jurisdiction
       FROM civil_phase_tasks t
       JOIN civil_cases c ON c.id = t.case_id
      WHERE ${where.join(" AND ")} AND c.status = 'active'
      ORDER BY (t.due_date IS NULL), t.due_date ASC, t.critical DESC
      LIMIT $${i}`,
    vals
  );
  return r.rows;
}

// ── Phase budgets ───────────────────────────────────────────
/**
 * Budget vs actual by UTBMS phase — the report corporate and
 * insurance clients ask for. Actuals are bucketed from the task
 * code on each time entry, the same way an e-billing platform
 * buckets an invoice line.
 */
async function phaseBudgetReport(caseId) {
  await initTables();
  const [budgetR, actualR] = await Promise.all([
    db.query(`SELECT * FROM civil_phase_budgets WHERE case_id = $1`, [caseId]),
    db.query(
      `SELECT utbms_code, SUM(billable_hours)::float AS hours, SUM(billable_amount)::float AS amount
         FROM (
           SELECT utbms_code, billable_hours, billable_amount FROM civil_case_events         WHERE case_id = $1
           UNION ALL
           SELECT utbms_code, billable_hours, billable_amount FROM civil_case_communications WHERE case_id = $1
         ) x
        WHERE billable_hours IS NOT NULL
        GROUP BY utbms_code`,
      [caseId]
    ).catch(() => ({ rows: [] })),
  ]);

  const budgets = new Map(budgetR.rows.map(b => [b.utbms_phase, b]));
  const actuals = new Map();
  for (const row of actualR.rows) {
    const ph = utbms.phaseOf(row.utbms_code) || "L100";
    const cur = actuals.get(ph) || { hours: 0, amount: 0 };
    cur.hours += Number(row.hours) || 0;
    cur.amount += Number(row.amount) || 0;
    actuals.set(ph, cur);
  }

  const rows = utbms.TASK_PHASES.map(p => {
    const b = budgets.get(p.key);
    const a = actuals.get(p.key) || { hours: 0, amount: 0 };
    const budget = b && b.budget_amount != null ? Number(b.budget_amount) : null;
    const pct = budget ? Number(((a.amount / budget) * 100).toFixed(1)) : null;
    return {
      utbms_phase: p.key, label: p.label, short: p.short,
      budget_amount: budget,
      budget_hours: b && b.budget_hours != null ? Number(b.budget_hours) : null,
      actual_amount: Number(a.amount.toFixed(2)),
      actual_hours: Number(a.hours.toFixed(2)),
      // Favourable (under budget) is positive, the convention every
      // vendor report uses.
      variance: budget != null ? Number((budget - a.amount).toFixed(2)) : null,
      pct_consumed: pct,
      over_budget: budget != null && a.amount > budget,
      notes: b ? b.notes : null,
      approved_by: b ? b.approved_by : null,
    };
  });

  const totalBudget = rows.reduce((s, r2) => s + (r2.budget_amount || 0), 0);
  const totalActual = rows.reduce((s, r2) => s + r2.actual_amount, 0);
  return {
    rows,
    totals: {
      budget_amount: Number(totalBudget.toFixed(2)),
      actual_amount: Number(totalActual.toFixed(2)),
      variance: Number((totalBudget - totalActual).toFixed(2)),
      pct_consumed: totalBudget ? Number(((totalActual / totalBudget) * 100).toFixed(1)) : null,
      over_phases: rows.filter(r2 => r2.over_budget).length,
    },
  };
}

async function setPhaseBudget(caseId, utbmsPhase, data = {}, by = null) {
  await initTables();
  const r = await db.query(
    `INSERT INTO civil_phase_budgets (case_id, utbms_phase, budget_amount, budget_hours, notes, approved_by, approved_at)
     VALUES ($1,$2,$3,$4,$5,$6,NOW())
     ON CONFLICT (case_id, utbms_phase) DO UPDATE
       SET budget_amount = EXCLUDED.budget_amount,
           budget_hours  = EXCLUDED.budget_hours,
           notes         = EXCLUDED.notes,
           approved_by   = EXCLUDED.approved_by,
           approved_at   = NOW(),
           updated_at    = NOW()
     RETURNING *`,
    [caseId, utbmsPhase,
     data.budget_amount === "" || data.budget_amount == null ? null : Number(data.budget_amount),
     data.budget_hours === "" || data.budget_hours == null ? null : Number(data.budget_hours),
     data.notes || null, by]
  );
  return r.rows[0];
}

// ═══════════════════════════════════════════════════════════
//  STAGE INFERENCE
//  ─────────────────────────────────────────────────────────
//  The Dropbox import lands every matter in Intake, which is
//  true of none of them: a folder full of deposition transcripts
//  is not an intake. This reads the matter's own dates and the
//  phases of its mirrored documents and proposes where it
//  actually belongs, with the reason stated so a human can
//  disagree. It never moves anything on its own.
// ═══════════════════════════════════════════════════════════

const STAGE_ORDER = ["intake", "pre_filing", "pleadings", "discovery", "motions",
                     "trial_prep", "trial", "post_trial", "closed"];

function daysFrom(d) {
  if (!d) return null;
  const t = new Date(d).getTime();
  return Number.isFinite(t) ? Math.round((t - Date.now()) / 86400000) : null;
}

/**
 * Propose a stage for a matter.
 *
 * filePhases — optional [{ phase, count }] from the Dropbox mirror. Documents
 * are the strongest signal available for an imported matter, because a firm's
 * folder tree records what actually happened.
 */
function suggestStage(caseRow, filePhases = []) {
  const c = caseRow || {};
  const reasons = [];
  let byDates = "intake";

  if (c.statute_of_limitations && !c.filed_date) {
    byDates = "pre_filing";
    reasons.push("SOL recorded but nothing filed");
  }
  if (c.filed_date) { byDates = "pleadings"; reasons.push("complaint filed " + String(c.filed_date).slice(0, 10)); }
  if (c.answered_date) { byDates = "discovery"; reasons.push("answer on file"); }
  else if (c.service_date && daysFrom(c.service_date) !== null && daysFrom(c.service_date) < -45) {
    byDates = "discovery"; reasons.push("served over 45 days ago");
  }
  if (c.discovery_cutoff_date && daysFrom(c.discovery_cutoff_date) < 0) {
    byDates = "motions"; reasons.push("discovery cutoff passed");
  }
  const trialIn = daysFrom(c.trial_date);
  if (trialIn !== null && trialIn >= 0 && trialIn <= 120) {
    byDates = "trial_prep"; reasons.push("trial in " + trialIn + " days");
  }
  if (trialIn !== null && trialIn < 0) { byDates = "post_trial"; reasons.push("trial date has passed"); }
  if (c.verdict_date || c.judgment_date) { byDates = "post_trial"; reasons.push("judgment or verdict recorded"); }
  if (c.files_archived_at) { byDates = "closed"; reasons.push("case file archived"); }

  // The furthest phase the documents reach. A matter with motion papers in the
  // folder has plainly been through pleadings and discovery.
  let byFiles = null;
  const counted = (filePhases || []).filter(f => f.phase && f.phase !== "unfiled" && f.count > 0);
  if (counted.length) {
    const idx = counted
      .map(f => STAGE_ORDER.indexOf(f.phase))
      .filter(i => i >= 0);
    if (idx.length) {
      byFiles = STAGE_ORDER[Math.max(...idx)];
      const top = counted.slice().sort((a, b) => b.count - a.count)[0];
      reasons.push("documents reach " + byFiles.replace(/_/g, " ") + " (" + top.count + " in " + top.phase.replace(/_/g, " ") + ")");
    }
  }

  // Take the further of the two signals: a date can be missing, but a
  // deposition transcript cannot be un-taken.
  const a = STAGE_ORDER.indexOf(byDates);
  const b = byFiles ? STAGE_ORDER.indexOf(byFiles) : -1;
  const suggested = b > a ? byFiles : byDates;

  // Closed is a deliberate human act; never infer past it from documents alone.
  const final = (c.files_archived_at ? "closed" : suggested);

  return {
    suggested: final,
    current: c.stage || "intake",
    changed: final !== (c.stage || "intake"),
    confidence: reasons.length >= 2 ? "high" : reasons.length === 1 ? "medium" : "low",
    reasons,
  };
}

/**
 * Propose stages across the whole book. Dry run by default — nothing moves
 * unless apply is true, and even then only matters above the confidence floor.
 */
async function triageStages({ apply = false, minConfidence = "medium", fromStage = null, by = null } = {}) {
  await initTables();
  const where = ["status = 'active'"];
  const vals = [];
  if (fromStage) { where.push("stage = $1"); vals.push(fromStage); }
  const casesR = await db.query(
    `SELECT * FROM civil_cases WHERE ${where.join(" AND ")} ORDER BY id`, vals);
  const cases = casesR.rows;
  if (!cases.length) return { ok: true, dry_run: !apply, considered: 0, proposals: [] };

  const ids = cases.map(c => c.id);
  let fileR = { rows: [] };
  try {
    fileR = await db.query(
      `SELECT case_id, COALESCE(phase, 'unfiled') AS phase, COUNT(*)::int AS count
         FROM civil_case_files WHERE case_id = ANY($1::int[]) AND removed_at IS NULL
        GROUP BY case_id, COALESCE(phase, 'unfiled')`,
      [ids]
    );
  } catch (e) { /* the Dropbox mirror is optional */ }
  const filesByCase = {};
  for (const row of fileR.rows) (filesByCase[row.case_id] = filesByCase[row.case_id] || []).push(row);

  const rank = { low: 0, medium: 1, high: 2 };
  const floor = rank[minConfidence] != null ? rank[minConfidence] : 1;

  const proposals = [];
  for (const c of cases) {
    const s2 = suggestStage(c, filesByCase[c.id] || []);
    if (!s2.changed) continue;
    const eligible = rank[s2.confidence] >= floor;
    proposals.push({
      case_id: c.id, case_name: c.case_name, client_key: c.client_key,
      from: s2.current, to: s2.suggested,
      confidence: s2.confidence, reasons: s2.reasons, eligible,
    });
  }

  let moved = 0;
  if (apply) {
    const civil = require("./civil-litigation");
    for (const p of proposals) {
      if (!p.eligible) continue;
      try {
        await civil.updateCase(p.case_id, { stage: p.to });
        await applyPhaseTemplate(p.case_id, p.to, { by: by || "stage-triage" }).catch(() => {});
        await civil.logEvent(p.case_id, {
          event_kind: "note",
          event_date: new Date().toISOString().slice(0, 10),
          title: `Stage → ${p.to.replace(/_/g, " ")}`,
          description: "Set by stage triage: " + p.reasons.join("; "),
          created_by: by || "stage-triage",
        }).catch(() => {});
        moved++;
      } catch (e) { p.error = e.message; }
    }
  }

  return {
    ok: true, dry_run: !apply, considered: cases.length,
    proposals, eligible: proposals.filter(p => p.eligible).length, moved,
  };
}

module.exports = {
  ROLES, ROLE_KEYS, PHASES, PHASE_KEYS, PHASE_FOLDERS, phaseForFile,
  STAGE_ORDER, suggestStage, triageStages,
  initTables,
  applyPhaseTemplate, listPhaseTasks, updateTask,
  gateStatus, attestGate, phaseProgress, roleQueue,
  phaseBudgetReport, setPhaseBudget,
};
