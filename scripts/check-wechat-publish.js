/**
 * check-wechat-publish.js
 *
 * JJ: "i have wechat clients too."
 *
 * The firm's clients are on WeChat, so this is the one publishing path
 * where a mistake reaches the people who actually matter. Two things are
 * worth more than the rest: nothing publishes without JJ tapping Publish,
 * and a post that Tencent rejects is recorded as rejected rather than
 * quietly assumed to be live.
 *
 * freepublish/submit returns a publish_id immediately and says nothing
 * about success. The truth arrives minutes later in a PUBLISHJOBFINISH
 * callback. Most of these checks are about not confusing the two.
 */
const Module = require("module");
let failures = 0;
function check(name, ok, detail) {
  if (!ok) failures++;
  console.log((ok ? "  ok   " : "  FAIL ") + name + (ok || !detail ? "" : "  → " + detail));
}
async function throwsA(name, fn, re) {
  try { await fn(); check(name, false, "did not throw"); }
  catch (e) { check(name, re.test(e.message), e.message); }
}

// ── Stand-in database ────────────────────────────────────
const rows = [];
let seq = 0;
const fakeDb = { query: async (sql, v = []) => {
  const q = sql.replace(/\s+/g, " ").trim();
  if (/^CREATE /i.test(q)) return { rows: [] };

  if (/^INSERT INTO wechat_posts/i.test(q)) {
    const row = {
      id: ++seq, title: v[0], digest: v[1], content: v[2],
      cover_media_id: v[3], source_url: v[4], status: v[5],
      draft_media_id: null, publish_id: null, article_url: null,
      error: null, decided_by: null, published_at: null,
    };
    rows.push(row);
    return { rows: [{ id: row.id }] };
  }
  if (/^SELECT \* FROM wechat_posts WHERE id/i.test(q)) {
    return { rows: rows.filter(r => r.id === v[0]) };
  }
  if (/SET status = 'publishing'/i.test(q)) {
    const r = rows.find(x => x.id === v[0]);
    if (r) { r.status = "publishing"; r.draft_media_id = v[1]; r.publish_id = v[2]; r.decided_by = v[3]; r.error = null; }
    return { rows: [] };
  }
  if (/SET status = 'failed', error = \$2, decided_at/i.test(q)) {
    const r = rows.find(x => x.id === v[0]);
    if (r) { r.status = "failed"; r.error = v[1]; r.decided_by = v[2]; }
    return { rows: [] };
  }
  if (/SET status = 'skipped'/i.test(q)) {
    const r = rows.find(x => x.id === v[0] && x.status === "pending");
    if (r) { r.status = "skipped"; r.decided_by = v[1]; }
    return { rows: [] };
  }
  if (/SET status = 'published'/i.test(q)) {
    const r = rows.find(x => x.publish_id === v[0]);
    if (r) { r.status = "published"; r.article_url = v[1] || r.article_url; r.error = null; }
    return { rows: [] };
  }
  if (/SET status = 'failed', error = \$2 WHERE publish_id/i.test(q)) {
    const r = rows.find(x => x.publish_id === v[0]);
    if (r) { r.status = "failed"; r.error = v[1]; }
    return { rows: [] };
  }
  if (/GROUP BY status/i.test(q)) {
    const by = {};
    for (const r of rows) by[r.status] = (by[r.status] || 0) + 1;
    return { rows: Object.entries(by).map(([status, n]) => ({ status, n })) };
  }
  if (/ORDER BY id DESC LIMIT 10/i.test(q)) return { rows: rows.slice(-10).reverse() };
  return { rows: [] };
} };

// ── Stand-in WeChat and Telegram ─────────────────────────
const calls = { draft: [], publish: [], telegram: [], upload: [] };
let weChatFails = null;

const fakeAxios = {
  post: async (url, body) => {
    if (url.includes("stable_token")) {
      return { data: { access_token: "tok-" + Date.now(), expires_in: 7200 } };
    }
    if (url.includes("api.telegram.org")) {
      calls.telegram.push(body);
      return { data: { ok: true } };
    }
    if (url.includes("draft/add")) {
      calls.draft.push(body);
      if (weChatFails === "draft") return { data: { errcode: 40007, errmsg: "invalid media_id" } };
      return { data: { media_id: "draft-" + calls.draft.length } };
    }
    if (url.includes("freepublish/submit")) {
      calls.publish.push(body);
      if (weChatFails === "publish") return { data: { errcode: 53503, errmsg: "audit failed" } };
      return { data: { publish_id: 1000 + calls.publish.length } };
    }
    if (url.includes("add_material")) {
      calls.upload.push(url);
      return { data: { media_id: "cover-1", url: "https://mmbiz.qpic.cn/cover.jpg" } };
    }
    if (url.includes("media/uploadimg")) {
      calls.upload.push(url);
      return { data: { url: "https://mmbiz.qpic.cn/inline.jpg" } };
    }
    return { data: {} };
  },
};

process.env.WECHAT_APP_ID = "wx-test";
process.env.WECHAT_APP_SECRET = "secret-test";
process.env.WECHAT_PUBLISH_ENABLED = "true";
process.env.WECHAT_COVER_MEDIA_ID = "cover-default";
process.env.TELEGRAM_TOKEN = "tg-test";
process.env.JJ_TELEGRAM_ID = "12345";
delete process.env.WECHAT_PUBLISH_AUTO;

const orig = Module._load;
Module._load = function (r, ...rest) {
  if (r === "./db") return fakeDb;
  if (r === "axios") return fakeAxios;
  return orig.call(this, r, ...rest);
};

const WC = require("../wechat-publish");

(async () => {
  console.log("turning a blog post into a WeChat article");

  const wpBody = [
    "<p>搬家後十天內要通知移民局。</p>",
    '<img src="https://tezlawfirm.com/wp-content/uploads/photo.jpg">',
    "<style>.tez-ab{color:red}</style>",
    '<aside class="tez-ab">About the author…</aside>',
    '<script type="application/ld+json">{"@type":"Article"}</script>',
  ].join("");
  const html = WC.toWeChatHtml(wpBody, { sourceUrl: "https://tezlawfirm.com/p/1" });

  check("the article body survives", html.includes("搬家後十天內"));
  check("the website's author card does not", !html.includes("About the author"));
  check("no script tag reaches WeChat", !/<script/i.test(html));
  check("no stylesheet either", !/<style/i.test(html));
  check("images WeChat would strip are removed first", !html.includes("tezlawfirm.com/wp-content"));
  check("an image already on WeChat's CDN is kept",
    WC.toWeChatHtml('<img src="https://mmbiz.qpic.cn/a.jpg">').includes("mmbiz.qpic.cn"));
  check("the firm's number is on every article", html.includes("626-678-8677"));
  check("and the disclaimer", html.includes("不構成法律意見"));
  check("the original is linked back", html.includes("tezlawfirm.com/p/1"));

  check("a digest is made when none is given",
    WC.makeDigest("", "<p>Hello <b>there</b></p>") === "Hello there");
  check("a digest never exceeds WeChat's limit",
    WC.makeDigest("x".repeat(400), "").length === 120);
  check("a title is cut to WeChat's limit at the draft, not by Tencent",
    WC._internals.MAX_TITLE === 64);

  console.log("\nnothing publishes without JJ");
  const q = await WC.queueForApproval({
    title: "搬家後要做的兩件事", content: wpBody,
    digest: "十天和五天", sourceUrl: "https://tezlawfirm.com/p/1",
  });
  check("the post is stored", q.queued === true && q.id === 1);
  check("as pending, not published", rows[0].status === "pending");
  check("and nothing was sent to WeChat", calls.draft.length === 0 && calls.publish.length === 0);
  check("JJ is asked on Telegram", calls.telegram.length === 1);
  check("…with Publish and Skip buttons", (() => {
    const kb = calls.telegram[0].reply_markup?.inline_keyboard?.[0] || [];
    return kb.length === 2 && kb[0].callback_data === "wcpost_go_1" && kb[1].callback_data === "wcpost_no_1";
  })(), JSON.stringify(calls.telegram[0].reply_markup));
  check("…and the message says what publishing means",
    /firm's name/i.test(calls.telegram[0].text || ""));

  console.log("\nwhen JJ taps Publish");
  const go = await WC.handleTelegramCallback("wcpost_go_1", "cb1", "JJ");
  check("a draft is created first", calls.draft.length === 1);
  check("…with the cover, the author and the source link", (() => {
    const a = calls.draft[0].articles[0];
    return a.thumb_media_id === "cover-default" && a.author && a.content_source_url === "https://tezlawfirm.com/p/1";
  })(), JSON.stringify(calls.draft[0].articles[0]).slice(0, 200));
  check("then the draft is submitted", calls.publish.length === 1);
  check("the row says publishing, not published", rows[0].status === "publishing");
  check("because submit only returns a publish_id", rows[0].publish_id === "1001");
  check("and JJ is told it is not done yet", /confirm when it lands/i.test(go.answer));

  console.log("\nwhen Tencent reports back");
  const done = await WC.handlePublishCallback({
    MsgType: "event", Event: "PUBLISHJOBFINISH",
    PublishEventInfo: {
      publish_id: "1001", publish_status: 0,
      article_detail: { item: { article_url: "https://mp.weixin.qq.com/s/abc" } },
    },
  });
  check("only now is it published", rows[0].status === "published");
  check("the article's link is kept", rows[0].article_url === "https://mp.weixin.qq.com/s/abc");
  check("and JJ is told", done.published === true &&
    calls.telegram.some(m => /is live/i.test(m.text || "")));

  console.log("\nwhen Tencent rejects it");
  await WC.queueForApproval({ title: "第二篇", content: "<p>內容</p>" });
  await WC.handleTelegramCallback("wcpost_go_2", "cb2", "JJ");
  const bad = await WC.handlePublishCallback({
    PublishEventInfo: { publish_id: "1002", publish_status: 2 },
  });
  check("the post is marked failed, never assumed live", rows[1].status === "failed");
  check("…with the reason Tencent gave", /original-article/i.test(rows[1].error || ""));
  check("and JJ hears about it", bad.published === false &&
    calls.telegram.some(m => /did not publish/i.test(m.text || "")));

  console.log("\nwhen JJ taps Skip");
  await WC.queueForApproval({ title: "第三篇", content: "<p>內容</p>" });
  const drafts = calls.draft.length;
  const skip = await WC.handleTelegramCallback("wcpost_no_3", "cb3", "JJ");
  check("it is skipped", rows[2].status === "skipped");
  check("and never reached WeChat", calls.draft.length === drafts);
  check("JJ is told nothing was published", /nothing was published/i.test(skip.answer));

  console.log("\nthe guards");
  await WC.queueForApproval({ title: "第四篇", content: "<p>內容</p>" });
  weChatFails = "draft";
  await WC.handleTelegramCallback("wcpost_go_4", "cb4", "JJ");
  check("a WeChat error is recorded, not swallowed", rows[3].status === "failed");
  check("…with the errcode Tencent returned", /40007/.test(rows[3].error || ""));
  weChatFails = null;

  check("a post already submitted is not submitted twice",
    (await WC.handleTelegramCallback("wcpost_go_1", "cb5", "JJ")).answer === "Already handled.");
  check("an unknown button is ignored",
    (await WC.handleTelegramCallback("something_else", "cb6")) === null);
  check("the default cover is used when a post brings none",
    calls.draft[0].articles[0].thumb_media_id === "cover-default");
  const savedCover = process.env.WECHAT_COVER_MEDIA_ID;
  delete process.env.WECHAT_COVER_MEDIA_ID;
  await throwsA("with no cover at all, it is refused before reaching Tencent",
    () => WC.createDraft({ title: "t", content: "c", thumbMediaId: "" }),
    /cover image/i);
  process.env.WECHAT_COVER_MEDIA_ID = savedCover;
  await throwsA("…and one with no title", () => WC.createDraft({ content: "c" }), /title/i);

  console.log("\nthe status page");
  const st = await WC.status();
  check("it reports the approval gate is on", st.auto_publish === false);
  check("it counts what happened", st.counts.published === 1 && st.counts.skipped === 1);
  check("and lists recent posts", st.recent.length >= 4);

  console.log("\nwiring");
  const fs = require("fs"), path = require("path");
  const srv = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  check("the publish callback is handled on the WeChat webhook",
    /Event === "PUBLISHJOBFINISH"/.test(srv));
  check("…and answered with the bare 'success' Tencent expects",
    /PUBLISHJOBFINISH[\s\S]{0,120}res\.send\("success"\)/.test(srv));
  check("the Telegram buttons are routed", /cb\.data\?\.startsWith\("wcpost_"\)/.test(srv));
  check("the table is created at boot", /wechat-publish"\)\.initTable\(\)/.test(srv));
  const ap = fs.readFileSync(path.join(__dirname, "..", "autoposter.js"), "utf8");
  check("the Chinese blog post is queued for WeChat", /wechat\.queueForApproval\(/.test(ap));
  check("…and a WeChat failure cannot break the blog post",
    /catch \(wcErr\)[\s\S]{0,120}WeChat queue error/.test(ap));

  console.log(failures ? `\n${failures} check(s) FAILED\n` : "\nWeChat publishing: all checks passed\n");
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error("THREW:", e); process.exit(1); });
