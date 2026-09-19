// ============================================================
//  NIGHTFOOD HOLDINGS, INC. — PCAOB AUDIT PORTAL
//  audit-zip.js — STREAMING ZIP WRITER
//  ─────────────────────────────────────────────────────────
//  Writes a ZIP archive directly to an HTTP response, one file
//  at a time, holding only the current file in memory.
//
//  WHY NOT A LIBRARY
//  `jszip` is present in node_modules, but only because `xlsx`
//  depends on it — it is not in package.json, so a future `xlsx`
//  release could remove it and this feature would vanish with no
//  warning. It also builds the whole archive in memory before
//  emitting a byte, and an annual engagement's documents can run
//  to hundreds of megabytes on a 512MB instance.
//
//  This writer uses only `zlib`, which is built into Node, and
//  streams: each entry is deflated and flushed before the next is
//  read, so peak memory is roughly one document rather than the
//  whole period.
//
//  FORMAT
//  ZIP is a simple container: for each file, a local header and
//  its (compressed) data; then a central directory repeating that
//  metadata; then an end-of-central-directory record. We emit
//  ZIP64 fields when an archive exceeds the 4GB/65535-entry limits
//  of the original format, which Windows Explorer, macOS Archive
//  Utility and `unzip` all read.
//
//  Data descriptors are NOT used: sizes and CRCs are known before
//  each header is written because every entry is materialised
//  before it is emitted. That keeps the output readable by the
//  strictest unzip implementations.
// ============================================================

const zlib = require("zlib");

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const SIG_EOCD64 = 0x06064b50;
const SIG_EOCD64_LOC = 0x07064b50;

const ZIP64_LIMIT = 0xffffffff;
const ZIP64_COUNT = 0xffff;

// ── CRC-32 ──────────────────────────────────────────────────
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

// ── DOS date/time ───────────────────────────────────────────
function dosTime(d) {
  const dt = d instanceof Date && !isNaN(d) ? d : new Date();
  const year = Math.max(1980, dt.getFullYear());
  return {
    time: (dt.getHours() << 11) | (dt.getMinutes() << 5) | (Math.floor(dt.getSeconds() / 2) & 0x1f),
    date: ((year - 1980) << 9) | ((dt.getMonth() + 1) << 5) | dt.getDate(),
  };
}

/**
 * Make a path safe to write inside an archive.
 *
 * Absolute paths and `..` segments are how a malicious archive
 * escapes its extraction directory (Zip Slip). Nothing here is
 * attacker-controlled today, but folder paths are built from
 * document filenames, and a filename is the one field a user
 * fully controls.
 */
function safeEntryName(name) {
  return String(name || "file")
    .replace(/\\/g, "/")
    .split("/")
    .map((seg) =>
      seg
        .replace(/[\u0000-\u001f<>:"|?*]/g, "-")
        .replace(/^\.+$/, "-")
        .trim()
    )
    .filter((seg) => seg.length)
    .join("/")
    .slice(0, 400) || "file";
}

class ZipWriter {
  /**
   * @param {stream.Writable} out  destination (an HTTP response)
   */
  constructor(out) {
    this.out = out;
    this.entries = [];
    this.offset = 0;
    this.names = new Set();
    this.finished = false;
  }

  _write(buf) {
    this.offset += buf.length;
    // Respect backpressure: if the socket's buffer is full, wait for
    // it to drain before queuing more. Without this a fast Postgres
    // read against a slow client grows the outbound buffer until the
    // process is killed — the exact failure a streaming writer is
    // supposed to prevent.
    if (!this.out.write(buf)) {
      return new Promise((resolve) => this.out.once("drain", resolve));
    }
    return null;
  }

  /** Ensure two documents with the same name do not collide. */
  _uniqueName(name) {
    let n = safeEntryName(name);
    if (!this.names.has(n)) {
      this.names.add(n);
      return n;
    }
    const dot = n.lastIndexOf(".");
    const stem = dot > 0 ? n.slice(0, dot) : n;
    const ext = dot > 0 ? n.slice(dot) : "";
    let i = 2;
    while (this.names.has(`${stem} (${i})${ext}`)) i++;
    const out = `${stem} (${i})${ext}`;
    this.names.add(out);
    return out;
  }

  /**
   * Add one file.
   * @param {string} name     path inside the archive
   * @param {Buffer} data     contents
   * @param {Date}   modified timestamp to record
   */
  async add(name, data, modified) {
    if (this.finished) throw new Error("Archive already finished.");
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data || "");
    const entryName = this._uniqueName(name);
    const nameBuf = Buffer.from(entryName, "utf8");
    const crc = crc32(buf);
    const { time, date } = dosTime(modified);

    // Already-compressed formats gain nothing from deflate and cost
    // CPU on a shared instance, so store those and deflate the rest.
    const incompressible = /\.(pdf|png|jpe?g|gif|zip|docx|xlsx|pptx|mp4|mov|webp|heic)$/i.test(entryName);
    let payload = buf;
    let method = 0; // stored
    if (!incompressible && buf.length > 256) {
      const deflated = zlib.deflateRawSync(buf, { level: 6 });
      if (deflated.length < buf.length) {
        payload = deflated;
        method = 8; // deflate
      }
    }

    const needsZip64 = buf.length > ZIP64_LIMIT || payload.length > ZIP64_LIMIT || this.offset > ZIP64_LIMIT;
    const localOffset = this.offset;

    // Local file header
    const extra = needsZip64 ? this._zip64Extra(buf.length, payload.length) : Buffer.alloc(0);
    const head = Buffer.alloc(30);
    head.writeUInt32LE(SIG_LOCAL, 0);
    head.writeUInt16LE(needsZip64 ? 45 : 20, 4); // version needed
    head.writeUInt16LE(0x0800, 6); // UTF-8 filename flag
    head.writeUInt16LE(method, 8);
    head.writeUInt16LE(time, 10);
    head.writeUInt16LE(date, 12);
    head.writeUInt32LE(crc, 14);
    head.writeUInt32LE(needsZip64 ? ZIP64_LIMIT : payload.length, 18);
    head.writeUInt32LE(needsZip64 ? ZIP64_LIMIT : buf.length, 22);
    head.writeUInt16LE(nameBuf.length, 26);
    head.writeUInt16LE(extra.length, 28);

    await this._write(Buffer.concat([head, nameBuf, extra]));
    await this._write(payload);

    this.entries.push({
      nameBuf,
      crc,
      method,
      time,
      date,
      compressed: payload.length,
      uncompressed: buf.length,
      localOffset,
      needsZip64,
    });
  }

  _zip64Extra(uncompressed, compressed) {
    const b = Buffer.alloc(20);
    b.writeUInt16LE(0x0001, 0);
    b.writeUInt16LE(16, 2);
    b.writeBigUInt64LE(BigInt(uncompressed), 4);
    b.writeBigUInt64LE(BigInt(compressed), 12);
    return b;
  }

  /** Write the central directory and close the archive. */
  async finish() {
    if (this.finished) return;
    this.finished = true;
    const cdStart = this.offset;

    for (const e of this.entries) {
      const zip64 = e.needsZip64 || e.localOffset > ZIP64_LIMIT;
      let extra = Buffer.alloc(0);
      if (zip64) {
        const parts = [];
        parts.push(Buffer.from([0x01, 0x00, 0x00, 0x00])); // header id + size placeholder
        const vals = Buffer.alloc(24);
        vals.writeBigUInt64LE(BigInt(e.uncompressed), 0);
        vals.writeBigUInt64LE(BigInt(e.compressed), 8);
        vals.writeBigUInt64LE(BigInt(e.localOffset), 16);
        const b = Buffer.alloc(28);
        b.writeUInt16LE(0x0001, 0);
        b.writeUInt16LE(24, 2);
        vals.copy(b, 4);
        extra = b;
      }

      const c = Buffer.alloc(46);
      c.writeUInt32LE(SIG_CENTRAL, 0);
      c.writeUInt16LE(45, 4); // version made by
      c.writeUInt16LE(zip64 ? 45 : 20, 6); // version needed
      c.writeUInt16LE(0x0800, 8);
      c.writeUInt16LE(e.method, 10);
      c.writeUInt16LE(e.time, 12);
      c.writeUInt16LE(e.date, 14);
      c.writeUInt32LE(e.crc, 16);
      c.writeUInt32LE(zip64 ? ZIP64_LIMIT : e.compressed, 20);
      c.writeUInt32LE(zip64 ? ZIP64_LIMIT : e.uncompressed, 24);
      c.writeUInt16LE(e.nameBuf.length, 28);
      c.writeUInt16LE(extra.length, 30);
      c.writeUInt16LE(0, 32); // comment length
      c.writeUInt16LE(0, 34); // disk number
      c.writeUInt16LE(0, 36); // internal attrs
      c.writeUInt32LE(0, 38); // external attrs
      c.writeUInt32LE(zip64 ? ZIP64_LIMIT : e.localOffset, 42);
      await this._write(Buffer.concat([c, e.nameBuf, extra]));
    }

    const cdSize = this.offset - cdStart;
    const needs64 = this.entries.length > ZIP64_COUNT || cdStart > ZIP64_LIMIT || cdSize > ZIP64_LIMIT;

    if (needs64) {
      const e64 = Buffer.alloc(56);
      e64.writeUInt32LE(SIG_EOCD64, 0);
      e64.writeBigUInt64LE(BigInt(44), 4); // size of this record minus 12
      e64.writeUInt16LE(45, 12);
      e64.writeUInt16LE(45, 14);
      e64.writeUInt32LE(0, 16);
      e64.writeUInt32LE(0, 20);
      e64.writeBigUInt64LE(BigInt(this.entries.length), 24);
      e64.writeBigUInt64LE(BigInt(this.entries.length), 32);
      e64.writeBigUInt64LE(BigInt(cdSize), 40);
      e64.writeBigUInt64LE(BigInt(cdStart), 48);
      await this._write(e64);

      const loc = Buffer.alloc(20);
      loc.writeUInt32LE(SIG_EOCD64_LOC, 0);
      loc.writeUInt32LE(0, 4);
      loc.writeBigUInt64LE(BigInt(cdStart + cdSize), 8);
      loc.writeUInt32LE(1, 16);
      await this._write(loc);
    }

    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(SIG_EOCD, 0);
    eocd.writeUInt16LE(0, 4);
    eocd.writeUInt16LE(0, 6);
    eocd.writeUInt16LE(needs64 ? ZIP64_COUNT : this.entries.length, 8);
    eocd.writeUInt16LE(needs64 ? ZIP64_COUNT : this.entries.length, 10);
    eocd.writeUInt32LE(needs64 ? ZIP64_LIMIT : cdSize, 12);
    eocd.writeUInt32LE(needs64 ? ZIP64_LIMIT : cdStart, 16);
    eocd.writeUInt16LE(0, 20);
    await this._write(eocd);
  }
}

module.exports = { ZipWriter, crc32, safeEntryName };
