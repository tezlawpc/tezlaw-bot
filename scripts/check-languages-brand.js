/**
 * check-languages-brand.js
 *
 * Two things that drift quietly:
 *
 *  1. The consultant portal speaks English and Simplified Chinese. A phrase
 *     added in one language and forgotten in the other shows the wrong
 *     language (or a raw key) on a real page. Every phrase must exist in both,
 *     every alert kind must have its Chinese wording, and the Chinese must be
 *     Simplified — the firm's rule.
 *
 *  2. The firm's own pages were redrawn in the TEZ brand (charcoal, marble,
 *     Seal Orange, Ember; Cormorant Garamond and Montserrat). The old walnut
 *     and navy-and-gold palettes, and the Cinzel face, must not creep back
 *     into the frame every page shares.
 */
const fs = require("fs");
const path = require("path");

let failures = 0;
function ok(name, cond, detail) {
  if (cond) console.log("  ok   " + name);
  else { failures++; console.log("  FAIL " + name + (detail !== undefined ? "  → " + JSON.stringify(detail).slice(0, 400) : "")); }
}
const REPO = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(REPO, f), "utf8");
const stub = (rel, exports) => { const id = require.resolve(rel); require.cache[id] = { id, filename: id, loaded: true, exports }; };
stub("../db", { query: async () => ({ rows: [] }), logAudit: async () => {} });

// The common characters that are written differently in Traditional Chinese
// and are not also Simplified characters in their own right (1,900 of them:
// the everyday set, from the OpenCC conversion table). Any of these on a
// page means a Traditional phrase was pasted in.
const TRADITIONAL = new RegExp("[" + "丟並亂亙亞佇佈佔併來侖侶侷係俠倀倆倉個們倖倫偉側偵偽傑傖傘備傢傭傯傳債傷傾僅僑僕僥僱價儀儂億儈儉儐儔儕儘償優儲儷儸儻儼兇兌兒兗內兩冊冑冪凍凜凱別刪則剎剛剝剴創剷劃劇劉劊劍劑勁動務勛勝勞勢勣勳勵勸勻匯匱區協卹卻厭厲參叢吒吳吶呂員唸問啞啟喚喪喫喬單喲嗆嗇嗎嗚嗶嘆嘍嘔嘖嘗嘩嘮嘯嘰噓噥噯噴噸噹嚀嚇嚐嚕嚥嚨嚮嚴嚶囀囁囂囈囉囌囑囪國圍園圓圖團執堅堊堝堯報場塊塋塒塗塚塢塵塹墊墜墮墳墾壇壎壓壘壙壞壟壢壩壯壺壽夠夢夾奐奧奩奪奮妝姍姦娛婁婦媧媼媽嫗嫵嫻嬈嬋嬌嬤嬪嬰嬸孃孫學孿宮寢實寧審寫寬寵寶將專尋對導尷屆屍屜屢層屨屬岡峴島峽崑崗崙崢嵐嶄嶇嶔嶸嶺嶼嶽巒巔巖帥師帳帶幀幃幗幟幣幫幹幾庫廁廂廄廈廚廝廟廠廢廣廬廳弒弔張強彆彈彌彎彙彥彫彿後徑從徠復徹恆恥悅悵悶悽惡惱惻愛愜愴愷愾慄態慍慘慚慟慣慫慮慶慼慾憂憊憐憑憚憤憫憮憲憶懇應懍懣懲懶懷懸懺懼懾戀戰戲戶拋挾捨捫捱捲掃掄掙掛採揀揚換揮損搖搗搶摑摟摯摺摻撈撐撓撥撫撲撳撻撾撿擁擄擇擊擋擔據擠擬擰擱擲擴擷擺擻擾攆攏攔攙攜攝攣攤攪攬敗敘敵數斂斃斕斬斷昇時晉晝暈暉暘暢暫曄曆曇曉曖曠曬書會朧朮東枴柵桿梔條梟棄棗棟棧棲楊楓楨業極榦榮構槍槓槨槳樁樂樅樑樓標樞樣樸樹樺橈橋機橢橫檔檜檢檣檮檯檳檸檻櫃櫓櫚櫛櫝櫥櫬櫻欄權欐欖欽歎歐歟歡歲歷歸歿殘殤殮殯殲殺殼毀毆氈氣氫氬氳氾汎汙決沒沖況洩洶浹涇涼淒淚淨淪淵淺渙減渦測渾湊湧湯準溝溫溼滄滅滌滬滯滲滷滾滿漁漢漣漬漲漸漿潑潔潛潤潯潰澀澆澗澠澤澦澱濁濃濕濘濛濟濤濫濰濱濺濾瀆瀉瀋瀏瀕瀘瀝瀟瀨瀰瀲瀾灑灘灣灤災為烏無煉煙煥煩煬熒熱熾燈燉燒燙燜營燦燬燭燴燻燼燾爍爐爛爭爺爾牆牘牽犖犛犢犧狀狹狽猙猶獄獅獎獨獰獲獵獷獸獺獻玀現琺琿瑣瑤瑩瑪璣璦環璽璿瓊瓏瓔瓚甌甕產甦畝畢畫異當疇疊痙痠瘋瘍瘓瘡瘧瘺療癆癒癘癟癡癢癥癩癬癮癱癲發皚皰皺盃盜盞盡監盤盧盪眾睏睜睞瞞瞼矇矓矚矯硃硯碩確碼磚磧磯礎礙礦礪礫礬祕祿禍禎禦禪禮禱禿秈稅稈稜稟種稱穀穌積穎穠穡穢穩穫窩窪窮窯窺竄竅竇竊競筆筍筧箇箋箏節範築篠篤篩簍簑簞簡簣簫簽簾籃籌籟籠籤籬籮籲粵糝糞糧糰糾紀紂約紅紆紇紉紋納紐純紕紗紙級紛紜紡紮細紱紲紳紹紼絀終絃組絆結絕絛絞絡絢給絨絰統絲絳絹綁綏綑經綜綞綠綢綬維綰綱網綴綵綸綺綻綽綾綿緇緊緒緘緙線緝緞締緣編緩緬緯緲練緹緻縈縉縊縐縑縛縝縞縣縫縮縯縱縲縴縵縷縹總績繃繅繆繈繒織繕繚繞繡繩繪繫繭繳繹繼繽續纏纓纔纖纜缽罈罌罰罵罷羅羈羋羨義羶習翹聖聞聯聰聲聳聶職聽聾肅脅脈脣脩脫脹腎腦腫腳腸膚膠膩膽膾膿臉臍臏臘臚臟臢臥臨臺與興舉舊艙艦艱艷芻茲荊莊莖莢莧華菴菸萇萊萬萵葉葦葷蒐蒞蒼蓀蓆蓋蓮蔔蔣蔥蔭蕩蕪蕭薊薑薔薦薩薺藍藝藥藪藷藹藺蘆蘇蘊蘋蘚蘭蘿處虛虜號虧蛻蜆蝕蝦蝨蝸螞螢螻蟈蟬蟯蟲蟻蠅蠍蠔蠟蠣蠱蠶蠻術衛衝袞裊補裝裡製複褲褸褻襖襠襤襪襬襯襲見規覓視覦親覬覲覺覽觀觴觸訂訃計訊訌討訏訐訑訓訕訖託記訛訝訟訢訣訥訪設許訴訶診註証詁詆詐詔評詖詛詞詠詢詣試詩詫詬詭詮詰話該詳詼誅誇誌認誑誕誘誚語誠誡誣誤誥誦誨說誰課誶誹誼調諂諄談諉請諍諒論諛諜諦諧諫諭諮諱諳諶諷諸諺諼諾謀謁謂謄謊謎謐謗謙講謝謠謨謫謬謹譁譆證譎譏識譙譚譜譟譫譯議譴護譽讀變讒讓讖讚讜豈豎豐豔豬貓貝貞負財貢貧貨販貪貫責貯貲貳貴貶買貸費貼貽貿賀賁賂賃賄賅資賈賊賑賒賓賜賞賠賡賢賣賤賦質賬賭賴賺賻購賽贅贈贊贍贏贓贖贗贛趕趙趨跡踐踴蹕蹟蹣蹤蹺躂躉躊躋躍躑躓躡躪軀車軋軌軍軏軒軔軛軟軸軻軼軾較載輊輒輓輔輕輛輜輝輞輟輥輦輩輪輯輳輸輻輾輿轂轄轅轉轍轎轔轟轡辦辭辮辯農迴逕這連週進遊運過達違遙遜遞遠適遲遷選遺遼邁還邇邊邏邐郵鄉鄒鄧鄭鄰鄴酈醃醜醞醣醫醬醱釀釁釅釋釐釗釘釙針釣釦釧釩釵鈇鈉鈍鈐鈑鈔鈕鈞鈣鈴鈷鈸鈹鈽鈾鈿鉀鉅鉉鉋鉍鉑鉗鉚鉛鉤鉸鉻銀銅銑銓銖銘銜銨銬銳銷銻銼鋁鋅鋇鋒鋤鋪鋰鋸鋼錄錐錕錘錙錚錠錡錢錦錨錫錮錯錳錶鍊鍋鍍鍔鍚鍛鍥鍬鍰鍵鍾鎂鎊鎔鎖鎘鎚鎢鎬鎮鎰鎳鏃鏈鏍鏑鏗鏘鏜鏝鏟鏡鏢鏤鏨鏽鐃鐘鐫鐮鐲鐳鐵鐸鐺鑄鑑鑒鑠鑣鑪鑰鑲鑷鑼鑽鑾鑿長門閂閃閉開閎閏閑閒間閔閘閡閣閤閥閨閩閭閱閻闆闈闊闋闌闐闔闕闖關闡闢陘陝陞陣陰陳陸陽隊階隕際隨險隱隴隸隻雋雖雙雛雜雞離難雲電霑霧霽靂靄靈靜靦靨鞏鞦韁韃韆韉韋韌韓韜韻響頁頂頃項順須頊頌預頑頒頓頗領頜頡頤頫頭頰頷頸頹頻顆題額顎顏顓願顛類顥顧顫顯顰顱風颯颱颳颶颺颼飄飛飢飩飪飭飯飲飴飼飽飾餃餅餉養餌餒餓餘餚餛餞餡館餵餾餿饅饉饑饒饗饜饞馬馭馮馱馳馴駁駐駑駒駕駙駛駝駟駢駭駱駿騁騎騖騙騫騰騵騷騾驀驃驅驍驕驗驚驛驟驢驥驪骯髏髒體髖髮鬆鬍鬚鬢鬥鬧鬨鬱魎魘魚魯魷鮑鮪鮫鮭鮮鯀鯉鯊鯖鯛鯧鯨鯽鰍鰓鰥鰭鰱鰻鰾鱉鱔鱖鱗鱟鱷鱸鳥鳩鳳鳴鳶鴃鴆鴉鴒鴕鴛鴣鴦鴨鴻鴿鵑鵝鵠鵡鵪鵬鵲鶉鶯鶴鷂鷓鷗鷥鷹鷺鸚鸛鸞鹵鹹鹼鹽麗麥麩麴麵麼黃黌點黨黴黷鼕鼴齊齋齒齜齟齡齣齦齧齪齬齲齷龍龐龔龜" + "]");
const CJK = /[一-鿿]/;

console.log("\n── The portal's two languages ───────────────────");
const portal = require("../consultant-portal");
const en = portal.STR.en, zh = portal.STR.zh;
const enKeys = Object.keys(en), zhKeys = Object.keys(zh);
ok("there are phrases to check", enKeys.length > 150, enKeys.length);
ok("every English phrase has its Chinese", enKeys.filter(k => !(k in zh)).length === 0, enKeys.filter(k => !(k in zh)));
ok("every Chinese phrase has its English", zhKeys.filter(k => !(k in en)).length === 0, zhKeys.filter(k => !(k in en)));
ok("no Chinese phrase is left empty", zhKeys.filter(k => !String(zh[k]).trim()).length === 0, zhKeys.filter(k => !String(zh[k]).trim()));
const untranslated = zhKeys.filter(k => !CJK.test(zh[k]) && /[A-Za-z]{4,}/.test(zh[k]) && !/^(switchTo|switchLabel|ch_tg|down_tg)$/.test(k));
ok("no Chinese phrase is still in English", untranslated.length === 0, untranslated.map(k => [k, zh[k]]));
const placeholders = (s) => (String(s).match(/\{[a-z_]+\}/g) || []).sort().join();
const mismatched = enKeys.filter(k => k in zh && placeholders(en[k]) !== placeholders(zh[k]));
ok("the same blanks ({name}, {date} …) are filled in both", mismatched.length === 0, mismatched.map(k => [k, en[k], zh[k]]));
const trad = zhKeys.filter(k => TRADITIONAL.test(zh[k]));
ok("the Chinese is Simplified", trad.length === 0, trad.map(k => [k, zh[k]]));
ok("nobody is asked for a \"work order\" in either language", !/work.?order/i.test(Object.values(en).join(" ")) && !/工单|工作单/.test(Object.values(zh).join(" ")));

const t = portal.words("zh");
ok("a phrase with a blank fills it", t("with", { name: "王律师" }).includes("王律师") && !t("with", { name: "x" }).includes("{"));
ok("an unknown language falls back to English, not to a raw key", portal.words("fr")("nav_tasks") === en.nav_tasks);
ok("zh-CN and zh both mean Chinese; anything else English", portal.langOf({ lang: "zh-CN" }) === "zh" && portal.langOf({ lang: "zh" }) === "zh" && portal.langOf({ lang: "es" }) === "en" && portal.langOf(null) === "en");

const user = { uid: 5, n: "Luna Huang", r: "consultant", lang: "zh" };
const page = portal.renderChrome({ title: "Tasks", activeTab: "dashboard", user,
  body: portal.renderDashboard({ user, tasks: [{ id: 1, title: "新客户", status: "pending_approval", priority: "high", matter_type: "immigration", created_at: new Date() }], stats: { pending_approval: 1 } }) });
ok("a Chinese page says so to the browser", /<html lang="zh-Hans">/.test(page));
ok("…and an English one too", /<html lang="en">/.test(portal.renderChrome({ title: "t", user: { ...user, lang: "en" }, body: "" })));
ok("the page offers the way back to English", /action="\/consultant\/lang"/.test(page) && /English/.test(page));
ok("status and kind of matter are worded in Chinese", /待审批/.test(page) && /移民/.test(page) && /提交于/.test(page));
const visible = page.replace(/<svg[\s\S]*?<\/svg>/g, "").replace(/<script[\s\S]*?<\/script>/g, "").replace(/<style[\s\S]*?<\/style>/g, "").replace(/<[^>]+>/g, " ");
ok("nothing on it is still in English but names and the switch", !/\b(Tasks|New task|My clients|Alerts|Signed in|Sign out|Waiting|Approved|Urgent|Deadline)\b/.test(visible.replace(/English/g, "")), (visible.match(/.{0,30}\b(Tasks|New task|My clients|Alerts|Signed in|Sign out|Waiting|Approved|Urgent|Deadline)\b.{0,20}/) || [])[0]);

console.log("\n── Alerts in both languages ─────────────────────");
const notify = require("../notify");
const kinds = Object.keys(notify.KINDS || {});
ok("there are alert kinds to check", kinds.length >= 5, kinds);
const noZh = kinds.filter(k => !CJK.test(notify.labelOf(k, "zh")));
ok("every alert kind has Chinese wording", noZh.length === 0, noZh);
ok("…in Simplified", kinds.filter(k => TRADITIONAL.test(notify.labelOf(k, "zh"))).length === 0, kinds.filter(k => TRADITIONAL.test(notify.labelOf(k, "zh"))));
ok("English stays the default", kinds.every(k => notify.labelOf(k) === notify.KINDS[k].label && !CJK.test(notify.labelOf(k))));
ok("only zh and zh-CN select Chinese", notify.isZh("zh") && notify.isZh("zh-CN") && !notify.isZh("en") && !notify.isZh("es") && !notify.isZh(undefined));

console.log("\n── Zara and the client app's Chinese ────────────");
const chat = read("zara-app-chat.js");
ok("Zara answers a Chinese-speaking client in Simplified", /Respond in Simplified Chinese \(简体中文\)/.test(chat) && !/Respond in Traditional Chinese/.test(chat));
ok("…including accounts saved as zh-TW when the app's only Chinese was labelled 中文", /lang === "zh-TW"\) \? "Respond in Simplified Chinese/.test(chat.replace(/\s+/g, " ")));
const api = read("app-api.js");
ok("the app may save zh-CN as a client's language", /\["en", "zh-CN", "zh-TW", "es"\]\.includes\(req\.body\?\.preferred_lang\)/.test(api));
ok("a consultant's language can be set from the app", /app\.post\("\/api\/consultant\/lang", requireBearer, requireConsultantRole/.test(api));

console.log("\n── The firm's pages, in the brand ───────────────");
stub("../tasks", {}); stub("../client-profiles", {});
let chrome = "";
try { chrome = require("../hearing-notes").renderAdminChrome({ title: "Tasks", body: "<p>x</p>", activeItem: "tasks" }); }
catch (e) { chrome = ""; ok("the admin frame renders", false, e.message); }
const theme = require("../tez-theme");
const style = (chrome.match(/<style>[\s\S]*?<\/style>/) || [""])[0];
ok("the frame renders", chrome.length > 5000 && style.length > 2000);
ok("charcoal sidebar, marble page, Seal Orange mark, Ember for orange text",
  /--sidebar-bg: #2B2523/.test(style) && /--canvas: #FAF8F5/.test(style) && /--orange: #FF7B00/.test(style) && /--ember: #A34C00/.test(style));
ok("the old walnut-and-sandstone and navy-and-gold colours are gone from the frame",
  !/#3E2818|#5A3B22|#E4CC94|#E0B44E|#0C1C36|#B79C62|#F0DDB4/i.test(style), (style.match(/#3E2818|#5A3B22|#E4CC94|#E0B44E|#0C1C36|#B79C62|#F0DDB4/i) || [])[0]);
ok("Cormorant Garamond for headlines, Montserrat for everything else", /Cormorant\+Garamond/.test(chrome) && /Montserrat/.test(chrome) && /--serif: "Cormorant Garamond"/.test(style) && /--sans: Montserrat/.test(style));
ok("Cinzel, IM Fell and Inter are no longer loaded", !/Cinzel|IM\+Fell|family=Inter/.test(chrome));
ok("the mark is the kit's own shield, drawn in the page — not an image fetched from the website",
  chrome.includes(theme.SHIELD.slice(0, 120)) && !/sidebar-brand">\s*<img/.test(chrome));
ok("dark initials on the orange avatar (white on orange is unreadable)", /\.user-avatar \{[^}]*background: var\(--orange\);[^}]*color: var\(--ink\)/.test(style.replace(/\s+/g, " ")));
ok("the role colour no longer paints over the avatar", !/avatar\.style\.background = d\.role_color/.test(chrome));
const navEmoji = (chrome.match(/<span class="nav-icon">([^<]*)<\/span>/g) || []).filter(s => /[\u{1F000}-\u{1FAFF}]/u.test(s));
ok("no emoji used as a menu icon", navEmoji.length === 0, navEmoji);
ok("the consultant-task approval page is on the menu, for those who can approve",
  /href="\/admin\/consultant-tasks" class="nav-link" data-perm="tasks\.approve"/.test(chrome) &&
  /"tasks\.approve":\s+\["admin", "manager", "attorney"\]/.test(read("auth.js")));
const pagesWithOldLook = ["server.js", "admin.js", "accounting-ui.js", "personal-injury-ui.js", "client-profiles.js", "civil-litigation-ui.js", "auth.js", "dashboard.js", "hearing-notes.js", "individual-hearing-notes.js"]
  .filter(f => /#0C1C36|#B79C62|#3E2818|Cinzel/i.test(read(f)));
ok("the pages inside the frame use the brand colours and type too", pagesWithOldLook.length === 0, pagesWithOldLook);

console.log("\n── Sign-in pages ────────────────────────────────");
const login = theme.authPage({ title: "Sign in", heading: "Sign in", sub: "", body: "<form></form>" });
ok("the sign-in page carries the lockup on charcoal", /class="tez-lockup"/.test(login) && /#2B2523/.test(login));
ok("it runs no script", !/<script/i.test(login));

console.log("\n── Blog footers ─────────────────────────────────");
const poster = read("autoposter.js");
ok("new posts point to the firm's contact page", /https:\/\/tezlawfirm\.com\/jj/.test(poster));
ok("…and no longer to chat apps or a third-party card", !/wa\.me|m\.me\/|v1ce\.co|t\.me\/TEZJJBot/i.test(poster), (poster.match(/wa\.me|m\.me\/|v1ce\.co|t\.me\/TEZJJBot/i) || [])[0]);

console.log(failures ? `\n${failures} check(s) FAILED` : "\nall checks passed");
process.exit(failures ? 1 : 0);
