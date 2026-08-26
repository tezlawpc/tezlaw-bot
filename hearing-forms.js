// ============================================================
//  TEZ LAW P.C. — HEARING FORMS
//  ─────────────────────────────────────────────────────────
//  Admin forms for generating client-facing emails about
//  immigration hearings. v1 covers MASTER CALENDAR HEARINGS.
//
//  Workflow:
//    1. JJ fills out form at /admin/hearing/master
//    2. Zara generates a professionally-formatted email in
//       the client's preferred language (EN/ZH/ES/HI/PA)
//    3. JJ previews, copies to clipboard, pastes into Outlook,
//       addresses the email himself, sends
//    4. Record saved to master_hearings table for future reference
//
//  Languages supported:
//    - English (en)
//    - Chinese Simplified (zh)
//    - Spanish (es)
//    - Hindi (hi)     [flagged: attorney review recommended]
//    - Punjabi (pa)   [flagged: attorney review recommended]
// ============================================================

const db = require("./db");

// ── Schema ───────────────────────────────────────────────

async function initHearingTables() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS master_hearings (
      id                SERIAL PRIMARY KEY,
      client_name       TEXT NOT NULL,
      a_number          TEXT NOT NULL,
      language          TEXT NOT NULL DEFAULT 'en',
      hearing_datetime  TIMESTAMPTZ,
      court_location    TEXT,
      court_address     TEXT,
      judge_name        TEXT,
      case_type         TEXT,
      biometrics_needed BOOLEAN DEFAULT FALSE,
      what_to_bring     JSONB DEFAULT '[]'::jsonb,
      special_notes     TEXT,
      generated_email   TEXT,
      created_at        TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_master_hearings_created
      ON master_hearings (created_at DESC)
  `);
}

// ── Common EOIR Courts ───────────────────────────────────

const EOIR_COURTS = [
  {
    id: "la-olive",
    label: "Los Angeles — 606 S Olive St",
    address: "606 South Olive Street, 15th Floor, Los Angeles, CA 90014",
  },
  {
    id: "van-nuys",
    label: "Van Nuys",
    address: "15737 Van Nuys Boulevard, Van Nuys, CA 91406",
  },
  {
    id: "adelanto",
    label: "Adelanto (detained)",
    address: "Adelanto Detention Facility Immigration Court, 10250 Rancho Road, Adelanto, CA 92301",
  },
  {
    id: "san-diego",
    label: "San Diego",
    address: "880 Front Street, Suite 2246, San Diego, CA 92101",
  },
  {
    id: "otay-mesa",
    label: "Otay Mesa (detained)",
    address: "7488 Calzada de la Fuente, San Diego, CA 92154",
  },
  {
    id: "custom",
    label: "Other (enter manually)",
    address: "",
  },
];

// ── Templates ────────────────────────────────────────────

// Each template returns { subject, body } given a `data` object.
// The `data` object has: clientName, aNumber, hearingDate, hearingTime,
// courtLocation, courtAddress, judgeName, caseType, biometricsNeeded,
// whatToBring (array), specialNotes.

function formatDate(dateStr, lang) {
  if (!dateStr) return "";
  try {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return dateStr;
    const localeMap = { en: "en-US", zh: "zh-CN", es: "es-US", hi: "hi-IN", pa: "pa-IN" };
    return d.toLocaleDateString(localeMap[lang] || "en-US", {
      weekday: "long", year: "numeric", month: "long", day: "numeric",
    });
  } catch (e) {
    return dateStr;
  }
}

function formatTime(dateStr, lang) {
  if (!dateStr) return "";
  try {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return "";
    const localeMap = { en: "en-US", zh: "zh-CN", es: "es-US", hi: "hi-IN", pa: "pa-IN" };
    return d.toLocaleTimeString(localeMap[lang] || "en-US", {
      hour: "numeric", minute: "2-digit", hour12: true,
    });
  } catch (e) {
    return "";
  }
}

// Arrival = hearing time minus 30 min
function calcArrivalTime(dateStr, lang) {
  if (!dateStr) return "";
  try {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return "";
    d.setMinutes(d.getMinutes() - 30);
    return formatTime(d.toISOString(), lang);
  } catch (e) {
    return "";
  }
}

// ── English Template ────────────────────────────────────

function renderEnglish(data) {
  const {
    clientName, aNumber, hearingDate, hearingTime, arrivalTime,
    courtLocation, courtAddress, judgeName, caseType,
    biometricsNeeded, whatToBring, specialNotes,
  } = data;

  const subject = `Important: Your Master Calendar Hearing on ${hearingDate}`;

  const bringList = whatToBring.length
    ? whatToBring.map(item => `  • ${item}`).join("\n")
    : "  • Government-issued photo ID\n  • All immigration documents you have received";

  const biometricsBlock = biometricsNeeded ? `

BIOMETRICS REQUIRED
USCIS may require you to complete biometrics (fingerprints and photograph) in
connection with your case. If USCIS has sent you a biometrics appointment
notice, YOU MUST ATTEND that appointment. Failure to attend biometrics can
result in your case being denied. Please forward any USCIS biometrics
appointment notice to Attorney JJ Zhang immediately upon receipt.` : "";

  const notesBlock = specialNotes ? `

ADDITIONAL NOTES FROM YOUR ATTORNEY
${specialNotes}` : "";

  const body = `Dear ${clientName},

This letter is to remind you of your upcoming Master Calendar Hearing in Immigration Court.

HEARING DETAILS
Date: ${hearingDate}
Time: ${hearingTime}
Court: ${courtLocation}
Address: ${courtAddress}${judgeName ? `\nJudge: ${judgeName}` : ""}
A-Number: ${aNumber}${caseType ? `\nCase Type: ${caseType}` : ""}

ARRIVAL TIME
Please arrive no later than ${arrivalTime} (30 minutes before the hearing).
Security screening at the courthouse can take significant time. Being late may
result in the Immigration Judge ordering you removed in absentia.

WHAT TO BRING
${bringList}

WHAT TO WEAR
Please dress professionally. Business attire is expected. Do not wear
sunglasses, hats, or clothing with images or slogans.

ATTORNEY REPRESENTATION
Attorney JJ Zhang of Tez Law, P.C. will represent you at this hearing. Please
plan to meet Attorney Zhang inside the courthouse waiting area at the arrival
time listed above.${biometricsBlock}${notesBlock}

IF YOU CANNOT ATTEND
If for any emergency reason you cannot attend, contact our office IMMEDIATELY.
Missing a Master Calendar Hearing without proper legal excuse can result in
the Immigration Judge ordering you removed from the United States.

QUESTIONS
If you have any questions before the hearing, please contact us:
Phone: 626-678-8677
Email: jj@tezlawfirm.com

We look forward to seeing you at your hearing.

Sincerely,

JJ Zhang
Managing Attorney
Tez Law, P.C.
California Bar #326666
626-678-8677
jj@tezlawfirm.com
www.tezlawfirm.com`;

  return { subject, body };
}

// ── Chinese Template ────────────────────────────────────

function renderChinese(data) {
  const {
    clientName, aNumber, hearingDate, hearingTime, arrivalTime,
    courtLocation, courtAddress, judgeName, caseType,
    biometricsNeeded, whatToBring, specialNotes,
  } = data;

  const subject = `重要通知:您的移民法庭首次(Master Calendar)听证 - ${hearingDate}`;

  const bringList = whatToBring.length
    ? whatToBring.map(item => `  • ${item}`).join("\n")
    : "  • 政府颁发的带照片身份证件\n  • 您收到的所有移民相关文件";

  const biometricsBlock = biometricsNeeded ? `

生物特征采集(Biometrics)要求
USCIS 可能要求您完成生物特征采集(指纹和照片)。如果 USCIS 向您发送
生物特征采集预约通知,您必须按时前往。未能出席生物特征采集可能导致
您的案件被拒绝。请在收到 USCIS 生物特征采集通知后立即转发给
章律师。` : "";

  const notesBlock = specialNotes ? `

律师附加说明
${specialNotes}` : "";

  const body = `尊敬的 ${clientName}:

此信提醒您即将到来的移民法庭首次(Master Calendar)听证。

听证详情
日期: ${hearingDate}
时间: ${hearingTime}
法庭: ${courtLocation}
地址: ${courtAddress}${judgeName ? `\n法官: ${judgeName}` : ""}
A号码: ${aNumber}${caseType ? `\n案件类型: ${caseType}` : ""}

到达时间
请务必在 ${arrivalTime} 之前到达(听证开始前30分钟)。
法院的安检可能需要较长时间。如果迟到,移民法官可能会缺席判决您被驱逐出境。

需要携带的文件
${bringList}

着装要求
请穿正式服装(商务着装)。请勿戴太阳镜、帽子,或穿有图案或口号的衣服。

律师代理
Tez Law, P.C. 的章律师(JJ Zhang)将代表您出席此次听证。请按上述到达
时间在法院候审区与章律师会面。${biometricsBlock}${notesBlock}

如无法出席
如因紧急原因无法出席,请立即联系我们的办公室。无正当法律理由缺席
首次(Master Calendar)听证,可能导致移民法官下令将您驱逐出境。

有疑问请联系
如在听证前有任何疑问,请联系我们:
电话: 626-678-8677
邮箱: jj@tezlawfirm.com

期待在您的听证时与您相见。

此致

章律师 (JJ Zhang)
主管律师
Tez Law, P.C.
加州律师执照 #326666
626-678-8677
jj@tezlawfirm.com
www.tezlawfirm.com`;

  return { subject, body };
}

// ── Spanish Template ────────────────────────────────────

function renderSpanish(data) {
  const {
    clientName, aNumber, hearingDate, hearingTime, arrivalTime,
    courtLocation, courtAddress, judgeName, caseType,
    biometricsNeeded, whatToBring, specialNotes,
  } = data;

  const subject = `Importante: Su audiencia Master Calendar el ${hearingDate}`;

  const bringList = whatToBring.length
    ? whatToBring.map(item => `  • ${item}`).join("\n")
    : "  • Identificación con foto emitida por el gobierno\n  • Todos los documentos de inmigración que ha recibido";

  const biometricsBlock = biometricsNeeded ? `

BIOMÉTRICOS REQUERIDOS
USCIS puede requerir que complete los biométricos (huellas digitales y
fotografía) para su caso. Si USCIS le ha enviado una cita para biométricos,
DEBE ASISTIR. No asistir puede resultar en la denegación de su caso.
Por favor reenvíe cualquier aviso de cita de biométricos al abogado JJ Zhang
inmediatamente al recibirlo.` : "";

  const notesBlock = specialNotes ? `

NOTAS ADICIONALES DE SU ABOGADO
${specialNotes}` : "";

  const body = `Estimado/a ${clientName}:

Esta carta es para recordarle su próxima audiencia Master Calendar en la
Corte de Inmigración.

DETALLES DE LA AUDIENCIA
Fecha: ${hearingDate}
Hora: ${hearingTime}
Corte: ${courtLocation}
Dirección: ${courtAddress}${judgeName ? `\nJuez: ${judgeName}` : ""}
Número A: ${aNumber}${caseType ? `\nTipo de caso: ${caseType}` : ""}

HORA DE LLEGADA
Por favor llegue antes de las ${arrivalTime} (30 minutos antes de la audiencia).
La revisión de seguridad en el tribunal puede tomar tiempo considerable. Llegar
tarde puede resultar en que el Juez de Inmigración ordene su deportación
en ausencia.

QUÉ TRAER
${bringList}

QUÉ VESTIR
Por favor vista profesionalmente. Se espera vestimenta de negocios. No use
lentes de sol, sombreros ni ropa con imágenes o eslóganes.

REPRESENTACIÓN LEGAL
El abogado JJ Zhang de Tez Law, P.C. le representará en esta audiencia.
Por favor planee reunirse con el abogado Zhang en el área de espera dentro
del tribunal a la hora de llegada indicada arriba.${biometricsBlock}${notesBlock}

SI NO PUEDE ASISTIR
Si por alguna emergencia no puede asistir, contacte nuestra oficina
INMEDIATAMENTE. Faltar a una audiencia Master Calendar sin una excusa legal
apropiada puede resultar en que el Juez de Inmigración ordene su deportación
de los Estados Unidos.

PREGUNTAS
Si tiene preguntas antes de la audiencia, contáctenos:
Teléfono: 626-678-8677
Correo: jj@tezlawfirm.com

Esperamos verle en su audiencia.

Atentamente,

JJ Zhang
Abogado Administrador
Tez Law, P.C.
Barra de California #326666
626-678-8677
jj@tezlawfirm.com
www.tezlawfirm.com`;

  return { subject, body };
}

// ── Hindi Template ──────────────────────────────────────
// NOTE: Attorney should review with a native speaker before sending to clients.

function renderHindi(data) {
  const {
    clientName, aNumber, hearingDate, hearingTime, arrivalTime,
    courtLocation, courtAddress, judgeName, caseType,
    biometricsNeeded, whatToBring, specialNotes,
  } = data;

  const subject = `महत्वपूर्ण सूचना: आपकी मास्टर कैलेंडर सुनवाई - ${hearingDate}`;

  const bringList = whatToBring.length
    ? whatToBring.map(item => `  • ${item}`).join("\n")
    : "  • सरकार द्वारा जारी फोटो पहचान पत्र\n  • आपके पास मौजूद सभी इमिग्रेशन दस्तावेज़";

  const biometricsBlock = biometricsNeeded ? `

बायोमेट्रिक्स आवश्यक
USCIS आपके केस के लिए बायोमेट्रिक्स (फिंगरप्रिंट और फोटो) की आवश्यकता कर सकता है।
यदि USCIS ने आपको बायोमेट्रिक्स अपॉइंटमेंट नोटिस भेजा है, तो आपको उपस्थित होना
अनिवार्य है। बायोमेट्रिक्स में उपस्थित न होने से आपका केस खारिज हो सकता है।
कृपया USCIS बायोमेट्रिक्स नोटिस मिलते ही तुरंत अटॉर्नी JJ Zhang को अग्रेषित करें।` : "";

  const notesBlock = specialNotes ? `

आपके अटॉर्नी की अतिरिक्त टिप्पणी
${specialNotes}` : "";

  const body = `प्रिय ${clientName},

यह पत्र आपकी आगामी मास्टर कैलेंडर सुनवाई (इमिग्रेशन कोर्ट में) के बारे में
आपको स्मरण दिलाने के लिए है।

सुनवाई का विवरण
तारीख: ${hearingDate}
समय: ${hearingTime}
कोर्ट: ${courtLocation}
पता: ${courtAddress}${judgeName ? `\nजज: ${judgeName}` : ""}
A-नंबर: ${aNumber}${caseType ? `\nकेस का प्रकार: ${caseType}` : ""}

आगमन समय
कृपया ${arrivalTime} बजे तक कोर्ट पहुँच जाएँ (सुनवाई से 30 मिनट पहले)।
कोर्टहाउस में सुरक्षा जाँच में काफी समय लग सकता है। देर से आने पर इमिग्रेशन जज
अनुपस्थिति में आपको निर्वासित करने का आदेश दे सकते हैं।

क्या लाना है
${bringList}

क्या पहनना है
कृपया औपचारिक कपड़े पहनें (बिजनेस कैज़ुअल)। धूप के चश्मे, टोपी, या किसी छवि
या नारे वाले कपड़े न पहनें।

अटॉर्नी प्रतिनिधित्व
Tez Law, P.C. के अटॉर्नी JJ Zhang इस सुनवाई में आपका प्रतिनिधित्व करेंगे।
कृपया ऊपर दिए गए आगमन समय पर कोर्टहाउस के प्रतीक्षा क्षेत्र में अटॉर्नी Zhang
से मिलने की योजना बनाएँ।${biometricsBlock}${notesBlock}

यदि आप उपस्थित नहीं हो सकते
यदि किसी आपात कारण से आप उपस्थित नहीं हो सकते, तो तुरंत हमारे कार्यालय से
संपर्क करें। उचित कानूनी बहाने के बिना मास्टर कैलेंडर सुनवाई से अनुपस्थित रहने
पर इमिग्रेशन जज आपको संयुक्त राज्य अमेरिका से निर्वासित करने का आदेश दे सकते हैं।

प्रश्न
सुनवाई से पहले कोई प्रश्न होने पर, कृपया संपर्क करें:
फ़ोन: 626-678-8677
ईमेल: jj@tezlawfirm.com

हम आपकी सुनवाई में आपसे मिलने की प्रतीक्षा करेंगे।

सादर,

JJ Zhang
प्रबंध अटॉर्नी
Tez Law, P.C.
California Bar #326666
626-678-8677
jj@tezlawfirm.com
www.tezlawfirm.com`;

  return { subject, body };
}

// ── Punjabi Template ────────────────────────────────────
// NOTE: Attorney should review with a native speaker before sending to clients.

function renderPunjabi(data) {
  const {
    clientName, aNumber, hearingDate, hearingTime, arrivalTime,
    courtLocation, courtAddress, judgeName, caseType,
    biometricsNeeded, whatToBring, specialNotes,
  } = data;

  const subject = `ਜ਼ਰੂਰੀ ਸੂਚਨਾ: ਤੁਹਾਡੀ ਮਾਸਟਰ ਕੈਲੰਡਰ ਸੁਣਵਾਈ - ${hearingDate}`;

  const bringList = whatToBring.length
    ? whatToBring.map(item => `  • ${item}`).join("\n")
    : "  • ਸਰਕਾਰ ਦੁਆਰਾ ਜਾਰੀ ਕੀਤਾ ਫੋਟੋ ਪਛਾਣ ਪੱਤਰ\n  • ਤੁਹਾਡੇ ਕੋਲ ਮੌਜੂਦ ਸਾਰੇ ਇਮੀਗ੍ਰੇਸ਼ਨ ਦਸਤਾਵੇਜ਼";

  const biometricsBlock = biometricsNeeded ? `

ਬਾਇਓਮੈਟ੍ਰਿਕਸ ਲੋੜੀਂਦੇ ਹਨ
USCIS ਤੁਹਾਡੇ ਕੇਸ ਲਈ ਬਾਇਓਮੈਟ੍ਰਿਕਸ (ਫਿੰਗਰਪ੍ਰਿੰਟ ਅਤੇ ਫੋਟੋ) ਦੀ ਮੰਗ ਕਰ ਸਕਦਾ ਹੈ।
ਜੇ USCIS ਨੇ ਤੁਹਾਨੂੰ ਬਾਇਓਮੈਟ੍ਰਿਕਸ ਅਪਾਇੰਟਮੈਂਟ ਦਾ ਨੋਟਿਸ ਭੇਜਿਆ ਹੈ, ਤਾਂ ਤੁਹਾਨੂੰ
ਹਾਜ਼ਰ ਹੋਣਾ ਜ਼ਰੂਰੀ ਹੈ। ਹਾਜ਼ਰ ਨਾ ਹੋਣ ਨਾਲ ਤੁਹਾਡਾ ਕੇਸ ਰੱਦ ਹੋ ਸਕਦਾ ਹੈ। ਕਿਰਪਾ ਕਰਕੇ
USCIS ਬਾਇਓਮੈਟ੍ਰਿਕਸ ਨੋਟਿਸ ਮਿਲਦੇ ਹੀ ਤੁਰੰਤ ਵਕੀਲ JJ Zhang ਨੂੰ ਭੇਜੋ।` : "";

  const notesBlock = specialNotes ? `

ਤੁਹਾਡੇ ਵਕੀਲ ਦੀਆਂ ਵਾਧੂ ਟਿੱਪਣੀਆਂ
${specialNotes}` : "";

  const body = `ਪਿਆਰੇ ${clientName},

ਇਹ ਪੱਤਰ ਤੁਹਾਡੀ ਆਉਣ ਵਾਲੀ ਮਾਸਟਰ ਕੈਲੰਡਰ ਸੁਣਵਾਈ (ਇਮੀਗ੍ਰੇਸ਼ਨ ਕੋਰਟ ਵਿੱਚ)
ਬਾਰੇ ਯਾਦ ਦਿਵਾਉਣ ਲਈ ਹੈ।

ਸੁਣਵਾਈ ਦੇ ਵੇਰਵੇ
ਤਾਰੀਖ: ${hearingDate}
ਸਮਾਂ: ${hearingTime}
ਕੋਰਟ: ${courtLocation}
ਪਤਾ: ${courtAddress}${judgeName ? `\nਜੱਜ: ${judgeName}` : ""}
A-ਨੰਬਰ: ${aNumber}${caseType ? `\nਕੇਸ ਦੀ ਕਿਸਮ: ${caseType}` : ""}

ਆਉਣ ਦਾ ਸਮਾਂ
ਕਿਰਪਾ ਕਰਕੇ ${arrivalTime} ਤੱਕ ਕੋਰਟ ਪਹੁੰਚ ਜਾਓ (ਸੁਣਵਾਈ ਤੋਂ 30 ਮਿੰਟ ਪਹਿਲਾਂ)।
ਕੋਰਟਹਾਊਸ ਵਿੱਚ ਸੁਰੱਖਿਆ ਜਾਂਚ ਵਿੱਚ ਕਾਫ਼ੀ ਸਮਾਂ ਲੱਗ ਸਕਦਾ ਹੈ। ਦੇਰੀ ਨਾਲ ਆਉਣ ਤੇ
ਇਮੀਗ੍ਰੇਸ਼ਨ ਜੱਜ ਗੈਰ-ਹਾਜ਼ਰੀ ਵਿੱਚ ਤੁਹਾਨੂੰ ਦੇਸ਼ ਨਿਕਾਲਾ ਦੇਣ ਦਾ ਹੁਕਮ ਦੇ ਸਕਦਾ ਹੈ।

ਕੀ ਲਿਆਉਣਾ ਹੈ
${bringList}

ਕੀ ਪਹਿਨਣਾ ਹੈ
ਕਿਰਪਾ ਕਰਕੇ ਰਸਮੀ ਕੱਪੜੇ ਪਹਿਨੋ (ਬਿਜ਼ਨਸ ਪਹਿਰਾਵਾ)। ਧੁੱਪ ਦੀਆਂ ਐਨਕਾਂ, ਟੋਪੀ, ਜਾਂ
ਕਿਸੇ ਵੀ ਤਸਵੀਰ ਜਾਂ ਨਾਅਰੇ ਵਾਲੇ ਕੱਪੜੇ ਨਾ ਪਹਿਨੋ।

ਵਕੀਲ ਦੀ ਪ੍ਰਤੀਨਿਧਤਾ
Tez Law, P.C. ਦੇ ਵਕੀਲ JJ Zhang ਇਸ ਸੁਣਵਾਈ ਵਿੱਚ ਤੁਹਾਡੀ ਪ੍ਰਤੀਨਿਧਤਾ ਕਰਨਗੇ।
ਕਿਰਪਾ ਕਰਕੇ ਉੱਪਰ ਦਿੱਤੇ ਗਏ ਆਉਣ ਦੇ ਸਮੇਂ ਤੇ ਕੋਰਟਹਾਊਸ ਦੇ ਉਡੀਕ ਖੇਤਰ ਵਿੱਚ
ਵਕੀਲ Zhang ਨੂੰ ਮਿਲਣ ਦੀ ਯੋਜਨਾ ਬਣਾਓ।${biometricsBlock}${notesBlock}

ਜੇ ਤੁਸੀਂ ਹਾਜ਼ਰ ਨਹੀਂ ਹੋ ਸਕਦੇ
ਜੇ ਕਿਸੇ ਐਮਰਜੈਂਸੀ ਕਾਰਨ ਤੁਸੀਂ ਹਾਜ਼ਰ ਨਹੀਂ ਹੋ ਸਕਦੇ, ਤਾਂ ਤੁਰੰਤ ਸਾਡੇ ਦਫ਼ਤਰ ਨਾਲ
ਸੰਪਰਕ ਕਰੋ। ਸਹੀ ਕਾਨੂੰਨੀ ਕਾਰਨ ਤੋਂ ਬਿਨਾਂ ਮਾਸਟਰ ਕੈਲੰਡਰ ਸੁਣਵਾਈ ਤੋਂ ਗੈਰ-ਹਾਜ਼ਰ
ਰਹਿਣ ਤੇ ਇਮੀਗ੍ਰੇਸ਼ਨ ਜੱਜ ਤੁਹਾਨੂੰ ਸੰਯੁਕਤ ਰਾਜ ਅਮਰੀਕਾ ਤੋਂ ਦੇਸ਼ ਨਿਕਾਲੇ ਦਾ ਹੁਕਮ
ਦੇ ਸਕਦਾ ਹੈ।

ਸਵਾਲ
ਸੁਣਵਾਈ ਤੋਂ ਪਹਿਲਾਂ ਕੋਈ ਸਵਾਲ ਹੋਵੇ ਤਾਂ ਕਿਰਪਾ ਕਰਕੇ ਸੰਪਰਕ ਕਰੋ:
ਫ਼ੋਨ: 626-678-8677
ਈਮੇਲ: jj@tezlawfirm.com

ਅਸੀਂ ਤੁਹਾਡੀ ਸੁਣਵਾਈ ਵਿੱਚ ਤੁਹਾਨੂੰ ਮਿਲਣ ਦੀ ਉਡੀਕ ਕਰਦੇ ਹਾਂ।

ਸਤਿਕਾਰ ਨਾਲ,

JJ Zhang
ਪ੍ਰਬੰਧਕ ਵਕੀਲ
Tez Law, P.C.
California Bar #326666
626-678-8677
jj@tezlawfirm.com
www.tezlawfirm.com`;

  return { subject, body };
}

// ── Template Dispatcher ─────────────────────────────────

function generateEmail(data) {
  const lang = data.language || "en";
  // Prepare formatted date/time
  const preparedData = {
    ...data,
    hearingDate: formatDate(data.hearing_datetime, lang),
    hearingTime: formatTime(data.hearing_datetime, lang),
    arrivalTime: calcArrivalTime(data.hearing_datetime, lang),
    whatToBring: data.what_to_bring || [],
    clientName: data.client_name,
    aNumber: data.a_number,
    courtLocation: data.court_location,
    courtAddress: data.court_address,
    judgeName: data.judge_name,
    caseType: data.case_type,
    biometricsNeeded: !!data.biometrics_needed,
    specialNotes: data.special_notes,
  };

  const renderers = {
    en: renderEnglish,
    zh: renderChinese,
    es: renderSpanish,
    hi: renderHindi,
    pa: renderPunjabi,
  };

  const renderer = renderers[lang] || renderEnglish;
  return renderer(preparedData);
}

// ── Storage ──────────────────────────────────────────────

async function saveHearing(data) {
  await initHearingTables();
  const generated = generateEmail(data);
  const r = await db.query(
    `INSERT INTO master_hearings
      (client_name, a_number, language, hearing_datetime, court_location, court_address,
       judge_name, case_type, biometrics_needed, what_to_bring, special_notes, generated_email)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12)
     RETURNING id`,
    [
      data.client_name, data.a_number, data.language,
      data.hearing_datetime || null,
      data.court_location, data.court_address,
      data.judge_name || null, data.case_type || null,
      !!data.biometrics_needed,
      JSON.stringify(data.what_to_bring || []),
      data.special_notes || null,
      `Subject: ${generated.subject}\n\n${generated.body}`,
    ]
  );
  return { id: r.rows[0].id, ...generated };
}

async function listHearings(limit = 30) {
  await initHearingTables();
  const r = await db.query(
    `SELECT id, client_name, a_number, language, hearing_datetime,
       court_location, judge_name, biometrics_needed, created_at
     FROM master_hearings
     ORDER BY created_at DESC LIMIT $1`,
    [limit]
  );
  return r.rows;
}

async function getHearing(id) {
  await initHearingTables();
  const r = await db.query(`SELECT * FROM master_hearings WHERE id = $1`, [id]);
  return r.rows[0];
}

// ── HTML Admin Form ──────────────────────────────────────

function renderAdminForm({ generated = null, saved = false, error = null, previousInputs = {} } = {}) {
  const prev = previousInputs;
  const courtOptions = EOIR_COURTS.map(c =>
    `<option value="${c.id}" ${prev.court_id === c.id ? "selected" : ""}>${c.label}</option>`
  ).join("");

  const langOptions = [
    { v: "en", l: "English" },
    { v: "zh", l: "中文 (Chinese)" },
    { v: "es", l: "Español (Spanish)" },
    { v: "hi", l: "हिन्दी (Hindi)" },
    { v: "pa", l: "ਪੰਜਾਬੀ (Punjabi)" },
  ].map(o => `<option value="${o.v}" ${prev.language === o.v ? "selected" : ""}>${o.l}</option>`).join("");

  const defaultBring = [
    "Government-issued photo ID",
    "All USCIS documents received (I-862 NTA, receipts, notices)",
    "Original identity documents from home country (if available)",
    "Any documents your attorney has requested",
  ];

  const previewSection = generated ? `
    <div style="background:#f9f9f9; padding:20px; margin:20px 0; border-left:4px solid #B79C62;">
      <h2 style="margin-top:0;">📧 Generated Email Preview</h2>
      <div style="background:white; padding:15px; border-radius:4px;">
        <strong>Subject:</strong> ${escapeHtml(generated.subject)}
        <hr>
        <pre id="email-body" style="white-space:pre-wrap; font-family:inherit; margin:0;">${escapeHtml(generated.body)}</pre>
      </div>
      <div style="margin-top:15px;">
        <button type="button" onclick="copyToClipboard()" style="background:#0C1C36; color:white; padding:12px 30px; border:none; border-radius:4px; font-size:16px; cursor:pointer;">📋 Copy Email To Clipboard</button>
        <span id="copy-status" style="margin-left:15px; color:#4CAF50; font-weight:bold;"></span>
      </div>
      ${saved ? '<p style="color:#4CAF50; margin-top:10px;">✅ Record saved to database.</p>' : ""}
    </div>
    <script>
      function copyToClipboard() {
        const subject = ${JSON.stringify(generated.subject)};
        const body = ${JSON.stringify(generated.body)};
        const full = "Subject: " + subject + "\\n\\n" + body;
        navigator.clipboard.writeText(full).then(() => {
          document.getElementById("copy-status").textContent = "✅ Copied!";
          setTimeout(() => document.getElementById("copy-status").textContent = "", 3000);
        });
      }
    </script>
  ` : "";

  const errorSection = error ? `
    <div style="background:#ffebee; padding:15px; border-left:4px solid #c00; margin:15px 0;">
      <strong>⚠️ Error:</strong> ${escapeHtml(error)}
    </div>
  ` : "";

  return `
<!DOCTYPE html>
<html>
<head>
  <title>Master Hearing Form — Tez Law Zara</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; max-width: 800px; margin: 30px auto; padding: 20px; color: #333; }
    h1 { color: #0C1C36; border-bottom: 3px solid #B79C62; padding-bottom: 10px; }
    h2 { color: #B79C62; }
    label { display: block; margin: 12px 0 4px; font-weight: 600; }
    input[type="text"], input[type="datetime-local"], select, textarea {
      width: 100%; padding: 10px; margin: 4px 0; box-sizing: border-box;
      border: 1px solid #ccc; border-radius: 4px; font-size: 14px;
      font-family: inherit;
    }
    textarea { min-height: 80px; }
    input[type="checkbox"] { margin-right: 8px; transform: scale(1.2); }
    .checkbox-row { margin: 6px 0; }
    .button-row { margin-top: 25px; display: flex; gap: 10px; flex-wrap: wrap; }
    button {
      padding: 12px 24px; font-size: 15px; border-radius: 4px; cursor: pointer;
      border: none; font-family: inherit;
    }
    button[type="submit"] { background: #B79C62; color: white; }
    button[type="submit"]:hover { background: #8f7a4c; }
    button.secondary { background: #eee; color: #333; }
    .warn {
      background: #fff3cd; padding: 12px; border-left: 4px solid #ffc107;
      margin: 15px 0; border-radius: 4px;
    }
    .hint { color: #666; font-size: 13px; font-style: italic; margin: 2px 0; }
    fieldset { border: 1px solid #ddd; padding: 15px; margin: 15px 0; border-radius: 4px; }
    legend { font-weight: 600; color: #0C1C36; padding: 0 8px; }
  </style>
</head>
<body>
  <h1>📅 Master Calendar Hearing — Client Email</h1>
  <p>Fill out the form below. Zara will generate a professional email in the client's preferred language. You'll copy it to your clipboard, paste into Outlook, address it to the client, and send.</p>

  ${errorSection}
  ${previewSection}

  <form method="POST" action="/admin/hearing/master">
    <fieldset>
      <legend>Client</legend>

      <label>Full name *</label>
      <input type="text" name="client_name" required placeholder="e.g. Chen, Xifen" value="${escapeAttr(prev.client_name)}">

      <label>A-Number *</label>
      <input type="text" name="a_number" required placeholder="e.g. A123-456-789" value="${escapeAttr(prev.a_number)}">

      <label>Preferred language *</label>
      <select name="language" required>
        ${langOptions}
      </select>
      <div class="hint">Hindi and Punjabi templates should be reviewed by a native speaker before sending to clients.</div>
    </fieldset>

    <fieldset>
      <legend>Hearing</legend>

      <label>Date and time *</label>
      <input type="datetime-local" name="hearing_datetime" required value="${escapeAttr(prev.hearing_datetime)}">

      <label>Court</label>
      <select name="court_id" onchange="fillCourt(this.value)">
        <option value="">-- select --</option>
        ${courtOptions}
      </select>

      <label>Court location (short name)</label>
      <input type="text" name="court_location" id="court_location" placeholder="e.g. Los Angeles Immigration Court" value="${escapeAttr(prev.court_location)}">

      <label>Court address</label>
      <textarea name="court_address" id="court_address" rows="2">${escapeHtml(prev.court_address || "")}</textarea>

      <label>Judge name (optional)</label>
      <input type="text" name="judge_name" placeholder="e.g. Hon. Kevin Riley" value="${escapeAttr(prev.judge_name)}">

      <label>Case type (optional)</label>
      <input type="text" name="case_type" placeholder="e.g. Asylum, Cancellation of Removal, LPR Cancellation" value="${escapeAttr(prev.case_type)}">
    </fieldset>

    <fieldset>
      <legend>Biometrics</legend>
      <div class="checkbox-row">
        <label style="display:inline-flex; align-items:center; font-weight:normal;">
          <input type="checkbox" name="biometrics_needed" value="1" ${prev.biometrics_needed ? "checked" : ""}>
          Biometrics (fingerprints) are required for this case
        </label>
      </div>
      <div class="hint">If checked, the email will include instructions to attend any USCIS biometrics appointment and forward the appointment notice to your attorney.</div>
    </fieldset>

    <fieldset>
      <legend>What to bring</legend>
      <p class="hint">Pre-checked items will be included in the email. Add case-specific items in the "Additional items" box.</p>
      ${defaultBring.map((item, i) => `
        <div class="checkbox-row">
          <label style="display:inline-flex; align-items:center; font-weight:normal;">
            <input type="checkbox" name="bring_default_${i}" value="1" checked>
            ${escapeHtml(item)}
          </label>
        </div>
      `).join("")}

      <label>Additional items (one per line)</label>
      <textarea name="bring_extra" rows="3" placeholder="e.g. Passport&#10;Client declaration signed and notarized&#10;Country conditions report">${escapeHtml(prev.bring_extra || "")}</textarea>
    </fieldset>

    <fieldset>
      <legend>Special notes to client</legend>
      <label>Attorney's additional message (optional)</label>
      <textarea name="special_notes" rows="4" placeholder="Any case-specific instructions, e.g. 'Please review Form I-589 attached and bring signed copy to hearing.'">${escapeHtml(prev.special_notes || "")}</textarea>
    </fieldset>

    <div class="button-row">
      <button type="submit" name="action" value="preview">👁️ Preview Email</button>
      <button type="submit" name="action" value="save">💾 Preview + Save</button>
      <button type="reset" class="secondary">Clear</button>
    </div>
  </form>

  <p style="margin-top:30px; color:#888; font-size:13px;">
    <a href="/admin/hearing/master/history">View past hearings →</a>
  </p>

  <script>
    const COURTS = ${JSON.stringify(EOIR_COURTS.reduce((acc, c) => { acc[c.id] = c; return acc; }, {}))};
    function fillCourt(id) {
      const c = COURTS[id];
      if (!c || id === "custom") return;
      document.getElementById("court_location").value = c.label;
      document.getElementById("court_address").value = c.address;
    }
  </script>
</body>
</html>
  `;
}

function renderHistoryPage(hearings) {
  const rows = hearings.length ? hearings.map(h => `
    <tr>
      <td>#${h.id}</td>
      <td>${escapeHtml(h.client_name)}</td>
      <td>${escapeHtml(h.a_number)}</td>
      <td>${h.language}</td>
      <td>${h.hearing_datetime ? new Date(h.hearing_datetime).toLocaleString() : "-"}</td>
      <td>${escapeHtml(h.court_location || "")}</td>
      <td>${h.biometrics_needed ? "yes" : "no"}</td>
      <td>${new Date(h.created_at).toLocaleDateString()}</td>
      <td><a href="/admin/hearing/master/${h.id}">view</a></td>
    </tr>
  `).join("") : `<tr><td colspan="9" style="text-align:center; color:#888;">No hearings recorded yet.</td></tr>`;

  return `
<!DOCTYPE html>
<html>
<head>
  <title>Master Hearing History — Tez Law Zara</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; max-width: 1100px; margin: 30px auto; padding: 20px; }
    h1 { color: #0C1C36; border-bottom: 3px solid #B79C62; padding-bottom: 10px; }
    table { width: 100%; border-collapse: collapse; margin: 20px 0; }
    th, td { padding: 10px; text-align: left; border-bottom: 1px solid #eee; }
    th { background: #f5f5f5; color: #0C1C36; }
    tr:hover { background: #fafafa; }
    a.button { display: inline-block; padding: 10px 20px; background: #B79C62; color: white; text-decoration: none; border-radius: 4px; }
  </style>
</head>
<body>
  <h1>📅 Master Hearing History</h1>
  <p><a href="/admin/hearing/master" class="button">← Back to form</a></p>
  <table>
    <thead>
      <tr>
        <th>ID</th><th>Client</th><th>A-Number</th><th>Lang</th>
        <th>Hearing</th><th>Court</th><th>Biometrics</th><th>Created</th><th></th>
      </tr>
    </thead>
    <tbody>
      ${rows}
    </tbody>
  </table>
</body>
</html>
  `;
}

function renderDetailPage(hearing) {
  if (!hearing) {
    return `<html><body><h1>Not found</h1><p><a href="/admin/hearing/master/history">← Back</a></p></body></html>`;
  }
  return `
<!DOCTYPE html>
<html>
<head>
  <title>Hearing #${hearing.id} — Tez Law Zara</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; max-width: 800px; margin: 30px auto; padding: 20px; }
    h1 { color: #0C1C36; border-bottom: 3px solid #B79C62; padding-bottom: 10px; }
    .meta { background: #f5f5f5; padding: 15px; border-radius: 4px; margin: 15px 0; }
    .meta div { margin: 4px 0; }
    pre { background: white; padding: 15px; border: 1px solid #ddd; border-radius: 4px;
          white-space: pre-wrap; font-family: inherit; }
    a { color: #B79C62; }
    button { background: #0C1C36; color: white; padding: 10px 20px; border: none; border-radius: 4px; cursor: pointer; }
  </style>
</head>
<body>
  <h1>Hearing #${hearing.id}</h1>
  <p><a href="/admin/hearing/master/history">← Back to history</a> · <a href="/admin/hearing/master">New form</a></p>
  <div class="meta">
    <div><strong>Client:</strong> ${escapeHtml(hearing.client_name)}</div>
    <div><strong>A-Number:</strong> ${escapeHtml(hearing.a_number)}</div>
    <div><strong>Language:</strong> ${hearing.language}</div>
    <div><strong>Hearing:</strong> ${hearing.hearing_datetime ? new Date(hearing.hearing_datetime).toLocaleString() : "-"}</div>
    <div><strong>Court:</strong> ${escapeHtml(hearing.court_location || "-")}</div>
    <div><strong>Judge:</strong> ${escapeHtml(hearing.judge_name || "-")}</div>
    <div><strong>Case type:</strong> ${escapeHtml(hearing.case_type || "-")}</div>
    <div><strong>Biometrics required:</strong> ${hearing.biometrics_needed ? "Yes" : "No"}</div>
    <div><strong>Generated:</strong> ${new Date(hearing.created_at).toLocaleString()}</div>
  </div>
  <h2>Generated email</h2>
  <button type="button" onclick="copyContent()">📋 Copy to clipboard</button>
  <pre id="content">${escapeHtml(hearing.generated_email || "")}</pre>
  <script>
    function copyContent() {
      navigator.clipboard.writeText(document.getElementById("content").textContent);
      alert("Copied!");
    }
  </script>
</body>
</html>
  `;
}

// ── Utilities ────────────────────────────────────────────

function escapeHtml(s) {
  if (s === null || s === undefined) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeAttr(s) {
  return escapeHtml(s);
}

// ── Parse Form Submission ───────────────────────────────

function parseFormSubmission(body) {
  const defaultBringLabels = [
    "Government-issued photo ID",
    "All USCIS documents received (I-862 NTA, receipts, notices)",
    "Original identity documents from home country (if available)",
    "Any documents your attorney has requested",
  ];
  const bringSelected = [];
  for (let i = 0; i < defaultBringLabels.length; i++) {
    if (body[`bring_default_${i}`]) bringSelected.push(defaultBringLabels[i]);
  }
  const extraItems = (body.bring_extra || "")
    .split(/\n+/).map(s => s.trim()).filter(Boolean);
  const whatToBring = [...bringSelected, ...extraItems];

  return {
    client_name: (body.client_name || "").trim(),
    a_number: (body.a_number || "").trim(),
    language: body.language || "en",
    hearing_datetime: body.hearing_datetime || null,
    court_id: body.court_id || null,
    court_location: (body.court_location || "").trim(),
    court_address: (body.court_address || "").trim(),
    judge_name: (body.judge_name || "").trim(),
    case_type: (body.case_type || "").trim(),
    biometrics_needed: !!body.biometrics_needed,
    what_to_bring: whatToBring,
    bring_extra: body.bring_extra || "",
    special_notes: (body.special_notes || "").trim(),
  };
}

// ── Exports ──────────────────────────────────────────────

module.exports = {
  initHearingTables,
  generateEmail,
  saveHearing,
  listHearings,
  getHearing,
  renderAdminForm,
  renderHistoryPage,
  renderDetailPage,
  parseFormSubmission,
  EOIR_COURTS,
};
