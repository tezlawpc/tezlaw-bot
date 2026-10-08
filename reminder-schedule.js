// ============================================================
//  reminder-schedule.js — every message an EOIR client gets,
//                         and when
//  ─────────────────────────────────────────────────────────
//  JJ, 2026-10-08, for asylum and other Immigration Court matters.
//
//  Master calendar hearing      30, 7 and 1 day before
//                               1 day AFTER: send us everything
//  Individual / merits hearing  60 days  review it all, tell us about
//                                        revisions, new evidence, witnesses
//                               30 days  filing cutoff, and voluntary
//                                        departure if it is wanted
//                               7, 5, 2 and 1 day before
//
//  THREE RULES THESE MESSAGES FOLLOW
//
//  1. NEVER STATE A TIME THAT WAS NOT ON THE NOTICE. Every date and time
//     goes through hearing-when.js, which quotes hearing_time_text and
//     refuses anything ambiguous. A client told noon for a 9:00 AM hearing
//     misses it; for a detained client that is not a usability problem.
//
//  2. NEVER STATE A DEADLINE THE COURT DID NOT SET. The filing cutoff in
//     an Immigration Court case is set by the IJ's scheduling order, and
//     it is not always 30 days -- 8 C.F.R. § 1003.31(c) leaves it to the
//     judge, and the notice in a given case may say 15, or something
//     else. JJ: "except the notes specifically states a different
//     deadline." So the 30-day message states the FIRM's working cutoff
//     and says the court's own order governs. It never tells a client a
//     date the system worked out for itself.
//
//  3. NEVER EXPLAIN VOLUNTARY DEPARTURE IN A TEXT MESSAGE. VD is an
//     election with real consequences: it has conditions, a bond, a
//     departure deadline, and failing to depart carries penalties and
//     bars. A paragraph in a reminder cannot carry that, and a client who
//     acts on a summarised version has been badly served. The message
//     says the option exists, that whether it fits depends on the case,
//     and to telephone the office. That is an invitation to a
//     conversation with a lawyer, which is what the decision needs.
//
//  TURNING ONE OFF
//  Each stage has `on`. Set it false and that message stops going out;
//  nothing else changes. Four messages in the last week of a merits case
//  is a lot of contact, and whether a client wants that is JJ's call per
//  stage rather than a code change.
// ============================================================

/**
 * The stages, in the order a client meets them.
 *
 * when      days from the hearing; negative means AFTER it
 * applies   "master", "individual", or both
 * key       what the dedup log stores, so a stage that is renamed does not
 *           re-send to everyone who already had it
 */
const STAGES = [
  // ── Master calendar ──────────────────────────────────────
  { key: "master-30",  when: 30, applies: ["master"], on: true, kind: "hearing",
    note: "A month out. Enough warning to arrange time off and travel." },
  { key: "master-7",   when: 7,  applies: ["master"], on: true, kind: "hearing" },
  { key: "master-1",   when: 1,  applies: ["master"], on: true, kind: "hearing", urgent: true },
  { key: "master-after", when: -1, applies: ["master"], on: true, kind: "collect",
    note: "The day after. The master sets the schedule, and the evidence has to start moving." },

  // ── Individual / merits ──────────────────────────────────
  { key: "merits-60", when: 60, applies: ["individual"], on: true, kind: "review",
    note: "Two months: long enough to find a witness or get a document from abroad." },
  { key: "merits-30", when: 30, applies: ["individual"], on: true, kind: "cutoff",
    note: "The filing cutoff, and the voluntary departure conversation." },
  { key: "merits-7",  when: 7,  applies: ["individual"], on: true, kind: "hearing" },
  { key: "merits-5",  when: 5,  applies: ["individual"], on: true, kind: "where",
    note: "Time and place, on their own, with nothing else in the message." },
  { key: "merits-2",  when: 2,  applies: ["individual"], on: true, kind: "hearing", urgent: true },
  { key: "merits-1",  when: 1,  applies: ["individual"], on: true, kind: "hearing", urgent: true },
];

const PHONE = "626-678-8677";

/** The stages that fire at this distance from a hearing of this kind. */
function stagesFor(source, daysOut) {
  return STAGES.filter((s) =>
    s.on && s.when === daysOut && s.applies.includes(source));
}

/** Every distinct day offset the runner has to look at. */
function allOffsets() {
  return [...new Set(STAGES.filter((s) => s.on).map((s) => s.when))].sort((a, b) => b - a);
}

// ── The messages ────────────────────────────────────────────
//
// `when` is already the quoted date and time out of hearing-when.js.

const MESSAGES = {
  en: {
    collect: ({ name }) => `Hi${name ? ` ${name}` : ""}, this is TEZ LAW FIRM.

Your master calendar hearing is done. The judge has set the schedule for your case, and the next step is the evidence.

Please send us everything you have, as soon as you can:
• Any documents about what happened to you
• Police, medical, hospital or court records
• Letters, photographs, news reports, country conditions
• Anything you have been waiting to send us

The sooner we have it, the more we can do with it. Documents take time to translate and to prepare properly, and we would rather have them early than argue about a late filing.

Send them by email to jj@tezlawfirm.com, by WhatsApp or WeChat, or bring them to any office. Call us on ${PHONE} if you are not sure whether something matters. Send it anyway and let us decide.

— TEZ LAW FIRM`,

    review: ({ name, when }) => `Hi${name ? ` ${name}` : ""}, this is TEZ LAW FIRM.

Your individual (merits) hearing is about two months away:

📅 ${when}

This is the time to look at everything with fresh eyes. Please go through the documents and the statement we prepared and check:
• Is every date, name and place correct?
• Is anything missing or out of order?
• Has anything changed since we wrote it?
• Is there evidence you have not sent us yet?
• Is there anyone who could testify for you?

If you want to change anything, add anything, or have someone speak at your hearing, tell us NOW. There is still time to do it properly. In a few weeks there will not be.

Call us on ${PHONE} or reply to this message.

— TEZ LAW FIRM`,

    cutoff: ({ name, when }) => `Hi${name ? ` ${name}` : ""}, this is TEZ LAW FIRM. Please read this one carefully.

Your individual (merits) hearing:

📅 ${when}

NEW DOCUMENTS. We are at the point where the court's filing deadline is close, so this is our cutoff for new evidence. After this, we can only file something late if there is a reason the judge will accept. The deadline in your case is the one in your hearing notice, which can differ from case to case, so if you are holding anything back, send it to us this week.

ONE MORE THING TO BE AWARE OF. There is an option in some cases called voluntary departure. Whether it is available, whether it is a good idea, and what it would cost you depend entirely on your situation, and it carries conditions and consequences we need to explain to you properly. It is not something to decide from a text message. If you want to understand it, or you are already thinking about it, call us on ${PHONE} and we will go through it with you.

Either way, please call us if you have questions.

— TEZ LAW FIRM`,

    where: ({ name, when, court, address, judge }) => `Hi${name ? ` ${name}` : ""}, this is TEZ LAW FIRM.

Your individual (merits) hearing is in five days. Here is where to go:

📅 ${when}
${court ? `📍 ${court}\n` : ""}${address ? `📌 ${address}\n` : ""}${judge ? `⚖️ Judge ${judge}\n` : ""}
Please arrive 30 minutes early and bring your government-issued ID. Allow extra time for parking and for security at the entrance.

If anything stops you attending, call us IMMEDIATELY on ${PHONE}. Missing this hearing can mean an order of removal in your absence.

— TEZ LAW FIRM`,
  },

  zh: {
    collect: ({ name }) => `${name ? `${name}，` : ""}您好，这里是 TEZ LAW FIRM 律师事务所。

您的首次出庭（Master Calendar）已经结束，法官已经为您的案件排定了后续日程。接下来最重要的就是证据。

请尽快将您手上的所有材料发给我们：
• 与您经历有关的任何文件
• 警察、医疗、医院或法院记录
• 信件、照片、新闻报道、国家状况资料
• 任何一直想发给我们但还没发的材料

我们越早拿到，能做的就越多。文件需要时间翻译和整理，我们宁可早点拿到，也不愿日后为逾期提交而争辩。

请发送至 jj@tezlawfirm.com，或通过 WhatsApp、微信发给我们，也可以送到任一办公室。如不确定某份材料是否重要，请致电 ${PHONE}；或者直接发给我们，由我们判断。

— TEZ LAW FIRM`,

    review: ({ name, when }) => `${name ? `${name}，` : ""}您好，这里是 TEZ LAW FIRM 律师事务所。

您的正式庭审（Individual / Merits）大约在两个月后：

📅 ${when}

现在是重新检查全部材料的时候。请仔细阅读我们准备的文件和您的陈述，并确认：
• 所有日期、姓名、地点是否正确？
• 是否有遗漏或次序错误？
• 自撰写以来是否有任何变化？
• 是否还有尚未发给我们的证据？
• 是否有人可以出庭为您作证？

如需修改、补充，或希望安排证人出庭，请立即告知我们。现在还来得及妥善办理，再过几周就不一定了。

请致电 ${PHONE} 或直接回复本消息。

— TEZ LAW FIRM`,

    cutoff: ({ name, when }) => `${name ? `${name}，` : ""}您好，这里是 TEZ LAW FIRM 律师事务所。请仔细阅读本条信息。

您的正式庭审（Individual / Merits）：

📅 ${when}

关于新证据： 法院的提交期限即将届至，因此这是我们接收新证据的截止时间。此后若要补交，必须有法官能够接受的理由。您案件的具体期限以您收到的开庭通知为准，各案可能不同；如您手上还有材料，请在本周内发给我们。

另有一事需要您知悉： 在部分案件中存在一项称为「自愿离境」（voluntary departure）的选择。该选择是否适用、是否可取、以及会带来什么后果，完全取决于您的个人情况，并附有若干条件和法律后果，需要我们当面向您解释清楚。这不是可以凭一条短信决定的事。如您想了解，或已在考虑，请致电 ${PHONE}，我们会与您逐项说明。

无论如何，如有疑问请随时与我们联系。

— TEZ LAW FIRM`,

    where: ({ name, when, court, address, judge }) => `${name ? `${name}，` : ""}您好，这里是 TEZ LAW FIRM 律师事务所。

您的正式庭审将于五天后举行。开庭地点如下：

📅 ${when}
${court ? `📍 ${court}\n` : ""}${address ? `📌 ${address}\n` : ""}${judge ? `⚖️ 法官：${judge}\n` : ""}
请提前 30 分钟到达，并携带政府签发的身份证件。请预留停车和入口安检的时间。

如有任何情况导致您无法出庭，请立即致电 ${PHONE}。未到庭可能导致法官在您缺席的情况下作出递解令。

— TEZ LAW FIRM`,
  },
};

// Spanish support exists for the hearing reminders; these longer messages
// are not written in Spanish yet, so a Spanish-speaking client gets the
// English one rather than a machine translation of a legal deadline.
MESSAGES.es = MESSAGES.en;

/**
 * The message for one stage.
 *
 * `when` must already be the quoted date and time from hearing-when.js:
 * this file never formats one itself.
 */
function messageFor(stage, { lang = "en", name = "", when = "", court = "", address = "", judge = "" } = {}) {
  const L = MESSAGES[["en", "zh", "es"].includes(lang) ? lang : "en"];
  const build = L[stage.kind];
  if (!build) return null;        // "hearing" is the existing templates' job
  return build({ name, when, court, address, judge });
}

module.exports = { STAGES, stagesFor, allOffsets, messageFor, MESSAGES, PHONE };
