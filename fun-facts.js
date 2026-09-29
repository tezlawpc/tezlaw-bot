// ============================================================
//  fun-facts.js — WEDNESDAY
//  Tez Law P.C.
//  ─────────────────────────────────────────────────────────
//  JJ: "schedule weekly fun facts every wednesday to lighten up
//  the mood in the middle of the week."
//
//  Same rule as the holiday posts, for the same reason: THE
//  FACT IS WRITTEN BY A HUMAN. The model picks the words, never
//  the content. A "fun legal fact" invented by a language model
//  is a made-up rule published under a lawyer's name, and it
//  would be the most plausible-sounding thing on the page.
//
//  So this is a bank, not a generator. Each entry carries the
//  fact in plain words and, where there is one, the authority to
//  check it against. Adding facts is the intended maintenance:
//  one a week means the bank below is about six months of
//  Wednesdays.
//
//  Facts are chosen to be STABLE. No current fee amounts, no
//  processing times, no pass rates, no "as of" figures — those
//  go stale silently and a stale fact posted confidently is
//  worse than no post.
// ============================================================

const FACTS = [
  // ── Immigration ──────────────────────────────────────────
  {
    key: "green_card_color",
    fact: "The green card was green from 1946 to 1964, then spent decades in "
        + "other colors — pink, blue, rose — while everyone kept calling it "
        + "the green card anyway. It only went back to green in 2010. The "
        + "nickname outlived the colour by nearly fifty years.",
  },
  {
    key: "eoir_not_a_court",
    fact: "Immigration court is not part of the judicial branch. It sits "
        + "inside the Department of Justice, and immigration judges are DOJ "
        + "employees rather than Article III judges. It surprises almost "
        + "everyone who hears it for the first time.",
    cite: "Executive Office for Immigration Review, 8 C.F.R. § 1003",
  },
  {
    key: "no_jury_immigration",
    fact: "There is no jury in immigration court. No jury box, no voir dire, "
        + "no twelve people deliberating — one judge decides.",
  },
  {
    key: "new_colossus",
    fact: "\"Give me your tired, your poor\" was not on the Statue of Liberty "
        + "when it opened. Emma Lazarus wrote the poem to help raise money "
        + "for the pedestal, and the plaque was not mounted until 1903 — "
        + "seventeen years after the statue was dedicated.",
  },
  {
    key: "uscis_fee_funded",
    fact: "USCIS runs almost entirely on the fees applicants pay, not on tax "
        + "money. It is one of the very few federal agencies that largely "
        + "funds itself.",
  },
  {
    key: "a_number",
    fact: "The A in A-number stands for Alien Registration Number. The system "
        + "dates to the Alien Registration Act of 1940, which means some "
        + "A-numbers in use today were issued before the Second World War "
        + "ended.",
  },
  {
    key: "no_smiling",
    fact: "You are not allowed to smile broadly in a US visa or passport "
        + "photo. A neutral expression is required because facial "
        + "recognition software measures distances between features, and a "
        + "grin moves them.",
  },
  {
    key: "before_1875",
    fact: "For the first hundred years of the country, there was essentially "
        + "no federal law restricting who could immigrate to the United "
        + "States. Federal immigration restriction begins in 1875.",
  },
  {
    key: "oath_length",
    fact: "The Oath of Allegiance new citizens take is only about 140 words — "
        + "shorter than most emails. An applicant with a religious objection "
        + "can ask to leave out the words about bearing arms.",
  },

  // ── California law ───────────────────────────────────────
  {
    key: "holographic_will",
    fact: "In California a will written entirely by hand can be valid with no "
        + "witnesses and no notary at all, as long as the signature and the "
        + "important parts are in the person's own handwriting. Typing it is "
        + "what creates the need for witnesses.",
    cite: "Cal. Probate Code § 6111",
  },
  {
    key: "community_property",
    fact: "California is one of only nine community property states. In most "
        + "of the country, what each spouse earns during a marriage is "
        + "legally theirs; here, by default, it is both of theirs.",
  },
  {
    key: "recording_a_deed",
    fact: "Recording a deed is not what transfers California property — "
        + "delivering the deed is. Recording protects you against someone "
        + "else claiming it later. People are often surprised the two are "
        + "separate steps.",
  },
  {
    key: "unlawful_detainer_speed",
    fact: "An eviction case in California is called an unlawful detainer, and "
        + "it moves faster than almost any other civil case — the response "
        + "deadline is counted in days, not the thirty a normal lawsuit "
        + "gets.",
  },
  {
    key: "ca_constitution_length",
    fact: "California's state constitution is one of the longest in the "
        + "world — many times the length of the US Constitution, because "
        + "voters can amend it directly at the ballot box and have, hundreds "
        + "of times.",
  },
  {
    key: "notario_problem",
    fact: "In much of Latin America a notario público is a trained lawyer. In "
        + "California a notary public is not, and cannot give legal advice. "
        + "The same two words meaning different things in two countries has "
        + "caused a great deal of real harm.",
  },
  {
    key: "pi_two_years",
    fact: "California gives you two years to bring most personal injury "
        + "claims — but if the defendant is a government agency, a written "
        + "claim is due far sooner. Same accident, very different clock.",
    cite: "Cal. Code Civ. Proc. § 335.1; Gov. Code § 911.2",
  },

  // ── Courts and language ──────────────────────────────────
  {
    key: "subpoena_meaning",
    fact: "Subpoena is Latin for \"under penalty\" — the name is the threat. "
        + "Habeas corpus, meanwhile, means \"that you have the body\", which "
        + "is a demand that whoever is holding a person produce them.",
  },
  {
    key: "esquire",
    fact: "Esquire has no legal meaning in the United States. No statute "
        + "grants it, no bar confers it, and nothing stops anyone using it. "
        + "It is pure convention.",
  },
  {
    key: "most_cases_settle",
    fact: "\"Your day in court\" is rarer than the phrase suggests: the large "
        + "majority of civil cases end in settlement or dismissal rather "
        + "than trial.",
  },
  {
    key: "four_districts",
    fact: "California is big enough to need four separate federal district "
        + "courts. Most states manage with one.",
  },
  {
    key: "attorney_origin",
    fact: "Attorney comes from the Old French atorné — one who is appointed. "
        + "The word is about being asked to stand in someone's place, which "
        + "is still exactly the job.",
  },

  // ── Business and local ───────────────────────────────────
  {
    key: "llc_age",
    fact: "The LLC is younger than the pocket calculator. Wyoming passed the "
        + "first one in 1977, and it took until the 1990s for every state to "
        + "follow.",
  },
  {
    key: "handshake_contracts",
    fact: "Most contracts do not have to be in writing to be binding. The "
        + "famous exceptions — land, and agreements that cannot be performed "
        + "within a year among them — come from a English statute of 1677 "
        + "that California still follows.",
    cite: "Statute of Frauds; Cal. Civ. Code § 1624",
  },
  {
    key: "corporation_person",
    fact: "A corporation is legally a person: it can own things, sign "
        + "contracts, sue and be sued in its own name. That idea is the "
        + "entire reason a business can outlive the people who started it.",
  },
  {
    key: "trademark_use",
    fact: "In the United States, trademark rights come from using a mark in "
        + "business, not from registering it. Registration makes those "
        + "rights far easier to enforce — but first use is what creates them.",
  },
  {
    key: "west_covina_age",
    fact: "West Covina was incorporated in 1923, when its population was "
        + "under a thousand people and the main business was citrus. The "
        + "\"Covina\" name came from the groves.",
  },
];

/**
 * Pick the next fact: one never posted before, oldest first; if the bank has
 * been exhausted, the least recently used. Returns null only if the bank is
 * empty.
 *
 * `used` is a Set of keys already in the queue, so the caller decides how to
 * look them up and this stays testable without a database.
 */
function nextFact(used = new Set(), order = []) {
  const unused = FACTS.filter(f => !used.has(f.key));
  if (unused.length) return unused[0];
  if (!FACTS.length) return null;
  // Everything has run: go round again, oldest-used first. A fact missing
  // from `order` has no record of being posted, so it sorts first (-1)
  // rather than tying with the most recently used one.
  const rank = new Map(order.map((k, i) => [k, i]));
  return [...FACTS].sort((a, b) => (rank.get(a.key) ?? -1) - (rank.get(b.key) ?? -1))[0];
}

// `ch` (the channel spec) is injectable so this stays loadable without a
// database: reaching into social-posts for it drags in pg, which is not
// installed on every machine that runs the checks.
function buildFactPrompt(fact, channel, ch = null) {
  ch = ch || require("./social-posts").CHANNELS[channel];
  return [
    `Write one ${ch.name} post for ${process.env.FIRM_NAME || "Tez Law P.C."}, `
      + "a law firm in West Covina, California.",
    "",
    "It is Wednesday. The job is to be the most interesting thing in "
      + "somebody's feed for fifteen seconds, and to leave them knowing one "
      + "thing they did not know at breakfast. Light on its feet. A little "
      + "delight is the entire point.",
    "",
    ch.voice,
    "",
    "THE FACT — use this and nothing else as the substance:",
    fact.fact,
    fact.cite ? `(Authority, for the firm's own reference — do NOT put this in the post: ${fact.cite})` : "",
    "",
    "You may choose the words, the opening and the rhythm. You may NOT add "
      + "further facts, dates, numbers, statutes or legal rules that are not "
      + "in the note above, and you may not extend the fact into advice. If "
      + "the fact is about the law, it is offered as something interesting, "
      + "never as guidance for the reader's situation.",
    "",
    "DO NOT WRITE, in any wording:",
    "  · \"Fun fact:\" or \"Did you know?\" as an opener — just tell them",
    "  · \"Happy Wednesday!\" or any reference to hump day",
    "  · anything about the firm's services, or an invitation to get in touch",
    "  · a moral at the end (\"which just goes to show...\")",
    "Open on the surprising part. Stop when the fact has landed.",
    "",
    `Hard limit: ${ch.max} characters.`,
    "",
    "Brand: the firm's public name is \"TEZ Law Firm\" (legal name Tez Law "
      + "P.C.; in Chinese posts: TEZ Law Firm 律师事务所).",
    "",
    "Never: guarantee or predict an outcome; call the firm the best or a "
      + "leader; manufacture urgency; tell the reader what to file or say "
      + "anything about 'your case'.",
    "",
    "Do not include any link or phone number.",
    "",
    "Reply with the post text only. No preamble, no quotation marks.",
  ].filter(Boolean).join("\n");
}

module.exports = { FACTS, nextFact, buildFactPrompt };
