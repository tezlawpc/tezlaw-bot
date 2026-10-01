/**
 * scripts/lib/stub-pg.js
 *
 * A do-nothing stand-in for the `pg` module.
 *
 * Several modules worth checking (auth.js among them) pull in db.js at require
 * time, and db.js does `const { Pool } = require("pg")`. That makes them
 * unloadable on a machine with no node_modules — which is the machine JJ
 * usually has open. The checks that use this never touch a database: they
 * exercise decision logic, and an access-control decision is exactly the kind
 * of thing that should be verifiable anywhere, not only where a full install
 * happens to exist.
 *
 * install() makes require("pg") resolve here. Anything that actually runs a
 * query gets an empty result rather than a connection, so a check that
 * accidentally depends on real data fails loudly instead of passing by luck.
 */
class Pool {
  constructor() {}
  async query() { return { rows: [], rowCount: 0 }; }
  async connect() { return { query: async () => ({ rows: [], rowCount: 0 }), release() {} }; }
  on() {}
  async end() {}
}

// Delegates to the general stub now. Two implementations of "let this load
// without node_modules" is one too many, and the general one covers pg along
// with everything else a module happens to pull in.
function install() {
  return require("./stub-missing").install();
}

module.exports = { Pool, Client: Pool, install };
