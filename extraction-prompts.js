// ============================================================
//  extraction-prompts.js — Practice-Area Specialized Prompts
//  Tez Law P.C. | Zara Legal Intelligence Stack
//
//  Nine specialized extraction prompts — one per practice area.
//  Each extracts the exact intelligence fields that matter for
//  that area, replacing the generic one-size-fits-all prompt.
//
//  COVERAGE:
//  immigration      → PSG, credibility, country conditions,
//                     nexus, corroboration, IJ patterns, BIA/9th
//  civil            → demurrer, MSJ, anti-SLAPP, pleading,
//                     damages, sanctions, discovery
//  eviction         → notice defects, AB 1482, habitability,
//                     just cause, retaliatory eviction
//  personal_injury  → comparative fault, damages, experts,
//                     Daubert/Kelly, government claims
//  estate           → trustee standards, capacity, accounting,
//                     probate scrutiny, trust interpretation
//  federal          → 12(b)(6), Rule 56, qualified immunity,
//                     class cert, temporal evolution
//  business         → contracts, breach, trade secrets,
//                     partnership disputes, corporate, IP
//  employment       → Title VII, FEHA, wage/hour, FMLA, CFRA,
//                     retaliation, wrongful termination, PAGA
//  public_entity_sec → § 1983, Monell, public employee rights,
//                     SEC/securities fraud, False Claims Act,
//                     government contracts, public entity liability
// ============================================================

// ── Route opinion to the right prompt ────────────────────────
function detectPracticeAreaFromOpinion(court, motionType, textSnippet) {
  const c = (court       || "").toLowerCase();
  const m = (motionType  || "").toLowerCase();
  const t = (textSnippet || "").toLowerCase();

  // Immigration — check first (most specific)
  if (/bia|eoir|immigration court|board of immigration/.test(c)) return "immigration";
  if (/asylum|removal|deportat|withholding|cancellation of removal|nta|in absentia|voluntary departure|particular social group|persecution|refugee/.test(m + t)) return "immigration";
  if (/ca9|ninth circuit/.test(c) && /asylum|removal|immigration|petitioner v\. garland|petitioner v\. holder/.test(t)) return "immigration";

  // Public entity & securities — check before employment/federal
  if (/monell|§ 1983|section 1983|public entity|municipal liability|government employee|civil service|sec v\.|securities fraud|false claims act|qui tam|dodd.frank|sarbox|sarbanes|securities exchange act|10b.5|rule 10b|insider trading|public contract|government contract|whistleblower retaliat/.test(t)) return "public_entity_sec";
  if (/sec\b|securities|fraud.*investor|investor.*fraud/.test(t) && !/immigration/.test(t)) return "public_entity_sec";

  // Employment — before general civil/federal
  if (/title vii|feha|fair employment|adea|age discrimination|ada|disability discriminat|fmla|cfra|pdl|pregnancy discriminat|equal pay act|wage.*hour|overtime|meal.*break|rest.*break|paga|labor code|wrongful terminat|constructive discharge|hostile work environment|retaliat.*employ|employ.*retaliat|sexual harassment.*employ|non.compete.*employ|trade secret.*employ/.test(t)) return "employment";

  // Business litigation — before general civil
  if (/breach of contract|trade secret|non.compete|noncompete|misappropriat|partnership disput|shareholder disput|llc disput|operating agreement|buy.sell|breach of fiduciary.*business|corporate opportunit|alter ego|piercing.*veil|veil.*piercing|franchise|licensing.*agreement|intellectual property|copyright infring|trademark infring|patent infring|unfair business practice|bus.*prof.*code 17200/.test(t) &&
      !/personal injury|negligence.*accident|slip.*fall|premises liability/.test(t)) return "business";

  // Personal injury — before general civil
  if (/personal injury|negligence|premises liability|wrongful death|products liability|medical malpractice|motor vehicle|slip and fall/.test(t) &&
      !/demurrer|unlawful detainer/.test(m)) return "personal_injury";

  // Eviction
  if (/unlawful detainer|eviction|3.day notice|just cause|habitability|security deposit|landlord|tenant|ab 1482|rent control/.test(m + t)) return "eviction";

  // Estate/probate
  if (/probate|trust|conservatorship|guardianship|estate|trustee|executor|beneficiary|will contest|capacity/.test(m + t)) return "estate";

  // Federal procedure (non-immigration, non-employment, non-securities federal)
  if (/cacd|caed|cand|casd/.test(c) || /12\(b\)\(6\)|rule 56|qualified immunity|class certification|daubert|erisa/.test(t)) return "federal";

  // 9th Circuit non-immigration
  if (/ca9|ninth circuit/.test(c)) return "federal";

  // Default: civil litigation
  return "civil";
}

// ============================================================
//  PROMPT 1 — IMMIGRATION
//  Jury instruction sources: INA 208, INA 241(b)(3), 8 CFR 1208.16,
//  INA 240A(b), 8 CFR 1003.23, EOIR bench book
//  Every element of every immigration cause of action is a field.
// ============================================================
function buildImmigrationPrompt(ruling) {
  return `You are extracting immigration law intelligence from a court opinion. Extract EVERY field present in the text — even a single data point builds the pattern over time. Use null for fields not mentioned.

Court: ${ruling.court}
Judge/IJ: ${ruling.judge_name || "Unknown"}
Motion/Issue: ${ruling.motion_type || "Unknown"}
Result: ${ruling.result || "Unknown"}
Date: ${ruling.hearing_date || "Unknown"}

OPINION TEXT:
${(ruling.full_text || "").substring(0, 4500)}

Respond ONLY with JSON (empty {} if not an immigration ruling):
{
  "motion_type": "Asylum|Withholding|CAT|Motion to Reopen|Motion to Reconsider|Cancellation of Removal|Voluntary Departure|Bond|Adjustment of Status|Other",
  "result": "Granted|Denied|Remanded|Sustained|Overruled|Continued|Other",
  "country_of_origin": "country name",
  "nationality": "nationality",
  "language": "language spoken",
  "legal_standard": "exact standard applied",
  "reasoning_chain": "Step 1: ... Step 2: ... Step 3: ...",

  "asylum_elements": {
    "refugee_definition_applied": "INA 101(a)(42) standard stated",
    "past_persecution_found": true,
    "past_persecution_type": "physical harm|threats|detention|economic persecution|other",
    "past_persecution_severity": "how severity was analyzed",
    "persecutor_type": "government|non-government actors|both",
    "government_unable_unwilling": "found|not found|not reached",
    "well_founded_fear_objective": "found|not found",
    "well_founded_fear_subjective": "found|not found — credibility link",
    "ten_percent_standard": "referenced|not referenced",
    "humanitarian_asylum": "considered|not considered"
  },

  "withholding_elements": {
    "more_likely_than_not_standard": "applied|not applied",
    "withholding_distinct_analysis": "analyzed separately|merged with asylum",
    "life_or_freedom_threatened": "found|not found",
    "bars_to_withholding": "persecutor bar|serious crime|terrorism|raised|not raised"
  },

  "cat_elements": {
    "torture_defined": "severe pain or suffering — definition stated",
    "public_official_involvement": "direct|acquiescence|not reached",
    "acquiescence_standard": "how acquiescence was analyzed",
    "likelihood_standard": "more likely than not — applied|not applied",
    "cat_granted": true,
    "deferral_vs_withholding": "deferral ordered|withholding|distinction noted"
  },

  "cancellation_elements": {
    "ten_year_continuous_presence": "established|not established|challenged",
    "continuous_presence_interruption": "what interrupted presence if raised",
    "good_moral_character": "established|not established",
    "gmc_bar_cited": "which bar applied if negative",
    "exceptional_hardship_standard": "how defined — exceptional extremely unusual",
    "hardship_factors_weighed": ["qualifying relative|country conditions|health|financial|education|other"],
    "qualifying_relative": "spouse|parent|child — USC or LPR",
    "battery_or_extreme_cruelty": "raised under VAWA|not raised"
  },

  "credibility": {
    "finding": "credible|not credible|mixed|not reached",
    "totality_of_circumstances": "applied|not cited",
    "adverse_factors": ["each specific inconsistency or omission cited"],
    "omission_vs_inconsistency": "omission|inconsistency|both",
    "demeanor_noted": true,
    "demeanor_description": "specific demeanor observation",
    "responsiveness_noted": true,
    "responsiveness_description": "evasive|non-responsive|other",
    "corroboration_required": true,
    "corroboration_missing": ["what specific corroboration was absent"],
    "corroboration_excused": true,
    "corroboration_excuse_basis": "unavailable|dangerous to obtain|other",
    "corroboration_available_but_missing": true,
    "documentary_evidence_evaluated": ["types of documents submitted"],
    "documents_rejected": ["documents rejected and reason"],
    "documents_authenticated": "required|not required",
    "oral_testimony_sufficiency": "alone sufficient|required corroboration",
    "interpreter_issue_noted": true,
    "interpreter_issue_description": "specific interpretation problem described",
    "attorney_preparation_noted": true,
    "attorney_preparation_comment": "IJ comment on attorney quality or preparation",
    "expert_witness_presented": true,
    "expert_witness_type": "country conditions|psychological|medical|other",
    "expert_witness_credited": true,
    "expert_witness_rejected_reason": "why expert was discredited",
    "credibility_saved_by": ["what rehabilitated credibility"],
    "exact_language": "quote under 20 words from credibility finding"
  },

  "psg_analysis": {
    "psg_proposed": "exact PSG wording proposed",
    "psg_accepted": true,
    "particularity_met": true,
    "particularity_analysis": "how defined by clear characteristics",
    "social_distinction_met": true,
    "social_distinction_evidence": "how society recognizes the group",
    "immutability_met": true,
    "immutability_analysis": "innate characteristic or fundamental to identity",
    "psg_rejection_reason": "exact reason for rejection",
    "cognizable_group_precedent_cited": "BIA cases cited on PSG",
    "gender_psg": "accepted|rejected|not raised",
    "family_psg": "accepted|rejected|not raised",
    "gang_resistance_psg": "accepted|rejected|not raised",
    "domestic_violence_psg": "accepted|rejected|not raised",
    "voluntary_association_issue": "raised|not raised",
    "circularity_objection": "raised|rejected|not raised"
  },

  "nexus": {
    "nexus_found": true,
    "protected_ground": "race|religion|nationality|PSG|political opinion",
    "nexus_theory": "one central reason|mixed motive",
    "mixed_motive_instruction": "REAL ID Act mixed motive applied",
    "persecutor_motive_analyzed": "what evidence of motive was assessed",
    "nexus_failure_reason": "why nexus was not established",
    "imputed_political_opinion": "found|not found|not raised",
    "political_opinion_type": "actual|imputed|both"
  },

  "country_conditions": {
    "country": "country analyzed",
    "evidence_types_accepted": ["State Dept report|NGO|news|expert|other"],
    "evidence_types_rejected": ["rejected types and reason"],
    "state_dept_report_weight": "given weight|discounted|ignored",
    "ngo_reports_accepted": "yes|no|partially",
    "news_articles_accepted": "yes|no",
    "weight_given": "heavy|moderate|minimal|none",
    "state_protection_analyzed": true,
    "police_protection": "available|unavailable|unwilling|unable",
    "corruption_found": true,
    "gang_control_noted": true,
    "femicide_noted": true,
    "political_violence_noted": true,
    "conditions_changed_analysis": "how changed conditions were addressed",
    "country_conditions_dispositive": true
  },

  "internal_relocation": {
    "raised": true,
    "burden": "applicant|government",
    "burden_basis": "persecution by non-government|government persecution",
    "relocation_reasonable": true,
    "relocation_unreasonable_factors": ["why relocation was unreasonable"],
    "family_ties_analyzed": true,
    "persecutor_reach_nationwide": "found|not found",
    "economic_viability": "considered|not considered",
    "safety_in_relocation_area": "established|not established"
  },

  "procedural": {
    "one_year_bar": "not raised|raised — met|exception found",
    "exception_type": "extraordinary circumstances|changed circumstances",
    "extraordinary_circumstances_basis": "serious illness|mental disability|legal disability|ineffective assistance|other",
    "changed_circumstances_basis": "changed country conditions|change in law|change in personal circumstances",
    "in_absentia": "not an issue|in absentia order exists",
    "in_absentia_rescission": "granted|denied",
    "in_absentia_rescission_basis": "exceptional circumstances — description|lack of notice",
    "exceptional_circumstances_defined": "how court defined exceptional circumstances",
    "mtr_deadline": "90 days|timely|untimely",
    "mtr_grounds": "exceptional circumstances|changed conditions|new evidence|ineffective assistance",
    "mtr_number_filed": "how many prior MTRs noted",
    "mtr_numerosity_noted": true,
    "lozada_compliance": "met|not met|excused",
    "lozada_elements": "bar complaint filed|affidavit|notice to counsel — which met",
    "notice_type": "in-court oral|certified mail|DHL|other",
    "notice_defect": true,
    "notice_defect_description": "specific notice problem",
    "continuance_requested": true,
    "continuance_granted": true,
    "continuance_number": "how many total continuances noted",
    "continuance_denial_reason": "specific reason denied",
    "master_calendar_vs_individual": "MCH|individual hearing|both",
    "bond_hearing": true,
    "bond_amount": "dollar amount",
    "bond_factors": ["flight risk|danger to community|ties|criminal history|other"],
    "custody_status": "detained|non-detained",
    "voluntary_departure": "granted|denied",
    "voluntary_departure_period": "days granted",
    "voluntary_departure_bond": "required|waived",
    "alternate_relief_considered": "CAT|withholding|adjustment|other"
  },

  "appellate": {
    "standard_of_review": "substantial evidence|de novo|abuse of discretion",
    "ij_deference": "full deference|no deference|partial",
    "brd_reversed_ij": true,
    "brd_reversal_basis": "why BIA reversed IJ",
    "ninth_reversed_brd": true,
    "ninth_reversal_basis": "why 9th Circuit reversed BIA",
    "remand_reason": "specific remand instruction",
    "due_process_raised": true,
    "due_process_violation_found": true,
    "due_process_basis": "right to present evidence|notice|fair hearing",
    "ineffective_assistance_raised": true,
    "prejudice_shown": true,
    "petitioner_prevailed_on": ["specific issues won on appeal"],
    "government_prevailed_on": ["specific issues government won"],
    "circuit_split_noted": true,
    "circuit_split_description": "what the split is about",
    "en_banc_cited": true,
    "matter_of_cited": ["BIA precedent decisions cited"]
  },

  "winning_arguments": [
    {"argument": "specific argument that succeeded", "why_it_worked": "court's reasoning", "exact_language": "quote under 20 words"}
  ],
  "losing_arguments": [
    {"argument": "specific argument that failed", "why_it_failed": "court's reasoning", "exact_language": "quote under 20 words"}
  ],

  "cited_statutes": ["8 U.S.C. 1158", "INA 241(b)(3)", "8 CFR 1208.16"],
  "cited_cases": ["case name only, max 8"],
  "drafting_insight": "one sentence: key practice point for filing this case with this judge/panel"
}`;
}

// ============================================================
//  PROMPT 2 — CIVIL LITIGATION
//  Jury instruction sources: CACI 300-400 (Contract), CACI 400-500
//  (Negligence/Tort), CACI 1700-1900 (Business Torts),
//  CACI 3900-4000 (Damages), CACI VF series (verdict forms)
// ============================================================
function buildCivilPrompt(ruling) {
  return `You are extracting civil litigation intelligence from a California court ruling. Use CACI jury instruction elements as your field architecture. Extract EVERY field present — even one data point builds the pattern.

Court: ${ruling.court}
Judge: ${ruling.judge_name || "Unknown"}
Motion: ${ruling.motion_type || "Unknown"}
Result: ${ruling.result || "Unknown"}
Date: ${ruling.hearing_date || "Unknown"}

OPINION TEXT:
${(ruling.full_text || "").substring(0, 4500)}

Respond ONLY with JSON (empty {} if not a civil motion ruling). Use null for absent fields:
{
  "motion_type": "Demurrer|MSJ|Motion to Strike|Anti-SLAPP|PI|TRO|Motion to Compel|Sanctions|Default Judgment|Other",
  "result": "Sustained|Overruled|Granted|Denied|Continued|Mixed",
  "cause_of_action": "breach of contract|negligence|fraud|IIED|NIED|conversion|trespass|nuisance|defamation|interference with contract|interference with prospective advantage|unjust enrichment|other",
  "complaint_generation": "original|FAC|SAC|TAC|4AC or more",
  "legal_standard": "exact standard applied",
  "reasoning_chain": "Step 1: ... Step 2: ... Step 3: ...",
  "oral_argument_held": true,
  "tentative_reversed_after_argument": true,
  "time_to_ruling_days": null,
  "continuance": {"requested": true, "granted": true, "denial_reason": null, "prior_count": null},

  "contract_elements": {
    "caci_303_applied": true,
    "element1_contract_existence": "formation dispute|formation undisputed",
    "contract_formation_issue": "offer|acceptance|consideration|mutual assent|other",
    "element2_plaintiff_performance": "performed|excused — basis",
    "substantial_performance_doctrine": "invoked|not invoked",
    "element3_defendant_breach": "specific breach alleged",
    "breach_materiality": "material|minor — how analyzed",
    "anticipatory_repudiation": "raised|not raised",
    "element4_damages_caused": "causation|damages link analyzed",
    "implied_covenant_caci_325": "raised|sustained|overruled",
    "implied_covenant_analysis": "what obligation was implied",
    "integration_clause_effect": "how applied",
    "parol_evidence_rule": "admitted under exception|excluded|not raised",
    "parol_evidence_exception": "fraud|condition precedent|ambiguity|collateral agreement",
    "modification_issue": "oral modification|written only|course of dealing",
    "waiver_raised": true,
    "waiver_basis": "conduct|express|implied",
    "estoppel_raised": true,
    "promissory_estoppel": "elements analyzed — promise|reliance|injustice",
    "specific_performance_sought": true,
    "specific_performance_granted": true,
    "specific_performance_standard": "unique subject matter|inadequate remedy at law",
    "liquidated_damages_clause": "enforced|voided as penalty",
    "liquidated_damages_standard": "reasonable estimate at time of contract|actual damages",
    "indemnification_clause": "broad|narrow|ambiguous — ruling",
    "indemnification_covers_own_negligence": true,
    "forum_selection_enforced": true,
    "choice_of_law_enforced": true,
    "arbitration_clause_raised": true,
    "arbitration_clause_result": "compelling arbitration|denying — basis",
    "force_majeure_raised": true,
    "force_majeure_result": "excused|not excused",
    "impossibility_frustration": "raised|excused|not excused"
  },

  "fraud_elements": {
    "caci_1900_applied": true,
    "element1_representation": "false representation of fact|opinion|future promise",
    "element2_falsity": "known false|reckless|basis",
    "element3_intent_to_defraud": "found|not found|inferred from what",
    "element4_justifiable_reliance": "found|not found — sophisticated party analysis",
    "element5_damages": "out of pocket|benefit of bargain rule applied",
    "concealment_caci_1902": "duty to disclose — basis",
    "negligent_misrep_caci_1901": "professional|business context",
    "false_promise_caci_1903": "no intent to perform at time made",
    "opinion_as_actionable_caci_1904": "superior knowledge|fiduciary|other",
    "economic_loss_rule": "bars fraud claim|exception applied|not raised"
  },

  "negligence_elements": {
    "caci_400_applied": true,
    "element1_duty": "general duty|special relationship|duty analysis",
    "duty_to_whom": "world at large|specific plaintiff|class",
    "rowland_factors_applied": true,
    "rowland_factors_weighed": ["foreseeability|certainty of harm|closeness of connection|moral blame|prevention policy|burden|insurance"],
    "element2_breach": "reasonable person standard|custom|regulation",
    "negligence_per_se_caci_418": "statute violated — negligence per se",
    "negligence_per_se_class_member": "plaintiff in protected class|not",
    "element3_causation_actual": "but-for|substantial factor",
    "substantial_factor_instruction": "CACI 430 applied|not applied",
    "element4_causation_proximate": "superseding cause raised|not raised",
    "superseding_cause_analysis": "independent|foreseeable|extraordinary",
    "element5_damages": "type of compensable damages analyzed",
    "caci_405_comparative_fault": "applied|not applied",
    "plaintiff_fault_percentage": "percentage if stated",
    "caci_406_apportionment": "multiple defendants — apportionment",
    "caci_407_primary_ror": "inherent risk|co-participant — activity",
    "caci_408_secondary_ror": "merged into comparative fault|separate",
    "firefighter_rule": "applied|rejected|not raised",
    "nied_bystander_elements": "close relationship|contemporaneous awareness|serious emotional distress",
    "nied_direct_victim_elements": "special relationship|negligent conduct|serious emotional distress"
  },

  "pleading_analysis": {
    "deficiency_type": "conclusory|missing elements|uncertainty|misjoinder|improper party|other",
    "specific_missing_elements": ["exact elements judge said were absent"],
    "facts_required": "what specific who/what/when/where/how facts were required",
    "leave_to_amend": true,
    "amendment_instructions": "exactly what judge said must be fixed",
    "amendment_this_is_number": "first|second|third|final",
    "futility_found": true,
    "futility_reason": "why amendment would not cure defect",
    "uncertainty_grounds_applied": true,
    "uncertainty_specificity_level": "what specificity was required",
    "speaking_demurrer_rejected": true,
    "general_demurrer_vs_special": "general|special|both",
    "demurrer_to_evidence_standard": "no substantial evidence",
    "exact_language": "judge's exact pleading standard words under 25 words"
  },

  "msj_analysis": {
    "moving_party": "plaintiff|defendant",
    "standard_stated": "no triable issue of material fact",
    "burden_shift_triggered": true,
    "burden_shift_basis": "prima facie case made|affirmed defense",
    "triable_issue_found": true,
    "triable_issue_description": "what the disputed fact was",
    "triable_issue_materiality": "would affect outcome|irrelevant — why",
    "inferences_drawn": "for non-moving party|against — why",
    "expert_declaration_role": "created triable issue|insufficient",
    "sham_declaration": "raised|not raised"
  },

  "anti_slapp": {
    "prong1_activity": "litigation|public issue|free speech|official proceeding",
    "prong1_activity_description": "specific protected activity identified",
    "prong1_found": true,
    "prong1_analysis": "how protected activity was identified",
    "prong2_standard": "minimal merit probability of prevailing",
    "prong2_met": true,
    "prong2_evidence": "what evidence showed/didn't show probability",
    "commercial_speech_exemption": "raised|not raised",
    "special_motion_timely": true,
    "discovery_stayed": true,
    "fees_awarded": true,
    "fees_amount": "dollar amount",
    "fees_standard": "prevailing defendant mandatory|plaintiff must show frivolous"
  },

  "interference_elements": {
    "caci_1800_applied": true,
    "economic_relationship_exists": "contract|prospective advantage",
    "defendant_knowledge": "knew of relationship|should have known",
    "intentional_acts": "what acts were alleged",
    "independently_wrongful_act": "required for prospective|what act",
    "independently_wrongful_finding": "found|not found",
    "disruption_causation": "disruption actually caused|independent decision",
    "justification_defense": "raised|rejected|accepted — basis"
  },

  "defamation_elements": {
    "caci_1700_applied": true,
    "statement_of_fact_vs_opinion": "fact|opinion|mixed",
    "opinion_analysis": "reasonable person test applied",
    "falsity_element": "defendant must prove truth|plaintiff must prove falsity",
    "public_figure_analysis": "public|private|limited purpose public",
    "actual_malice_standard": "applied — knowledge of falsity or reckless disregard",
    "negligence_standard": "applied for private plaintiff",
    "publication_element": "third party communication — how",
    "defamation_per_se": "occupation|crime|loathsome disease|sexual conduct",
    "defamation_per_quod": "special damages required|alleged",
    "republication": "raised|not raised",
    "slapp_connection": "anti-SLAPP intersected|not"
  },

  "damages_analysis": {
    "economic_damages_type": "lost profits|lost wages|repair costs|medical|other",
    "punitive_damages_caci_3940": "raised|granted|denied",
    "punitive_malice_oppression_fraud": "malice|oppression|fraud — which",
    "malice_defined": "intent to harm|despicable with willful disregard",
    "oppression_defined": "despicable conduct with cruel disregard",
    "fraud_defined": "intentional misrepresentation|concealment|false promise",
    "ratification_theory": "advanced knowledge|ratified by officer|director|managing agent",
    "managing_agent_analysis": "who qualified as managing agent",
    "punitive_evidence_standard": "clear and convincing — met|not met",
    "economic_loss_rule_applied": true,
    "econ_loss_exception": "fraud|negligent misrep|CSPC|other",
    "attorneys_fees": "awarded|denied",
    "fees_basis": "contract|CCP 1021.5|statute",
    "fees_1021_5_standard": "significant benefit|necessity|financial burden",
    "prejudgment_interest": "Civil Code 3287|3288 — awarded|denied",
    "consequential_damages": "foreseeable|not foreseeable|limited by contract",
    "future_damages_method": "present cash value|per diem|lump sum",
    "mitigation_analyzed": true,
    "mitigation_burden": "defendant|plaintiff"
  },

  "preliminary_injunction": {
    "ca_standard": "two-part OR balance of hardships",
    "likelihood_success": "strong|moderate|weak|not found",
    "probability_of_prevailing": "percentage or description",
    "interim_harm": "great|moderate|minimal",
    "balance_tips_toward": "plaintiff|defendant|neutral",
    "irreparable_harm_found": true,
    "irreparable_harm_analysis": "what made harm irreparable",
    "public_interest": "favors|opposes|neutral",
    "bond_required": true,
    "bond_amount": "dollar amount",
    "tro_ex_parte": true,
    "tro_duration": "days"
  },

  "discovery_sanctions": {
    "violation": "failure to respond|incomplete|misuse|deposition|ESI",
    "sanction_type": "monetary|terminating|issue|evidence|combination",
    "amount": "dollar amount",
    "willfulness": "found|not found",
    "prejudice": "found|not found",
    "lesser_sanction_first": "considered|not considered",
    "prior_violations": "noted|not noted",
    "m_and_c_adequate": "yes|no|not required",
    "esi_preservation": "addressed|not addressed",
    "spoliation_instruction": "given|denied|not raised"
  },

  "temporal_data": {"ruling_year": null, "trend_note": null},

  "winning_arguments": [
    {"argument": "specific argument", "why_it_worked": "reasoning", "exact_language": "quote under 20 words"}
  ],
  "losing_arguments": [
    {"argument": "specific argument", "why_it_failed": "reasoning", "exact_language": "quote under 20 words"}
  ],

  "cited_statutes": ["CCP 430.10", "CCP 437c", "Civ. Code 3294"],
  "cited_cases": ["case name only, max 8"],
  "drafting_insight": "one sentence: key practice point for this judge"
}`;
}


// ============================================================
//  PROMPT 3 — EVICTION / LANDLORD-TENANT
//  Jury instruction sources: CACI 4300-4360 (UD), Civil Code
//  1940-1954.1 (habitability), CCP 1161-1179a, AB 1482
// ============================================================
function buildEvictionPrompt(ruling) {
  return `You are extracting eviction and landlord-tenant intelligence. Every field matters. Use CACI 4300 series and Civil Code elements as the field architecture.

Court: ${ruling.court}
Judge: ${ruling.judge_name || "Unknown"}
Motion/Proceeding: ${ruling.motion_type || "Unknown"}
Result: ${ruling.result || "Unknown"}
Date: ${ruling.hearing_date || "Unknown"}

OPINION TEXT:
${(ruling.full_text || "").substring(0, 4500)}

Respond ONLY with JSON (empty {} if not an eviction/landlord-tenant ruling). Use null for absent fields:
{
  "proceeding_type": "Unlawful Detainer|Habitability|Wrongful Eviction|Security Deposit|Rent Control|Lockout|Other",
  "result": "Judgment Landlord|Judgment Tenant|Demurrer Sustained|Demurrer Overruled|Continued|Other",
  "property_type": "residential|commercial|mobile home|SRO|Section 8|other",
  "tenancy_type": "month-to-month|fixed term|at-will|holdover",
  "lease_type": "written|oral|implied",
  "legal_standard": "exact standard applied",
  "reasoning_chain": "Step 1: ... Step 2: ... Step 3: ...",
  "oral_argument_held": true,
  "continuance": {"requested": true, "granted": true, "denial_reason": null, "prior_count": null},
  "time_to_judgment_days": null,

  "notice_elements": {
    "notice_type": "3-day pay or quit|3-day cure|3-day unconditional|30-day|60-day|90-day|120-day|other",
    "ccp_1161_subsection": "1161(1)|1161(2)|1161(3)|1161(4)|1161a|other",
    "notice_valid": true,
    "defect_found": "specific defect identified",
    "defect_type": "service|content|timing|amount|form|other",
    "service_method_used": "personal|substituted — who|posted and mailed|other",
    "substituted_service_requirements": "competent person|mailing within 10 days — met|not met",
    "posting_and_mailing_requirements": "conspicuous posting|first class mail — met|not met",
    "service_attempt_diligence": "how many attempts|reasonable|not reasonable",
    "amount_in_notice": "correct amount|incorrect — by how much",
    "fees_in_notice": "allowed under agreement|not allowed",
    "utilities_in_notice": "proper|improper",
    "forfeiture_clause_required": "present|absent — impact",
    "substantial_compliance": "applied|rejected",
    "substantial_compliance_result": "notice validated|not validated",
    "notice_period_calculation": "correct|incorrect — error",
    "notice_served_by_whom": "landlord|agent|attorney — authorized?",
    "proof_of_service_adequate": "yes|no — deficiency",
    "cure_opportunity_provided": "yes|no|cure period days",
    "exact_language": "judge's exact words on notice validity"
  },

  "just_cause_elements": {
    "required": true,
    "ab_1482_applies": true,
    "ab_1482_exempt": true,
    "exemption_type": "single family|condo|new construction 15yr|owner-occupied 2unit|other",
    "exemption_notice_required": "given|not given — impact",
    "just_cause_type": "at-fault: nonpayment|lease violation|nuisance|criminal|unauthorized sublease|refusal to sign|employee housing|no-fault: owner move-in|relative move-in|demolition|capital improvement|withdrawal|ETRLA|other",
    "at_fault_vs_no_fault": "at-fault|no-fault",
    "material_breach_threshold": "how serious violation must be",
    "lease_violation_described": "specific violation alleged",
    "cure_period_given": "3 days|30 days|reasonable time",
    "cure_possible": "curable|incurable",
    "breach_uncured": "not cured|cured — impact",
    "nuisance_elements": "substantial interference|continuous or recurring|unreasonable",
    "criminal_activity_standard": "conviction required|preponderance|other",
    "no_fault_relocation_assistance": "1 month rent|not required|disputed",
    "owner_move_in_good_faith": "genuine intent — evidence",
    "just_cause_found": true
  },

  "habitability_elements": {
    "defense_raised": true,
    "civil_code_1941_standard": "fit for human habitation — applied",
    "element1_effective_waterproofing": "addressed|not addressed",
    "element2_plumbing_gas": "addressed|not addressed",
    "element3_water_heating": "hot and cold running water|addressed|not addressed",
    "element4_heating": "addressed|not addressed",
    "element5_electrical": "addressed|not addressed",
    "element6_clean_sanitary": "addressed|not addressed",
    "element7_trash": "addressed|not addressed",
    "element8_floors_stairways": "addressed|not addressed",
    "element9_locks_windows": "addressed|not addressed",
    "element10_pest_free": "vermin|roach|bedbugs|addressed|not addressed",
    "mold_addressed": true,
    "mold_health_safety_code": "17920.3 cited|not cited",
    "conditions_described": ["specific conditions identified"],
    "condition_severity": "minor|moderate|substantial|uninhabitable",
    "tenant_notice_to_landlord": "oral|written|both|none",
    "notice_date": "date of notice if mentioned",
    "reasonable_time_to_repair": "elapsed|not elapsed",
    "landlord_entry_issue": "Civil Code 1954 compliance|not addressed",
    "repair_deduct_amount": "dollar amount",
    "repair_deduct_ceiling": "$300 or 1 month|limit issue",
    "rent_withheld_amount": "dollar amount",
    "warranted_rent_abatement": "percentage|dollar amount",
    "health_code_violations": ["specific code sections cited"],
    "habitability_defense_accepted": true
  },

  "retaliatory_eviction_elements": {
    "raised": true,
    "civil_code_1942_5_applied": true,
    "protected_activity": "habitability complaint|rent withholding|code inspection|organizing|other",
    "temporal_connection": "days between activity and notice",
    "presumption_period": "180 days — triggered|not triggered",
    "presumption_triggered": true,
    "landlord_rebuttal_offered": true,
    "rebuttal_basis": "legitimate reason offered — what",
    "rebuttal_accepted": true,
    "punitive_damages_allowed": true
  },

  "security_deposit_elements": {
    "deposit_amount": "dollar amount",
    "civil_code_1950_5_applied": true,
    "itemization_deadline": "21 days — met|missed",
    "itemization_provided": true,
    "itemization_adequate": true,
    "allowable_deductions": ["unpaid rent|cleaning|repair beyond normal wear|restoration|other"],
    "normal_wear_tear_analyzed": true,
    "normal_wear_tear_definition": "how judge defined normal wear and tear",
    "cleaning_charge_reasonable": true,
    "repair_deduction_documented": true,
    "bad_faith_withholding": "found|not found",
    "bad_faith_penalty": "2x additional|not imposed",
    "attorney_fees_awarded": true,
    "deposit_exceeded_limit": "2 months|raised|not raised"
  },

  "rent_control_elements": {
    "applicable": true,
    "ordinance": "LA RSTPCO|San Jose|Oakland|Berkeley|Statewide AB 1482|other",
    "unit_covered": "covered|exempt — basis",
    "registration_required": "registered|not registered — impact",
    "allowable_increase": "percentage or amount if stated",
    "increase_exceeded": true,
    "banking_raised": true,
    "passthrough_raised": true,
    "relocation_assistance_owed": true,
    "relocation_amount": "dollar amount",
    "wrongful_eviction_damages": "out of possession plus",
    "treble_damages_available": true
  },

  "unlawful_lockout_elements": {
    "raised": true,
    "civil_code_789_3_applied": true,
    "lockout_means": "lock change|utility shutoff|property removal|other",
    "actual_damages": "dollar amount",
    "punitive_damages_100_per_day": "awarded|not awarded",
    "reinstatement_ordered": true,
    "attorney_fees": "awarded|not awarded"
  },

  "winning_arguments": [
    {"argument": "specific argument", "party": "landlord|tenant", "why_it_worked": "reasoning", "exact_language": "quote under 20 words"}
  ],
  "losing_arguments": [
    {"argument": "specific argument", "party": "landlord|tenant", "why_it_failed": "reasoning", "exact_language": "quote under 20 words"}
  ],

  "cited_statutes": ["CCP 1161", "Civil Code 1941.1", "Civil Code 1950.5"],
  "cited_cases": ["case name only, max 6"],
  "drafting_insight": "one sentence: key practice point for this judge"
}`;
}

// ============================================================
//  PROMPT 4 — PERSONAL INJURY
//  Jury instruction sources: CACI 400-470 (Negligence),
//  CACI 700-730 (Motor Vehicle), CACI 900-940 (Premises),
//  CACI 1200-1270 (Products), CACI 3900-3960 (Damages),
//  Gov. Code 810-996 (Government Claims)
// ============================================================
function buildPersonalInjuryPrompt(ruling) {
  return `You are extracting personal injury intelligence using CACI jury instruction elements as the field architecture. Every field present matters.

Court: ${ruling.court}
Judge: ${ruling.judge_name || "Unknown"}
Motion: ${ruling.motion_type || "Unknown"}
Result: ${ruling.result || "Unknown"}
Date: ${ruling.hearing_date || "Unknown"}

OPINION TEXT:
${(ruling.full_text || "").substring(0, 4500)}

Respond ONLY with JSON (empty {} if not a personal injury ruling). Use null for absent fields:
{
  "case_type": "Motor Vehicle|Premises Liability|Products Liability|Medical Malpractice|Dog Bite|Wrongful Death|Slip and Fall|Assault|Other",
  "motion_type": "MSJ|Demurrer|Motion in Limine|Daubert/Kelly|Sanctions|Default|Summary Adjudication|Other",
  "result": "Granted|Denied|Sustained|Overruled|Other",
  "injury_type": "description of injury",
  "plaintiff_status": "adult|minor|elder adult|deceased estate",
  "legal_standard": "exact standard applied",
  "reasoning_chain": "Step 1: ... Step 2: ... Step 3: ...",
  "oral_argument_held": true,
  "continuance": {"requested": true, "granted": true, "denial_reason": null},

  "negligence_elements_caci_400": {
    "element1_duty": "duty found|not found",
    "duty_basis": "general|special relationship|voluntary undertaking|contract|statute",
    "rowland_factors_applied": true,
    "rowland_foreseeability": "how analyzed",
    "rowland_certainty_of_harm": "how analyzed",
    "rowland_connection_between_conduct_harm": "analyzed",
    "rowland_moral_blame": "analyzed",
    "rowland_prevention_policy": "analyzed",
    "rowland_burden_on_defendant": "analyzed",
    "rowland_liability_insurance": "analyzed",
    "special_relationship_type": "possessor-invitee|employer-employee|school-student|other",
    "element2_breach": "reasonable person standard",
    "res_ipsa_loquitur": "raised|three elements — exclusive control|not ordinary|no voluntary action",
    "res_ipsa_found": true,
    "element3_cause_in_fact": "but-for|substantial factor",
    "caci_430_substantial_factor": "applied — moving force",
    "multiple_causes": "concurrent|independent|successive",
    "element4_proximate_cause": "foreseeable|unforeseen|superseding",
    "superseding_cause_type": "third party criminal act|negligent medical|other",
    "superseding_cause_foreseeability": "foreseeable — no superseding|unforeseeable",
    "element5_damages": "physical|emotional|economic — types analyzed"
  },

  "premises_liability_caci_1000": {
    "plaintiff_status": "invitee|licensee|trespasser|firefighter rule",
    "invitee_duty": "inspect|repair|warn",
    "licensee_duty": "warn of known dangers",
    "trespasser_duty": "wilful or wanton",
    "dangerous_condition": "found|not found",
    "dangerous_condition_description": "specific condition",
    "open_and_obvious": "raised|not raised — impact",
    "constructive_notice": "how long condition existed",
    "actual_notice": "prior complaints|inspection records",
    "warning_provided": "adequate|inadequate|none",
    "primary_assumption_of_risk_caci_407": "inherent risk|sport|recreational",
    "activity_type": "sport or activity analyzed",
    "co_participant_liability": "reckless or intentional only"
  },

  "motor_vehicle_caci_700": {
    "vehicle_type": "auto|truck|motorcycle|commercial|other",
    "traffic_violation": "specific violation if cited",
    "negligence_per_se_caci_418": "statute|regulation violated — negligence per se",
    "dui_involved": true,
    "dui_impact_on_damages": "punitive considered|not raised",
    "right_of_way_analysis": "how right of way was analyzed",
    "speed_analysis": "excessive speed|proper — analyzed",
    "following_distance": "addressed|not addressed",
    "lane_change": "addressed|not addressed",
    "pedestrian_right_of_way": "caci_715|addressed|not addressed",
    "bicycle_rules": "addressed|not addressed",
    "employer_liability": "respondeat superior|negligent entrustment",
    "negligent_entrustment_elements": "owner knowledge of incompetence|authorization"
  },

  "products_liability_caci_1200": {
    "theory": "strict liability|negligence|warranty|all",
    "defect_type": "manufacturing|design|failure to warn",
    "strict_liability_elements": "manufacturer|in chain of distribution|defective|harm caused",
    "consumer_expectation_test": "ordinary consumer|product performed below expectations",
    "risk_benefit_test": "excessive preventable danger — factors",
    "risk_benefit_factors": ["gravity|probability|feasibility of alternative|adverse consequences"],
    "manufacturing_defect": "deviated from intended design",
    "design_defect": "all units — consumer expectation|risk benefit",
    "warning_defect": "inadequate warning|failure to update",
    "sophisticated_user_doctrine": "raised|not raised",
    "component_parts_doctrine": "raised|not raised",
    "assumption_of_risk_products": "raised|not raised",
    "bystander_recovery": "allowed|addressed"
  },

  "medical_malpractice_caci_500": {
    "standard_of_care_source": "expert testimony|treatise|statute",
    "standard_defined": "reasonable skill knowledge care — specialty",
    "departure_from_standard": "found|not found",
    "departure_description": "specific departure alleged",
    "causation_standard": "reasonable medical probability",
    "loss_of_chance_doctrine": "raised|not raised",
    "informed_consent_theory": "battery|negligent failure to disclose",
    "informed_consent_elements": "material risk|would have refused|harm materialized",
    "expert_required": "yes — specialty|waived"
  },

  "wrongful_death_caci_3921": {
    "relationship": "spouse|child|parent|dependent|other",
    "elements": "wrongful act|resulting death|plaintiff is heir",
    "economic_damages": "financial support|loss of services|burial",
    "noneconomic_damages": "loss of love comfort society",
    "survival_action_combined": "yes|no",
    "loss_of_consortium_separate": "raised|not raised"
  },

  "comparative_fault_caci_405": {
    "applied": true,
    "plaintiff_fault_percentage": "percentage",
    "basis_for_plaintiff_fault": "specific conduct",
    "primary_ror_applied": "sport|activity — complete bar",
    "assumption_of_risk_type": "express|implied primary|implied secondary",
    "express_waiver_analyzed": true,
    "express_waiver_valid": true,
    "express_waiver_standard": "gross negligence exception|clear and unambiguous",
    "firefighter_rule": "applied|rejected — basis"
  },

  "damages_caci_3900": {
    "economic_medical_expenses": "past|future|both",
    "howell_hanif_applied": true,
    "howell_hanif_result": "limited to amount paid|negotiated rate",
    "future_medical_method": "present cash value required|not addressed",
    "lost_earnings_past": "addressed|not addressed",
    "lost_earnings_future": "addressed|not addressed",
    "loss_of_earning_capacity": "addressed|not addressed",
    "noneconomic_general_damages": "pain suffering|emotional distress|loss of enjoyment",
    "noneconomic_past_future": "both|only past|only future",
    "micra_cap_applied": true,
    "micra_cap_amount": "$350,000 or adjusted amount",
    "wrongful_death_noneconomic": "no cap — analyzed",
    "punitive_damages_malice_fraud_oppression": "raised|met standard|not met",
    "collateral_source_rule": "applied|modified|rejected",
    "future_damages_present_value": "required|not addressed",
    "per_diem_argument": "used|not used",
    "hedonic_damages": "addressed|not addressed"
  },

  "expert_witness": {
    "challenged": true,
    "challenge_standard": "Daubert|Kelly-Frye",
    "kelly_frye_elements": "new scientific technique|general acceptance|proper application",
    "daubert_elements": "testing|peer review|error rate|acceptance",
    "field": "medical|biomechanical|accident reconstruction|economics|other",
    "excluded": true,
    "exclusion_basis": "methodology|qualifications|relevance|cumulative",
    "admitted": true,
    "treating_physician_designation": "timely|untimely|retroactive — impact",
    "expert_on_standard_of_care": "qualified|not qualified — basis"
  },

  "government_claim": {
    "entity_type": "state|county|city|school|transit|water agency|other",
    "gov_code_910_claim_filed": true,
    "6_month_deadline": "met|missed",
    "late_claim_petition_ccp_946_6": "filed|not filed|granted|denied",
    "substantial_compliance": "applied|rejected",
    "accrual_date_disputed": "discovery rule|occurrence rule",
    "dangerous_condition_830": "found|not found",
    "dangerous_condition_description": "specific condition",
    "constructive_notice_835": "how long existed|inspections",
    "design_immunity_830_6": "applied|rejected",
    "design_immunity_approval": "discretionary approval required — met",
    "changed_conditions_830_6b": "immunity lost|not raised",
    "discretionary_act_immunity_820_2": "applied|rejected",
    "ministerial_vs_discretionary": "how analyzed",
    "emergency_vehicle_17004_7": "applied|rejected|not raised",
    "scope_of_employment_820": "within scope|outside scope",
    "public_employee_liability": "personal|entity only"
  },

  "insurance_issues": {
    "um_uim_issue": "addressed|not addressed",
    "stacking": "addressed|not addressed",
    "coverage_dispute": "addressed|not addressed",
    "bad_faith_elements": "unreasonable denial|damages",
    "subrogation": "addressed|not addressed"
  },

  "temporal_data": {"ruling_year": null, "trend_note": null},

  "winning_arguments": [
    {"argument": "specific argument", "why_it_worked": "reasoning", "exact_language": "quote under 20 words"}
  ],
  "losing_arguments": [
    {"argument": "specific argument", "why_it_failed": "reasoning", "exact_language": "quote under 20 words"}
  ],

  "cited_statutes": ["Civil Code 1714", "CCP 335.1", "Gov. Code 835"],
  "cited_cases": ["case name only, max 8"],
  "drafting_insight": "one sentence: key practice point for this judge"
}`;
}

// ============================================================
//  PROMPT 5 — ESTATE / PROBATE / TRUST
//  Jury instruction sources: CACI 4100-4130 (Trust),
//  Prob. Code 16000-17200, CACI 4150-4160 (Elder Abuse)
// ============================================================
function buildEstatePrompt(ruling) {
  return `You are extracting estate planning and probate intelligence using Probate Code and CACI jury instruction elements. Extract every field present.

Court: ${ruling.court}
Judge: ${ruling.judge_name || "Unknown"}
Proceeding: ${ruling.motion_type || "Unknown"}
Result: ${ruling.result || "Unknown"}
Date: ${ruling.hearing_date || "Unknown"}

OPINION TEXT:
${(ruling.full_text || "").substring(0, 4500)}

Respond ONLY with JSON (empty {} if not estate/probate). Use null for absent fields:
{
  "proceeding_type": "Trust Administration|Will Contest|Conservatorship|Guardianship|Probate|Accounting|Elder Abuse|Other",
  "instrument_type": "revocable trust|irrevocable trust|testamentary trust|will|intestate|joint tenancy|TOD|other",
  "result": "Granted|Denied|Sustained|Overruled|Other",
  "legal_standard": "exact standard applied",
  "reasoning_chain": "Step 1: ... Step 2: ... Step 3: ...",
  "continuance_granted": true,
  "court_investigator": {"appointed": true, "findings_weight": null},

  "trustee_duties_prob_16000": {
    "duty_of_loyalty_16002": "raised|violated|not raised",
    "self_dealing_type": "competing interest|competing self|benefiting affiliate|other",
    "self_dealing_transaction_described": "specific transaction",
    "no_further_inquiry_rule": "applied|not applied",
    "authorization_by_trust": "authorized|unauthorized|ambiguous",
    "duty_of_impartiality_16003": "raised|violated|not raised",
    "income_vs_principal_conflict": "how impartiality was analyzed",
    "duty_to_invest_16047": "prudent investor rule — applied",
    "prudent_investor_factors": ["risk|return|diversification|liquidity|tax|other"],
    "delegation_16052": "proper delegation|improper|not raised",
    "duty_to_inform_16060": "raised|violated|not raised",
    "duty_to_account_16062": "raised|violated|not raised",
    "duty_to_keep_separate_16009": "commingling found|not found",
    "duty_not_to_profit_16004": "raised|violated|not raised",
    "trustee_removal_15642": "sought|granted|denied",
    "removal_standard": "breach of trust|insolvency|hostility|best interest",
    "co_trustee_liability": "jointly liable|several|exculpated",
    "exculpation_clause": "valid|invalid — public policy",
    "surcharge_amount": "dollar amount",
    "surcharge_with_interest": "rate|not addressed",
    "attorneys_fees_allowed": true,
    "trustee_fees_allowed": true,
    "fee_reduction_for_breach": "reduced|forfeited — basis"
  },

  "capacity_elements": {
    "testamentary_capacity_std": "understand nature of act|property|natural objects|plan — all four elements",
    "element1_nature_of_testamentary_act": "understood|not understood",
    "element2_nature_extent_property": "understood|not understood",
    "element3_natural_objects_of_bounty": "understood|not understood",
    "element4_plan_of_disposition": "understood|not understood",
    "lucid_interval": "raised|established|not established",
    "lucid_interval_timing": "date of execution — evidence",
    "contractual_capacity_standard": "higher than testamentary — analysis",
    "conservatorship_capacity_1801": "unable to resist fraud or undue influence|unable to manage",
    "dementia_diagnosis": "noted|not noted",
    "medical_evidence": "treating physician|retained expert|both",
    "lay_witness_testimony": "admitted|weight given",
    "MMSE_score": "noted|not noted",
    "capacity_at_time_of_execution": "established|disputed"
  },

  "undue_influence_elements": {
    "prob_21380_presumption": "triggered|not triggered",
    "presumption_basis": "donative transfer to care custodian|dependent adult|other",
    "care_custodian_analysis": "who qualifies as care custodian",
    "independent_attorney_review": "done|not done — impact",
    "general_undue_influence_elements": "susceptibility|opportunity|motive|result",
    "susceptibility": "evidence of susceptibility",
    "opportunity": "evidence of access and opportunity",
    "active_procurement": "evidence drafter selected by donee",
    "unnatural_result": "disinheriting family|unusual disposition",
    "confidential_relationship_triggers_presumption": true,
    "confidential_relationship_type": "fiduciary|reliance|dominant influence",
    "burden_shift": "to proponent of instrument",
    "rebuttal_evidence": "what overcame presumption",
    "duress": "raised|not raised"
  },

  "accounting_elements_prob_16460": {
    "accounting_period": "years covered",
    "objections_sustained": ["specific objection categories sustained"],
    "objection_improper_investment": "specific investment challenged",
    "objection_excessive_fees": "attorney|trustee|both",
    "objection_commingling": "specific instances",
    "objection_improper_distribution": "to whom|when|authority",
    "objection_failure_to_collect": "what assets not pursued",
    "objections_overruled": ["categories overruled and reason"],
    "independent_auditor_appointed": true,
    "surcharge_from_accounting": "amount",
    "passthrough_from_surcharge": "to whom"
  },

  "trust_interpretation_prob_21102": {
    "ambiguity_type": "patent|latent",
    "plain_language_applies": true,
    "extrinsic_evidence_basis": "ambiguity established — type",
    "extrinsic_evidence_admitted": true,
    "extrinsic_types": ["declarations|circumstances at execution|drafting history|other"],
    "intent_found": "what intent was established",
    "per_stirpes_vs_per_capita": "addressed|not addressed",
    "class_gift_issue": "addressed|not addressed",
    "ademption": "raised|not raised",
    "lapse": "raised|not raised",
    "anti_lapse_statute": "applied|not applicable",
    "no_contest_clause_21310": "raised|enforced|not enforced",
    "no_contest_probable_cause": "found|not found",
    "probable_cause_standard": "reasonable attorney would file|not",
    "spendthrift_15300": "raised|enforced|exception applied",
    "spendthrift_exception_type": "self-settled|support|tort creditor|other",
    "distribution_standard": "mandatory|discretionary — HEMS or other",
    "hems_standard": "health education maintenance support — analysis"
  },

  "will_contest_8250": {
    "grounds_alleged": "lack of capacity|undue influence|fraud|duress|menace|mistake|revocation|failure to execute",
    "execution_formalities": "signed|witnessed|notarized — compliance",
    "revocation_method": "subsequent instrument|physical act|operation of law",
    "holographic_will": "handwritten|dated|signed — requirements",
    "no_contest_clause_triggered": true,
    "standing_8004": "interested person — who qualifies",
    "jury_trial_right": "waived|preserved|addressed"
  },

  "conservatorship_1801": {
    "grounds_1801a": "unable to manage financial resources|resist fraud|meet needs",
    "grounds_basis": "medical|behavioral|other evidence",
    "least_restrictive_alternative": "considered|found adequate|not adequate",
    "limited_vs_general": "limited — specific powers|general",
    "powers_granted": ["specific powers listed"],
    "powers_withheld": ["powers retained by conservatee"],
    "capacity_declaration_required": "physician|psychologist — provided",
    "court_investigator_recommendation": "noted|weight given",
    "conservatee_objection": "raised|not raised — impact",
    "temporary_conservatorship": "granted|denied|duration",
    "bond_required": "amount|waived"
  },

  "elder_abuse_15610": {
    "raised": true,
    "physical_abuse_elements": "physical harm|deprivation|isolation",
    "financial_abuse_elements_15610_30": "took|hid|appropriated|retained|assisted",
    "undue_influence_connection": "part of financial abuse",
    "enhanced_remedies_15657": "sought|available — recklessness or malice",
    "attorneys_fees_15657_3": "available — bad faith",
    "punitive_damages": "available — malice oppression fraud",
    "employer_liability": "advance knowledge|ratification"
  },

  "prop_19_analysis": {
    "addressed": true,
    "parent_child_exclusion": "sought|granted|denied",
    "grandparent_grandchild": "sought|granted|denied",
    "principal_residence_requirement": "met|not met",
    "filing_deadline_1_year": "met|missed",
    "partial_exclusion_calculation": "how partial exclusion was computed",
    "trusts_qualify": "addressed|not addressed"
  },

  "temporal_data": {"ruling_year": null, "trend_note": null},

  "winning_arguments": [
    {"argument": "specific argument", "party": "petitioner|respondent|trustee|beneficiary", "why_it_worked": "reasoning", "exact_language": "quote under 20 words"}
  ],
  "losing_arguments": [
    {"argument": "specific argument", "why_it_failed": "reasoning", "exact_language": "quote under 20 words"}
  ],

  "cited_statutes": ["Prob. Code 16000", "Prob. Code 21380", "Welf. & Inst. Code 15610"],
  "cited_cases": ["case name only, max 6"],
  "drafting_insight": "one sentence: key practice point for this judge"
}`;
}


// ============================================================
//  PROMPT 6 — FEDERAL CIVIL PROCEDURE
//  9th Circuit Model Instructions: 5.1-5.5 (Preponderance),
//  5.6 (Clear and Convincing), 9.1-9.9 (Civil Rights),
//  FRCP Rules 8, 9, 11, 12, 23, 56 elements
// ============================================================
function buildFederalPrompt(ruling) {
  return `You are extracting federal civil procedure intelligence using 9th Circuit Model Jury Instructions and FRCP as the field architecture.

Court: ${ruling.court}
Judge: ${ruling.judge_name || "Unknown"}
Motion: ${ruling.motion_type || "Unknown"}
Result: ${ruling.result || "Unknown"}
Date: ${ruling.hearing_date || "Unknown"}

OPINION TEXT:
${(ruling.full_text || "").substring(0, 4500)}

Respond ONLY with JSON (empty {} if not federal civil). Use null for absent fields:
{
  "motion_type": "12(b)(6)|12(b)(1)|12(b)(2)|Rule 56|Class Cert|QI|Motion in Limine|Rule 11|28 USC 1927|Other",
  "result": "Granted|Denied|Granted in Part|Other",
  "claim_type": "Section 1983|Title VII|ADA|ADEA|FMLA|ERISA|Copyright|Patent|Securities|FCA|RICO|Other",
  "legal_standard": "exact standard applied",
  "reasoning_chain": "Step 1: ... Step 2: ... Step 3: ...",
  "oral_argument_held": true,
  "continuance": {"requested": true, "granted": true, "denial_reason": null},

  "pleading_standard_frcp_8_9": {
    "twombly_iqbal_applied": true,
    "plausibility_standard": "facially plausible — not merely possible",
    "factual_allegations_sufficient": true,
    "formulaic_recitation_rejected": "labels and conclusions not enough",
    "specific_deficiency": "what allegations were missing",
    "required_allegations": "what judge said must be alleged",
    "rule_9b_fraud_applied": true,
    "9b_particularity": "who|what|when|where|how — which missing",
    "9b_scienter_relaxed": "on information and belief — allowed",
    "pslra_heightened_standard": "applied — each element analyzed",
    "pslra_strong_inference": "powerful or cogent — met|not met",
    "leave_to_amend_frcp_15": true,
    "amendment_number": "first|second|third|final",
    "futility_analysis": "would not survive motion — basis",
    "prejudice_to_defendant": "addressed|not addressed",
    "undue_delay": "addressed|not addressed",
    "exact_language": "quote under 25 words"
  },

  "subject_matter_jurisdiction_12b1": {
    "raised": true,
    "basis": "federal question|diversity|supplemental|other",
    "federal_question_analysis": "arising under — well-pleaded complaint",
    "diversity_amount_in_controversy": "amount analyzed — met|not met",
    "diversity_citizenship_analysis": "domicile|LLC citizenship analysis",
    "supplemental_jurisdiction": "same case or controversy|declined|retained",
    "standing_elements": "injury in fact|traceability|redressability",
    "injury_in_fact": "concrete and particularized|imminent",
    "organizational_standing": "members would have standing|purpose frustrated",
    "mootness": "raised|not raised — exception applied",
    "ripeness": "raised|not raised — fitness and hardship",
    "political_question": "raised|not raised"
  },

  "personal_jurisdiction_12b2": {
    "raised": true,
    "general_vs_specific": "general jurisdiction|specific jurisdiction",
    "purposeful_availment": "contacts — analyzed",
    "arising_out_of": "claim arises from contacts",
    "fair_play_substantial_justice": "factors analyzed",
    "long_arm_statute": "California|other state — cited",
    "consent_waiver": "addressed|not addressed"
  },

  "summary_judgment_rule_56": {
    "moving_party": "plaintiff|defendant",
    "burden_statement": "no genuine dispute of material fact",
    "initial_burden_met": true,
    "burden_shift_triggered": true,
    "non_movant_burden": "specific facts — not mere allegations",
    "genuine_dispute_found": true,
    "genuine_dispute_description": "specific factual dispute",
    "materiality_analysis": "would affect outcome|irrelevant",
    "all_inferences_for_non_movant": true,
    "sham_affidavit": "raised|rejected — not contradicting prior testimony",
    "expert_creates_triable_issue": true,
    "qualified_expert_foundation": "addressed|not addressed",
    "partial_summary_judgment": "granted on — specific issues"
  },

  "qualified_immunity_elements": {
    "two_step_saucier": "constitutional violation|clearly established",
    "pearson_discretion": "order of analysis — constitutional first|immunity first",
    "step1_constitutional_violation": "found|not found|not reached",
    "constitutional_right_at_issue": "4th Amendment|14th Amendment|1st Amendment|other",
    "step2_clearly_established": "established|not established",
    "clearly_established_standard": "every reasonable officer would know",
    "high_level_generality_insufficient": "particularized application required",
    "prior_case_on_point": "specific case cited|required|not found",
    "hope_v_pelzer_obvious_exception": "applied|not applied",
    "factual_disputes_preclude_immunity": true,
    "interlocutory_appeal_right": "noted|not noted"
  },

  "class_certification_rule_23": {
    "certified": true,
    "23a_numerosity": "met|not met — number of members",
    "impracticability_of_joinder": "joinder impracticable — why",
    "23a_commonality": "met|not met",
    "common_question": "specific question that drives resolution",
    "23a_typicality": "met|not met",
    "typicality_analysis": "same injury same conduct",
    "23a_adequacy": "met|not met",
    "adequacy_attorney": "experience|resources — analyzed",
    "adequacy_named_plaintiff": "no conflicts|interests aligned",
    "23b1_incompatible_standards": "not applicable|applied",
    "23b2_injunctive_relief": "applied|not applied",
    "23b3_predominance": "met|not met",
    "predominating_question": "what common question predominated",
    "individual_issues_identified": ["specific individualized issues cited"],
    "23b3_superiority": "met|not met",
    "manageability": "manageable|not — why",
    "ascertainability": "met|not met|not required in 9th Circuit",
    "class_period": "dates if stated",
    "fail_safe_class_problem": "raised|not raised"
  },

  "erisa_elements": {
    "plan_type": "pension|welfare|disability|other",
    "502a_claim": "benefits|enforcement|breach|other",
    "abuse_of_discretion_review": "applied|de novo — discretionary authority",
    "conflict_of_interest": "insurer also payor — noted|not noted",
    "exhaustion": "required|excused|not required",
    "full_and_fair_review": "met|not met",
    "de_novo_review": "applied — no discretionary authority",
    "arbitrary_and_capricious": "applied — discretionary|not met"
  },

  "sanctions_rule_11": {
    "raised": true,
    "21_day_safe_harbor": "served|not served — impact",
    "safe_harbor_compliance": "met|not met",
    "frivolous_claim": "no arguable basis in law or fact",
    "improper_purpose": "harassment|delay|cost — found",
    "unwarranted_extension": "not warranted by existing law",
    "reasonable_inquiry": "not conducted — basis",
    "amount": "dollar amount",
    "28_usc_1927_vexatious": "unreasonable and vexatious — found"
  },

  "temporal_data": {
    "ruling_year": null,
    "circuit_split_noted": true,
    "circuit_split_description": "what the split involves",
    "en_banc_cited": true,
    "overruling_or_distinguishing": "specific prior case and how",
    "trend_noted": null
  },

  "winning_arguments": [
    {"argument": "specific argument", "why_it_worked": "reasoning", "exact_language": "quote under 20 words"}
  ],
  "losing_arguments": [
    {"argument": "specific argument", "why_it_failed": "reasoning", "exact_language": "quote under 20 words"}
  ],

  "cited_statutes": ["42 U.S.C. § 1983", "Fed. R. Civ. P. 56", "28 U.S.C. § 1331"],
  "cited_cases": ["case name only, max 8"],
  "drafting_insight": "one sentence: key practice point for this judge"
}`;
}

// ============================================================
//  PROMPT 7 — BUSINESS LITIGATION
//  CACI 300-390 (Contract), CACI 1800-1802 (Interference),
//  CACI 4400-4410 (Trade Secret), BPC 16600, BPC 17200,
//  Corp. Code (Entities), CACI 3700-3760 (Fiduciary)
// ============================================================
function buildBusinessPrompt(ruling) {
  return `You are extracting business litigation intelligence using CACI and Corp. Code jury instruction elements. Extract every field present.

Court: ${ruling.court}
Judge: ${ruling.judge_name || "Unknown"}
Motion: ${ruling.motion_type || "Unknown"}
Result: ${ruling.result || "Unknown"}
Date: ${ruling.hearing_date || "Unknown"}

OPINION TEXT:
${(ruling.full_text || "").substring(0, 4500)}

Respond ONLY with JSON (empty {} if not business litigation). Use null for absent fields:
{
  "motion_type": "Demurrer|MSJ|Anti-SLAPP|PI|TRO|Motion to Compel|Sanctions|Other",
  "result": "Sustained|Overruled|Granted|Denied|Mixed",
  "case_type": "Breach of Contract|Trade Secret|Non-Compete|Partnership|Shareholder|LLC|IP|Unfair Practices|Interference|Defamation|Other",
  "complaint_generation": "original|FAC|SAC|other",
  "legal_standard": "exact standard applied",
  "reasoning_chain": "Step 1: ... Step 2: ... Step 3: ...",
  "oral_argument_held": true,
  "continuance": {"requested": true, "granted": true, "denial_reason": null},

  "contract_elements_caci_303": {
    "element1_existence": "formation dispute|undisputed",
    "formation_issue": "offer|acceptance|consideration|mutual assent|definiteness",
    "definiteness_issue": "essential terms identified|too vague",
    "illusory_promise": "raised|not raised",
    "consideration_adequacy": "courts do not inquire|nominal|sham",
    "element2_performance_or_excuse": "performed|excused|in dispute",
    "excuse_type": "impossibility|frustration|force majeure|prevention|anticipatory breach",
    "force_majeure_clause": "enforced|not enforced|not in contract",
    "force_majeure_trigger": "what event claimed|foreseeability analyzed",
    "element3_breach": "material|minor|anticipatory",
    "materiality_factors": "substantial performance|extent of deficiency|cure|intent",
    "anticipatory_repudiation": "unequivocal refusal|voluntary disablement",
    "element4_causation_damages": "caused by breach|too speculative",
    "certainty_of_damages": "lost profits certainty|new business rule|other",
    "caci_315_implied_covenant": "raised|specific obligation implied",
    "implied_covenant_limits": "cannot contradict express terms",
    "modification_oral": "allowed|not allowed — statute of frauds",
    "statute_of_frauds": "raised|not raised — type",
    "waiver_analysis": "clear unambiguous expression|conduct",
    "estoppel_elements": "promise|reliance|detriment|injustice",
    "integration_clause": "fully integrated|partially|ambiguous",
    "parol_evidence_exception_used": "fraud|condition precedent|ambiguity|collateral",
    "ambiguity_type": "patent|latent",
    "extrinsic_evidence_admitted": true,
    "specific_performance_elements": "unique|inadequate legal remedy|feasible|not against public policy",
    "liquidated_damages_test": "reasonable forecast at time|actual damages",
    "penalty_clause_voided": true,
    "indemnification_scope": "express negligence|broad form|limited",
    "indemnification_own_negligence": "covered|not covered|ambiguous",
    "consequential_damages_waiver": "valid|unconscionable|ambiguous",
    "limitation_of_liability": "enforced|not enforced — unconscionable",
    "attorneys_fees_provision": "prevailing party|one-sided|mutual",
    "forum_selection_enforced": true,
    "mandatory_vs_permissive_forum": "mandatory|permissive — difference",
    "choice_of_law_result": "CA law|other state law — applied"
  },

  "trade_secret_caci_4400": {
    "element1_secret_existence": "identified with specificity|too general",
    "specificity_required": "what level of description court required",
    "reasonable_measures_caci_4401": "security protocols|NDAs|access controls|other measures",
    "measures_reasonable": true,
    "not_generally_known": "industry competitors could not readily ascertain",
    "element2_misappropriation_caci_4402": "acquisition|use|disclosure",
    "acquisition_by_improper_means": "theft|bribery|misrepresentation|espionage|breach of duty",
    "breach_of_confidence": "NDA|employment duty|confidential relationship",
    "inevitable_disclosure": "adopted|rejected — jurisdiction analysis",
    "threatened_misappropriation": "found|not found",
    "element3_damages_or_unjust_enrichment": "actual loss|unjust enrichment|reasonable royalty",
    "unjust_enrichment_calculation": "how calculated",
    "exemplary_damages_civ_3426_3": "willful and malicious — 2x",
    "attorneys_fees_civ_3426_4": "bad faith — awarded|not awarded",
    "injunction_elements": "reasonable to prevent|scope",
    "injunction_scope": "specific activities enjoined",
    "trade_secret_identification_order": "complied|not complied — impact"
  },

  "non_compete_bpc_16600": {
    "void_ab_initio": true,
    "edwards_rule": "no enforceable non-compete in CA",
    "narrow_restraint_exception": "sale of business|dissolution|dissolution of partnership",
    "exception_analysis": "how exception was analyzed",
    "sale_of_business_goodwill": "goodwill transferred — element",
    "out_of_state_choice_of_law": "another state's law sought|CA law applied anyway",
    "application_of_ca_law": "fundamental policy|materially greater interest",
    "non_solicitation_analyzed": true,
    "customer_non_solicitation": "trade secret basis|void|enforced",
    "employee_non_solicitation": "void|analyzed",
    "non_disclosure_analyzed": true,
    "nda_scope": "legitimate|overbroad",
    "injunction_granted": true,
    "remedy_if_void": "damages|no injunction"
  },

  "entity_disputes": {
    "entity_type": "partnership|LLC|corporation|joint venture|LLP",
    "fiduciary_duty_source": "Corp. Code|partnership law|LLC Act|common law",
    "caci_3704_duty_of_loyalty": "raised|violated",
    "caci_3705_duty_of_care": "raised|violated",
    "duty_of_loyalty_elements": "not act adverse interest|not compete|disclose",
    "self_dealing_transaction": "described|interested director standard",
    "business_judgment_rule": "applied|not applied",
    "bjr_rebutted": "how overcome — fraud|bad faith|irrational",
    "oppression_elements_corp_1800": "frustrating reasonable expectations|squeeze out",
    "oppression_finding": "found|not found",
    "buyout_ordered": true,
    "fair_value_standard": "going concern|minority discount|control premium",
    "dissolution_corp_1800": "granted|denied — conditions",
    "deadlock": "addressed|not addressed",
    "alter_ego_elements": "unity of interest and ownership|inequitable result",
    "unity_factors": "commingling|undercapitalization|common officers|failure to follow formalities",
    "inequitable_result_factor": "unjust or inequitable — analysis",
    "single_enterprise_doctrine": "raised|not raised",
    "derivative_suit_standing": "shareholder|member — demand required",
    "demand_futility": "raised|not raised — excused why",
    "corporate_opportunity_elements": "opportunity|interest or expectancy|failure to disclose",
    "dissolution_voluntary_vs_judicial": "voluntary|judicial|petition basis"
  },

  "ip_elements": {
    "copyright_elements": "original work|authorship|fixed in tangible medium|ownership",
    "copyright_infringement": "copying|access plus similarity|substantial similarity test",
    "substantial_similarity_test": "extrinsic|intrinsic — both applied",
    "fair_use_factors": "1-purpose|2-nature|3-amount|4-market effect — each analyzed",
    "fair_use_finding": "fair use|not fair use",
    "trademark_likelihood_of_confusion": "Sleekcraft 8 factors applied",
    "sleekcraft_factors_analyzed": ["strength|proximity|evidence of actual confusion|marketing channels|care|defendant intent|expansion likelihood|other"],
    "trademark_dilution": "blurring|tarnishment — raised|not raised",
    "patent_claim_construction": "addressed|not addressed",
    "patent_infringement_theory": "literal|doctrine of equivalents",
    "patent_invalidity": "prior art|obviousness|anticipation — raised",
    "willful_infringement": "found|not found — enhanced damages",
    "statutory_damages_copyright": "per work range — minimum|maximum|within",
    "injunction_ip": "permanent|preliminary — four factor test"
  },

  "interference_elements_caci_1800": {
    "contract_interference_elements": "valid contract|defendant knowledge|intentional inducing|actual breach|resulting damages",
    "economic_advantage_elements": "economic relationship|probability of future benefit|defendant knowledge|intentional interference|independently wrongful|disruption|damages",
    "independently_wrongful_act": "required for prospective|specific act",
    "independently_wrongful_types": "crime|fraud|defamation|misrep|other",
    "justification_defense": "asserted|rejected|accepted — basis",
    "manager_privilege": "raised|rejected"
  },

  "unfair_practices_bpc_17200": {
    "prong": "unlawful|unfair|fraudulent|all three",
    "unlawful_predicate": "specific statute or regulation violated",
    "unfair_balancing_test": "harm vs utility|tethered to policy",
    "fraudulent_prong": "likely to deceive reasonable consumer",
    "standing_lost_money_property": "economic injury alleged — what",
    "representative_action": "standing issues|who can bring",
    "restitution": "money had and received|ordered|not ordered",
    "disgorgement_vs_restitution": "distinction analyzed|not addressed",
    "injunction_17203": "granted|denied — likelihood",
    "17500_false_advertising": "companion claim|not raised",
    "class_action_ucl": "via CCP 382 — certified|not certified"
  },

  "preliminary_injunction_business": {
    "likelihood_success": "strong|moderate|weak",
    "irreparable_harm": "found|not found",
    "irreparable_harm_type": "loss of trade secret|loss of goodwill|irreplaceable|other",
    "money_damages_adequate": "yes — no PI|no — PI appropriate",
    "balance_hardships": "plaintiff|defendant|neutral",
    "public_interest": "competition|innovation|free employment|other",
    "bond_amount": "dollar amount",
    "tro_basis": "ex parte elements — notice|likelihood|irreparable"
  },

  "temporal_data": {"ruling_year": null, "trend_note": null},

  "winning_arguments": [
    {"argument": "specific argument", "why_it_worked": "reasoning", "exact_language": "quote under 20 words"}
  ],
  "losing_arguments": [
    {"argument": "specific argument", "why_it_failed": "reasoning", "exact_language": "quote under 20 words"}
  ],

  "cited_statutes": ["Bus. & Prof. Code 16600", "Civ. Code 3426", "Corp. Code 1800"],
  "cited_cases": ["case name only, max 8"],
  "drafting_insight": "one sentence: key practice point for this judge"
}`;
}

// ============================================================
//  PROMPT 8 — EMPLOYMENT LAW
//  9th Circuit Model: 10.1-10.8, CACI 2500-2720,
//  FEHA (Gov. Code 12900+), Labor Code, PAGA, FMLA/CFRA
// ============================================================
function buildEmploymentPrompt(ruling) {
  return `You are extracting employment law intelligence using 9th Circuit Model Instructions and CACI employment series as the field architecture.

Court: ${ruling.court}
Judge: ${ruling.judge_name || "Unknown"}
Motion: ${ruling.motion_type || "Unknown"}
Result: ${ruling.result || "Unknown"}
Date: ${ruling.hearing_date || "Unknown"}

OPINION TEXT:
${(ruling.full_text || "").substring(0, 4500)}

Respond ONLY with JSON (empty {} if not employment). Use null for absent fields:
{
  "motion_type": "MSJ|Demurrer|Class Cert|PAGA Motion|Compel Arbitration|PI|Other",
  "result": "Granted|Denied|Sustained|Overruled|Mixed",
  "claim_type": "Discrimination|Harassment|Retaliation|Wrongful Termination|Wage Hour|PAGA|FMLA/CFRA|ADA|Other",
  "employer_type": "private|public entity|non-profit",
  "industry": "tech|healthcare|retail|food service|construction|transportation|other",
  "employee_status": "employee|independent contractor|exempt|non-exempt",
  "legal_standard": "exact standard applied",
  "reasoning_chain": "Step 1: ... Step 2: ... Step 3: ...",
  "oral_argument_held": true,
  "continuance": {"requested": true, "granted": true, "denial_reason": null},

  "feha_discrimination_caci_2540": {
    "protected_characteristic": "race|color|religion|sex|gender|national origin|ancestry|disability|age|sexual orientation|marital status|pregnancy|other",
    "theory": "disparate treatment|disparate impact|mixed motive|same actor",
    "element1_plaintiff_employee": "employed or applied|undisputed",
    "element2_adverse_action": "termination|demotion|pay cut|other — what",
    "adverse_action_threshold": "materially adverse — analysis",
    "element3_protected_characteristic_factor": "substantial motivating reason — FEHA|motivating factor — Title VII",
    "substantial_motivating_vs_but_for": "FEHA substantial motivating|Title VII but-for — distinction noted",
    "mcdonnell_douglas_caci_2500": "applied|mixed motive instead",
    "prima_facie_elements": "member of protected class|qualified|adverse action|inference",
    "prima_facie_met": true,
    "legitimate_reason_articulated": true,
    "legitimate_reason": "reason employer gave",
    "pretext_elements": "reason false|discriminatory reason more likely|both",
    "pretext_evidence_type": "shifting reasons|departure from policy|comparator treatment|statistical|timing|stray remarks",
    "stray_remarks_doctrine": "isolated|not by decision maker|not proximate — applied",
    "stray_remarks_result": "admissible circumstantial|no pretext alone",
    "comparator_analysis": "similarly situated in all material respects",
    "comparator_result": "treated differently|not similarly situated — why",
    "same_actor_inference": "raised|not raised — weight",
    "same_protected_class_defense": "raised|not raised",
    "cat_paw_liability": "raised|applied — knowledge plus decision maker",
    "mixed_motive_framework": "Price Waterhouse|Desert Palace|instruction given",
    "disparate_impact_elements": "facially neutral policy|statistical disparity|business necessity defense|less discriminatory alternative",
    "business_necessity_met": true,
    "less_discriminatory_alternative": "exists|does not exist|not raised"
  },

  "harassment_caci_2520_2521": {
    "harasser_status": "supervisor|non-supervisor|third party",
    "supervisor_tangible_action": "termination|demotion|pay change — strict liability",
    "faragher_ellerth_defense": "anti-harassment policy|plaintiff unreasonably failed to use",
    "element1_hostile_environment": "sufficiently severe or pervasive",
    "severe_single_incident": "physical assault|extremely serious — analyzed",
    "pervasive_pattern": "frequency|duration|intensity",
    "objective_standard": "reasonable person of same sex|race|etc",
    "subjective_standard": "plaintiff found hostile|believed hostile",
    "welcomeness": "raised|analyzed|not raised",
    "unwelcome_conduct": "found|not found",
    "knew_or_should_have_known": "employer notice — analyzed",
    "prompt_effective_remedial_action": "took action|did not — liability",
    "quid_pro_quo_theory": "tangible job benefit|explicit or implicit condition"
  },

  "feha_retaliation_caci_2505": {
    "element1_protected_activity": "FEHA complaint|DFEH charge|opposition|request accommodation|leave|jury duty|other",
    "internal_vs_external_complaint": "internal|DFEH|EEOC|both",
    "opposition_protected": "reasonable belief of violation — analysis",
    "element2_adverse_action": "materially adverse — would deter reasonable employee",
    "element3_causal_connection": "substantial motivating reason|but-for",
    "causal_connection_evidence": "temporal proximity|direct|pattern|comparator",
    "temporal_proximity_days": "specific days between activity and action",
    "temporal_proximity_sufficient_alone": "yes|no — additional evidence needed",
    "intervening_events": "events breaking causal chain",
    "pretext_for_retaliation": "same pretext analysis as discrimination"
  },

  "wrongful_termination_caci_2600": {
    "theory": "FEHA|public policy Tameny|implied contract|good faith covenant",
    "public_policy_elements": "substantial public policy|clearly expressed|fundamental|beneficial to public",
    "policy_source": "specific statute cited|constitutional provision|regulation",
    "policy_brinker_restaurant": "statute for public benefit|not merely private",
    "at_will_doctrine": "presumption|rebutted by",
    "implied_contract_caci_2621": "employer promises|oral|policy|longevity|custom",
    "handbook_disclaimer": "clearly stated at-will|ambiguous|no disclaimer",
    "disclaimer_effective": "yes|no — circumstances",
    "progressive_discipline_policy": "existed|followed|not followed — impact",
    "covenant_good_faith_caci_2622": "bad faith discharge — sole purpose to deprive benefits",
    "covenant_limits": "cannot convert at-will|only economic motive",
    "loss_of_vested_benefits": "commissions|pension|bonus — about to vest"
  },

  "disability_caci_2540_2543": {
    "disability_definition_gov_12926": "physical|mental|limiting major life activity",
    "physical_disability_broad": "any physiological condition — CA broader than ADA",
    "mental_disability": "psychological disorder — CA broader",
    "regarded_as_disabled": "employer regarded — analysis",
    "qualified_individual": "can perform essential functions|with or without accommodation",
    "essential_functions": "what functions were identified as essential",
    "reasonable_accommodation_caci_2541": "what accommodations were discussed",
    "interactive_process_caci_2546": "good faith process|who failed|what steps taken",
    "undue_hardship_defense": "significant difficulty or expense — factors",
    "reassignment_duty": "duty to reassign to vacant position — analyzed",
    "leave_as_accommodation": "reasonable|indefinite leave not required"
  },

  "ada_elements_9th_10_3": {
    "element1_disability_defined": "physical or mental impairment|substantially limits major life activity",
    "substantially_limits_standard": "ADA Amendments Act — broader",
    "mitigating_measures": "not considered — ADA Amendments",
    "element2_qualified": "essential functions|with reasonable accommodation",
    "element3_adverse_because_of_disability": "but-for standard|motivating factor",
    "interactive_process": "employer duty|employee duty — who failed",
    "reasonable_accommodation_types": "modification|leave|reassignment|other"
  },

  "wage_hour_elements": {
    "overtime_elements": "hours over 8 in day|40 in week|7th day — rate",
    "overtime_rate": "1.5x|2x — which triggered",
    "exemption_executive_caci_2751": "primary duty|management|two employees|discretion",
    "exemption_administrative": "primary duty office|discretion independent judgment|matters of significance",
    "exemption_professional": "learned|creative — analysis",
    "salary_basis_test": "predetermined amount|prohibited deductions",
    "discretion_and_independent_judgment": "how analyzed — policies vs true judgment",
    "outside_sales_exemption": "more than half time outside|sales or obtains orders",
    "computer_professional": "salary $53.80+|duties — analyzed",
    "meal_break_elements": "30 min|uninterrupted|off duty — premium for violation",
    "meal_break_waiver": "first waiver valid|second requires <6 hour shift",
    "rest_break_elements": "10 min|every 4 hours|net time — premium for violation",
    "rest_break_waiver": "valid|not valid",
    "rounding_policy": "neutral on its face|favors employer — invalid",
    "auto_deduct_policy": "valid if breaks actually taken|invalid if not",
    "piece_rate_rest_breaks": "separate compensation required — analyzed",
    "minimum_wage_elements": "all hours worked|including waiting time|on-call",
    "on_call_analysis": "waiting to be engaged|engaged to wait",
    "expense_reimbursement_2802": "all necessary expenditures|indemnify",
    "cell_phone_reimbursement": "business use — some amount required",
    "mileage_reimbursement": "actual cost|IRS rate|reasonable",
    "final_pay_elements": "discharge immediate|quit 72 hours|waiting time penalty",
    "waiting_time_penalty_203": "willful failure — 1 day wages up to 30 days",
    "pay_stub_elements_226": "gross|net|hourly rate|hours|employer name|employee info",
    "pay_stub_injury": "injury standard — not merely technical",
    "misclassification_theory": "IC vs employee|exempt vs non-exempt",
    "abc_test_dynamex": "A|B|C — which prong failed",
    "abc_prong_a": "control and direction — how analyzed",
    "abc_prong_b": "outside usual course of business — how analyzed",
    "abc_prong_c": "independently established trade — how analyzed",
    "borello_test": "still applies for some claims|hybrid analysis"
  },

  "paga_elements": {
    "standing_aggrieved_employee": "personally suffered violation|employed by defendant",
    "notice_to_lwda": "filed|65 day period|cure notice sent",
    "cure_period": "33 days for small employers|addressed",
    "cure_effectiveness": "cured|not cured — what inadequate",
    "representative_action_nature": "not class action — Arias|different requirements",
    "manageability": "PAGA manageable|not manageable — factors",
    "individualized_issues": "what individual issues were raised",
    "75_25_split": "LWDA 75%|employees 25%|modified",
    "per_violation_calculation": "100 first|200 subsequent|other",
    "penalty_amount_estimated": "total estimate if stated",
    "viking_river_applied": true,
    "individual_paga_to_arbitration": "yes|no",
    "representative_paga_stays_in_court": "yes|no|dismissed",
    "adolph_v_uber_applied": "individual settled|representative standing continues"
  },

  "fmla_cfra_elements": {
    "leave_law": "FMLA|CFRA|PDL|all — which applied",
    "eligible_employee": "12 months|1250 hours|50 employees within 75 miles",
    "serious_health_condition_defined": "inpatient|continuing treatment — which",
    "chronic_condition": "periodic incapacity — analyzed",
    "continuing_treatment_standard": "3 day incapacity plus treatment|other",
    "interference_theory": "denied|interfered|discouraged|retaliated",
    "reinstatement_right": "same or equivalent position",
    "equivalent_position_standard": "equivalent pay|benefits|other terms",
    "light_duty_not_equivalent": "not same position — analyzed",
    "cfra_expansion_over_fmla": "parent in law|grandparent|sibling|domestic partner",
    "pdl_pregnancy": "4 months|up to 4 months — how calculated",
    "baby_bonding_cfra": "separate from PDL|12 weeks",
    "interplay_pdl_cfra": "sequential leaves — how calculated"
  },

  "arbitration_elements": {
    "agreement_existence": "signed|click-through|provided in handbook",
    "mutual_assent": "analyzed — knowledge of terms",
    "procedural_unconscionability_factors": "oppression|surprise — which present",
    "substantive_unconscionability_provisions": ["confidentiality|shortened limitations|cost splitting|limited discovery|other"],
    "sliding_scale": "more procedural less substantive required — applied",
    "paga_waiver_analysis": "pre-viking river void|post-viking river split",
    "class_waiver": "enforceable under FAA|NLRA concerns",
    "faa_preemption": "preempts CA rule against waivers — analysis",
    "delegation_clause": "arbitrator decides arbitrability|court retains",
    "unconscionability_severs": "offending provision|entire agreement",
    "cost_splitting_unconscionable": "prohibitive cost to employee",
    "shortened_limitations_unconscionable": "analyzed|upheld"
  },

  "class_certification_employment": {
    "certified": true,
    "primary_common_question": "policy or practice driving common answer",
    "policy_or_practice_identified": "specific employer policy",
    "predominance_analysis": "policy drives outcome|individual issues overwhelm",
    "individual_issues": ["specific individualized issues argued"],
    "ascertainability": "class members identifiable|not|not required",
    "statute_of_limitations_tolling": "American Pipe tolling|not addressed"
  },

  "damages_employment": {
    "back_pay_period": "from date of adverse action to judgment",
    "back_pay_offset": "interim earnings|failure to mitigate",
    "mitigation_duty": "reasonable efforts|evidence|not required to accept inferior",
    "front_pay_period": "years|basis for calculation",
    "emotional_distress": "garden variety|severe — clinical evidence required",
    "punitive_malice_feha": "officer director managing agent|advance knowledge|ratification",
    "punitive_standard_feha": "same as Civil Code 3294",
    "attorneys_fees_feha_12965": "prevailing plaintiff mandatory|prevailing defendant frivolous",
    "fees_multiplier": "lodestar|multiplier — basis and amount",
    "paga_fees": "attorney fees recoverable — separately"
  },

  "temporal_data": {"ruling_year": null, "trend_note": null},

  "winning_arguments": [
    {"argument": "specific argument", "party": "employee|employer", "why_it_worked": "reasoning", "exact_language": "quote under 20 words"}
  ],
  "losing_arguments": [
    {"argument": "specific argument", "party": "employee|employer", "why_it_failed": "reasoning", "exact_language": "quote under 20 words"}
  ],

  "cited_statutes": ["Gov. Code 12940", "Labor Code 1102.5", "Labor Code 226"],
  "cited_cases": ["case name only, max 8"],
  "drafting_insight": "one sentence: key practice point for this judge"
}`;
}

// ============================================================
//  PROMPT 9 — PUBLIC ENTITY & SECURITIES LAW
//  9th Circuit Model: 9.1-9.9 (Civil Rights), 18.1-18.5
//  (Securities), FCA elements, Gov. Code 810-996
// ============================================================
function buildPublicEntitySecPrompt(ruling) {
  return `You are extracting public entity and securities law intelligence using 9th Circuit Model Instructions and statutory elements as the field architecture.

Court: ${ruling.court}
Judge: ${ruling.judge_name || "Unknown"}
Motion: ${ruling.motion_type || "Unknown"}
Result: ${ruling.result || "Unknown"}
Date: ${ruling.hearing_date || "Unknown"}

OPINION TEXT:
${(ruling.full_text || "").substring(0, 4500)}

Respond ONLY with JSON (empty {} if not public entity or securities). Use null for absent fields:
{
  "motion_type": "12(b)(6)|MSJ|Motion to Dismiss|Class Cert|Summary Adjudication|Other",
  "result": "Granted|Denied|Sustained|Overruled|Mixed",
  "case_type": "Section 1983|Monell|Public Employee|SEC Enforcement|Securities Fraud|FCA|Government Contract|Public Entity Tort|Whistleblower|RICO|Other",
  "legal_standard": "exact standard applied",
  "reasoning_chain": "Step 1: ... Step 2: ... Step 3: ...",
  "oral_argument_held": true,
  "continuance": {"requested": true, "granted": true, "denial_reason": null},

  "section_1983_elements_9th_9_1": {
    "element1_deprivation_of_rights": "what constitutional or federal right was deprived",
    "element2_under_color_of_law": "state actor|joint action|public function|nexus",
    "color_of_law_analysis": "how state action was established or not",
    "element3_causation": "defendant's conduct caused deprivation",
    "constitutional_violation_found": true,
    "fourth_amendment_search_seizure": "raised|warrant|exception — analyzed",
    "fourth_amendment_excessive_force": "objective reasonableness|Graham factors",
    "graham_factors": "severity of crime|immediate threat|resisting or fleeing",
    "fourteenth_due_process_procedural": "protected interest|process required|received",
    "fourteenth_due_process_substantive": "shocks conscience|arbitrary and oppressive",
    "fourteenth_equal_protection": "class of one|suspect class|rational basis|strict scrutiny",
    "first_amendment_speech": "protected|unprotected|content based|content neutral",
    "first_amendment_retaliation_elements": "protected activity|adverse action|causal connection",
    "bivens_extension": "new context|special factors|alternative remedy",
    "bivens_special_factors": ["security|national security|Congress declined to create|other"]
  },

  "qualified_immunity_detail": {
    "step1_constitutional_violation": "found|not found|not reached",
    "step2_clearly_established": "clearly established|not clearly established",
    "clearly_established_test": "every reasonable officer would know",
    "particularized_standard": "general rule applied|specific case required",
    "prior_circuit_precedent": "circuit precedent existed|did not",
    "specific_case_identified": "case that clearly established",
    "obvious_case_exception": "hope v pelzer — so obvious no prior case needed",
    "obvious_case_found": true,
    "factual_disputes_preclude_qi": "disputed facts|defendant version|plaintiff version",
    "qualified_for_all_claims": "full immunity|partial immunity",
    "interlocutory_appeal": "noted|not noted"
  },

  "monell_elements_9th_9_5": {
    "element1_official_policy": "formal policy|custom|practice",
    "official_policy_definition": "deliberate choice by authorized policymaker",
    "element2_widespread_custom": "so persistent as to have force of law",
    "custom_evidence": "incidents|complaints|lack of discipline — quantity",
    "deliberate_indifference_standard": "obvious consequence|actual notice",
    "failure_to_train": "inadequacy so obvious|deliberate indifference",
    "training_inadequacy": "specific training deficiency",
    "pattern_of_violations": "sufficient pattern|single incident",
    "single_incident_exception": "so obviously likely to violate|not required",
    "element3_moving_force": "policy was moving force behind violation",
    "causation_standard": "but-for|direct cause",
    "ratification": "policymaker approved decision and basis",
    "final_policymaker": "who qualifies as final policymaker",
    "policymaker_analysis": "state law determines who|analysis"
  },

  "public_employee_rights": {
    "property_interest_source": "tenure|contract|policy|other",
    "property_interest_found": true,
    "liberty_interest_source": "stigma plus|name clearing|other",
    "liberty_interest_found": true,
    "predeprivation_process": "pre-termination hearing|written notice|response opportunity",
    "balancing_test_mathews": "private interest|government interest|risk of error",
    "mathews_result": "process was adequate|inadequate",
    "first_amendment_pickering": "speech on matter of public concern|Garcetti threshold",
    "matter_of_public_concern": "content|form|context — Connick analysis",
    "pickering_balance": "employee interest|government efficiency interest",
    "garcetti_scope_of_duties": "speech pursuant to official duties — no protection",
    "citizen_speech_vs_employee": "citizen capacity — Garcetti inapplicable",
    "civil_service_protections": "merit system|just cause|due process overlay",
    "post_termination_process": "Loudermill hearing|available|used",
    "stigma_plus_elements": "defamatory statement plus|alteration of legal status",
    "name_clearing_hearing_required": "yes|no — adequate remedies"
  },

  "securities_fraud_elements_9th_18_1": {
    "element1_material_misrepresentation_omission": "false statement|misleading half-truth",
    "materiality_standard_18_3": "substantial likelihood|reasonable investor|total mix",
    "materiality_qualitative": "core operations|accounting violations|senior management — presumptively material",
    "forward_looking_statement": "made|not protected — actual knowledge of falsity",
    "safe_harbor_pslra": "identified as forward-looking|meaningful cautionary language",
    "bespeaks_caution": "common law analog|applied",
    "element2_scienter_18_2": "deliberately reckless|conscious disregard",
    "scienter_inference": "strong inference — as likely as not inference of culpable state",
    "motive_opportunity": "concrete benefit|unusual trading — as part of inference",
    "core_operations_inference": "should have known — senior officer|core business",
    "element3_connection_with_purchase_sale": "in connection with — fraud on market|direct",
    "element4_reliance_18_4": "fraud on market presumed|rebutted how",
    "affiliated_ute_presumption": "omission case — presumed reliance",
    "element5_economic_loss": "price decline|corrective disclosure|other",
    "element6_loss_causation_18_5": "but-for|disclosure ended inflation",
    "loss_causation_analysis": "corrective disclosure|materialization of risk|other",
    "pslra_pleading": "each element with particularity|strong inference scienter",
    "group_pleading_doctrine": "rejected|allowed — analysis",
    "bespeaks_caution_applied": true,
    "class_action_securities": "Basic presumption|fraud on market",
    "securities_act_11": "material misstatement in registration|strict liability|due diligence defense",
    "section_12": "solicitation|privity or similar|rescission",
    "insider_trading_elements": "material nonpublic info|duty|trade|tip",
    "misappropriation_theory": "duty to source|breach — analyzed",
    "disgorgement": "ordered|not ordered|ill-gotten gains",
    "civil_penalty": "tier 1|tier 2|tier 3 — amount",
    "officer_bar": "permanent|limited years|not imposed",
    "pslra_discovery_stay": "automatic stay|lift motion — analyzed"
  },

  "false_claims_act_elements": {
    "element1_false_claim": "false|fraudulent claim for payment",
    "falsity_theory": "factually false|legally false|implied certification|express certification",
    "implied_certification_escobar": "specific representation|half-truth|statutory violation material",
    "materiality_escobar": "would actually cause government to pay less|did continue to pay",
    "materiality_government_decision": "knew of violation and paid anyway — not material",
    "element2_presented_to_government": "direct submission|government funded program",
    "element3_knowledge": "actual knowledge|deliberate ignorance|reckless disregard",
    "reckless_disregard_standard": "high probability of falsity|conscious disregard",
    "element4_materiality": "natural tendency to influence payment decision",
    "qui_tam_standing": "original source|voluntarily provided before public disclosure",
    "public_disclosure_bar": "news media|congressional report|government audit|other",
    "original_source_exception": "direct and independent knowledge|before disclosure",
    "retaliation_elements_3730h": "protected activity|knew of activity|discriminatory act|causal connection",
    "protected_activity_fca": "investigating|filing|assisting|objecting",
    "damages": "treble actual damages|civil penalties per claim",
    "government_share": "intervened split|declined split",
    "reverse_false_claim_3729a1g": "obligation to pay government|concealed|avoided"
  },

  "government_contracts": {
    "contract_type": "federal|state|local|FAR-governed|not FAR",
    "formation_issue": "competitive bidding|sole source|small business",
    "competitive_bidding_violation": "found|not found",
    "procurement_integrity": "raised|not raised",
    "breach_theory": "cardinal change|constructive change|termination",
    "cardinal_change_elements": "fundamentally different from bargained for|radical scope change",
    "cardinal_change_factors": "magnitude|nature|duration|total performance disruption",
    "constructive_change": "ordered to perform beyond contract|compensation owed",
    "changes_clause": "modification without formal change order",
    "disputes_clause_exhaustion": "contracting officer decision|Board of Contract Appeals",
    "sovereign_immunity_waiver": "Tucker Act jurisdiction|contract|express or implied",
    "implied_warranty_specifications": "defective specs — Spearin doctrine",
    "termination_for_convenience": "settled costs|anticipatory profits formula",
    "termination_for_default": "excusable delay defense|prior notice required",
    "implied_duty_good_faith": "federal contracts — implied|not to hinder performance",
    "debarment": "raised|initiated|grounds",
    "suspension": "raised|immediate|grounds"
  },

  "public_entity_tort_gov_code": {
    "entity_type": "state|county|city|school|transit|water|other",
    "gov_code_810_application": "general immunity then waiver|specific waiver",
    "claim_act_gov_905": "required|exempt|complied|not complied",
    "claim_deadline": "6 months from accrual|personal injury",
    "late_claim_945_4": "leave to file|denied|granted",
    "accrual_rule": "occurrence|discovery|continuing violation",
    "substantial_compliance_912_7": "applied|rejected",
    "dangerous_condition_830": "public property|created substantial risk|foreseeable injury",
    "dangerous_condition_description": "specific condition",
    "property_related_injury": "injury from use|not from use",
    "notice_835": "actual|constructive — length of time",
    "constructive_notice_period": "how long existed before injury",
    "design_immunity_830_6": "discretionary approval|design approved|no notice after changed conditions",
    "design_immunity_lost": "830_6b — changed conditions noticed",
    "discretionary_act_820_2": "basic policy decision|immune",
    "ministerial_act": "prescribed manner|no discretion — not immune",
    "emergency_vehicle_17004_7": "operating emergency vehicle|code 3",
    "firefighter_police_rule": "assumption of risk variant|addressed",
    "respondeat_superior_815_2": "employee act within scope|injury caused",
    "scope_of_employment": "authorized acts|motivated by serving employer",
    "independent_contractor": "no liability for IC|retained control exception",
    "design_build_liability": "split|not addressed",
    "inverse_condemnation": "physical taking|substantial damage|no just compensation"
  },

  "whistleblower_elements": {
    "statute": "Dodd-Frank|SOX 806|FCA 3730h|Labor Code 1102.5|CFRA|WARN|other",
    "protected_activity_type": "internal report|SEC report|OSHA|qui tam|regulatory|other",
    "reasonable_belief_standard": "objectively reasonable — analysis",
    "employer_knowledge": "knew or suspected protected activity",
    "adverse_action": "discharge|demotion|suspension|harassment|other",
    "causation_standard": "contributing factor|but-for|substantial motivating",
    "burden_shift": "prima facie then employer legitimate reason then pretext",
    "clear_convincing_evidence": "required for some statutes — applied",
    "dodd_frank_tipper": "SEC tip directly|through employer|who is covered",
    "sox_covered_entity": "publicly traded|subsidiary|contractor",
    "sox_administrative_exhaustion": "required|excused|met",
    "reinstatement_remedy": "ordered|front pay in lieu",
    "back_pay_remedy": "ordered|amount",
    "special_damages": "attorney fees|expert witness fees|other"
  },

  "rico_elements": {
    "raised": true,
    "element1_enterprise": "legal entity|association in fact — defined",
    "element2_pattern_racketeering": "at least two predicate acts|related and continuous",
    "relatedness": "same purpose|results|participants|victims|methods",
    "continuity": "closed ended|open ended — threat of continuing",
    "predicate_acts": "mail fraud|wire fraud|bank fraud|extortion|other",
    "element3_conduct_enterprise": "managing or operating — Reves test",
    "element4_injury_by_reason_of": "proximate causation|direct harm",
    "rico_conspiracy_1962d": "agree to participate — elements",
    "civil_rico_damages": "treble|attorney fees",
    "pleading_standard": "Rule 9(b) for fraud predicates"
  },

  "temporal_data": {
    "ruling_year": null,
    "circuit_split_noted": true,
    "circuit_split_description": "what the split involves",
    "trend_noted": null
  },

  "winning_arguments": [
    {"argument": "specific argument", "party": "plaintiff|defendant|government", "why_it_worked": "reasoning", "exact_language": "quote under 20 words"}
  ],
  "losing_arguments": [
    {"argument": "specific argument", "why_it_failed": "reasoning", "exact_language": "quote under 20 words"}
  ],

  "cited_statutes": ["42 U.S.C. § 1983", "15 U.S.C. § 78j", "31 U.S.C. § 3729", "Gov. Code 835"],
  "cited_cases": ["case name only, max 8"],
  "drafting_insight": "one sentence: key practice point for this judge"
}`;
}

// ============================================================
//  MAIN ROUTER — picks the right prompt for each opinion
// ============================================================
function buildExtractionPrompt(ruling) {
  const area = detectPracticeAreaFromOpinion(
    ruling.court,
    ruling.motion_type,
    ruling.full_text?.substring(0, 500) || ""
  );

  ruling._practiceArea = area;

  switch (area) {
    case "immigration":      return { prompt: buildImmigrationPrompt(ruling),      area };
    case "eviction":         return { prompt: buildEvictionPrompt(ruling),         area };
    case "personal_injury":  return { prompt: buildPersonalInjuryPrompt(ruling),   area };
    case "estate":           return { prompt: buildEstatePrompt(ruling),           area };
    case "business":         return { prompt: buildBusinessPrompt(ruling),         area };
    case "employment":       return { prompt: buildEmploymentPrompt(ruling),       area };
    case "public_entity_sec":return { prompt: buildPublicEntitySecPrompt(ruling),  area };
    case "federal":          return { prompt: buildFederalPrompt(ruling),          area };
    default:                 return { prompt: buildCivilPrompt(ruling),            area };
  }
}

// ============================================================
//  FIELD MAPPER — normalizes varied JSON structures
//  into the standard motion_arguments / reasoning_patterns
//  fields, regardless of which prompt was used
// ============================================================
function normalizeExtractedData(raw, area) {
  if (!raw || typeof raw !== "object") return null;

  // All prompts share these core fields
  const normalized = {
    practiceArea:      area,
    motion_type:       raw.motion_type        || raw.proceeding_type || raw.case_type || null,
    result:            raw.result             || null,
    legal_standard:    raw.legal_standard     || null,
    reasoning_chain:   raw.reasoning_chain    || null,
    winning_arguments: raw.winning_arguments  || [],
    losing_arguments:  raw.losing_arguments   || [],
    cited_statutes:    raw.cited_statutes      || [],
    cited_cases:       raw.cited_cases         || [],
    drafting_insight:  raw.drafting_insight    || null,

    // Temporal tracking (all prompts)
    ruling_year:       raw.temporal_evolution?.ruling_year
                        || raw.temporal_data?.ruling_year
                        || null,
    trend_note:        raw.temporal_evolution?.trend_noted
                        || raw.temporal_data?.trend_note
                        || null,

    // Area-specific structured data stored as JSON
    area_data: buildAreaData(raw, area),
  };

  // Extract key_factors from various prompt shapes
  normalized.key_factors = [
    ...(raw.decisive_factors || []),
    ...(raw.credibility?.adverse_factors || []),
    ...(raw.pleading_analysis?.specific_missing_elements || []),
    ...(raw.liability ? [raw.liability.causation_analysis].filter(Boolean) : []),
    ...(raw.discrimination_harassment?.prima_facie_elements_required || []),
    ...(raw.trade_secret ? [raw.trade_secret.misappropriation_theory].filter(Boolean) : []),
    ...(raw.section_1983 ? [raw.section_1983.constitutional_right_alleged].filter(Boolean) : []),
    ...(raw.securities_fraud ? [raw.securities_fraud.scienter_standard].filter(Boolean) : []),
  ].filter(Boolean).slice(0, 6);

  normalized.counter_factors = [
    ...(raw.credibility?.credibility_saved_by || []),
    ...(raw.counter_factors || []),
    ...(raw.non_compete ? [raw.non_compete.exception_found].filter(Boolean) : []),
    ...(raw.discrimination_harassment ? [raw.discrimination_harassment.pretext_evidence].filter(Boolean) : []),
  ].filter(Boolean).slice(0, 4);

  normalized.burden_placement = raw.burden_placement
    || raw.merits_analysis?.burden_on
    || raw.internal_relocation?.burden
    || raw.wage_hour?.misclassification_theory
    || raw.false_claims_act?.knowledge_standard
    || null;

  // Sample language — pick best available from any prompt
  normalized.sample_language = raw.credibility?.exact_language
    || raw.pleading_analysis?.exact_language
    || raw.notice_analysis?.exact_language
    || raw.discrimination_harassment?.severe_pervasive_standard
    || raw.winning_arguments?.[0]?.exact_language
    || null;

  return normalized;
}

// ── Build area-specific data blob ────────────────────────────
function buildAreaData(raw, area) {
  switch (area) {
    case "immigration":
      return {
        credibility:        raw.credibility        || null,
        psg_analysis:       raw.psg_analysis       || null,
        nexus:              raw.nexus              || null,
        country_conditions: raw.country_conditions || null,
        internal_relocation:raw.internal_relocation|| null,
        procedural:         raw.procedural         || null,
        appellate_issues:   raw.appellate_issues   || null,
      };
    case "civil":
      return {
        pleading_analysis:  raw.pleading_analysis  || null,
        merits_analysis:    raw.merits_analysis    || null,
        damages:            raw.damages            || null,
        anti_slapp:         raw.anti_slapp         || null,
        discovery_sanctions:raw.discovery_sanctions|| null,
      };
    case "eviction":
      return {
        notice_analysis:     raw.notice_analysis      || null,
        just_cause:          raw.just_cause           || null,
        habitability:        raw.habitability         || null,
        retaliatory_eviction:raw.retaliatory_eviction || null,
        security_deposit:    raw.security_deposit     || null,
        rent_control:        raw.rent_control         || null,
      };
    case "personal_injury":
      return {
        liability:          raw.liability          || null,
        comparative_fault:  raw.comparative_fault  || null,
        damages:            raw.damages            || null,
        expert_witness:     raw.expert_witness     || null,
        government_claim:   raw.government_claim   || null,
        insurance_issues:   raw.insurance_issues   || null,
      };
    case "estate":
      return {
        trustee_analysis:    raw.trustee_analysis    || null,
        capacity:            raw.capacity            || null,
        accounting:          raw.accounting          || null,
        trust_interpretation:raw.trust_interpretation|| null,
        conservatorship:     raw.conservatorship     || null,
        prop_19_analysis:    raw.prop_19_analysis    || null,
      };
    case "business":
      return {
        contract_analysis:   raw.contract_analysis   || null,
        trade_secret:        raw.trade_secret        || null,
        non_compete:         raw.non_compete         || null,
        entity_disputes:     raw.entity_disputes     || null,
        ip_analysis:         raw.ip_analysis         || null,
        unfair_practices:    raw.unfair_practices    || null,
        preliminary_injunction: raw.preliminary_injunction || null,
      };
    case "employment":
      return {
        discrimination_harassment: raw.discrimination_harassment || null,
        retaliation:         raw.retaliation         || null,
        wrongful_termination:raw.wrongful_termination|| null,
        wage_hour:           raw.wage_hour           || null,
        paga:                raw.paga                || null,
        fmla_cfra:           raw.fmla_cfra           || null,
        arbitration:         raw.arbitration         || null,
        class_certification: raw.class_certification || null,
        damages:             raw.damages             || null,
      };
    case "public_entity_sec":
      return {
        section_1983:        raw.section_1983        || null,
        monell:              raw.monell              || null,
        public_employee:     raw.public_employee     || null,
        securities_fraud:    raw.securities_fraud    || null,
        false_claims_act:    raw.false_claims_act    || null,
        government_contract: raw.government_contract || null,
        public_entity_tort:  raw.public_entity_tort  || null,
        whistleblower:       raw.whistleblower       || null,
      };
    case "federal":
      return {
        pleading_standard:   raw.pleading_standard   || null,
        summary_judgment:    raw.summary_judgment    || null,
        qualified_immunity:  raw.qualified_immunity  || null,
        class_certification: raw.class_certification || null,
        employment:          raw.employment          || null,
        temporal_evolution:  raw.temporal_evolution  || null,
      };
    default:
      return raw;
  }
}

module.exports = {
  buildExtractionPrompt,
  normalizeExtractedData,
  detectPracticeAreaFromOpinion,
};
