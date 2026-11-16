// Git's object layer: SHA-1 hashing, tree/commit/tag encoding, packfiles and
// pkt-lines. Standard library only (node:crypto, node:zlib). Packs this server
// writes are plain (no deltas); packs it reads may carry OFS/REF deltas, which
// resolve recursively.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import { sha1Hex, ZERO_OID } from './util.ts';
import type { GitObject, GitObjectType } from './store.ts';

export { ZERO_OID };

/** The object id of `<type> <size>\0<data>`. */
export function hashObject(type: GitObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return sha1Hex(Buffer.concat([header, data]));
}

export function isObjectId(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

// ---------------------------------------------------------------- trees

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

/** Sort order for tree entries: byte order of the name, a directory compared
 *  as if its name ended in '/'. */
export function compareTreeEntries(a: TreeEntry, b: TreeEntry): number {
  const an = a.mode === '40000' ? `${a.name}/` : a.name;
  const bn = b.mode === '40000' ? `${b.name}/` : b.name;
  return an < bn ? -1 : an > bn ? 1 : 0;
}

/** Encode a tree object from its entries (sorted). */
export function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeEntries);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Parse a tree object into its entries, in stored order. */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) break;
    const mode = data.subarray(offset, space).toString('utf8');
    const nul = data.indexOf(0, space + 1);
    if (nul < 0) break;
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

// ---------------------------------------------------------------- commits and tags

export interface Identity {
  name: string;
  email: string;
}

export interface CommitInfo {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

/** Encode a commit object. `timestamp` is epoch seconds; the zone is +0000. */
export function buildCommit(input: {
  tree: string;
  parents: readonly string[];
  author: Identity;
  committer: Identity;
  timestamp: number;
  message: string;
}): Buffer {
  const lines: string[] = [`tree ${input.tree}`];
  for (const parent of input.parents) lines.push(`parent ${parent}`);
  lines.push(
    `author ${input.author.name} <${input.author.email}> ${input.timestamp} +0000`,
    `committer ${input.committer.name} <${input.committer.email}> ${input.timestamp} +0000`,
    '',
    input.message,
  );
  return Buffer.from(lines.join('\n'), 'utf8');
}

/** Parse a commit object. */
export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const header = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  const out: CommitInfo = { tree: '', parents: [], author: '', committer: '', message };
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) out.tree = line.slice(5);
    else if (line.startsWith('parent ')) out.parents.push(line.slice(7));
    else if (line.startsWith('author ')) out.author = line.slice(7);
    else if (line.startsWith('committer ')) out.committer = line.slice(10);
  }
  return out;
}

/** Encode an annotated tag object. */
export function buildTag(input: {
  object: string;
  type: GitObjectType;
  tag: string;
  tagger: Identity;
  timestamp: number;
  message: string;
}): Buffer {
  const lines = [
    `object ${input.object}`,
    `type ${input.type}`,
    `tag ${input.tag}`,
    `tagger ${input.tagger.name} <${input.tagger.email}> ${input.timestamp} +0000`,
    '',
    input.message,
  ];
  return Buffer.from(lines.join('\n'), 'utf8');
}

/** Parse an annotated tag object. */
export function parseTag(data: Buffer): { object: string; type: string; tag: string; tagger: string; message: string } {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const header = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  const out = { object: '', type: '', tag: '', tagger: '', message };
  for (const line of header.split('\n')) {
    if (line.startsWith('object ')) out.object = line.slice(7);
    else if (line.startsWith('type ')) out.type = line.slice(5);
    else if (line.startsWith('tag ')) out.tag = line.slice(4);
    else if (line.startsWith('tagger ')) out.tagger = line.slice(7);
  }
  return out;
}

// ---------------------------------------------------------------- packfiles

const PACK_TYPES: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
const PACK_TYPE_IDS: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };

/** Read a varint object header: [typeId, size, bytesConsumed]. */
function readPackObjectHeader(buf: Buffer, offset: number): [number, number, number] {
  let byte = buf[offset] as number;
  const typeId = (byte >> 4) & 0x7;
  let size = byte & 0x0f;
  let shift = 4;
  let pos = offset + 1;
  while ((byte & 0x80) !== 0) {
    byte = buf[pos] as number;
    size |= (byte & 0x7f) << shift;
    shift += 7;
    pos += 1;
  }
  return [typeId, size, pos - offset];
}

/** Write a varint object header. */
function writePackObjectHeader(typeId: number, size: number): Buffer {
  const bytes: number[] = [];
  let first = (typeId << 4) | (size & 0x0f);
  size >>= 4;
  if (size > 0) first |= 0x80;
  bytes.push(first);
  while (size > 0) {
    let byte = size & 0x7f;
    size >>= 7;
    if (size > 0) byte |= 0x80;
    bytes.push(byte);
  }
  return Buffer.from(bytes);
}

/** Apply a binary delta (git's delta format) to a base buffer. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let pos = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[pos] as number;
      pos += 1;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  const baseSize = readVarint();
  if (baseSize !== base.length) throw new Error('delta base size mismatch');
  const resultSize = readVarint();
  const parts: Buffer[] = [];
  let total = 0;
  while (pos < delta.length) {
    const op = delta[pos] as number;
    pos += 1;
    if ((op & 0x80) !== 0) {
      let offset = 0;
      let size = 0;
      if ((op & 0x01) !== 0) offset = delta[pos] as number, pos += 1;
      if ((op & 0x02) !== 0) offset |= (delta[pos] as number) << 8, pos += 1;
      if ((op & 0x04) !== 0) offset |= (delta[pos] as number) << 16, pos += 1;
      if ((op & 0x08) !== 0) offset |= (delta[pos] as number) << 24, pos += 1;
      if ((op & 0x10) !== 0) size = delta[pos] as number, pos += 1;
      if ((op & 0x20) !== 0) size |= (delta[pos] as number) << 8, pos += 1;
      if ((op & 0x40) !== 0) size |= (delta[pos] as number) << 16, pos += 1;
      if (size === 0) size = 0x10000;
      parts.push(base.subarray(offset, offset + size));
      total += size;
    } else if (op !== 0) {
      parts.push(delta.subarray(pos, pos + op));
      total += op;
      pos += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  const out = Buffer.concat(parts);
  if (out.length !== resultSize || total !== resultSize) throw new Error('delta result size mismatch');
  return out;
}

/** Parse a packfile into objects. `resolveBase` supplies thin-pack bases the
 *  client already holds. Throws on a bad header, a bad trailer or an
 *  unresolvable delta. */
export function readPack(
  buf: Buffer,
  resolveBase?: (oid: string) => GitObject | undefined,
): Map<string, GitObject> {
  if (buf.length < 12 || buf.subarray(0, 4).toString('ascii') !== 'PACK') {
    throw new Error('not a packfile');
  }
  const version = buf.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = buf.readUInt32BE(8);
  if (buf.length < 32) throw new Error('packfile too short');
  const trailer = buf.subarray(buf.length - 20).toString('hex');
  if (trailer !== sha1Hex(buf.subarray(0, buf.length - 20))) throw new Error('pack trailer mismatch');

  interface RawEntry {
    offset: number;
    type: GitObjectType | 'ofs-delta' | 'ref-delta';
    data: Buffer;
    baseOid?: string;
    baseOffset?: number;
    oid?: string;
  }
  const entries: RawEntry[] = [];
  const byOffset = new Map<number, RawEntry>();
  let pos = 12;
  for (let index = 0; index < count; index += 1) {
    const offset = pos;
    const [typeId, size, headerLen] = readPackObjectHeader(buf, pos);
    pos += headerLen;
    let baseOid: string | undefined;
    let baseOffset: number | undefined;
    if (typeId === 6) {
      // OFS_DELTA: a negative offset to the base, varint-encoded.
      let byte = buf[pos] as number;
      pos += 1;
      let decoded = byte & 0x7f;
      while ((byte & 0x80) !== 0) {
        byte = buf[pos] as number;
        pos += 1;
        decoded = ((decoded + 1) << 7) | (byte & 0x7f);
      }
      baseOffset = offset - decoded;
    } else if (typeId === 7) {
      baseOid = buf.subarray(pos, pos + 20).toString('hex');
      pos += 20;
    } else if (PACK_TYPES[typeId] === undefined) {
      throw new Error(`unknown pack object type ${typeId}`);
    }
    const end = findDeflateEnd(buf, pos);
    const inflated = inflateSync(buf.subarray(pos, end), { maxOutputLength: Math.max(size, 1) });
    if (inflated.length !== size) throw new Error('pack object size mismatch');
    pos = end;
    const entry: RawEntry = {
      offset,
      type: typeId === 6 ? 'ofs-delta' : typeId === 7 ? 'ref-delta' : (PACK_TYPES[typeId] as GitObjectType),
      data: inflated,
      baseOid,
      baseOffset,
    };
    if (entry.type !== 'ofs-delta' && entry.type !== 'ref-delta') {
      entry.oid = hashObject(entry.type, inflated);
    }
    entries.push(entry);
    byOffset.set(offset, entry);
  }

  const objects = new Map<string, GitObject>();
  for (const entry of entries) {
    if (entry.oid !== undefined) objects.set(entry.oid, { type: entry.type as GitObjectType, data: entry.data });
  }
  const resolving = new Set<RawEntry>();
  const resolve = (entry: RawEntry): GitObject => {
    if (entry.oid !== undefined) {
      const found = objects.get(entry.oid);
      if (found !== undefined) return found;
    }
    if (resolving.has(entry)) throw new Error('delta cycle');
    resolving.add(entry);
    try {
      let base: GitObject | undefined;
      if (entry.type === 'ofs-delta') {
        const baseEntry = byOffset.get(entry.baseOffset as number);
        if (baseEntry === undefined) throw new Error('ofs-delta base not found');
        base = resolve(baseEntry);
      } else if (entry.type === 'ref-delta') {
        const baseOid = entry.baseOid as string;
        base = objects.get(baseOid) ?? resolveBase?.(baseOid);
        if (base === undefined) {
          const baseEntry = entries.find((candidate) => candidate.oid === baseOid);
          if (baseEntry !== undefined) base = resolve(baseEntry);
        }
      }
      if (base === undefined) throw new Error('delta base not found');
      const data = applyDelta(base.data, entry.data);
      const oid = hashObject(base.type, data);
      const object: GitObject = { type: base.type, data };
      entry.oid = oid;
      objects.set(oid, object);
      return object;
    } finally {
      resolving.delete(entry);
    }
  };
  for (const entry of entries) {
    if (entry.type === 'ofs-delta' || entry.type === 'ref-delta') resolve(entry);
  }
  return objects;
}

/** The offset just past the zlib stream starting at `pos`: the smallest end
 *  at which inflateSync succeeds (it ignores trailing bytes, throws when
 *  truncated), found by binary search. */
export function findDeflateEnd(buf: Buffer, pos: number): number {
  let lo = pos;
  let hi = buf.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    try {
      inflateSync(buf.subarray(pos, mid));
      hi = mid;
    } catch {
      lo = mid + 1;
    }
  }
  return lo;
}

/** Write a packfile (version 2, plain objects, no deltas), deterministic order. */
export function writePack(objects: readonly { type: GitObjectType; data: Buffer }[]): Buffer {
  const sorted = [...objects].sort((a, b) => {
    const ao = hashObject(a.type, a.data);
    const bo = hashObject(b.type, b.data);
    return ao < bo ? -1 : ao > bo ? 1 : 0;
  });
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(sorted.length, 8);
  const parts: Buffer[] = [header];
  for (const object of sorted) {
    parts.push(writePackObjectHeader(PACK_TYPE_IDS[object.type], object.data.length));
    parts.push(deflateSync(object.data, { level: 6 }));
  }
  const body = Buffer.concat(parts);
  const trailer = Buffer.from(sha1Hex(body), 'hex');
  return Buffer.concat([body, trailer]);
}

// ---------------------------------------------------------------- pkt-lines

/** Encode one pkt-line. `line` must end with '\n' when it is text. */
export function pktLine(line: string | Buffer): Buffer {
  const payload = typeof line === 'string' ? Buffer.from(line, 'utf8') : line;
  const length = payload.length + 4;
  const head = Buffer.alloc(4);
  head.write(length.toString(16).padStart(4, '0'), 0, 'ascii');
  return Buffer.concat([head, payload]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');
export const PKT_RESPONSE_END = Buffer.from('0002', 'ascii');

export type PktPacket =
  | { kind: 'data'; payload: Buffer }
  | { kind: 'flush' }
  | { kind: 'delim' }
  | { kind: 'response-end' };

/** Decode pkt-lines from a buffer. Returns the packets and the bytes consumed.
 *  Throws on a malformed length. A trailing partial packet stops decoding.
 *  With stopAtFlush, decoding stops after the first flush packet: everything
 *  after it is raw data (a packfile), not pkt-lines. */
export function decodePktLines(buf: Buffer, options: { stopAtFlush?: boolean } = {}): { packets: PktPacket[]; consumed: number } {
  const packets: PktPacket[] = [];
  let pos = 0;
  while (pos + 4 <= buf.length) {
    const head = buf.subarray(pos, pos + 4).toString('ascii');
    if (head === '0000') {
      packets.push({ kind: 'flush' });
      pos += 4;
      if (options.stopAtFlush === true) break;
      continue;
    }
    if (head === '0001') {
      packets.push({ kind: 'delim' });
      pos += 4;
      continue;
    }
    if (head === '0002') {
      packets.push({ kind: 'response-end' });
      pos += 4;
      continue;
    }
    const length = Number.parseInt(head, 16);
    if (!Number.isFinite(length) || length < 4 || length > 65520) {
      throw new Error(`malformed pkt-line length ${JSON.stringify(head)}`);
    }
    if (pos + length > buf.length) break;
    packets.push({ kind: 'data', payload: buf.subarray(pos + 4, pos + length) });
    pos += length;
  }
  return { packets, consumed: pos };
}

/** Wrap data bytes into sideband packets (band 1), each a pkt-line. */
export function sidebandPackets(data: Buffer, band = 1): Buffer {
  if (data.length === 0) return Buffer.alloc(0);
  const parts: Buffer[] = [];
  const maxChunk = 65520 - 5;
  for (let offset = 0; offset < data.length; offset += maxChunk) {
    const chunk = data.subarray(offset, Math.min(data.length, offset + maxChunk));
    const payload = Buffer.concat([Buffer.from([band]), chunk]);
    parts.push(pktLine(payload));
  }
  return Buffer.concat(parts);
}
