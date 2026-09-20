// Boots app-api against a real express app with stubbed modules, then proves
// every /api/staff/civil route has an /admin/civil/api twin on the same handler.
const express = require('express');
const Module = require('module');
const orig = Module._load;
const stub = new Proxy({}, { get: (_t, k) => {
  if (k === 'initTables') return async () => {};
  if (k === 'DOC_CATEGORIES') return [];
  if (k === 'startScheduler') return () => {};
  if (k === 'STAGES') return []; if (k === 'STAGE_KEYS') return new Set();
  if (k === 'CASE_TYPES' || k === 'OUR_ROLES') return [];
  return async () => ({});
}});
Module._load = function (r) {
  if (/^\.\/(civil-litigation|civil-discovery|civil-team|civil-billing|civil-dropbox|civil-court-docket|db|push-notifications)$/.test(r)) return stub;
  return orig.apply(this, arguments);
};
const app = express();
app.use(express.json());
require('../app-api').registerAppApi(app);

const routes = (app._router?.stack || app.router?.stack || [])
  .filter(l => l.route)
  .map(l => ({ m: Object.keys(l.route.methods)[0], p: l.route.path, h: l.route.stack[l.route.stack.length - 1].handle }));

const staff = routes.filter(r => r.p.startsWith('/api/staff/civil'));
const admin = routes.filter(r => r.p.startsWith('/admin/civil/api'));
const adminKey = new Map(admin.map(r => [r.m + ' ' + r.p, r]));

let missing = [], wrongHandler = [];
for (const r of staff) {
  const twin = adminKey.get(r.m + ' /admin/civil/api' + r.p.slice('/api/staff/civil'.length));
  if (!twin) missing.push(r.m.toUpperCase() + ' ' + r.p);
  else if (twin.h !== r.h) wrongHandler.push(r.p);
}
console.log('staff civil routes :', staff.length);
console.log('admin twins        :', admin.length);
console.log('missing twins      :', missing.length, missing.slice(0, 5));
console.log('handler mismatches :', wrongHandler.length);
// Spot-check that the bearer middleware really is gone from the twin chain.
const sample = admin.find(r => r.p === '/admin/civil/api/cases/:id');
const chain = (app._router?.stack || app.router?.stack).find(l => l.route && l.route.path === '/admin/civil/api/cases/:id' && l.route.methods.get);
console.log('GET twin mw count  :', chain ? chain.route.stack.length : 'n/a', '(staff side has 3: bearer, firmUser, handler)');
process.exit(missing.length || wrongHandler.length ? 1 : 0);
