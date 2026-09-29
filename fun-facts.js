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

// JJ, 28 Sep 2026: "fun fact posts every wednesday about american history."
// The legal facts below are kept for later use; Wednesday draws from this bank.
// Every entry is well documented; the cite is where to check it.
const HISTORY_FACTS = [
  {
    key: "independence_july_2",
    fact: "Congress actually voted for independence on July 2, 1776. John Adams wrote that July 2 would be celebrated for generations with parades and illuminations. The Declaration was adopted two days later, and most delegates did not sign it until August 2.",
    cite: "National Archives, Declaration of Independence",
  },
  {
    key: "adams_jefferson_july_4",
    fact: "John Adams and Thomas Jefferson, once rivals and later friends by letter, both died on July 4, 1826, exactly fifty years after the Declaration they had worked on together. Adams died a few hours after Jefferson, not knowing Jefferson was already gone.",
    cite: "Library of Congress",
  },
  {
    key: "constitution_four_pages",
    fact: "The original United States Constitution fits on four sheets of parchment. It is on display at the National Archives in Washington, D.C., in the same rotunda as the Declaration of Independence and the Bill of Rights.",
    cite: "National Archives",
  },
  {
    key: "liberty_turned_green",
    fact: "The Statue of Liberty was not always green. When she was dedicated in 1886 she was the reddish-brown of new copper, and she turned green over roughly two decades as the copper weathered. The green coat now protects the metal underneath.",
    cite: "National Park Service, Statue of Liberty",
  },
  {
    key: "ellis_island",
    fact: "Ellis Island opened in 1892, and by the time it closed in 1954 more than twelve million immigrants had passed through its halls. Today a large share of Americans can trace at least one ancestor through that single island in New York Harbor.",
    cite: "National Park Service, Ellis Island",
  },
  {
    key: "angel_island_poems",
    fact: "At the Angel Island Immigration Station in San Francisco Bay, open from 1910 to 1940, Chinese immigrants held for weeks or months carved poems into the wooden walls of the barracks. Many of those poems can still be read there today.",
    cite: "Angel Island Immigration Station Foundation; California State Parks",
  },
  {
    key: "chinese_exclusion_act",
    fact: "The Chinese Exclusion Act of 1882 was the first federal law to bar immigration by people of a specific nationality. It stayed in force for sixty-one years, until Congress repealed it in 1943, when China was a wartime ally.",
    cite: "National Archives, Chinese Exclusion Act",
  },
  {
    key: "railroad_workers",
    fact: "When the transcontinental railroad was completed at Promontory Summit, Utah, on May 10, 1869, thousands of Chinese immigrants had made up most of the Central Pacific's workforce, blasting and laying track through the Sierra Nevada.",
    cite: "Library of Congress; Stanford Chinese Railroad Workers in North America Project",
  },
  {
    key: "wong_kim_ark",
    fact: "In 1898 the Supreme Court decided United States v. Wong Kim Ark. Wong was born in San Francisco to Chinese parents, and the Court held that he was a U.S. citizen by birth under the Fourteenth Amendment.",
    cite: "United States v. Wong Kim Ark, 169 U.S. 649 (1898)",
  },
  {
    key: "california_no_territory",
    fact: "California became the 31st state on September 9, 1850, without ever having been an organized U.S. territory. It went from land taken in the Mexican–American War straight to statehood in about two years, sped along by the Gold Rush.",
    cite: "California State Library",
  },
  {
    key: "gold_before_treaty",
    fact: "Gold was found at Sutter's Mill on January 24, 1848, just nine days before the treaty that ended the Mexican–American War and handed California to the United States. Neither side at the treaty table knew about the discovery.",
    cite: "Treaty of Guadalupe Hidalgo (1848); California State Parks",
  },
  {
    key: "los_pobladores",
    fact: "Los Angeles was founded in 1781 by a group of forty-four settlers, known as Los Pobladores, who walked north from Mexico. They came from a mix of Spanish, African, and Indigenous backgrounds.",
    cite: "City of Los Angeles; El Pueblo de Los Ángeles Historical Monument",
  },
  {
    key: "white_house_burned",
    fact: "In 1814, during the War of 1812, British troops set fire to the White House. Dolley Madison is remembered for making sure the large portrait of George Washington was saved before the building burned.",
    cite: "White House Historical Association",
  },
  {
    key: "lincoln_patent",
    fact: "Abraham Lincoln is the only U.S. president to hold a patent. In 1849 he patented a device for lifting riverboats over sandbars and shallow water. It was never built for use, but a model survives at the Smithsonian.",
    cite: "U.S. Patent No. 6,469; Smithsonian",
  },
  {
    key: "washington_teeth",
    fact: "George Washington never had wooden teeth. His dentures were made from materials such as ivory, metal, and human and animal teeth. The wooden-teeth story is a myth that has lasted more than two centuries.",
    cite: "George Washington's Mount Vernon",
  },
  {
    key: "thanksgiving_moved",
    fact: "Thanksgiving became a national holiday when Lincoln proclaimed it in 1863, after years of lobbying by the writer Sarah Josepha Hale. In 1939 Franklin Roosevelt moved it a week earlier, the country argued about it, and Congress fixed it on the fourth Thursday of November in 1941.",
    cite: "National Archives",
  },
  {
    key: "liberty_bell_name",
    fact: "The Liberty Bell got its name from abolitionists in the 1830s, who adopted it as a symbol of their fight to end slavery. The inscription on it reads: Proclaim liberty throughout all the land unto all the inhabitants thereof.",
    cite: "National Park Service, Independence National Historical Park",
  },
  {
    key: "wyoming_vote",
    fact: "Wyoming gave women the right to vote in 1869, while it was still a territory, more than fifty years before the Nineteenth Amendment guaranteed women the vote nationwide in 1920.",
    cite: "Wyoming State Archives; National Archives",
  },
  {
    key: "route_66",
    fact: "Route 66, established in 1926, ran about 2,400 miles from Chicago to Santa Monica. Its official end is marked near the Santa Monica Pier, just a short drive from our offices.",
    cite: "National Park Service, Route 66",
  },
  {
    key: "hollywoodland",
    fact: "The Hollywood sign first read HOLLYWOODLAND. It went up in 1923 as an advertisement for a new housing development, and the last four letters came down in 1949.",
    cite: "Hollywood Sign Trust",
  },
  {
    key: "international_orange",
    fact: "The Golden Gate Bridge opened in 1937, and it is not gold. Its color is called International Orange, chosen partly because it stands out in the fog and blends with the hills around the bay.",
    cite: "Golden Gate Bridge, Highway and Transportation District",
  },
  {
    key: "first_coast_call",
    fact: "In January 1915 Alexander Graham Bell, in New York, made the first transcontinental telephone call to his assistant Thomas Watson in San Francisco, repeating the famous line from their first call years earlier: Mr. Watson, come here, I want you.",
    cite: "Library of Congress",
  },
  {
    key: "anthem_1931",
    fact: "Francis Scott Key wrote the words of The Star-Spangled Banner in 1814, after watching the British bombard Fort McHenry in Baltimore. It did not officially become the national anthem until 1931, more than a century later.",
    cite: "Smithsonian, National Museum of American History",
  },
  {
    key: "juneteenth",
    fact: "On June 19, 1865, Union troops arrived in Galveston, Texas, and announced that enslaved people there were free, more than two years after the Emancipation Proclamation. Juneteenth became a federal holiday in 2021.",
    cite: "National Archives",
  },
  {
    key: "dalip_singh_saund",
    fact: "The first Asian American elected to Congress was Dalip Singh Saund, an immigrant from India who represented a Southern California district that included Riverside and Imperial Counties. He took office in 1957.",
    cite: "U.S. House of Representatives, History, Art & Archives",
  },
  {
    key: "hiram_fong",
    fact: "Hiram Fong, the son of Chinese immigrants, became one of Hawaii's first two U.S. senators when Hawaii became a state in 1959. He was the first Asian American to serve in the Senate.",
    cite: "U.S. Senate Historical Office",
  },
  {
    key: "mendez_westminster",
    fact: "In 1947, in Mendez v. Westminster, a federal appeals court ruled against segregating Mexican American children in Orange County schools. It came seven years before Brown v. Board of Education, and California ended school segregation by law that same year.",
    cite: "Mendez v. Westminster, 161 F.2d 774 (9th Cir. 1947)",
  },
  {
    key: "alaska_two_cents",
    fact: "The United States bought Alaska from Russia in 1867 for about two cents an acre. Critics called it Seward's Folly, after the Secretary of State who negotiated it. Gold, fish and oil later made it look like a bargain.",
    cite: "National Archives",
  },
];

const LEGAL_FACTS = [
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

const FACTS = HISTORY_FACTS;

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

module.exports = { FACTS, HISTORY_FACTS, LEGAL_FACTS, nextFact, buildFactPrompt };
