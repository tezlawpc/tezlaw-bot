// ============================================================
//  holiday-posts.js — THE FIRM'S CALENDAR POSTS
//  Tez Law P.C.
//  ─────────────────────────────────────────────────────────
//  Planned on the 1st of each month for the 30 days ahead, and
//  queued for JJ's approval like every other post.
//
//  TWO DESIGN RULES, both learned the hard way elsewhere in
//  this repo:
//
//  1. THE SUBSTANCE IS WRITTEN BY A HUMAN, NOT THE MODEL.
//     Every holiday below carries an `angle`: the actual fact
//     or sentiment the post is built on. The model chooses the
//     words; it does not choose the content. An article-sourced
//     post is anchored by the article. A holiday post has no
//     article, so without an angle the model would be free to
//     invent immigration law to fill the space — which is how a
//     cheerful Fourth of July post ends up stating a rule that
//     does not exist.
//
//  2. LUNAR DATES ARE NEVER COMPUTED OR GUESSED.
//     Lunar New Year, Qingming, Duanwu and Mid-Autumn move every
//     year. Only verified years are in LUNAR below. A year that
//     is not in the table is SKIPPED with a warning naming what
//     to add — never approximated. A post on the wrong day is a
//     public mistake, and for these festivals it is one this
//     firm's clients would notice immediately.
//
//  Tone is per-holiday and deliberate. "Happy Memorial Day" is
//  the kind of thing that gets a firm quoted unkindly, so the
//  day carries tone: "solemn" and the prompt is told what that
//  forbids.
// ============================================================


// ── Date helpers ────────────────────────────────────────────

const iso = (y, m, d) => `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

/** The nth given weekday of a month. nth = -1 means the last one. */
function nthWeekday(year, month, weekday, nth) {
  if (nth > 0) {
    const first = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
    return iso(year, month, 1 + ((weekday - first + 7) % 7) + (nth - 1) * 7);
  }
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const lastDay = new Date(Date.UTC(year, month - 1, last)).getUTCDay();
  return iso(year, month, last - ((lastDay - weekday + 7) % 7));
}

/**
 * Easter Sunday, by the anonymous Gregorian algorithm (Computus).
 *
 * Unlike the Chinese lunisolar festivals, Easter IS computable from a closed
 * formula — it does not need an astronomical table — so it is calculated here
 * rather than tabulated. Good Friday is two days earlier.
 */
function easter(year) {
  const a = year % 19, b = Math.floor(year / 100), c = year % 100;
  const d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const hh = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4;
  const l = (32 + 2 * e + 2 * i - hh - k) % 7;
  const m = Math.floor((a + 11 * hh + 22 * l) / 451);
  const month = Math.floor((hh + l - 7 * m + 114) / 31);
  const day = ((hh + l - 7 * m + 114) % 31) + 1;
  return iso(year, month, day);
}

/** N days before a date string, as a date string. */
function daysBefore(dateStr, n) {
  const d = new Date(dateStr + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() - n);
  return iso(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
}

// Verified Gregorian dates for the lunisolar festivals. Sources:
// Wikipedia "List of observances set by the Chinese calendar" (2026) and
// studycli.org/chinese-holidays/2027 (2027). ADD YEARS HERE as they are
// confirmed — nothing below is calculated.
const LUNAR = {
  2026: { lunar_new_year: "2026-02-17", qingming: "2026-04-05", duanwu: "2026-06-19", mid_autumn: "2026-09-25" },
  2027: { lunar_new_year: "2027-02-06", qingming: "2027-04-05", duanwu: "2027-06-09", mid_autumn: "2027-09-15" },
};

// ── The calendar ────────────────────────────────────────────
//
// `angle` is the post's actual content. Keep it true, keep it specific, and
// keep it free of anything that reads as advice to one person. Edit these
// freely — this list is the whole editorial policy.

const HOLIDAYS = [
  {
    key: "new_year", name: "New Year's Day", tone: "warm",
    date: y => iso(y, 1, 1),
    angle: "A new year, and for a lot of families a new filing year. Warm, "
      + "brief, no legal content. A quiet note that the office is closed.",
  },
  {
    key: "lunar_new_year", name: "Lunar New Year / 春节", tone: "celebratory",
    lunar: "lunar_new_year", channels: ["facebook", "instagram", "wechat_moments", "gbp"],
    angle: "The biggest holiday of the year for much of the firm's community. "
      + "Warm wishes, red envelopes, family reunion. Name the animal of the "
      + "year only if certain of it. No legal content at all — this one is "
      + "purely a greeting to neighbours.",
  },
  {
    key: "mlk", name: "Martin Luther King Jr. Day", tone: "reflective",
    date: y => nthWeekday(y, 1, 1, 3),
    angle: "A day about civil rights law actually changing what people's lives "
      + "were allowed to look like. Reflective, not celebratory. No firm "
      + "promotion of any kind.",
  },
  {
    key: "presidents", name: "Presidents' Day", tone: "warm",
    date: y => nthWeekday(y, 2, 1, 3),
    angle: "Federal holiday: USCIS offices and immigration courts are closed, "
      + "and a filing deadline that lands on a federal holiday rolls to the "
      + "next business day. That roll-forward rule is the genuinely useful "
      + "thing most people do not know.",
  },
  {
    key: "qingming", name: "Qingming / 清明节", tone: "solemn",
    lunar: "qingming", channels: ["wechat_moments", "facebook"],
    angle: "Tomb-sweeping day — families remember those who came before. "
      + "Quiet and respectful. No legal content, no firm promotion, and "
      + "nothing celebratory in the wording.",
  },
  {
    key: "mothers_day", name: "Mother's Day", tone: "warm",
    date: y => nthWeekday(y, 5, 0, 2),
    angle: "Warm and human. If it touches the firm's work at all, it is that "
      + "a great many immigration cases are, underneath, somebody trying to "
      + "get their mother to the same country as them. Keep it light.",
  },
  {
    key: "memorial", name: "Memorial Day", tone: "solemn",
    date: y => nthWeekday(y, 5, 1, -1),
    angle: "A day for those who died in service, not a day of celebration and "
      + "not a sale. One or two sentences of respect. Never the words 'happy' "
      + "or 'celebrate'. Worth knowing: non-citizens have served in the US "
      + "military in every American war.",
  },
  {
    key: "duanwu", name: "Dragon Boat Festival / 端午节", tone: "celebratory",
    lunar: "duanwu", channels: ["wechat_moments", "facebook", "instagram"],
    angle: "Zongzi, dragon boat races, the start of summer. Purely a warm "
      + "greeting. No legal content.",
  },
  {
    key: "juneteenth", name: "Juneteenth", tone: "reflective",
    date: y => iso(y, 6, 19),
    angle: "Marks the day the news of emancipation finally reached Galveston "
      + "in 1865 — two and a half years after the proclamation. The gap "
      + "between a law existing and a law reaching people is the whole point "
      + "of the day. Reflective. A federal holiday, so offices are closed.",
  },
  {
    key: "fathers_day", name: "Father's Day", tone: "warm",
    date: y => nthWeekday(y, 6, 0, 3),
    angle: "Warm and human, same register as Mother's Day. Keep it light and "
      + "short.",
  },
  {
    key: "independence", name: "Independence Day", tone: "celebratory",
    date: y => iso(y, 7, 4),
    angle: "USCIS holds naturalization ceremonies across the country around "
      + "the Fourth every year, including at some unusual venues. New "
      + "citizens taking the oath on Independence Day is the warmest true "
      + "thing about this holiday for an immigration firm. Do not state a "
      + "number of new citizens unless certain of it.",
  },
  {
    key: "labor_day", name: "Labor Day", tone: "warm",
    date: y => nthWeekday(y, 9, 1, 1),
    angle: "A day about the people who built the eight-hour day and the "
      + "weekend. Federal holiday, so offices are closed and deadlines roll "
      + "to the next business day.",
  },
  {
    key: "constitution_day", name: "Constitution Day and Citizenship Day", tone: "reflective",
    date: y => iso(y, 9, 17),
    angle: "September 17 commemorates the signing of the Constitution in 1787 "
      + "AND, by the same statute, the people who became citizens that year. "
      + "The two halves sharing one day is the point, and almost nobody knows "
      + "the second half exists. The most on-topic holiday in the firm's year.",
  },
  {
    key: "mid_autumn", name: "Mid-Autumn Festival / 中秋节", tone: "celebratory",
    lunar: "mid_autumn", channels: ["wechat_moments", "facebook", "instagram"],
    angle: "Mooncakes, the full moon, and family who are far away looking at "
      + "the same one. That last part lands hard with immigrant families and "
      + "needs no legal content whatsoever.",
  },
  {
    key: "indigenous", name: "Indigenous Peoples' Day / Columbus Day", tone: "reflective",
    date: y => nthWeekday(y, 10, 1, 2),
    angle: "A federal holiday that a growing number of states and cities now "
      + "observe under a different name. Keep it brief and factual. Offices "
      + "are closed; deadlines roll forward.",
  },
  {
    key: "halloween", name: "Halloween", tone: "celebratory",
    date: y => iso(y, 10, 31),
    channels: ["facebook", "instagram"],
    angle: "Light and fun. A small joke is welcome here — this is the one day "
      + "of the year a law firm is allowed to be silly. No legal content.",
  },
  {
    key: "veterans", name: "Veterans Day", tone: "solemn",
    date: y => iso(y, 11, 11),
    angle: "Honours all who served, living and dead — distinct from Memorial "
      + "Day, and the distinction is worth making because people mix them up. "
      + "Respectful, not celebratory.",
  },
  {
    key: "thanksgiving", name: "Thanksgiving", tone: "warm",
    date: y => nthWeekday(y, 11, 4, 4),
    angle: "Genuine thanks to clients and the community, in plain words. No "
      + "promotion, no offer, nothing about services. The office is closed "
      + "Thursday and Friday.",
  },
  {
    key: "valentines", name: "Valentine's Day", tone: "celebratory",
    date: y => iso(y, 2, 14),
    channels: ["facebook", "instagram"],
    angle: "Light and warm. If it touches the firm's work at all, it is that "
      + "a marriage-based petition is the one immigration filing where the "
      + "government asks for your love story in writing. Keep it charming, "
      + "not clinical, and give no advice.",
  },
  {
    key: "st_patricks", name: "St. Patrick's Day", tone: "celebratory",
    date: y => iso(y, 3, 17),
    channels: ["facebook", "instagram"],
    angle: "Light. The Irish were once the immigrant group America was most "
      + "anxious about, and now the whole country wears green for them. That "
      + "turn is the warm, true thing worth saying. No legal content.",
  },
  {
    key: "tax_day", name: "Tax Day", tone: "warm",
    date: y => iso(y, 4, 15),
    angle: "The federal filing deadline. The genuinely useful point for this "
      + "firm's readers: filing taxes is how a person builds the record of a "
      + "life lived in the United States, which matters far beyond the IRS. "
      + "Do not give filing advice or state any threshold or amount.",
  },
  {
    key: "easter", name: "Easter", tone: "warm",
    computed: "easter",
    channels: ["facebook", "instagram"],
    angle: "Warm seasonal wishes, inclusive of people who do not celebrate it. "
      + "Short. No legal content.",
  },
  {
    key: "cinco_de_mayo", name: "Cinco de Mayo", tone: "celebratory",
    date: y => iso(y, 5, 5),
    channels: ["facebook", "instagram", "gbp"],
    angle: "The thing almost everyone gets wrong: this is NOT Mexican "
      + "Independence Day, which is September 16. May 5 marks the Battle of "
      + "Puebla in 1862, and it is celebrated more widely in the United "
      + "States than in most of Mexico. Perfect material — a real "
      + "misconception, cheerfully corrected. No legal content.",
  },
  {
    key: "flag_day", name: "Flag Day", tone: "warm",
    date: y => iso(y, 6, 14),
    channels: ["facebook", "gbp"],
    angle: "Marks the 1777 adoption of the flag. Brief and plain. Many "
      + "naturalization ceremonies are held around it.",
  },
  {
    key: "patriot_day", name: "Patriot Day (September 11)", tone: "solemn",
    date: y => iso(y, 9, 11),
    angle: "Remembrance. One or two restrained sentences, nothing more. No "
      + "firm promotion of any kind, no emoji, and nothing that reads as "
      + "content marketing. If there is any doubt about the wording, post "
      + "nothing at all.",
  },
  {
    key: "mexican_independence", name: "Mexican Independence Day", tone: "celebratory",
    date: y => iso(y, 9, 16),
    channels: ["facebook", "instagram", "gbp"],
    angle: "The actual Mexican Independence Day — the one Cinco de Mayo is "
      + "mistaken for. El Grito is the night before. Warm and celebratory, "
      + "and meaningful to a large part of West Covina. No legal content.",
  },
  {
    key: "dia_de_muertos", name: "Día de los Muertos", tone: "reflective",
    date: y => iso(y, 11, 2),
    channels: ["facebook", "instagram", "gbp"],
    angle: "Not a Mexican Halloween, and saying so gently is the useful part. "
      + "A holiday about remembering people by name and keeping them "
      + "present — ofrendas, marigolds, favourite foods. Warm rather than "
      + "spooky. No legal content.",
  },
  {
    key: "small_business_saturday", name: "Small Business Saturday", tone: "warm",
    date: y => {
      const t = nthWeekday(y, 11, 4, 4);          // Thanksgiving
      return daysBefore(t, -2);                    // the Saturday after
    },
    channels: ["facebook", "instagram", "linkedin", "gbp"],
    angle: "The Saturday after Thanksgiving. Relevant because a good share of "
      + "this firm's business clients ARE the small businesses of the San "
      + "Gabriel Valley. Encourage shopping local. No pitch for the firm.",
  },
  {
    key: "new_years_eve", name: "New Year's Eve", tone: "warm",
    date: y => iso(y, 12, 31),
    channels: ["facebook", "instagram", "wechat_moments"],
    angle: "A short, warm sign-off to the year. Thanks rather than "
      + "resolutions. No legal content, no looking-ahead-to-your-goals "
      + "cliché.",
  },
  {
    key: "christmas", name: "Christmas", tone: "warm",
    date: y => iso(y, 12, 25),
    angle: "Warm seasonal wishes, inclusive of people who do not celebrate it. "
      + "Office closure. No legal content.",
  },
];

// ── What is coming up ───────────────────────────────────────

/**
 * Holidays falling in the next `days` days.
 * `warnings` names any lunar festival skipped because its year is not in the
 * verified table — silence there would mean a festival quietly never posted.
 */
function upcoming({ from = new Date(), days = 30 } = {}) {
  const start = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));
  const end = new Date(start.getTime() + days * 86400000);
  const out = [], warnings = [];
  const years = [...new Set([start.getUTCFullYear(), end.getUTCFullYear()])];

  for (const h of HOLIDAYS) {
    for (const y of years) {
      let d = null;
      if (h.lunar) {
        const table = LUNAR[y];
        if (!table || !table[h.lunar]) {
          const w = `${h.name} ${y}: no verified date — add it to LUNAR in holiday-posts.js`;
          if (!warnings.includes(w)) warnings.push(w);
          continue;
        }
        d = table[h.lunar];
      } else if (h.computed === "easter") {
        d = easter(y);
      } else if (h.computed === "good_friday") {
        d = daysBefore(easter(y), 2);
      } else {
        d = h.date(y);
      }
      const when = new Date(d + "T00:00:00Z");
      if (when >= start && when < end) out.push({ ...h, date: d, year: y });
    }
  }
  out.sort((a, b) => a.date.localeCompare(b.date));
  return { holidays: out, warnings };
}

// ── The prompt ──────────────────────────────────────────────

const TONE = {
  celebratory: "Warm and genuinely happy. A little fun is welcome.",
  warm: "Warm and human. Understated rather than cheery.",
  reflective: "Thoughtful. Say something true rather than something nice.",
  solemn: "Respectful and restrained. Never the words 'happy' or 'celebrate', "
    + "no exclamation marks, no emoji, and nothing that reads as marketing.",
};

// `ch` (the channel spec) is injectable — see the note in fun-facts.js.
function buildHolidayPrompt(holiday, channel, ch = null) {
  ch = ch || require("./social-posts").CHANNELS[channel];
  return [
    `Write one ${ch.name} post for ${process.env.FIRM_NAME || "Tez Law P.C."}, `
      + `a law firm in West Covina, California, for ${holiday.name} `
      + `(${holiday.date}).`,
    "",
    TONE[holiday.tone] || TONE.warm,
    "",
    ch.voice,
    "",
    "WHAT THE POST IS ABOUT — use this and nothing else as its substance:",
    holiday.angle,
    "",
    "You may choose the words. You may NOT add facts, dates, statistics, "
      + "numbers of people, legal rules or deadlines that are not in the note "
      + "above. If the note says the post carries no legal content, then it "
      + "carries none.",
    "",
    "DO NOT WRITE, in any wording:",
    "  · \"On behalf of everyone at TEZ Law Firm...\"",
    "  · \"we would like to wish\" or \"we hope you enjoy\"",
    "  · anything about the firm's services, or any invitation to get in touch",
    "  · a holiday cliché (\"time to reflect on what matters most\")",
    "A holiday post from a law firm is usually filler. This one should be "
      + "worth the space it takes: say one real thing.",
    "",
    `Hard limit: ${ch.max} characters.`,
    "",
    "Brand: the firm's public name is \"TEZ Law Firm\" (legal name Tez Law P.C.; "
      + "in Chinese posts: TEZ Law Firm 律师事务所).",
    "",
    "Never: guarantee or predict an outcome; call the firm the best or a "
      + "leader; manufacture urgency; tell the reader what to file.",
    "",
    "Do not include any link or phone number.",
    "",
    "Reply with the post text only. No preamble, no quotation marks.",
  ].join("\n");
}

module.exports = { HOLIDAYS, LUNAR, TONE, nthWeekday, easter, daysBefore, upcoming, buildHolidayPrompt };
