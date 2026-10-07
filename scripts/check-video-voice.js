/**
 * check-video-voice.js
 *
 * JJ, on video #116: "the speech in this video in some instances are all
 * scrambles that i don't understand. when we make these videos. lets do all
 * 3 languages, mandarin, english and spanish."
 *
 * Two promises, checked here with the model, the voice and Telegram stood in
 * for (nothing leaves the machine):
 *
 *   1. A spoken line is something a synthetic voice can read in that
 *      language, and a line that does not come back as written is recorded
 *      again and then pointed out to JJ. It is never passed over in silence.
 *   2. An article gets a video in 普通话, English and Español, each from its
 *      own post and each approved on its own.
 */
const Module = require("module");
const path = require("path");
const fs = require("fs");
const os = require("os");
const ROOT = path.join(__dirname, "..");

let failures = 0, count = 0;
function ok(name, cond, detail = "") {
  count++;
  if (!cond) failures++;
  console.log((cond ? "  ok   " : "  FAIL ") + name + (cond || detail === "" ? "" : "\n         → " + (typeof detail === "string" ? detail : JSON.stringify(detail))));
}

process.env.SOCIAL_POSTS_ENABLED = "true";
process.env.SOCIAL_VIDEO_ENABLED = "true";
for (const k of ["SOCIAL_VIDEOS_PER_WEEK", "SOCIAL_VIDEO_LANGS", "SOCIAL_TTS_MODEL", "SOCIAL_TTS_VOICE", "SOCIAL_TTS_VOICE_ZH", "SOCIAL_TTS_VOICE_EN", "SOCIAL_TTS_VOICE_ES", "OPENAI_API_KEY", "TELEGRAM_TOKEN", "JJ_TELEGRAM_ID"]) delete process.env[k];

// ── Stand-ins: the table, and Telegram ───────────────────────
const T = { rows: [], seq: 1 };
const fakeDb = { query: async (sql, v = []) => {
  const q = sql.replace(/\s+/g, " ").trim();
  if (/^INSERT INTO social_posts/.test(q)) {
    const r = { id: T.seq++, channel: v[0], text: v[1], source_url: v[2], source_title: v[3], status: "pending", media: v[5] ? JSON.parse(v[5]) : null, lang: v[6] || null, media_file: v[7] || null };
    T.rows.push(r); return { rows: [{ id: r.id }] };
  }
  if (/^SELECT id, lang, media->>'group' AS grp FROM social_posts WHERE channel = 'video'/.test(q))
    return { rows: T.rows.filter(r => r.channel === "video").reverse().map(r => ({ id: r.id, lang: r.lang, grp: (r.media && r.media.group) || null })) };
  return { rows: [] };
} };
const TG = { text: [], media: [] };
const fakeRoute = {
  send: async (topic, text, opts) => { TG.text.push({ topic, text, opts }); return true; },
  sendMedia: async (topic, kind, buffer, filename, caption, opts) => { TG.media.push({ topic, kind, filename, caption, bytes: buffer.length, opts }); return true; },
};
const realLoad = Module._load;
Module._load = function (request) {
  if (request === "./db" || request === path.join(ROOT, "db")) return fakeDb;
  if (request === "./tg-route") return fakeRoute;
  if (request === "./postiz") return { configured: () => false };
  return realLoad.apply(this, arguments);
};

const V = require("../video-voice");
const S = require("../social-posts");
const M = require("../social-media");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vv-"));

(async () => {
  console.log("\n── What the voice is given to read ──────────────");
  // The on-screen lines of video #116. Before this, the voice was handed lines like them.
  for (const line of ["USCIS申请费10月16日起上调", "EB-5费用11月30日翻倍以上", "H-1B十万美元费用再被法院叫停", "完整文章请见 tezlawfirm.com"])
    ok(`a line like video #116's is refused as a spoken line: ${line}`, V.checkSay(line, "zh").length > 0);
  for (const line of ["美国移民局的申请费从十月十六日起上调。", "E B 五投资移民的费用，十一月三十日起翻倍以上。", "H 一 B 签证的十万美元费用，再次被法院叫停。", "完整文章请见我们的网站。"])
    ok(`…and the same thing written for the ear is accepted: ${line}`, V.checkSay(line, "zh").length === 0, V.checkSay(line, "zh"));
  ok("English: digits and symbols are refused, words are accepted",
    V.checkSay("The fee is $100,000 from 10/16.", "en").length >= 2 && V.checkSay("The fee is one hundred thousand dollars from October sixteenth.", "en").length === 0);
  ok("English: the site may be said as words, never written as an address",
    V.checkSay("The full article is at tez law firm dot com.", "en").length === 0 && V.checkSay("Read it at tezlawfirm.com.", "en").length > 0);
  ok("Spanish: an English abbreviation in capitals is refused, the agency's name is accepted",
    V.checkSay("USCIS sube las tarifas el dieciséis de octubre.", "es").length === 1 &&
    V.checkSay("El Servicio de Ciudadanía e Inmigración sube las tarifas el dieciséis de octubre.", "es").length === 0);
  ok("a line in the wrong script is refused (Chinese in an English or Spanish line; no Chinese in a Chinese line)",
    V.checkSay("绿卡 is pending", "en").length > 0 && V.checkSay("La 绿卡 está pendiente", "es").length > 0 && V.checkSay("Green card pending", "zh").length > 0);

  const SRC = { en: { title: "USCIS fees rise October 16", url: "https://tezlawfirm.com/fees", summary: "USCIS filing fees rise on October 16, 2026. The H-1B fee of $100,000 was paused by a court." },
    zh: { title: "USCIS申请费10月16日起上调", url: "https://tezlawfirm.com/zh/fees", summary: "美国移民局的申请费将于2026年10月16日上调。" },
    es: { title: "Las tarifas de USCIS suben el 16 de octubre", url: "https://tezlawfirm.com/es/tarifas", summary: "Las tarifas de USCIS suben el 16 de octubre de 2026." } };
  const pz = S.buildVideoPrompt(SRC.zh, "zh"), pe = S.buildVideoPrompt(SRC.en, "en"), ps = S.buildVideoPrompt(SRC.es, "es");
  ok("the writer is told, in each language, to write numbers in words", /十月十六日/.test(pz) && /October sixteenth/.test(pe) && /dieciséis de octubre/.test(ps));
  ok("…to name agencies in that language", /美国移民局/.test(pz) && /Servicio de Ciudadanía e Inmigración/.test(ps));
  ok("…and how to spell a visa code", /H 一 B/.test(pz) && /H one B/.test(pe) && /H uno B/.test(ps));
  ok("the Spanish brief is in Spanish, addresses the viewer as usted, and bars \"notario\"", /Escriba en español/.test(ps) && /de usted/.test(ps) && /notario/.test(ps));
  ok("every brief keeps the narrator from speaking as the attorney", /never speak as a lawyer/.test(pe) && /不要用“我是律师”/.test(pz) && /nunca hable como abogado/.test(ps));
  ok("a second attempt is told what the first was refused for", /previous script was refused.*digits/.test(S.buildVideoPrompt(SRC.en, "en", ["a spoken line has digits (write numbers in words)"])) && !/previous script/.test(pe));

  const GOOD = {
    zh: { title: "移民局申请费上调", caption: "申请费十月起上调，哪些表格受影响。", tags: ["移民"], scenes: [
      { text: "USCIS申请费要涨了？", say: "美国移民局的申请费要涨了吗？" }, { text: "10月16日起上调", say: "新的收费从十月十六日开始。" },
      { text: "H-1B十万美元费用被叫停", say: "H 一 B 签证的十万美元费用，被法院叫停。" }, { text: "完整文章请见 tezlawfirm.com", say: "完整文章请见我们的网站。" }] },
    en: { title: "USCIS fees rise October 16", caption: "Which forms cost more, and from when.", tags: ["immigration"], scenes: [
      { text: "Are USCIS fees going up?", say: "Are immigration filing fees going up?" }, { text: "New fees start Oct. 16", say: "The new fees start on October sixteenth." },
      { text: "The $100,000 H-1B fee is paused", say: "A court paused the one hundred thousand dollar H one B fee." }, { text: "Full article at tezlawfirm.com", say: "The full article is at tez law firm dot com." }] },
    es: { title: "Suben las tarifas de inmigración", caption: "Qué formularios cuestan más y desde cuándo.", tags: ["inmigración"], scenes: [
      { text: "¿Suben las tarifas de USCIS?", say: "¿Suben las tarifas de inmigración?" }, { text: "Desde el 16 de octubre", say: "Las nuevas tarifas empiezan el dieciséis de octubre." },
      { text: "La tarifa H-1B de $100,000, en pausa", say: "Un tribunal suspendió la tarifa de cien mil dólares de la visa H uno B." }, { text: "Artículo completo en tezlawfirm.com", say: "El artículo completo está en nuestro sitio web." }] },
  };
  for (const l of V.LANGS) { const c = S.checkScript(GOOD[l], l); ok(`a sound ${V.LANG_NAME[l]} script passes, with codes and dates on screen and words in the voice`, c.ok, c.problems); }
  const bad = JSON.parse(JSON.stringify(GOOD.zh)); bad.scenes[1].say = "USCIS申请费10月16日起上调";
  ok("a script whose voice line mixes in \"USCIS\" and digits is refused", !S.checkScript(bad, "zh").ok && S.checkScript(bad, "zh").problems.some(p => /digits/.test(p)) && S.checkScript(bad, "zh").problems.some(p => /English word/.test(p)));
  const noSay = JSON.parse(JSON.stringify(GOOD.zh)); delete noSay.scenes[2].say;
  ok("with no voice line the on-screen line would be read, so it is held to the same rules", !S.checkScript(noSay, "zh").ok);
  const notario = JSON.parse(JSON.stringify(GOOD.es)); notario.scenes[1].say = "Consulte con un notario sobre las nuevas tarifas.";
  ok("a Spanish script that says \"notario\" is refused", S.checkScript(notario, "es").problems.some(p => /notario/.test(p)));
  const soy = JSON.parse(JSON.stringify(GOOD.es)); soy.scenes[1].say = "Soy abogado y le explico las nuevas tarifas.";
  ok("a Spanish narrator speaking as the attorney is refused", S.checkScript(soy, "es").problems.some(p => /speaks as the attorney/.test(p)));
  {
    const asked = [];
    const think = async (p) => { asked.push(p); return { text: JSON.stringify(asked.length === 1 ? bad : GOOD.zh) }; };
    const r = await S.composeVideoScript(SRC.zh, "zh", { think });
    ok("a refused script is written again with the reasons, and the corrected one is used", r.ok && r.attempts === 2 && /previous script was refused/.test(asked[1]) && /digits/.test(asked[1]) && r.script.scenes[1].say === "新的收费从十月十六日开始。", r);
  }

  console.log("\n── The voice ────────────────────────────────────");
  {
    const z = V.speechRequest("新的收费从十月十六日开始。", "zh", "gpt-4o-mini-tts");
    ok("the newer voice model is told the language", /Mandarin/.test(z.instructions) && z.voice === "nova" && z.speed === undefined && z.response_format === "mp3");
    ok("…for English and Spanish too", /American English/.test(V.speechRequest("x", "en", "gpt-4o-mini-tts").instructions) && /Spanish/.test(V.speechRequest("x", "es", "gpt-4o-mini-tts").instructions));
    const old = V.speechRequest("x", "es", "tts-1-hd");
    ok("the older model is sent no instruction it would refuse", old.instructions === undefined && old.speed === 1.0 && old.voice === "onyx");
    process.env.SOCIAL_TTS_VOICE_ES = "coral";
    ok("a voice can be chosen per language", V.speechRequest("x", "es", "gpt-4o-mini-tts").voice === "coral" && V.speechRequest("x", "en", "gpt-4o-mini-tts").voice === "onyx");
    delete process.env.SOCIAL_TTS_VOICE_ES;

    const sent = [];
    const refuse = (status) => { const e = new Error("HTTP " + status); e.response = { status }; return e; };
    let post = async (body) => { sent.push(body.model); if (body.model === "gpt-4o-mini-tts") throw refuse(404); return { data: Buffer.from("mp3") }; };
    const f = path.join(tmp, "a.mp3");
    const used = await V.synth("hello", "en", f, { post });
    ok("if the newer model is refused the older one is used, and the line is still made", used === "tts-1-hd" && sent.join() === "gpt-4o-mini-tts,tts-1-hd" && fs.readFileSync(f, "utf8") === "mp3");
    sent.length = 0; post = async (body) => { sent.push(body.model); throw refuse(500); };
    let msg = ""; try { await V.synth("hello", "en", f, { post }); } catch (e) { msg = e.message; }
    ok("a service failure is not papered over by switching models", sent.length === 1 && /could not be made: HTTP 500/.test(msg), msg);
    process.env.SOCIAL_TTS_MODEL = "tts-1";
    sent.length = 0; post = async (body) => { sent.push(body.model); return { data: Buffer.from("x") }; };
    await V.synth("hello", "en", f, { post });
    ok("SOCIAL_TTS_MODEL, when set, is the only model used", sent.join() === "tts-1");
    delete process.env.SOCIAL_TTS_MODEL;
  }

  console.log("\n── Listening back ───────────────────────────────");
  {
    const a = V.agreement;
    ok("a line heard as written scores 1, whatever the punctuation", a("美国移民局的申请费从十月十六日起上调。", "美国移民局的申请费从10月16日起上调", "zh") === 1 && a("Leaving can be treated as abandoning the application.", "leaving can be treated as abandoning the application", "en") === 1);
    ok("numbers are not held against it (\"sixteenth\" is heard as \"16th\")", a("The new fees start on October sixteenth.", "The new fees start on October 16th.", "en") >= V.CLEAR && a("Las nuevas tarifas empiezan el dieciséis de octubre.", "Las nuevas tarifas empiezan el 16 de octubre.", "es") >= V.CLEAR);
    ok("a transcript in Traditional characters still matches", a("美国移民局的申请费从十月十六日起上调。", "美國移民局的申請費從10月16日起上調", "zh") === 1);
    ok("a scrambled line scores below the bar in each language",
      a("E B 五投资移民的费用，十一月三十日起翻倍以上。", "一笔无头子一名的飞翁是一月三号起翻被以上", "zh") < V.CLEAR &&
      a("The fee for the H one B petition rises on October sixteenth.", "The feet of the age when be potato rice is on a tuba.", "en") < V.CLEAR &&
      a("Las tarifas del Servicio de Ciudadanía e Inmigración suben el dieciséis de octubre.", "La starifa del servicio de se ha dado en migración su ven.", "es") < V.CLEAR);
    ok("a line read in the wrong language scores 0", a("美国移民局的申请费从十月十六日起上调。", "Thank you for watching.", "zh") === 0);

    const say = "The new fees start on October sixteenth.";
    const mk = (heardList) => { const made = []; let n = 0;
      return { made, synthFn: async (t, l, file) => { made.push(file); fs.writeFileSync(file, "take" + made.length); return "gpt-4o-mini-tts"; }, hearFn: async () => heardList[n++] }; };
    let f = path.join(tmp, "l1.mp3"), k = mk([say]);
    let r = await V.speakChecked(say, "en", f, k);
    ok("a line that comes back as written is recorded once", r.checked && r.clear && r.takes === 1 && k.made.length === 1 && fs.readFileSync(f, "utf8") === "take1", r);
    f = path.join(tmp, "l2.mp3"); k = mk(["The newt freeze dart tone a tuba.", "The new fees start on October 16th."]);
    r = await V.speakChecked(say, "en", f, k);
    ok("a line that comes back scrambled is recorded again, and the clear take is the one kept", r.clear && r.takes === 2 && fs.readFileSync(f, "utf8") === "take2" && !fs.existsSync(f + ".take2.mp3"), r);
    f = path.join(tmp, "l3.mp3"); k = mk(["Thank you.", "The newt freeze dart tone a tuba."]);
    r = await V.speakChecked(say, "en", f, k);
    ok("a line scrambled both times is kept (the better take) and marked unclear, with what was heard", r.checked && r.clear === false && r.takes === 2 && /newt/.test(r.heard) && fs.readFileSync(f, "utf8") === "take2", r);
    f = path.join(tmp, "l4.mp3"); k = mk([null]);
    r = await V.speakChecked(say, "en", f, k);
    ok("when listening back is not possible the line is still made, and marked as not checked", r.checked === false && r.clear === null && k.made.length === 1 && fs.existsSync(f), r);

    ok("the approval message says so when every line came back", /all 4 spoken lines came back as written/.test(V.voiceReport([1, 2, 3, 4].map(scene => ({ scene, checked: true, clear: true })))));
    const rep = V.voiceReport([{ scene: 1, checked: true, clear: true }, { scene: 2, checked: true, clear: false, heard: "一笔无头子" }, { scene: 3, checked: true, clear: true }]);
    ok("…names the line to listen to, with what was heard", /^⚠️ Voice check: listen to line 2\./.test(rep) && /一笔无头子/.test(rep), rep);
    ok("…and says when the check could not run", /could not run/.test(V.voiceReport([{ scene: 1, checked: false }, { scene: 2, checked: false }])));
  }

  console.log("\n── The slides, in Spanish ───────────────────────");
  ok("the closing notice exists in all three languages and says the voice is AI-generated",
    /AI-generated/.test(M.DISCLAIMER.en) && /AI合成/.test(M.DISCLAIMER.zh) && /generada por IA/.test(M.DISCLAIMER.es) && /Publicidad de abogado/.test(M.DISCLAIMER.es));
  ok("the tagline exists in all three", !!M.TAGLINE.en && !!M.TAGLINE.zh && /Proteja sus derechos/.test(M.TAGLINE.es));
  {
    const scene = M.slide({ text: "¿Suben las tarifas de inmigración el 16 de octubre?", eyebrow: "Conozca la ley", lang: "es", index: 0, total: 4, kind: "title" });
    const end = M.slide({ text: M.DISCLAIMER.es, lang: "es", kind: "end" });
    ok("a Spanish slide and the Spanish closing slide render", scene.length > 20000 && end.length > 40000, [scene.length, end.length]);
    const fonts = ["Brand-Cormorant-Bold.ttf", "Brand-Montserrat-Regular.ttf", "Brand-Montserrat-Bold.ttf"].map(f => require("opentype.js").loadSync(path.join(ROOT, "assets", "fonts", f)));
    const missing = Array.from("ñÑáéíóúÁÉÍÓÚü¿¡").filter(c => fonts.some(f => f.charToGlyph(c).index === 0));
    ok("the brand fonts have every Spanish letter and mark", missing.length === 0, missing.join(""));
  }
  {
    // The real renderer with a stand-in voice: is each scene's result handed back?
    const FF = (() => { try { return require("ffmpeg-static"); } catch (_) { return null; } })();
    if (FF && fs.existsSync(FF)) {
      const { execFileSync } = require("child_process");
      const tone = path.join(tmp, "tone.mp3");
      let toneOk = true;
      try { execFileSync(FF, ["-y", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=0.6", "-c:a", "libmp3lame", tone]); } catch (_) { toneOk = false; }
      if (!toneOk) console.log("  note  this ffmpeg cannot make a test tone, so the render itself was not run");
      else {
      const results = [{ checked: true, clear: true, score: 1, takes: 1 }, { checked: true, clear: false, score: 0.2, takes: 2, heard: "???" }, { checked: true, clear: true, score: 0.9, takes: 1 }];
      let n = 0;
      const out = await M.video({ lang: "es", eyebrow: "Conozca la ley", scenes: GOOD.es.scenes.slice(0, 3), speakFn: async (t, l, file) => { fs.copyFileSync(tone, file); return results[n++]; } });
      ok("a rendered video reports, scene by scene, how the voice check went", out.seconds > 6 && out.voice.length === 3 && out.voice[1].scene === 2 && out.voice[1].clear === false && fs.statSync(out.file).size > 20000, out.voice);
      fs.rmSync(out.dir, { recursive: true, force: true });
      }
    } else console.log("  note  ffmpeg is not installed here, so the render itself was not run");
  }

  console.log("\n── One article, three videos ────────────────────");
  const render = async ({ lang, scenes }) => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tv-")); const file = path.join(dir, "v.mp4"); fs.writeFileSync(file, Buffer.alloc(900, 1));
    return { file, dir, seconds: 40, voice: scenes.map((s, i) => ({ scene: i + 1, checked: true, clear: !(lang === "zh" && i === 1), score: 1, takes: 1, heard: lang === "zh" && i === 1 ? "一笔无头子" : s.say })) }; };
  const langOf = (p) => /简体中文/.test(p) ? "zh" : /Escriba en español/.test(p) ? "es" : "en";
  const think = async (p) => ({ text: JSON.stringify(GOOD[langOf(p)]) });
  {
    T.rows = []; TG.text = []; TG.media = [];
    const r = await S.queueVideo(SRC, { think, render });
    ok("an article published in three languages gets three videos: 普通话, English, Español", r.queued === 3 && r.langs.join() === "zh,en,es", r);
    ok("each is written from its own language's post and links to it", T.rows.map(x => x.source_url).join() === [SRC.zh.url, SRC.en.url, SRC.es.url].join() && T.rows.every(x => x.text.includes(x.source_url)));
    ok("each is its own row, waiting for its own approval", T.rows.length === 3 && T.rows.every(x => x.status === "pending" && x.media_file && x.media.script.lang === x.lang));
    ok("the three are tied together as one article", new Set(T.rows.map(x => x.media.group)).size === 1 && T.rows[0].media.group === SRC.en.url);
    ok("each is sent to JJ with its own button, labelled by language and position", TG.media.length === 3 && /^🎬 普通话 explainer · 40s · 1 of 3/.test(TG.media[0].caption) && /English explainer · 40s · 2 of 3/.test(TG.media[1].caption) && /Español explainer · 40s · 3 of 3/.test(TG.media[2].caption) &&
      TG.media.every((m, i) => m.opts.reply_markup.inline_keyboard[0][0].callback_data === "soc_go_" + T.rows[i].id), TG.media.map(m => m.caption.split("\n")[0]));
    ok("a line that did not come back clearly is pointed out in that video's message, and only there", /⚠️ Voice check: listen to line 2/.test(TG.media[0].caption) && /一笔无头子/.test(TG.media[0].caption) && /all 4 spoken lines came back/.test(TG.media[1].caption) && /all 4 spoken lines came back/.test(TG.media[2].caption));
    ok("…and kept on the record with the video", T.rows[0].media.voice[1].clear === false && T.rows[0].media.voice[1].heard === "一笔无头子" && T.rows[1].media.voice.every(v => v.clear));
    ok("every message fits a Telegram caption", TG.media.every(m => m.caption.length <= 1024), TG.media.map(m => m.caption.length));
    ok("the Spanish description says the narration is AI-generated, in Spanish", /generada por IA/.test(T.rows[2].text) && /AI-generated/.test(T.rows[1].text) && /AI合成/.test(T.rows[0].text));
    ok("what the voice reads has no digits, symbols or address in any of the three", T.rows.every(x => x.media.script.scenes.every(s => V.checkSay(s.say, x.lang).length === 0)));

    const again = await S.queueVideo({ en: { ...SRC.en, url: SRC.en.url + "-2" }, zh: SRC.zh, es: SRC.es }, { think, render, notify: false });
    const third = await S.queueVideo({ en: { ...SRC.en, url: SRC.en.url + "-3" }, zh: SRC.zh, es: SRC.es }, { think, render, notify: false });
    ok("the weekly limit counts articles, not videos: two articles are six videos, a third article is refused", again.queued === 3 && third.queued === 0 && /weekly limit reached \(2\/2\)/.test(third.reason) && T.rows.length === 6, [again.queued, third.reason]);
  }
  {
    T.rows = []; TG.text = []; TG.media = [];
    const r = await S.queueVideo({ en: SRC.en, zh: SRC.zh }, { think, render });
    ok("a language with no published post gets no video, and JJ is told which", r.queued === 2 && r.langs.join() === "zh,en" && TG.text.length === 1 && /2 of 3 videos made/.test(TG.text[0].text) && /Español \(no published post in that language\)/.test(TG.text[0].text), TG.text);
    ok("…and the two that were made are numbered 1 of 2 and 2 of 2", /1 of 2/.test(TG.media[0].caption) && /2 of 2/.test(TG.media[1].caption));
  }
  {
    T.rows = []; TG.text = []; TG.media = [];
    const stubborn = async (p) => ({ text: JSON.stringify(langOf(p) === "es" ? { ...GOOD.es, scenes: GOOD.es.scenes.map(s => ({ ...s, say: s.text })) } : GOOD[langOf(p)]) });
    const r = await S.queueVideo(SRC, { think: stubborn, render });
    ok("one language that cannot be written properly does not cost the other two", r.queued === 2 && r.langs.join() === "zh,en" && r.skipped.length === 1 && r.skipped[0].lang === "es", r.skipped);
    ok("…and JJ is told why, in plain words", TG.text.length === 1 && /Español \(.*digits/.test(TG.text[0].text), TG.text.map(x => x.text));
    T.rows = []; TG.text = [];
    const broke = async (o) => { if (o.lang === "en") throw new Error("the voice could not be made: HTTP 500"); return render(o); };
    const r2 = await S.queueVideo(SRC, { think, render: broke });
    ok("a voice failure in one language is reported, and the others are still made", r2.queued === 2 && r2.langs.join() === "zh,es" && /English \(the voice could not be made: HTTP 500\)/.test(TG.text[0].text), r2.skipped);
  }
  {
    T.rows = []; TG.text = [];
    process.env.SOCIAL_VIDEO_LANGS = "en";
    const r = await S.queueVideo(SRC, { think, render, notify: false });
    ok("SOCIAL_VIDEO_LANGS still narrows the languages when it is set", r.queued === 1 && r.langs.join() === "en");
    delete process.env.SOCIAL_VIDEO_LANGS;
    process.env.SOCIAL_VIDEO_ENABLED = "false";
    ok("nothing is made when videos are switched off", (await S.queueVideo(SRC, { think, render, notify: false })).queued === 0);
    process.env.SOCIAL_VIDEO_ENABLED = "true";
    T.rows = [];
    const nothing = await S.queueVideo(SRC, { think: async () => ({ text: "NOTHING TO SAY" }), render });
    ok("an article that cannot support a video makes none, without a message", nothing.queued === 0 && TG.text.length === 0, [nothing, TG.text]);
  }
  {
    const auto = fs.readFileSync(path.join(ROOT, "autoposter.js"), "utf8");
    ok("the autoposter offers the Spanish post for a video along with the English and Chinese ones", /vsrc\.es = \{ title: esPost\.title, url: es,/.test(auto) && /if \(vsrc\.en \|\| vsrc\.zh \|\| vsrc\.es\)/.test(auto));
    const media = fs.readFileSync(path.join(ROOT, "social-media.js"), "utf8");
    ok("the renderer makes every line through the checked voice, not straight from the old model", /speakChecked\(text, lang, outFile\)/.test(media) && !/"tts-1-hd"/.test(media));
  }

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(failures ? `\n${failures} of ${count} checks FAILED` : `\n${count} of ${count} checks passed`);
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
