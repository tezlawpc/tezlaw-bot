// check-voice-rt.js — Zara on the phone (voice-rt.js), against fakes.
//
// No network and no packages: OpenAI, Telegram, the database and the
// WebSocket are stand-ins that record what they were asked to do. What is
// checked is what JJ asked for on 9 Oct 2026:
//   · 9–5 Pacific, Monday–Friday, a caller is put through to the intake line,
//     with a note in Telegram first;
//   · after hours there is no transfer at all, and a prospective client
//     becomes a lead in Leads & intake;
//   · court clerks' messages go to the court topic;
//   · what she is told to say keeps to the advertising rules;
//   · if OpenAI refuses the call, it goes back to Twilio's backup, and the
//     office hears about it.

const assert = require("assert");
const crypto = require("crypto");
const path = require("path");
const EventEmitter = require("events");
const V = require(path.join(__dirname, "..", "voice-rt.js"));
const I = V._internal;

let passed = 0;
const tests = [];
function check(name, fn) { tests.push([name, fn]); }

// Pacific Daylight Time in October: UTC−7.
const PT = (iso) => new Date(new Date(iso + "-07:00").getTime());
const ENV = { OPENAI_API_KEY: "sk-test", OPENAI_WEBHOOK_SECRET: "whsec_" + Buffer.from("0123456789abcdef0123456789abcdef").toString("base64"),
  RECEPTION_TRANSFER_TO: "(626) 555-0101", RECEPTION_CLOSED_DATES: "2026-11-26" };

// ── Office hours ─────────────────────────────────────────────────────────
check("open Friday 10:00, closed at 5:00 and before 9:00", () => {
  assert.strictEqual(I.officeOpen(PT("2026-10-09T10:00:00"), ENV), true);
  assert.strictEqual(I.officeOpen(PT("2026-10-09T16:59:00"), ENV), true);
  assert.strictEqual(I.officeOpen(PT("2026-10-09T17:00:00"), ENV), false);
  assert.strictEqual(I.officeOpen(PT("2026-10-12T08:59:00"), ENV), false);
});
check("closed on weekends and on RECEPTION_CLOSED_DATES", () => {
  assert.strictEqual(I.officeOpen(PT("2026-10-10T11:00:00"), ENV), false);
  assert.strictEqual(I.officeOpen(PT("2026-11-26T11:00:00"), ENV), false);   // Thanksgiving, listed
  assert.strictEqual(I.officeOpen(PT("2026-11-25T11:00:00"), ENV), true);
});
check("the call-back promise matches the calendar", () => {
  assert.strictEqual(I.nextCallback(PT("2026-10-09T18:00:00"), ENV).en, "on Monday morning");   // Friday evening
  assert.strictEqual(I.nextCallback(PT("2026-10-13T20:00:00"), ENV).en, "tomorrow morning");    // Tuesday night
  assert.strictEqual(I.nextCallback(PT("2026-10-13T07:00:00"), ENV).en, "this morning after 9");
  assert.strictEqual(I.nextCallback(PT("2026-11-25T18:00:00"), ENV).en, "on Friday morning");   // Thanksgiving skipped
  assert.strictEqual(I.nextCallback(PT("2026-10-09T18:00:00"), ENV).zh, "周一上午");
});

// ── Webhook signature ───────────────────────────────────────────────────
function sign(body, id, ts, secret = ENV.OPENAI_WEBHOOK_SECRET) {
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  return "v1," + crypto.createHmac("sha256", key).update(`${id}.${ts}.${body}`).digest("base64");
}
check("a correctly signed webhook is accepted; tampered, stale or unsigned ones are not", () => {
  const body = JSON.stringify({ type: "realtime.call.incoming", data: { call_id: "rtc_1" } });
  const ts = "1791500000";
  const h = { "webhook-id": "wh_1", "webhook-timestamp": ts, "webhook-signature": sign(body, "wh_1", ts) };
  assert.strictEqual(I.verifyWebhook(Buffer.from(body), h, ENV.OPENAI_WEBHOOK_SECRET, 1791500010), true);
  assert.strictEqual(I.verifyWebhook(Buffer.from(body + " "), h, ENV.OPENAI_WEBHOOK_SECRET, 1791500010), false);
  assert.strictEqual(I.verifyWebhook(Buffer.from(body), h, ENV.OPENAI_WEBHOOK_SECRET, 1791500000 + 900), false);
  assert.strictEqual(I.verifyWebhook(Buffer.from(body), { ...h, "webhook-signature": "" }, ENV.OPENAI_WEBHOOK_SECRET, 1791500010), false);
  assert.strictEqual(I.verifyWebhook(Buffer.from(body), h, "whsec_" + Buffer.from("x".repeat(32)).toString("base64"), 1791500010), false);
  // Several signatures (key rotation): any one valid is enough.
  assert.strictEqual(I.verifyWebhook(Buffer.from(body), { ...h, "webhook-signature": "v1,AAAA " + h["webhook-signature"] }, ENV.OPENAI_WEBHOOK_SECRET, 1791500010), true);
});

// ── Who is calling ──────────────────────────────────────────────────────
check("caller and line are read from the SIP headers", () => {
  const s = I.parseSip([{ name: "From", value: '"WANG LI" <sip:+16265559876@pstn.twilio.com>;tag=1' }, { name: "To", value: "<sip:+16269000688@sip.api.openai.com>" }]);
  assert.deepStrictEqual(s, { from: "+16265559876", to: "+16269000688", name: "WANG LI" });
  assert.deepStrictEqual(I.parseSip([]), { from: "", to: "", name: "" });
  assert.strictEqual(I.prettyNumber("+16265559876"), "(626) 555-9876");
  assert.strictEqual(I.normalizeNumber("(626) 555-0101"), "+16265550101");
});

// ── What she is told ────────────────────────────────────────────────────
check("open hours: transfer to staff is offered; closed: no transfer tool and an explicit no", () => {
  const open = I.buildInstructions({ open: true, zhFirst: false, now: PT("2026-10-09T10:00:00"), env: ENV });
  const shut = I.buildInstructions({ open: false, zhFirst: false, now: PT("2026-10-09T19:00:00"), env: ENV });
  assert(/THE OFFICE IS OPEN NOW/.test(open) && /transfer_to_staff/.test(open));
  assert(/There are NO transfers after hours/.test(shut) && /log_lead/.test(shut));
  assert(/on Monday morning/.test(shut));
  assert(I.toolDefs(true).some(t => t.name === "transfer_to_staff"));
  assert(!I.toolDefs(false).some(t => t.name === "transfer_to_staff"));
  for (const t of I.toolDefs(false)) assert(t.parameters && t.parameters.type === "object" && Array.isArray(t.parameters.required), t.name);
});
check("the Chinese line greets in Mandarin first; she says she is AI either way", () => {
  const zh = I.buildInstructions({ open: true, zhFirst: true, env: ENV });
  const en = I.buildInstructions({ open: true, zhFirst: false, env: ENV });
  // The greeting itself says AI and not an attorney, not only her instructions.
  assert(I.greeting(true).includes("我是Zara，事务所的AI助理，不是律师") && I.greeting(true).includes("录音并转成文字"));
  assert(/This is Zara, the firm's AI assistant\. I'm not an attorney\. This call may be recorded and transcribed/.test(I.greeting(false)));
  assert(zh.includes(I.greeting(true)) && en.includes(I.greeting(false)));
  for (const s of [zh, en]) {
    assert(/You are the firm's AI assistant\. You are not a lawyer, not a paralegal, not staff and not a person/.test(s));
    assert(/If the caller answers in a different language, before anything else tell them in their language that you are the firm's AI assistant, not an attorney, and that the call may be recorded/.test(s));
  }
});
check("advertising rules: no free consultation, no claims, Spanish help is office staff", () => {
  for (const open of [true, false]) {
    const s = I.buildInstructions({ open, zhFirst: false, env: ENV });
    assert(/Never say a consultation is free/.test(s));
    assert(!/free consultation/i.test(s.replace(/Never say a consultation is free[^\n]*/, "")));
    assert(/Never claim the firm's or the attorney's experience, skill, record, success rate or results/.test(s));
    assert(/Never call anyone an expert or a specialist/.test(s));
    assert(/Spanish help comes from office staff, who are not attorneys/.test(s));
    assert(!/Hablamos español|Puede hablar español/.test(s));
    assert(/never give out information about a case/.test(s));
    assert(/call 911/.test(s));
  }
});

check("the calendar, not 24-hour steps: Saturday night before the March clock change is followed by Monday", () => {
  assert.strictEqual(I.nextCallback(new Date("2026-03-08T07:30:00Z"), ENV).en, "on Monday morning");   // Sat 7 Mar 23:30 PST
  assert.strictEqual(I.nextCallback(PT("2026-10-09T16:30:00"), ENV).en, "on Monday morning");          // Friday, last half hour
  assert.strictEqual(I.nextCallback(PT("2026-10-08T16:30:00"), ENV).en, "tomorrow morning");           // Thursday, last half hour
  assert.strictEqual(I.nextCallback(PT("2026-10-08T15:30:00"), ENV).en, "later today");
});
check("time to close is counted to 5:00 Pacific, and only while open", () => {
  assert.strictEqual(I.msUntilClose(PT("2026-10-09T16:30:00"), ENV), 30 * 60000);
  assert.strictEqual(I.msUntilClose(PT("2026-10-09T17:30:00"), ENV), null);
});
check("general questions are passed without the caller's own facts; the firm's fees are not looked up", () => {
  const s = I.buildInstructions({ open: false, zhFirst: false, env: ENV });
  assert(/WITHOUT the caller's own facts/.test(s) && /Never use it for the firm's own fees/.test(s));
  const t = I.toolDefs(false).find(x => x.name === "answer_question");
  assert(/Not for the firm's own fees and not for the caller's own case/.test(t.description));
  assert(/personal facts left out/.test(t.parameters.properties.question.description));
});
check("mid-call at 5:00: no second greeting", () => {
  const s = I.buildInstructions({ open: false, zhFirst: true, env: ENV, midCall: true });
  assert(!s.includes(I.greeting(true)) && /Do not greet the caller again/.test(s));
});

// ── The accept request ──────────────────────────────────────────────────
check("the accept body carries the model, voice, instructions and tools", () => {
  const b = I.acceptBody({ model: "gpt-realtime-2", voice: "marin", instructions: "x", tools: [{ name: "t" }] });
  assert.strictEqual(b.type, "realtime");
  assert.strictEqual(b.model, "gpt-realtime-2");
  assert.strictEqual(b.audio.output.voice, "marin");
  assert.strictEqual(b.audio.input.transcription.model, "gpt-4o-mini-transcribe");
  assert(!I.acceptBody({ model: "m", voice: "v", instructions: "x", tools: [], minimal: true }).audio.input);
});

// ── A whole call, with fakes ────────────────────────────────────────────
class FakeWS extends EventEmitter {
  constructor(url, opts) { super(); this.url = url; this.opts = opts; this.sent = []; this.readyState = 0; FakeWS.all.push(this);
    setImmediate(() => { if (FakeWS.fail) { this.emit("error", new Error("refused")); this.emit("close"); } else { this.readyState = 1; this.emit("open"); } }); }
  send(s) { this.sent.push(JSON.parse(s)); }
  close() { this.readyState = 3; this.emit("close"); }
}
FakeWS.all = []; FakeWS.fail = false;

function fakes({ open = true, acceptFails = 0, acceptStatus = 400, referFails = false } = {}) {
  const posts = [], tg = [], db = [];
  let acceptN = 0;
  const http = { post: async (url, body, opts) => {
    posts.push({ url, body, auth: opts && opts.headers && opts.headers.Authorization });
    if (/\/accept$/.test(url) && acceptN++ < acceptFails) { const e = new Error("bad"); e.response = { status: acceptStatus, data: { error: "x" } }; throw e; }
    if (/\/refer$/.test(url) && referFails) throw new Error("refer refused");
    return { data: {} };
  } };
  const deps = {
    env: ENV, cfg: I.cfg(ENV), http, WebSocket: FakeWS,
    tg: { send: async (topic, text) => { tg.push({ topic, text }); }, courtTopic: (h) => /superior/i.test(h.court || "") ? "state" : "court" },
    db: { query: async (sql, params) => { db.push({ sql, params }); return { rows: [] }; } },
    transcribe: async (url) => `TRANSCRIPT of ${url}`,
    askClaude: async (q, lang) => `ANSWER(${lang}): ${q}`,
    compose: async (extra) => `CHARTER\n\n${extra}`,
    wait: async () => {}, log: { warn() {}, log() {} },
    now: () => open ? PT("2026-10-09T10:00:00") : PT("2026-10-09T19:00:00"),
  };
  return { deps, posts, tg, db };
}
const incoming = (id, to = "+16269000688") => ({ type: "realtime.call.incoming", data: { call_id: id,
  sip_headers: [{ name: "From", value: "<sip:+16265559876@x>" }, { name: "To", value: `<sip:${to}@sip.api.openai.com>` }] } });
const said = (text) => ({ type: "message", content: [{ type: "output_audio", transcript: text }] });
const fnCall = (name, args, call_id = "c1", spoken = "One moment, I'm connecting you now.") => ({ type: "response.done", response: { output: [
  ...(spoken ? [said(spoken)] : []), { type: "function_call", name, arguments: JSON.stringify(args), call_id }] } });
const lastWS = () => FakeWS.all[FakeWS.all.length - 1];

check("an incoming call is accepted, the control line opened, and she speaks first", async () => {
  const f = fakes();
  const r = await V.handleIncoming(incoming("rtc_a"), f.deps);
  assert.strictEqual(r.ok, true);
  const acc = f.posts.find(p => /\/calls\/rtc_a\/accept$/.test(p.url));
  assert(acc && acc.auth === "Bearer sk-test");
  assert(acc.body.instructions.includes("我是Zara"), "the Chinese line greets in Mandarin");
  assert(acc.body.tools.some(t => t.name === "transfer_to_staff"));
  const ws = lastWS();
  assert(/realtime\?call_id=rtc_a$/.test(ws.url) && ws.opts.headers.Authorization === "Bearer sk-test");
  assert.deepStrictEqual(ws.sent[0], { type: "response.create" });
  I.ACTIVE.get("rtc_a").ended = true; I.ACTIVE.delete("rtc_a");
});

check("her charter comes first and the line's rules last; if the charter cannot be read, the call still goes ahead", async () => {
  const f = fakes();
  await V.handleIncoming(incoming("rtc_ch"), f.deps);
  const acc = f.posts.find(p => /rtc_ch\/accept$/.test(p.url));
  assert(/^CHARTER\n\nON THIS LINE/.test(acc.body.instructions));
  I.ACTIVE.get("rtc_ch").ended = true; I.ACTIVE.delete("rtc_ch");
  const g = fakes();
  g.deps.compose = async () => { throw new Error("db down"); };
  const r = await V.handleIncoming(incoming("rtc_ch2"), g.deps);
  assert.strictEqual(r.ok, true);
  assert(/^ON THIS LINE/.test(g.posts.find(p => /rtc_ch2\/accept$/.test(p.url)).body.instructions));
  I.ACTIVE.get("rtc_ch2").ended = true; I.ACTIVE.delete("rtc_ch2");
});

check("office hours: a transfer posts the note to Telegram first, then refers the call to the intake line", async () => {
  const f = fakes();
  await V.handleIncoming(incoming("rtc_b"), f.deps);
  const call = I.ACTIVE.get("rtc_b");
  await call.onEvent(fnCall("transfer_to_staff", { name: "Wang Li", role: "prospective_client", summary: "Rear-ended on the 10 yesterday, neck pain", language: "zh" }));
  const note = f.tg.find(m => /TRANSFERRING NOW/.test(m.text));
  assert(note && note.topic === "leads" && /Wang Li/.test(note.text) && /\(626\) 555-0101/.test(note.text));
  const refer = f.posts.find(p => /\/refer$/.test(p.url));
  assert(refer && refer.body.target_uri === "tel:+16265550101");
  assert(f.tg.indexOf(note) >= 0 && f.posts.indexOf(refer) > 0);
  assert(!lastWS().sent.some(e => e.type === "conversation.item.create"), "no tool reply after the call has left");
  call.ended = true; I.ACTIVE.delete("rtc_b");
});

check("after hours: no transfer tool, and a transfer request is refused without calling anyone", async () => {
  const f = fakes({ open: false });
  await V.handleIncoming(incoming("rtc_c"), f.deps);
  const acc = f.posts.find(p => /accept$/.test(p.url));
  assert(!acc.body.tools.some(t => t.name === "transfer_to_staff"));
  const call = I.ACTIVE.get("rtc_c");
  await call.onEvent(fnCall("transfer_to_staff", { name: "X", role: "client", summary: "s", language: "en" }));
  assert(!f.posts.some(p => /\/refer$/.test(p.url)));
  const out = lastWS().sent.find(e => e.type === "conversation.item.create");
  assert(/after_hours/.test(out.item.output));
  call.ended = true; I.ACTIVE.delete("rtc_c");
});

check("a call accepted in office hours does not transfer once it runs past 5:00", async () => {
  const f = fakes();
  await V.handleIncoming(incoming("rtc_c2"), f.deps);
  const call = I.ACTIVE.get("rtc_c2");
  f.deps.now = () => PT("2026-10-09T17:01:00");
  await call.onEvent(fnCall("transfer_to_staff", { name: "X", role: "client", summary: "s", language: "en" }));
  assert(!f.posts.some(p => /\/refer$/.test(p.url)));
  assert(/after_hours/.test(lastWS().sent.find(e => e.type === "conversation.item.create").item.output));
  call.ended = true; I.ACTIVE.delete("rtc_c2");
});

check("after hours: a prospective client becomes one lead in Leads & intake, with a call-back time", async () => {
  const f = fakes({ open: false });
  await V.handleIncoming(incoming("rtc_d", "+16266788677"), f.deps);
  const call = I.ACTIVE.get("rtc_d");
  const args = { name: "Maria Lopez", phone: "6265551212", language: "es", matter: "personal_injury", summary: "Hit by a truck in Pomona today", details: "ER visit, police report taken, other driver's insurer State Farm", urgent: true };
  await call.onEvent(fnCall("log_lead", args, "c1"));
  await call.onEvent(fnCall("log_lead", args, "c2"));
  const leads = f.tg.filter(m => /NEW LEAD/.test(m.text));
  assert.strictEqual(leads.length, 1, "logged once");
  assert(leads[0].topic === "leads" && /URGENT/.test(leads[0].text) && /Personal injury/.test(leads[0].text) && /\(626\) 555-1212/.test(leads[0].text) && /after hours/.test(leads[0].text));
  const out = JSON.parse(lastWS().sent.find(e => e.type === "conversation.item.create").item.output);
  assert.strictEqual(out.staff_will_call, "el lunes por la mañana");
  const acc = f.posts.find(p => /accept$/.test(p.url));
  assert(acc.body.instructions.includes("Thank you for calling TEZ Law Firm"), "the main line greets in English");
  call.ended = true; I.ACTIVE.delete("rtc_d");
});

check("a court clerk's message goes to that court's topic, word for word", async () => {
  const f = fakes({ open: false });
  await V.handleIncoming(incoming("rtc_e"), f.deps);
  const call = I.ACTIVE.get("rtc_e");
  await call.onEvent(fnCall("take_message", { name: "Ms. Garcia", role: "court_clerk", calling_from: "LA Superior Court, Dept 12", case_ref: "25NNCV09262", message: "The hearing on Oct 20 at 8:30 a.m. is continued to Nov 3, same time, Dept 12.", phone: "2135550000", language: "en", urgent: true }));
  const m = f.tg.find(x => /MESSAGE/.test(x.text));
  assert(m.topic === "state" && /Court clerk/.test(m.text) && /Nov 3, same time, Dept 12/.test(m.text) && /25NNCV09262/.test(m.text));
  call.ended = true; I.ACTIVE.delete("rtc_e");
});

check("a general question is answered by Claude, in the caller's language", async () => {
  const f = fakes({ open: false });
  await V.handleIncoming(incoming("rtc_f"), f.deps);
  const call = I.ACTIVE.get("rtc_f");
  await call.onEvent(fnCall("answer_question", { question: "How long do I have to file a claim against a city?", language: "zh" }));
  const sent = lastWS().sent;
  const out = JSON.parse(sent.find(e => e.type === "conversation.item.create").item.output);
  assert(/^ANSWER\(zh\)/.test(out.answer));
  assert.deepStrictEqual(sent[sent.length - 1], { type: "response.create" });
  call.ended = true; I.ACTIVE.delete("rtc_f");
});

check("with a termination domain set, the transfer is addressed through it", async () => {
  const f = fakes();
  f.deps.cfg = { ...f.deps.cfg, referDomain: "tez-zara.pstn.twilio.com" };
  await V.handleIncoming(incoming("rtc_rd"), f.deps);
  const call = I.ACTIVE.get("rtc_rd");
  await call.onEvent(fnCall("transfer_to_staff", { name: "A", role: "client", summary: "s", language: "en" }));
  assert.strictEqual(f.posts.find(p => /\/refer$/.test(p.url)).body.target_uri, "sip:+16265550101@tez-zara.pstn.twilio.com");
  call.ended = true; I.ACTIVE.delete("rtc_rd");
});

check("she must say she is connecting them before the line rings", async () => {
  const f = fakes();
  await V.handleIncoming(incoming("rtc_q"), f.deps);
  const call = I.ACTIVE.get("rtc_q");
  await call.onEvent(fnCall("transfer_to_staff", { name: "A", role: "client", summary: "s", language: "en" }, "c1", ""));
  assert(!f.posts.some(p => /\/refer$/.test(p.url)));
  assert(/announce_first/.test(lastWS().sent.find(e => e.type === "conversation.item.create").item.output));
  call.ended = true; I.ACTIVE.delete("rtc_q");
});

check("an announcement in her previous turn counts, and a second request goes through regardless", async () => {
  const f = fakes();
  await V.handleIncoming(incoming("rtc_an"), f.deps);
  const call = I.ACTIVE.get("rtc_an");
  await call.onEvent({ type: "response.done", response: { output: [said("请稍等，我现在为您转接。")] } });
  await call.onEvent(fnCall("transfer_to_staff", { name: "A", role: "client", summary: "s", language: "zh" }, "c1", ""));
  assert(f.posts.some(p => /rtc_an\/refer$/.test(p.url)));
  call.ended = true; I.ACTIVE.delete("rtc_an");
  const g = fakes();
  await V.handleIncoming(incoming("rtc_an2"), g.deps);
  const c2 = I.ACTIVE.get("rtc_an2");
  await c2.onEvent(fnCall("transfer_to_staff", { name: "A", role: "client", summary: "s", language: "en" }, "c1", ""));
  await c2.onEvent(fnCall("transfer_to_staff", { name: "A", role: "client", summary: "s", language: "en" }, "c2", ""));
  assert.strictEqual(g.posts.filter(p => /rtc_an2\/refer$/.test(p.url)).length, 1, "asked once, then put through");
  c2.ended = true; I.ACTIVE.delete("rtc_an2");
});

check("a server that has lost a call to another one lets go of it", async () => {
  const f = fakes();
  await V.handleIncoming(incoming("rtc_rel"), f.deps);
  const call = I.ACTIVE.get("rtc_rel");
  call.release();
  assert(call.ended && !I.ACTIVE.has("rtc_rel"));
  assert(!f.tg.some(m => /without a message/.test(m.text)), "no end-of-call notice: the other server has it");
  const save = f.db.find(q => /INSERT INTO voice_rt_calls/.test(q.sql));
  assert(/CASE WHEN voice_rt_calls\.owner = EXCLUDED\.owner THEN NOW\(\)/.test(save.sql), "a save never takes a call back from its new owner");
});

check("one transfer only, and several tools in one turn get one response", async () => {
  const f = fakes();
  await V.handleIncoming(incoming("rtc_r"), f.deps);
  const call = I.ACTIVE.get("rtc_r");
  const a = { name: "A", role: "client", summary: "s", language: "en" };
  await call.onEvent({ type: "response.done", response: { output: [said("Connecting you now."),
    { type: "function_call", name: "transfer_to_staff", arguments: JSON.stringify(a), call_id: "t1" },
    { type: "function_call", name: "transfer_to_staff", arguments: JSON.stringify(a), call_id: "t2" }] } });
  assert.strictEqual(f.posts.filter(p => /\/refer$/.test(p.url)).length, 1);
  call.ended = true; I.ACTIVE.delete("rtc_r");

  const g = fakes({ open: false });
  await V.handleIncoming(incoming("rtc_s"), g.deps);
  const c2 = I.ACTIVE.get("rtc_s");
  const ws = lastWS(); ws.sent.length = 0;
  await c2.onEvent({ type: "response.done", response: { output: [
    { type: "function_call", name: "answer_question", arguments: JSON.stringify({ question: "q", language: "en" }), call_id: "a1" },
    { type: "function_call", name: "take_message", arguments: JSON.stringify({ name: "B", role: "client", message: "m", phone: "6265550000", language: "en", urgent: false }), call_id: "a2" }] } });
  assert.strictEqual(ws.sent.filter(e => e.type === "conversation.item.create").length, 2);
  assert.strictEqual(ws.sent.filter(e => e.type === "response.create").length, 1);
  c2.ended = true; I.ACTIVE.delete("rtc_s");
});

check("a slow Telegram does not hold the transfer", async () => {
  const f = fakes();
  f.deps.tg.send = () => new Promise(() => {});             // never answers
  await V.handleIncoming(incoming("rtc_t"), f.deps);
  const call = I.ACTIVE.get("rtc_t");
  await call.onEvent(fnCall("transfer_to_staff", { name: "A", role: "client", summary: "s", language: "en" }));
  assert(f.posts.some(p => /\/refer$/.test(p.url)));
  call.ended = true; I.ACTIVE.delete("rtc_t");
});

check("at 5:00 a call in progress loses the transfer tool and is told the office has closed", async () => {
  const f = fakes();
  await V.handleIncoming(incoming("rtc_u"), f.deps);
  const call = I.ACTIVE.get("rtc_u");
  f.deps.now = () => PT("2026-10-09T17:00:00");
  await call.closeOffice();
  const up = lastWS().sent.find(e => e.type === "session.update");
  assert(up && !up.session.tools.some(t => t.name === "transfer_to_staff") && /office has just closed/.test(up.session.instructions));
  for (const t of call.timers) clearTimeout(t);
  call.ended = true; I.ACTIVE.delete("rtc_u");
});

check("a failed transfer is reported and she takes a message instead", async () => {
  const f = fakes({ referFails: true });
  await V.handleIncoming(incoming("rtc_g"), f.deps);
  const call = I.ACTIVE.get("rtc_g");
  await call.onEvent(fnCall("transfer_to_staff", { name: "A", role: "attorney", summary: "Opposing counsel re: meet and confer", language: "en" }));
  assert(f.tg.some(m => /did not go through/.test(m.text)));
  assert(/transfer_failed/.test(lastWS().sent.find(e => e.type === "conversation.item.create").item.output));
  call.ended = true; I.ACTIVE.delete("rtc_g");
});

check("no transfer line configured: no refer, she is told to take a message", async () => {
  const f = fakes();
  f.deps.cfg = { ...f.deps.cfg, transferTo: "" };
  await V.handleIncoming(incoming("rtc_h"), f.deps);
  const call = I.ACTIVE.get("rtc_h");
  await call.onEvent(fnCall("transfer_to_staff", { name: "A", role: "client", summary: "s", language: "en" }));
  assert(!f.posts.some(p => /\/refer$/.test(p.url)));
  assert(/no_line/.test(lastWS().sent.find(e => e.type === "conversation.item.create").item.output));
  call.ended = true; I.ACTIVE.delete("rtc_h");
});

check("a refused accept is retried simpler, then with the fallback model", async () => {
  const f = fakes({ acceptFails: 2 });
  const r = await V.handleIncoming(incoming("rtc_i"), f.deps);
  assert.strictEqual(r.ok, true);
  const accepts = f.posts.filter(p => /accept$/.test(p.url));
  assert.strictEqual(accepts.length, 3);
  assert(accepts[0].body.audio.input && !accepts[1].body.audio.input);
  assert.strictEqual(accepts[2].body.model, "gpt-realtime");
  I.ACTIVE.get("rtc_i").ended = true; I.ACTIVE.delete("rtc_i");
});

check("if OpenAI will not take the call, it is rejected back to Twilio's backup and the office is told", async () => {
  const f = fakes({ acceptFails: 9 });
  const r = await V.handleIncoming(incoming("rtc_j"), f.deps);
  assert.strictEqual(r.ok, false);
  assert(f.posts.some(p => /\/rtc_j\/reject$/.test(p.url)));
  assert(f.tg.some(m => m.topic === "ops" && /backup line/.test(m.text)));
  assert(!I.ACTIVE.has("rtc_j"));
});

check("a server error on accept is not retried three times (the caller is waiting)", async () => {
  const f = fakes({ acceptFails: 9, acceptStatus: 500 });
  await V.handleIncoming(incoming("rtc_k"), f.deps);
  assert.strictEqual(f.posts.filter(p => /accept$/.test(p.url)).length, 1);
});

check("an accept that times out: if the call turns out to be answered, she carries on; if not, it goes to the backup", async () => {
  const mk = (wsFails) => {
    const f = fakes();
    f.deps.http.post = async (url, body) => { f.posts.push({ url, body }); if (/accept$/.test(url)) throw new Error("timeout of 6000ms exceeded"); return { data: {} }; };
    if (wsFails) f.deps.WebSocket = class extends FakeWS { emit(ev, ...a) { if (ev === "open") { super.emit("error", new Error("no")); return super.emit("close"); } return super.emit(ev, ...a); } };
    return f;
  };
  const a = mk(false);
  assert.strictEqual((await V.handleIncoming(incoming("rtc_v1"), a.deps)).ok, true);
  assert.strictEqual(a.posts.filter(p => /accept$/.test(p.url)).length, 1, "a timeout is not retried");
  assert(!a.posts.some(p => /reject$/.test(p.url)));
  I.ACTIVE.get("rtc_v1").ended = true; I.ACTIVE.delete("rtc_v1");
  const b = mk(true);
  assert.strictEqual((await V.handleIncoming(incoming("rtc_v2"), b.deps)).ok, false);
  assert(b.posts.some(p => /rtc_v2\/reject$/.test(p.url)));
});

check("an accept that timed out but went through (it can no longer be refused) is handled as answered", async () => {
  const f = fakes();
  f.deps.http.post = async (url, body) => { f.posts.push({ url, body }); if (/accept$|reject$/.test(url)) throw new Error("timeout"); return { data: {} }; };
  f.deps.WebSocket = class extends FakeWS { emit(ev, ...a) { if (ev === "open") { super.emit("error", new Error("no")); return super.emit("close"); } return super.emit(ev, ...a); } };
  await V.handleIncoming(incoming("rtc_tu"), f.deps);
  assert(f.posts.some(p => /rtc_tu\/refer$/.test(p.url)), "sent to the intake line");
  assert(!f.tg.some(m => /went to the backup line/.test(m.text)));
  assert(f.tg.some(m => /lost her connection/.test(m.text)));
});

check("answered but no line to the server: office hours go to the intake line, after hours to the backup number", async () => {
  const noWS = class extends FakeWS { emit(ev, ...a) { if (ev === "open") { super.emit("error", new Error("no")); return super.emit("close"); } return super.emit(ev, ...a); } };
  const a = fakes(); a.deps.WebSocket = noWS;
  await V.handleIncoming(incoming("rtc_x1"), a.deps);
  assert.strictEqual(a.posts.find(p => /rtc_x1\/refer$/.test(p.url)).body.target_uri, "tel:+16265550101");
  assert(a.tg.some(m => /lost her connection/.test(m.text) && /Please call them back/.test(m.text)));
  const b = fakes({ open: false }); b.deps.WebSocket = noWS; b.deps.cfg = { ...b.deps.cfg, backupTo: "+16265550199" };
  await V.handleIncoming(incoming("rtc_x2"), b.deps);
  assert.strictEqual(b.posts.find(p => /rtc_x2\/refer$/.test(p.url)).body.target_uri, "tel:+16265550199");
  const c = fakes({ open: false }); c.deps.WebSocket = noWS;
  await V.handleIncoming(incoming("rtc_x3"), c.deps);
  assert(c.posts.some(p => /rtc_x3\/hangup$/.test(p.url)) && !c.posts.some(p => /rtc_x3\/refer$/.test(p.url)));
  for (const id of ["rtc_x1", "rtc_x2", "rtc_x3"]) assert(!I.ACTIVE.has(id));
});

check("a line that fails to open does not start a second reconnect loop", async () => {
  const f = fakes();
  let made = 0;
  f.deps.WebSocket = class extends FakeWS { constructor(u, o) { super(u, o); this.n = ++made; } emit(ev, ...a) { if (ev === "open" && this.n <= 2) { super.emit("error", new Error("no")); return super.emit("close"); } return super.emit(ev, ...a); } };
  const r = await V.handleIncoming(incoming("rtc_y"), f.deps);
  for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r));
  assert.strictEqual(r.ok, true);
  assert.strictEqual(made, 3, "three attempts, no more");
  const call = I.ACTIVE.get("rtc_y");
  assert(call && !call.ended, "the call is live and still tracked");
  call.ended = true; I.ACTIVE.delete("rtc_y");
});

check("a failed save does not turn a done transfer or a recorded lead into an apology", async () => {
  const f = fakes();
  f.deps.db.query = async () => { throw new Error("db down"); };
  await V.handleIncoming(incoming("rtc_z"), f.deps);
  const call = I.ACTIVE.get("rtc_z");
  await call.onEvent(fnCall("transfer_to_staff", { name: "A", role: "client", summary: "s", language: "en" }));
  assert(call.left && !f.tg.some(m => /did not go through/.test(m.text)));
  call.ended = true; I.ACTIVE.delete("rtc_z");
  const g = fakes({ open: false });
  g.deps.db.query = async () => { throw new Error("db down"); };
  await V.handleIncoming(incoming("rtc_z2"), g.deps);
  const c2 = I.ACTIVE.get("rtc_z2");
  await c2.onEvent(fnCall("log_lead", { name: "B", phone: "6265550000", language: "en", matter: "other", summary: "s", urgent: false }));
  assert(/staff_will_call/.test(lastWS().sent.find(e => e.type === "conversation.item.create").item.output));
  c2.ended = true; I.ACTIVE.delete("rtc_z2");
});

check("backup-line voicemails: Twilio's signature is checked, and every message is reported, transcribed", async () => {
  const token = "tok123";
  const url = "https://tezlaw-bot.onrender.com/voice/rt/voicemail?from=%2B16265559876";
  const params = { RecordingUrl: "https://api.twilio.com/rec/RE1", RecordingStatus: "completed", RecordingDuration: "42", CallSid: "CA1" };
  const sig = crypto.createHmac("sha1", token).update(url + Object.keys(params).sort().map(k => k + params[k]).join("")).digest("base64");
  assert.strictEqual(I.twilioSignatureOk(url, params, sig, token), true);
  assert.strictEqual(I.twilioSignatureOk(url, { ...params, RecordingDuration: "43" }, sig, token), false);
  const f = fakes();
  await I.handleVoicemail(params, { from: "+16265559876" }, f.deps);
  const m = f.tg.find(x => /VOICEMAIL/.test(x.text));
  assert(m.topic === "leads" && /\(626\) 555-9876/.test(m.text) && /TRANSCRIPT of https:\/\/api\.twilio\.com\/rec\/RE1/.test(m.text));
  assert.strictEqual(I.twilioSignatureOk(url, params, sig, ""), false, "no token configured: refused");
  f.deps.transcribe = async () => { throw new Error("nope"); };
  await I.handleVoicemail(params, { from: "+16265559876" }, f.deps);
  assert(f.tg.some(x => /could not transcribe/.test(x.text)), "reported even when transcription fails");
});

check("a database that is down does not stop a call being answered", async () => {
  const routes = {};
  const f = fakes();
  f.deps.db = { query: async () => { throw new Error("db down"); } };
  V.mount({ post: (p, fn) => { routes[p] = fn; } }, { ...f.deps, noSweep: true });
  const body = JSON.stringify(incoming("rtc_db"));
  const ts = String(Math.floor(Date.now() / 1000));
  const r = { code: 0, status(c) { r.code = c; return r; }, send() { return r; } };
  routes["/voice/rt/incoming"]({ rawBody: Buffer.from(body), headers: { "webhook-id": "wh_db", "webhook-timestamp": ts, "webhook-signature": sign(body, "wh_db", ts) } }, r);
  for (let i = 0; i < 10; i++) await new Promise(r => setImmediate(r));
  assert(f.posts.some(p => /rtc_db\/accept$/.test(p.url)));
  if (I.ACTIVE.has("rtc_db")) { I.ACTIVE.get("rtc_db").ended = true; I.ACTIVE.delete("rtc_db"); }
});

check("end_call hangs up after the goodbye", async () => {
  const f = fakes();
  await V.handleIncoming(incoming("rtc_l"), f.deps);
  const call = I.ACTIVE.get("rtc_l");
  await call.onEvent(fnCall("end_call", { reason: "done" }));
  assert(f.posts.some(p => /\/rtc_l\/hangup$/.test(p.url)));
  call.ended = true; I.ACTIVE.delete("rtc_l");
});

check("a caller who hangs up without leaving anything is still reported", async () => {
  const f = fakes({ open: false });
  await V.handleIncoming(incoming("rtc_m"), f.deps);
  const call = I.ACTIVE.get("rtc_m");
  call.started = new Date(Date.now() - 40000);
  await call.onEvent({ type: "conversation.item.input_audio_transcription.completed", transcript: "我出车祸了，想问一下" });
  call.reconnects = 1;
  lastWS().close();
  await new Promise(r => setImmediate(r));
  await new Promise(r => setImmediate(r));
  const n = f.tg.find(m => /without a message/.test(m.text));
  assert(n && n.topic === "leads" && /我出车祸了/.test(n.text) && /\(626\) 555-9876/.test(n.text));
  assert(f.db.some(q => /INSERT INTO voice_rt_calls/.test(q.sql) && q.params[7] instanceof Date), "saved as ended");
});

check("after a deploy, the next server takes over open calls once the old one stops beating; an ended one is reported", async () => {
  const f = fakes();
  f.deps.db.query = async (sql, params) => {
    f.db.push({ sql, params });
    if (/UPDATE voice_rt_calls SET owner = \$1, heartbeat_at = NOW\(\)/.test(sql)) return { rows: [
      { call_id: "rtc_live", from_number: "+16265559876", to_number: "+16269000688", office_open: true, started_at: new Date(), transcript: [], logged: [] },
      { call_id: "rtc_gone", from_number: "+16265550000", to_number: "+16269000688", office_open: false, started_at: new Date(Date.now() - 60000), transcript: [{ who: "caller", text: "I need a lawyer for my accident" }], logged: [] },
    ] };
    return { rows: [] };
  };
  class WS2 extends FakeWS { constructor(u, o) { super(u, o); this.gone = /rtc_gone/.test(u); } emit(ev, ...a) { if (ev === "open" && this.gone) { super.emit("error", new Error("gone")); return super.emit("close"); } return super.emit(ev, ...a); } }
  f.deps.WebSocket = WS2;
  const n = await V.sweep(f.deps);
  assert.strictEqual(n, 1);
  const claim = f.db.find(q => /SET owner = \$1/.test(q.sql));
  assert(/heartbeat_at < NOW\(\) - INTERVAL '25 seconds'/.test(claim.sql), "only calls whose server stopped beating");
  assert(I.ACTIVE.has("rtc_live") && !I.ACTIVE.has("rtc_gone"));
  const note = f.tg.find(m => /without a message/.test(m.text));
  assert(note && /\(626\) 555-0000/.test(note.text) && /my accident/.test(note.text), "the caller who hung up is reported");
  assert(f.db.some(q => /ended_at IS NULL AND started_at < NOW\(\) - INTERVAL '45 minutes'/.test(q.sql)), "old rows closed off");
  I.ACTIVE.get("rtc_live").ended = true; I.ACTIVE.delete("rtc_live");
});

check("the webhook route: bad signature 400, good one 200 and the call is handled, a retry is not answered twice", async () => {
  const routes = {};
  const app = { post: (p, fn) => { routes[p] = fn; } };
  const f = fakes();
  let handled = 0;
  const deps = V.mount(app, { ...f.deps, noSweep: true });
  deps.db = { query: async () => ({ rows: [] }) };
  const body = JSON.stringify(incoming("rtc_w"));
  const ts = String(Math.floor(Date.now() / 1000));
  const mk = (sig) => ({ rawBody: Buffer.from(body), headers: { "webhook-id": "wh_w", "webhook-timestamp": ts, "webhook-signature": sig } });
  const res = () => { const r = { code: 0, status(c) { r.code = c; return r; }, send() { return r; } }; return r; };
  const r1 = res(); routes["/voice/rt/incoming"](mk("v1,AAAA"), r1); assert.strictEqual(r1.code, 400);
  const before = f.posts.length;
  const r2 = res(); routes["/voice/rt/incoming"](mk(sign(body, "wh_w", ts)), r2); assert.strictEqual(r2.code, 200);
  for (let i = 0; i < 10; i++) await new Promise(r => setImmediate(r));
  handled = f.posts.slice(before).filter(p => /rtc_w\/accept$/.test(p.url)).length;
  assert.strictEqual(handled, 1);
  const r3 = res(); routes["/voice/rt/incoming"](mk(sign(body, "wh_w", ts)), r3); assert.strictEqual(r3.code, 200);
  for (let i = 0; i < 10; i++) await new Promise(r => setImmediate(r));
  assert.strictEqual(f.posts.filter(p => /rtc_w\/accept$/.test(p.url)).length, 1);
  if (I.ACTIVE.has("rtc_w")) { I.ACTIVE.get("rtc_w").ended = true; I.ACTIVE.delete("rtc_w"); }
});

check("not configured: the webhook says so instead of half-answering", () => {
  const routes = {};
  V.mount({ post: (p, fn) => { routes[p] = fn; } }, { ...fakes().deps, env: {}, cfg: I.cfg({}), noSweep: true });
  const r = { code: 0, status(c) { r.code = c; return r; }, send() { return r; } };
  routes["/voice/rt/incoming"]({ rawBody: Buffer.from("{}"), headers: {} }, r);
  assert.strictEqual(r.code, 503);
});

(async () => {
  for (const [name, fn] of tests) {
    try { await fn(); passed++; console.log(`  ok  ${name}`); }
    catch (e) { console.error(`  FAIL ${name}\n       ${e.stack.split("\n").slice(0, 3).join("\n       ")}`); process.exitCode = 1; }
  }
  console.log(`\nvoice-rt: ${passed}/${tests.length} passed`);
  process.exit(process.exitCode || 0);
})();
