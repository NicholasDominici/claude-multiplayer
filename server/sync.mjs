// Live two-way mirror of the shared folder over the encrypted peer link.
// Each side scans its copy once a second and sends changed files whole. On
// connect, both sides swap a manifest and the newer copy of each file wins.
// Nothing is ever unlinked: deleted files and files that lose a conflict move
// to <shared>/.multiplayer/trash/. Symlinks and paths that leave the folder
// are refused, so the peer can only write inside the shared folder.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const IGNORED_NAMES = new Set(['.git', 'node_modules', '.DS_Store', 'Thumbs.db', '.multiplayer', '__pycache__', '.venv']);
const TEMP_MARKER = '.mp-tmp-';
export const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_FILES = 5000;
const SCAN_MS = 1000;

/** Returns the normalized relative path, or null when it is unsafe or ignored. */
export function safeRelPath(rel) {
  if (typeof rel !== 'string' || rel.length === 0 || rel.length > 1024) return null;
  if (rel.includes('\0') || rel.includes('\\') || rel.startsWith('/') || /^[A-Za-z]:/.test(rel)) return null;
  const parts = rel.split('/');
  for (const part of parts) {
    if (part === '' || part === '.' || part === '..') return null;
    if (IGNORED_NAMES.has(part) || part.includes(TEMP_MARKER)) return null;
  }
  return parts.join('/');
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

export class FolderSync {
  /**
   * @param {object} opts
   * @param {string} opts.root shared folder on this machine
   * @param {(frame: object) => void} opts.send sends one frame to the peer
   * @param {boolean} opts.tieWinner true on exactly one side, to settle equal mtimes
   * @param {(msg: string) => void} opts.log
   */
  constructor({ root, send, tieWinner, log }) {
    this.root = root;
    this.send = send;
    this.tieWinner = tieWinner;
    this.log = log || (() => {});
    this.live = false;
    this.timer = null;
    this.warned = new Set();
    this.stats = { sent: 0, received: 0, deleted: 0, conflicts: 0, refused: 0 };
    fs.mkdirSync(root, { recursive: true });
    this.rootReal = fs.realpathSync(root);
    this.known = new Map();
    this.known = this.scan();
  }

  /** Starts syncing after the link goes live. */
  connected() {
    this.live = true;
    this.known = this.scan();
    this.send({ t: 'manifest', files: Object.fromEntries(this.known) });
    clearInterval(this.timer);
    this.timer = setInterval(() => this.safeTick(), SCAN_MS);
    this.timer.unref?.();
  }

  /** Pauses syncing while the link is down. */
  disconnected() {
    this.live = false;
    clearInterval(this.timer);
    this.timer = null;
  }

  stop() {
    this.disconnected();
  }

  /** Handles one sync frame from the peer. */
  handle(frame) {
    try {
      if (frame.t === 'manifest') this.onManifest(frame.files);
      else if (frame.t === 'file') this.onFile(frame);
      else if (frame.t === 'del') this.onDelete(frame);
    } catch (err) {
      this.log(`sync: ${frame.t} failed: ${err.message}`);
    }
  }

  safeTick() {
    try {
      this.tick();
    } catch (err) {
      this.log(`sync: scan failed: ${err.message}`);
    }
  }

  tick() {
    if (!this.live) return;
    const now = this.scan();
    for (const [rel, cur] of now) {
      const prev = this.known.get(rel);
      if (!prev || prev.h !== cur.h) this.sendFile(rel);
    }
    for (const [rel, prev] of this.known) {
      if (!now.has(rel)) this.send({ t: 'del', path: rel, h: prev.h });
    }
    this.known = now;
  }

  /** Walks the shared folder; reuses hashes for files whose size and mtime did not change. */
  scan() {
    const out = new Map();
    const walk = (dir, base) => {
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (IGNORED_NAMES.has(entry.name) || entry.name.includes(TEMP_MARKER) || entry.isSymbolicLink()) continue;
        const full = path.join(dir, entry.name);
        const rel = base ? `${base}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          walk(full, rel);
        } else if (entry.isFile()) {
          if (out.size >= MAX_FILES) {
            this.warnOnce('too-many', `sync: more than ${MAX_FILES} files; the rest are not synced`);
            return;
          }
          let st;
          try {
            st = fs.statSync(full);
          } catch {
            continue;
          }
          if (st.size > MAX_FILE_BYTES) {
            this.warnOnce(rel, `sync: ${rel} is over ${MAX_FILE_BYTES} bytes; not synced`);
            continue;
          }
          const prev = this.known.get(rel);
          let h = prev && prev.m === st.mtimeMs && prev.s === st.size ? prev.h : null;
          if (!h) {
            try {
              h = sha256(fs.readFileSync(full));
            } catch {
              continue;
            }
          }
          out.set(rel, { h, m: st.mtimeMs, s: st.size });
        }
      }
    };
    walk(this.rootReal, '');
    return out;
  }

  sendFile(rel) {
    const full = path.join(this.rootReal, ...rel.split('/'));
    let data;
    let st;
    try {
      data = fs.readFileSync(full);
      st = fs.statSync(full);
    } catch {
      return;
    }
    this.send({ t: 'file', path: rel, h: sha256(data), m: st.mtimeMs, data: data.toString('base64') });
    this.stats.sent++;
  }

  onManifest(files) {
    if (!files || typeof files !== 'object') return;
    for (const [rel, mine] of this.known) {
      const theirs = files[rel];
      if (!theirs) {
        this.sendFile(rel);
      } else if (theirs.h !== mine.h) {
        if (mine.m > theirs.m || (mine.m === theirs.m && this.tieWinner)) this.sendFile(rel);
      }
    }
  }

  onFile(frame) {
    const rel = safeRelPath(frame.path);
    if (!rel || typeof frame.data !== 'string') return this.refuse(frame.path);
    const data = Buffer.from(frame.data, 'base64');
    if (data.length > MAX_FILE_BYTES || sha256(data) !== frame.h) return this.refuse(rel);
    const target = this.resolveTarget(rel);
    if (!target) return this.refuse(rel);

    let current = null;
    try {
      const lst = fs.lstatSync(target);
      if (!lst.isFile()) return this.refuse(rel);
      current = sha256(fs.readFileSync(target));
    } catch {}
    if (current === frame.h) {
      const st = fs.statSync(target);
      this.known.set(rel, { h: current, m: st.mtimeMs, s: st.size });
      return;
    }
    const prev = this.known.get(rel);
    if (current !== null && (!prev || prev.h !== current)) {
      // A local edit that the peer has not seen yet: keep it in the trash.
      this.moveToTrash(target, rel, 'conflict');
      this.stats.conflicts++;
    }

    const tmp = path.join(path.dirname(target), `.${path.basename(target)}${TEMP_MARKER}${crypto.randomBytes(4).toString('hex')}`);
    fs.writeFileSync(tmp, data, { flag: 'wx' });
    const mtime = Number.isFinite(frame.m) ? new Date(frame.m) : new Date();
    fs.utimesSync(tmp, new Date(), mtime);
    fs.renameSync(tmp, target);
    const st = fs.statSync(target);
    this.known.set(rel, { h: frame.h, m: st.mtimeMs, s: st.size });
    this.stats.received++;
  }

  onDelete(frame) {
    const rel = safeRelPath(frame.path);
    if (!rel) return this.refuse(frame.path);
    const target = this.resolveTarget(rel, false);
    if (!target) return;
    let current;
    try {
      if (!fs.lstatSync(target).isFile()) return;
      current = sha256(fs.readFileSync(target));
    } catch {
      this.known.delete(rel);
      return;
    }
    const prev = this.known.get(rel);
    if ((prev && prev.h === current) || frame.h === current) {
      this.moveToTrash(target, rel, 'deleted');
      this.known.delete(rel);
      this.stats.deleted++;
    }
    // Otherwise the local copy changed since the last sync; the next scan sends it back.
  }

  /**
   * Maps a safe relative path to an absolute path inside the shared folder.
   * Walks each parent with lstat, so a symlinked directory can never redirect a write.
   */
  resolveTarget(rel, create = true) {
    const parts = rel.split('/');
    let dir = this.rootReal;
    for (const part of parts.slice(0, -1)) {
      dir = path.join(dir, part);
      let st;
      try {
        st = fs.lstatSync(dir);
      } catch {
        if (!create) return null;
        fs.mkdirSync(dir);
        continue;
      }
      if (!st.isDirectory()) return null;
    }
    return path.join(dir, parts[parts.length - 1]);
  }

  moveToTrash(full, rel, reason) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dest = path.join(this.rootReal, '.multiplayer', 'trash', `${stamp}-${reason}`, ...rel.split('/'));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.renameSync(full, dest);
  }

  refuse(rel) {
    this.stats.refused++;
    this.log(`sync: refused ${JSON.stringify(String(rel)).slice(0, 200)}`);
  }

  warnOnce(key, msg) {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    this.log(msg);
  }
}
