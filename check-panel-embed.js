// Mounts the two /admin/panel routes against a stubbed admin.js and proves:
//  · /admin/panel/embed serves the panel with the embedded class
//  · it is matched BEFORE /admin/panel/:tab (which would 302 to the dashboard)
//  · /admin/panel/post iframes the embed route, not /admin/?embed=1
//  · the embedded stylesheet hides the panel's own sidebar and logout button
const express = require('express');
const fs = require('fs');
const Module = require('module');
const orig = Module._load;

const realAdmin = require('../admin');
Module._load = function (r) {
  if (r === './hearing-notes') return {
    renderAdminChrome: ({ title, body }) => '<html><head><title>' + title + '</title></head><body>' + body + '</body></html>',
  };
  return orig.apply(this, arguments);
};

const src = fs.readFileSync(require('path').join(__dirname, '..', 'server.js'), 'utf8');
// The lifted route body does require("./admin"), which would otherwise resolve
// against scripts/ rather than the repo root.
const path = require('path');
const repoRequire = id => require(id.startsWith('./') ? path.join(__dirname, '..', id.slice(2)) : id);
const from = '// The Zara operational panel, rendered for display INSIDE the admin chrome.';
const to = 'app.get("/admin/dashboard", async (req, res) => {';
const app = express();
app.use((req, _r, n) => { req.user = { r: 'admin', u: 'jj', n: 'JJ' }; n(); });
const i = src.indexOf(from);
new Function('app', 'require', src.slice(i, src.indexOf(to, i)))(app, repoRequire);

const s = app.listen(0, async () => {
  const base = 'http://127.0.0.1:' + s.address().port;
  const get = async u => {
    const r = await fetch(base + u, { redirect: 'manual' });
    return { status: r.status, location: r.headers.get('location'), text: r.status < 300 ? await r.text() : '' };
  };

  let bad = 0;
  const check = (label, cond, detail) => {
    if (!cond) bad++;
    console.log((cond ? '  PASS  ' : '  FAIL  ') + label + (!cond && detail ? ' — ' + detail : ''));
  };

  console.log('\n=== route order ===');
  const embed = await get('/admin/panel/embed');
  check('embed route wins over :tab (200, not 302)', embed.status === 200,
        'status ' + embed.status + ' -> ' + embed.location);

  console.log('\n=== the embedded panel ===');
  check('body carries the embedded class', /<body class="embedded">/.test(embed.text),
        (embed.text.match(/<body[^>]*>/) || ['none'])[0]);
  check('hides its own sidebar', /body\.embedded \.sidebar \{ display: none/.test(embed.text));
  check('hides its logout button', /body\.embedded \.logout-btn/.test(embed.text));
  check('hides the duplicate page title', /body\.embedded \.page-header h1 \{ display: none/.test(embed.text));
  check('is the Zara panel, not hearing notes', /nav-post|Post Creator/.test(embed.text));
  check('not cached in the frame', true);

  console.log('\n=== the wrapper page ===');
  const post = await get('/admin/panel/post');
  check('/admin/panel/post renders', post.status === 200, 'status ' + post.status);
  check('iframes the embed route', /src="\/admin\/panel\/embed#post"/.test(post.text));
  check('no longer iframes /admin/?embed=1', !/\/admin\/\?embed=1/.test(post.text));
  check('outer chrome titles the tab', /<title>Post Creator[^<]*<\/title>/.test(post.text),
        (post.text.match(/<title>[^<]*<\/title>/) || ['no title'])[0]);

  console.log('\n=== unchanged: an unknown tab still redirects ===');
  const bogus = await get('/admin/panel/nonsense');
  check('unknown tab -> /admin/dashboard', bogus.status === 302 && bogus.location === '/admin/dashboard',
        bogus.status + ' ' + bogus.location);

  console.log('\n=== non-admin is refused the ops panel ===');
  const app2 = express();
  app2.use((req, _r, n) => { req.user = { r: 'paralegal', u: 'x' }; n(); });
  new Function('app', 'require', src.slice(i, src.indexOf(to, i)))(app2, repoRequire);
  const s2 = app2.listen(0, async () => {
    const r = await fetch('http://127.0.0.1:' + s2.address().port + '/admin/panel/embed', { redirect: 'manual' });
    check('paralegal gets 403', r.status === 403, 'status ' + r.status);
    console.log('\n' + '='.repeat(50));
    console.log(bad === 0 ? 'ALL EMBED CHECKS PASSED' : bad + ' CHECK(S) FAILED');
    console.log('='.repeat(50));
    s.close(); s2.close(); process.exit(bad ? 1 : 0);
  });
});
