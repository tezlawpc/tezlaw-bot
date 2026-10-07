// ============================================================
//  video-voice.js — the voice of the explainer videos
//
//  JJ, about video #116 (普通话): "the speech in this video in some
//  instances are all scrambles that i don't understand."
//
//  That video's lines mixed Chinese with "USCIS", "EB-5", "H-1B", digits and
//  a web address, and each line was handed to the voice as written. A
//  synthetic voice reading Chinese does not know what to do with "EB-5" or
//  "10月16日" or "tezlawfirm.com". Three things here, in the order they act:
//
//    1. The script. What the voice reads ("say") is written for the ear:
//       numbers in words, agencies by their name in that language, form and
//       visa codes spelled the way people say them, no symbols, no web
//       address. speechRules() tells the writer; checkSay() refuses a line
//       that breaks them, so it is rewritten before any audio is made.
//       The on-screen line ("text") is free to say "EB-5" and "10月16日".
//
//    2. The voice. The newer OpenAI voice model takes an instruction naming
//       the language, which the older one did not. If that model is not
//       available the older one is used, as before.
//
//    3. Listening back. Each spoken line is transcribed again and compared
//       with what it was supposed to say. A line that does not come back is
//       recorded a second time. If it still does not, the video is still
//       made, and the approval message says which line to listen to.
//       Nothing here blocks a video on its own: JJ approves each one.
//
//  Languages: 普通话 (zh), English (en), Español (es).
// ============================================================

const fs = require("fs");

const LANGS = ["zh", "en", "es"];
const LANG_NAME = { zh: "普通话", en: "English", es: "Español" };

// ── 1. Writing for the ear ───────────────────────────────────

/** Lines for the script prompt: how the "say" field must be written in this language. */
function speechRules(lang) {
  if (lang === "zh") return [
    "“say”是交给合成语音朗读的，必须完全按读出来的样子写；“text”是屏幕上的字，可以照常写 USCIS、EB-5、10月16日。",
    "“say”的规则：",
    "- 不用阿拉伯数字。日期、金额、百分比、年份都写成汉字：十月十六日、十万美元、百分之五十、二〇二六年。",
    "- 机构用中文名称：美国移民局、国土安全部、劳工部、国务院、移民法庭、最高法院。不要写 USCIS、DHS、DOL 这类缩写。",
    "- 签证和表格的代号逐个写开，字母之间留空格：H-1B 写成“H 一 B”，EB-5 写成“E B 五”，I-485 写成“I 四八五”。除这种单个字母外，不要出现英文单词。",
    "- 不写网址，不写符号（$ % § / & @ # +）和括号。",
    "- 最后一个场景的“say”说：完整文章请见我们的网站。网址只写在“text”里。",
  ];
  if (lang === "es") return [
    "Escriba todo en español neutro de Latinoamérica, tratando de usted. No use la palabra «notario».",
    "«say» lo lee una voz sintética: escríbalo exactamente como debe sonar. «text» es lo que aparece en pantalla y sí puede llevar USCIS, EB-5 o 16 de octubre.",
    "Reglas para «say»:",
    "- Sin cifras: fechas, cantidades, porcentajes y años en palabras (dieciséis de octubre; cien mil dólares; cincuenta por ciento; dos mil veintiséis).",
    "- Las agencias por su nombre en español (el Servicio de Ciudadanía e Inmigración, el Departamento de Seguridad Nacional, el Departamento de Trabajo, la Corte Suprema), no con siglas en inglés como USCIS o DHS.",
    "- Las visas y los formularios como se dicen, letra por letra y con espacios: «H uno B», «E B cinco», «formulario I cuatro ochenta y cinco».",
    "- Sin direcciones web ni símbolos ($ % § / & @ # +) ni paréntesis.",
    "- La última escena dice en «say»: El artículo completo está en nuestro sitio web. La dirección va solo en «text».",
  ];
  return [
    "\"say\" is read aloud by a synthetic voice, so write it exactly as it should sound. \"text\" is the on-screen line and may use USCIS, EB-5 or Oct. 16.",
    "Rules for \"say\":",
    "- No digits: write dates, money, percentages and years in words (October sixteenth; one hundred thousand dollars; fifty percent; twenty twenty-six).",
    "- Visa and form codes the way people say them, letter by letter with spaces: \"H one B\", \"E B five\", \"form I four eighty-five\".",
    "- No symbols ($ % § / & @ # +) and no parentheses.",
    "- The last scene's \"say\" is: The full article is at tez law firm dot com. In \"text\" it is written tezlawfirm.com.",
  ];
}

const CJK = /[㐀-鿿]/;
const SYMBOLS = /[$%§\/&@#+=<>*_|\\^~()（）\[\]{}]/;

/** Problems with one spoken line, as short phrases. An empty list means it can be read aloud. */
function checkSay(text, lang) {
  const s = String(text || "").trim();
  const problems = [];
  if (!s) return ["a spoken line is empty"];
  if (/\d/.test(s)) problems.push("a spoken line has digits (write numbers in words)");
  if (SYMBOLS.test(s)) problems.push("a spoken line has a symbol the voice cannot read");
  if (/https?:|www\.|\.(com|org|gov|net)\b|tezlawfirm/i.test(s)) problems.push("a spoken line has a web address written out");
  if (lang === "zh") {
    if (/[A-Za-z]{2,}/.test(s)) problems.push("a spoken Chinese line has an English word or abbreviation");
    if (!CJK.test(s)) problems.push("a spoken Chinese line has no Chinese in it");
  } else {
    if (CJK.test(s)) problems.push("a spoken line mixes in Chinese characters");
    if (lang === "es" && /\b(?!TEZ\b)[A-ZÁÉÍÓÚÑ]{3,}\b/.test(s)) problems.push("a spoken Spanish line has an abbreviation in capitals (use the agency's name)");
  }
  return problems;
}

// ── 2. The voice ─────────────────────────────────────────────

const INSTRUCTIONS = {
  zh: "Speak in Mandarin Chinese (Putonghua), clearly and evenly, like a news explainer. A single Latin letter is read as its English letter name. Read exactly the words given: do not add, skip or change any.",
  en: "Speak in American English, clearly and evenly, like a news explainer. Read exactly the words given: do not add, skip or change any.",
  es: "Speak in neutral Latin American Spanish, clearly and evenly, like a news explainer. A single letter is read as its Spanish letter name. Read exactly the words given: do not add, skip or change any.",
};
const voiceFor = (lang) =>
  process.env["SOCIAL_TTS_VOICE_" + String(lang).toUpperCase()] || process.env.SOCIAL_TTS_VOICE || (lang === "zh" ? "nova" : "onyx");
// SOCIAL_TTS_MODEL, when set, is used alone. Otherwise the newer model first, the older one if it is refused.
const modelsToTry = () => process.env.SOCIAL_TTS_MODEL ? [process.env.SOCIAL_TTS_MODEL] : ["gpt-4o-mini-tts", "tts-1-hd"];
const takesInstructions = (model) => /^gpt-4o/.test(model);

function speechRequest(text, lang, model) {
  const body = { model, voice: voiceFor(lang), input: String(text), response_format: "mp3" };
  if (takesInstructions(model)) body.instructions = INSTRUCTIONS[lang] || INSTRUCTIONS.en;
  else body.speed = 1.0;
  return body;
}

/** Text → an MP3 file. Returns the model that produced it. */
async function synth(text, lang, outFile, { post = null } = {}) {
  const key = process.env.OPENAI_API_KEY;
  if (!key && !post) throw new Error("OPENAI_API_KEY is not set (needed for the voiceover)");
  const send = post || ((body) => require("axios").post("https://api.openai.com/v1/audio/speech", body,
    { headers: { Authorization: `Bearer ${key}` }, responseType: "arraybuffer", timeout: 60000 }));
  const models = modelsToTry();
  let lastErr = null;
  for (let i = 0; i < models.length; i++) {
    try {
      const r = await send(speechRequest(text, lang, models[i]));
      fs.writeFileSync(outFile, Buffer.from(r.data));
      return models[i];
    } catch (e) {
      lastErr = e;
      const status = e.response && e.response.status;
      // A refused model or field (400, 403, 404) is a reason to try the older model. Anything else is not.
      if (!(status === 400 || status === 403 || status === 404) || i === models.length - 1) break;
      console.warn(`[video-voice] ${models[i]} was refused (HTTP ${status}); using ${models[i + 1]}`);
    }
  }
  throw new Error("the voice could not be made: " + (lastErr && (lastErr.response ? "HTTP " + lastErr.response.status : lastErr.message)));
}

// ── 3. Listening back ────────────────────────────────────────

// A plain sentence in the language, given to the transcriber as context. For
// Chinese it is what makes the transcript come back in Simplified characters.
const HEAR_HINT = { zh: "以下是普通话的句子，使用简体中文。", en: "", es: "" };

/** An audio file → the words a transcriber hears in it, or null when it could not be asked. */
async function hear(file, lang) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return null;
  try {
    const form = new FormData();
    form.append("file", new Blob([fs.readFileSync(file)], { type: "audio/mpeg" }), "line.mp3");
    form.append("model", process.env.SOCIAL_HEAR_MODEL || "whisper-1");
    form.append("response_format", "text");
    form.append("language", lang === "zh" ? "zh" : lang === "es" ? "es" : "en");
    if (HEAR_HINT[lang]) form.append("prompt", HEAR_HINT[lang]);
    const res = await fetch("https://api.openai.com/v1/audio/transcriptions", { method: "POST", headers: { Authorization: `Bearer ${key}` }, body: form, signal: AbortSignal.timeout(60000) });
    if (!res.ok) { console.warn(`[video-voice] listening back failed (HTTP ${res.status})`); return null; }
    return (await res.text()).trim();
  } catch (e) { console.warn("[video-voice] listening back failed: " + e.message); return null; }
}

// A transcript sometimes comes back in Traditional characters. The common
// ones are folded to Simplified before comparing; pairs are traditional, simplified.
const T2S_PAIRS =
  "這这個个們们來来時时說说國国會会發发經经對对學学過过還还點点現现開开關关問问題题電电車车東东馬马風风語语實实體体樣样當当應应從从讓让間间聽听見见買买賣卖錢钱" +
  "簽签證证費费請请處处辦办護护資资產产業业務务師师條条規规則则權权稅税續续轉转變变報报審审庫库領领館馆親亲屬属離离結结婚婚總总統统黨党議议員员選选舉举" +
  "萬万億亿兩两幾几種种裡里後后麼么為为與与於于無无並并卻却僅仅雖虽難难樣样號号節节極极類类項项標标準准備备確确認认識识記记錄录訴诉訟讼證证據据庭庭" +
  "駁驳撤撤銷销遞递補补償偿賠赔罰罚違违憲宪聯联邦邦級级區区縣县鄉乡鎮镇廳厅處处長长專专職职勞劳動动傭佣僱雇廠厂廣广場场決决定定執执療疗醫医藥药" +
  "財财貨货幣币銀银貸贷帳账戶户額额債债繼继遺遗囑嘱贈赠購购價价值值漲涨倍倍調调減减增增計计劃划預预約约談谈訪访閱阅讀读寫写練练習习試试驗验" +
  "歲岁歷历曆历紀纪週周晝昼夜夜鐘钟頭头臉脸腦脑聲声響响視视頻频網网絡络線线機机構构設设製制術术運运輸输進进遠远邊边達达適适選选擇择遷迁歸归" +
  "國国內内華华僑侨難难民民庇庇護护遣遣返返拘拘留留釋释獄狱犯犯罪罪檢检查查警警衛卫軍军戰战爭争勝胜敗败贏赢輸输獲获獎奖勵励懲惩" +
  "嗎吗誰谁給给沒没著着塊块幫帮帶带張张單单雙双隻只該该夠够願愿愛爱氣气歡欢樂乐畫画書书紙纸筆笔飛飞魚鱼鳥鸟門门紅红綠绿藍蓝黃黄貓猫壞坏舊旧乾干濕湿";
const T2S = (() => { const m = new Map(); const a = Array.from(T2S_PAIRS); for (let i = 0; i + 1 < a.length; i += 2) if (a[i] !== a[i + 1]) m.set(a[i], a[i + 1]); return m; })();
const toSimplified = (s) => Array.from(String(s)).map(c => T2S.get(c) || c).join("");

const ZH_NUMERALS = /[〇零一二三四五六七八九十百千万亿两]/g;
function units(text, lang) {
  let s = String(text || "").normalize("NFKC").toLowerCase();
  if (lang === "zh") {
    // Numbers are left out on both sides: "十月十六日" is heard, correctly, as "10月16日".
    s = toSimplified(s).replace(ZH_NUMERALS, "");
    return Array.from(s).filter(c => CJK.test(c));
  }
  s = s.normalize("NFD").replace(/[̀-ͯ]/g, "");
  return s.replace(/[^a-z\s]/g, " ").split(/\s+/).filter(w => w.length > 1);          // single letters and digits fall away
}

/**
 * How much of what should have been said was heard: 0 to 1.
 * Each word (or Chinese character) of the script that turns up in the
 * transcript counts once. Numbers are ignored, because a transcriber writes
 * "16" for "sixteenth" and that is not a mistake.
 */
function agreement(say, heard, lang) {
  const want = units(say, lang);
  if (!want.length) return 1;                    // nothing checkable in the line
  const have = new Map();
  for (const u of units(heard, lang)) have.set(u, (have.get(u) || 0) + 1);
  let hit = 0;
  for (const u of want) { const n = have.get(u) || 0; if (n > 0) { hit++; have.set(u, n - 1); } }
  return hit / want.length;
}

const CLEAR = 0.6;       // at or above this, the line came back as written

/**
 * Speak one line and listen to it. Returns
 *   { checked, clear, score, heard, takes, model }
 * `checked` is false when listening back was not possible (no key, the
 * service did not answer); the audio is still made.
 */
async function speakChecked(text, lang, outFile, { synthFn = synth, hearFn = hear } = {}) {
  const retake = outFile + ".take2.mp3";
  const drop = (f) => { try { fs.unlinkSync(f); } catch (_) {} };
  let best = null;
  for (let take = 1; take <= 2; take++) {
    const file = take === 1 ? outFile : retake;
    const model = await synthFn(text, lang, file);
    const heard = await hearFn(file, lang);
    if (heard == null) {                           // cannot listen: keep what there is and say so
      if (take === 2) drop(retake);
      return best ? Object.assign(best, { takes: take }) : { checked: false, clear: null, score: null, heard: null, takes: 1, model };
    }
    const score = Math.round(agreement(text, heard, lang) * 100) / 100;
    if (!best || score > best.score) {
      if (take === 2) fs.copyFileSync(retake, outFile);      // the second take is the better one: it becomes the line
      best = { checked: true, clear: score >= CLEAR, score, heard, model };
    }
    best.takes = take;
    if (take === 2) drop(retake);
    if (best.clear) break;
  }
  return best;
}

/** One line for the approval message, from the per-scene results video() returns. */
function voiceReport(voice) {
  const rows = (voice || []).filter(Boolean);
  if (!rows.length) return "";
  if (rows.every(v => v.checked === false)) return "Voice check could not run, so listen to the whole video.";
  const unclear = rows.filter(v => v.checked && !v.clear);
  if (!unclear.length) return `Voice check: all ${rows.filter(v => v.checked).length} spoken lines came back as written.`;
  return "⚠️ Voice check: listen to line " + unclear.map(v => v.scene).join(", ") + ". " +
    unclear.slice(0, 2).map(v => `Line ${v.scene} was heard as “${String(v.heard || "").slice(0, 70)}”.`).join(" ");
}

module.exports = { LANGS, LANG_NAME, speechRules, checkSay, synth, hear, agreement, speakChecked, voiceReport, speechRequest, toSimplified, CLEAR };
