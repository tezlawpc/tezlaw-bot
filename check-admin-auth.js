// requireAuth must accept the main admin session, keep accepting the legacy
// token, keep 401-ing API calls for strangers, and never widen access to
// non-admin roles.
const Module = require('module');
const orig = Module._load;
Module._load = function (r) {
  if (r === './db') return { query: async () => ({ rows: [] }) };
  return orig.apply(this, arguments);
};
const { requireAuth } = require('../admin');

function run(req) {
  return new Promise(resolve => {
    const res = {
      redirect: url => resolve({ outcome: 'redirect', url }),
      status: code => ({ json: body => resolve({ outcome: 'status', code, body }) }),
    };
    requireAuth(req, res, () => resolve({ outcome: 'next' }));
  });
}

(async () => {
  let bad = 0;
  const check = (label, cond, detail) => {
    if (!cond) bad++;
    console.log((cond ? '  PASS  ' : '  FAIL  ') + label + (!cond ? ' — ' + JSON.stringify(detail) : ''));
  };

  console.log('\n=== the main admin session (the case that was broken) ===');
  let r = await run({ path: '/panel.js', user: { r: 'admin', u: 'jj' }, cookies: {}, headers: {} });
  check('admin reaches /panel.js', r.outcome === 'next', r);
  r = await run({ path: '/api/stats', user: { r: 'admin', u: 'jj' }, cookies: {}, headers: {} });
  check('admin reaches /api/stats', r.outcome === 'next', r);
  r = await run({ path: '/', user: { r: 'admin', u: 'jj' }, cookies: {}, headers: {} });
  check('admin reaches the panel root', r.outcome === 'next', r);

  console.log('\n=== access is not widened ===');
  r = await run({ path: '/', user: { r: 'paralegal', u: 'x' }, cookies: {}, headers: {} });
  check('paralegal is sent to the triage dashboard',
        r.outcome === 'redirect' && r.url === '/admin/dashboard', r);
  r = await run({ path: '/api/stats', user: { r: 'attorney', u: 'y' }, cookies: {}, headers: {} });
  check('non-admin API call is still 401', r.outcome === 'status' && r.code === 401, r);

  console.log('\n=== anonymous is unchanged ===');
  r = await run({ path: '/', cookies: {}, headers: {} });
  check('anonymous page -> /admin/login', r.outcome === 'redirect' && r.url === '/admin/login', r);
  r = await run({ path: '/api/stats', cookies: {}, headers: {} });
  check('anonymous API -> 401', r.outcome === 'status' && r.code === 401, r);

  console.log('\n' + '='.repeat(50));
  console.log(bad === 0 ? 'ALL ADMIN-AUTH CHECKS PASSED' : bad + ' CHECK(S) FAILED');
  console.log('='.repeat(50));
  process.exit(bad ? 1 : 0);
})();
