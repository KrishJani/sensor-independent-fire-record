// File helpers: streaming line readers, hashing, deterministic gzip.

import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { createInterface } from 'node:readline';
import { createGunzip, gunzipSync, gzipSync } from 'node:zlib';
import type { Readable } from 'node:stream';

export function listCsvFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      if (name.startsWith('.')) continue;
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.csv(\.gz)?$/i.test(name)) out.push(p);
    }
  };
  walk(dir);
  return out.sort();
}

/** Stream lines of a .csv or .csv.gz file; also returns the SHA-256 of the file bytes. */
export async function forEachLine(path: string, fn: (line: string) => void): Promise<{ sha256: string; lines: number }> {
  const hash = createHash('sha256');
  const raw = createReadStream(path);
  raw.on('data', (b) => hash.update(b as Buffer));
  const src: Readable = path.endsWith('.gz') ? raw.pipe(createGunzip()) : raw;
  const rl = createInterface({ input: src, crlfDelay: Infinity });
  let lines = 0;
  for await (const line of rl) {
    lines++;
    fn(line);
  }
  return { sha256: hash.digest('hex'), lines };
}

export function ensureDir(p: string) {
  mkdirSync(p, { recursive: true });
}

/** Atomic write: tmp file + rename, so a crash never leaves a half-written output. */
export function writeAtomic(path: string, data: string | Buffer) {
  ensureDir(dirname(path));
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, data);
  renameSync(tmp, path);
}

/**
 * gzip whose bytes do not depend on the host: Node already writes MTIME = 0; we also set the
 * OS byte (offset 9) to 255 "unknown" (macOS zlib writes 19, Linux 3). The manifest hashes the
 * *uncompressed* content anyway, so a different zlib build can never fail `verify`.
 */
export function gzipDeterministic(data: string | Buffer): Buffer {
  const buf = gzipSync(data, { level: 9 });
  buf[9] = 0xff;
  return buf;
}

export function sha256(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

/** Content hash used in the manifest: for .gz, the hash of the decompressed bytes. */
export function contentHashOfFile(path: string, bytes: Buffer): string {
  return sha256(path.endsWith('.gz') ? gunzipSync(bytes) : bytes);
}

export function rel(from: string, p: string) {
  return relative(from, p).split('\\').join('/');
}

/** Line-buffered appender for many temp files at once. */
export function createAppenders() {
  const streams = new Map<string, ReturnType<typeof createWriteStream>>();
  return {
    write(path: string, line: string) {
      let s = streams.get(path);
      if (!s) {
        ensureDir(dirname(path));
        s = createWriteStream(path, { flags: 'w' });
        streams.set(path, s);
      }
      s.write(line);
    },
    async closeAll() {
      await Promise.all(
        [...streams.values()].map((s) => new Promise<void>((res, rej) => s.end((e?: Error | null) => (e ? rej(e) : res())))),
      );
      streams.clear();
    },
  };
}
