// Git smart HTTP: info/refs (v0/v2 advertisements), upload-pack (v2 ls-refs
// and fetch, v0 fetch) and receive-pack (v0). The wire is exactly what the
// suite's git-client speaks; see program/env/src/git-client.ts in the kit.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { VIEWER, ZERO_OID, isAuthenticated, readBody, sendError, sendJson } from './util.ts';
import type { Repo, Store } from './store.ts';
import {
  decodePktLines,
  hashObject,
  isObjectId,
  parseCommit,
  parseTag,
  parseTree,
  pktLine,
  readPack,
  sidebandPackets,
  writePack,
  PKT_FLUSH,
} from './gitcore.ts';
import type { GitObject } from './store.ts';

const AGENT = 'forge/1.0.0';
const UPLOAD_V0_CAPS = `symref=HEAD:refs/heads/main side-band-64k shallow multi_ack_detailed thin-pack ofs-delta agent=${AGENT} object-format=sha1`;
const RECEIVE_V0_CAPS = `report-status side-band-64k delete-refs ofs-delta agent=${AGENT} symref=HEAD:refs/heads/main`;
const V2_CAPS = ['agent=' + AGENT, 'ls-refs=unborn', 'fetch=shallow', 'object-format=sha1'];

interface Ctx {
  store: Store;
  req: IncomingMessage;
  res: ServerResponse;
}

/** Look a repository up by owner/name. Any owner other than the viewer is a
 *  404, never a 403 (the rules' wire contract). */
function lookupRepo(ctx: Ctx, owner: string, name: string): Repo | null {
  if (owner !== VIEWER.login) return null;
  return ctx.store.getRepo(owner, name) ?? null;
}

function sendGit404(ctx: Ctx): void {
  ctx.res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
  ctx.res.end(JSON.stringify({ message: 'Not Found' }));
}

/** All refs of a repo, sorted: heads first, then tags, each by name. */
function sortedRefs(repo: Repo): { name: string; oid: string }[] {
  const heads: { name: string; oid: string }[] = [];
  const tags: { name: string; oid: string }[] = [];
  for (const [name, oid] of repo.refs) {
    if (name.startsWith('refs/heads/')) heads.push({ name, oid });
    else if (name.startsWith('refs/tags/')) tags.push({ name, oid });
    else heads.push({ name, oid });
  }
  heads.sort((a, b) => (a.name < b.name ? -1 : 1));
  tags.sort((a, b) => (a.name < b.name ? -1 : 1));
  return [...heads, ...tags];
}

/** The default branch tip, or ZERO_OID when the repo has no commits. */
function headOid(repo: Repo): string {
  return repo.refs.get(`refs/heads/${repo.default_branch}`) ?? ZERO_OID;
}

// ---------------------------------------------------------------- advertisements

function v0Advertisement(ctx: Ctx, repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): void {
  const caps = service === 'git-upload-pack' ? UPLOAD_V0_CAPS : RECEIVE_V0_CAPS;
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), PKT_FLUSH];
  const refs = sortedRefs(repo);
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    const tip = headOid(repo);
    parts.push(pktLine(`${tip} HEAD\0${caps}\n`));
    for (const ref of refs) {
      parts.push(pktLine(`${ref.oid} ${ref.name}\n`));
      const object = repo.objects.get(ref.oid);
      if (ref.name.startsWith('refs/tags/') && object?.type === 'tag') {
        const tag = parseTag(object.data);
        parts.push(pktLine(`${tag.object} ${ref.name}^{}\n`));
      }
    }
  }
  const body = Buffer.concat(parts);
  ctx.res.writeHead(200, {
    'content-type': `application/x-${service}-advertisement`,
    'content-length': body.length,
  });
  ctx.res.end(body);
}

function v2Advertisement(ctx: Ctx, repo: Repo): void {
  const parts: Buffer[] = [pktLine('version 2\n')];
  for (const cap of V2_CAPS) parts.push(pktLine(`${cap}\n`));
  parts.push(PKT_FLUSH);
  const body = Buffer.concat(parts);
  ctx.res.writeHead(200, {
    'content-type': 'application/x-git-upload-pack-advertisement',
    'content-length': body.length,
  });
  ctx.res.end(body);
}

// ---------------------------------------------------------------- fetch computation

interface FetchParams {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth?: number;
}

interface FetchResult {
  objects: Map<string, GitObject>;
  shallowOut: string[];
  unshallowOut: string[];
  acks: string[];
}

/** The ancestors of `roots` (commits only), with their distance from a root. */
function commitDistances(repo: Repo, roots: readonly string[]): Map<string, number> {
  const dist = new Map<string, number>();
  const queue: string[] = [];
  for (const root of roots) {
    if (!dist.has(root)) {
      dist.set(root, 0);
      queue.push(root);
    }
  }
  for (let index = 0; index < queue.length; index += 1) {
    const oid = queue[index] as string;
    const depth = dist.get(oid) as number;
    const object = repo.objects.get(oid);
    if (object?.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) {
      if (!dist.has(parent)) {
        dist.set(parent, depth + 1);
        queue.push(parent);
      }
    }
  }
  return dist;
}

/** Trees and blobs reachable from the trees of these commits (no parents). */
function treeClosure(repo: Repo, commits: ReadonlySet<string>): Set<string> {
  const out = new Set<string>();
  const queue: string[] = [];
  for (const commitOid of commits) {
    const object = repo.objects.get(commitOid);
    if (object?.type !== 'commit') continue;
    const tree = parseCommit(object.data).tree;
    if (tree !== '' && !out.has(tree)) {
      out.add(tree);
      queue.push(tree);
    }
  }
  for (let index = 0; index < queue.length; index += 1) {
    const oid = queue[index] as string;
    const object = repo.objects.get(oid);
    if (object?.type !== 'tree') continue;
    for (const entry of parseTree(object.data)) {
      if (out.has(entry.oid)) continue;
      out.add(entry.oid);
      if (entry.mode === '40000') queue.push(entry.oid);
    }
  }
  return out;
}

/** Whether `ancestor` is an ancestor of (or equal to) `descendant`. */
export function isAncestor(repo: Repo, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>([descendant]);
  const queue = [descendant];
  for (let index = 0; index < queue.length; index += 1) {
    const oid = queue[index] as string;
    const object = repo.objects.get(oid);
    if (object?.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) {
      if (parent === ancestor) return true;
      if (!seen.has(parent)) {
        seen.add(parent);
        queue.push(parent);
      }
    }
  }
  return false;
}

function computeFetch(repo: Repo, params: FetchParams): FetchResult {
  const { wants, haves, shallow, depth } = params;
  // Validate the wants and expand tag wants to their targets.
  const tagObjects = new Map<string, GitObject>();
  const commitRoots: string[] = [];
  for (const want of wants) {
    const object = repo.objects.get(want);
    if (object === undefined) throw new Error(`unknown object ${want}`);
    if (object.type === 'tag') {
      tagObjects.set(want, object);
      commitRoots.push(parseTag(object.data).object);
    } else if (object.type === 'commit') {
      commitRoots.push(want);
    } else {
      // A tree or blob want: send it directly.
      tagObjects.set(want, object);
    }
  }
  // Commits within depth of a want (depth counts the want itself as 0).
  const dist = commitDistances(repo, commitRoots);
  const included = new Map<string, number>();
  for (const [oid, d] of dist) {
    if (depth === undefined || d < depth) included.set(oid, d);
  }
  const haveSet = new Set(haves);
  const sendCommits = new Set<string>();
  for (const oid of included.keys()) {
    if (!haveSet.has(oid)) sendCommits.add(oid);
  }
  // Trees/blobs of the sent commits, minus the trees/blobs of the haves.
  const haveCommits = new Set<string>();
  for (const have of haves) {
    const object = repo.objects.get(have);
    if (object?.type === 'commit') haveCommits.add(have);
    else if (object?.type === 'tag') haveCommits.add(parseTag(object.data).object);
  }
  const sendObjects = new Map<string, GitObject>();
  for (const oid of sendCommits) {
    const object = repo.objects.get(oid);
    if (object !== undefined) sendObjects.set(oid, object);
  }
  for (const oid of treeClosure(repo, sendCommits)) {
    const object = repo.objects.get(oid);
    if (object !== undefined) sendObjects.set(oid, object);
  }
  const held = new Set<string>(haves);
  for (const oid of treeClosure(repo, haveCommits)) held.add(oid);
  for (const oid of held) sendObjects.delete(oid);
  // A wanted tag object itself is always sent (unless held).
  for (const [oid, object] of tagObjects) {
    if (!held.has(oid)) sendObjects.set(oid, object);
  }
  // Shallow boundaries: included commits at distance depth-1; previous
  // boundaries whose parents are now included become unshallow.
  const shallowOut: string[] = [];
  const unshallowOut: string[] = [];
  if (depth !== undefined) {
    for (const [oid, d] of included) {
      if (d === depth - 1) shallowOut.push(oid);
    }
    for (const boundary of shallow) {
      const d = included.get(boundary);
      if (d !== undefined && d < depth - 1) unshallowOut.push(boundary);
    }
  }
  // ACKs: haves that are ancestors of (or equal to) a want.
  const ancestors = commitDistances(repo, commitRoots);
  const acks: string[] = [];
  for (const have of haves) {
    if (ancestors.has(have)) acks.push(have);
  }
  return { objects: sendObjects, shallowOut, unshallowOut, acks };
}

// ---------------------------------------------------------------- upload-pack

interface V2Command {
  command: string;
  args: Record<string, string[]>;
  prefixes: string[];
  flags: Set<string>;
}

/** Parse a v2 request body into its command and arguments. */
function parseV2Request(body: Buffer): V2Command {
  const { packets } = decodePktLines(body);
  const command: V2Command = { command: '', args: {}, prefixes: [], flags: new Set() };
  let seenDelim = false;
  for (const packet of packets) {
    if (packet.kind === 'flush') break;
    if (packet.kind === 'delim') {
      seenDelim = true;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (!seenDelim) {
      const eq = line.indexOf('=');
      if (eq >= 0) command.args[line.slice(0, eq)] = [line.slice(eq + 1)];
      continue;
    }
    if (line === 'peel' || line === 'symrefs' || line === 'unborn' || line === 'thin-pack' || line === 'no-progress' || line === 'ofs-delta' || line === 'done') {
      command.flags.add(line);
      continue;
    }
    const space = line.indexOf(' ');
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1);
    if (key === 'command') command.command = value;
    else if (key === 'ref-prefix') command.prefixes.push(value);
    else {
      const list = command.args[key] ?? [];
      list.push(value);
      command.args[key] = list;
    }
  }
  if (command.command === '') {
    const first = command.args.command?.[0];
    if (first !== undefined) command.command = first;
  }
  return command;
}

function lsRefsResponse(ctx: Ctx, repo: Repo, command: V2Command): void {
  const peel = command.flags.has('peel');
  const symrefs = command.flags.has('symrefs');
  const unborn = command.flags.has('unborn');
  const prefixes = command.prefixes;
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const parts: Buffer[] = [];
  const tip = headOid(repo);
  const empty = sortedRefs(repo).length === 0;
  if (empty) {
    // Only the unborn HEAD line: an `unborn refs/heads/main` line reads as a
    // real ref to the client (and as an existing branch tip to the fixtures),
    // so a fresh repo must not advertise it.
    if (unborn && keep('HEAD')) {
      parts.push(pktLine(`unborn HEAD${symrefs ? ' symref-target:refs/heads/main' : ''}\n`));
    }
  } else {
    if (keep('HEAD')) {
      parts.push(pktLine(`${tip} HEAD${symrefs ? ' symref-target:refs/heads/main' : ''}\n`));
    }
    for (const ref of sortedRefs(repo)) {
      if (!keep(ref.name)) continue;
      const object = repo.objects.get(ref.oid);
      let line = `${ref.oid} ${ref.name}`;
      if (peel && ref.name.startsWith('refs/tags/') && object?.type === 'tag') {
        line += ` peeled:${parseTag(object.data).object}`;
      }
      parts.push(pktLine(`${line}\n`));
    }
  }
  parts.push(PKT_FLUSH);
  const body = Buffer.concat(parts);
  ctx.res.writeHead(200, {
    'content-type': 'application/x-git-upload-pack-result',
    'content-length': body.length,
  });
  ctx.res.end(body);
}

function v2FetchResponse(ctx: Ctx, repo: Repo, command: V2Command): void {
  const wants = command.args.want ?? [];
  const haves = command.args.have ?? [];
  const shallow = command.args.shallow ?? [];
  const deepen = command.args.deepen?.[0];
  const depth = deepen === undefined ? undefined : Number.parseInt(deepen, 10);
  const cacheKey = JSON.stringify(['v2', wants, haves, shallow, depth]);
  const cached = repo.fetchCache.get(cacheKey);
  if (cached !== undefined) {
    ctx.res.writeHead(200, {
      'content-type': 'application/x-git-upload-pack-result',
      'content-length': cached.length,
    });
    ctx.res.end(cached);
    return;
  }
  const result = computeFetch(repo, { wants, haves, shallow, depth: Number.isFinite(depth) ? depth : undefined });
  const parts: Buffer[] = [];
  // acknowledgments
  parts.push(pktLine('acknowledgments\n'));
  if (result.acks.length > 0) {
    for (const ack of result.acks) parts.push(pktLine(`ACK ${ack}\n`));
    parts.push(pktLine('ready\n'));
  } else {
    parts.push(pktLine('NAK\n'));
  }
  parts.push(PKT_FLUSH);
  // shallow-info
  if (result.shallowOut.length > 0 || result.unshallowOut.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of result.shallowOut) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of result.unshallowOut) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(PKT_FLUSH);
  }
  // packfile
  const pack = writePack([...result.objects.values()]);
  parts.push(pktLine('packfile\n'));
  parts.push(sidebandPackets(pack, 1));
  parts.push(PKT_FLUSH);
  const body = Buffer.concat(parts);
  if (repo.fetchCache.size > 64) repo.fetchCache.clear();
  repo.fetchCache.set(cacheKey, body);
  ctx.res.writeHead(200, {
    'content-type': 'application/x-git-upload-pack-result',
    'content-length': body.length,
  });
  ctx.res.end(body);
}

/** Parse a v0 fetch body: wants (+shallow/deepen) to the first flush, then
 *  haves (+done) to the second. */
function parseV0Fetch(body: Buffer): FetchParams {
  const { packets } = decodePktLines(body);
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | undefined;
  let section = 0;
  for (const packet of packets) {
    if (packet.kind === 'flush') {
      section += 1;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    const [key, ...rest] = line.split(' ');
    if (section === 0) {
      if (key === 'want') wants.push(rest[0] as string);
      else if (key === 'shallow') shallow.push(rest[0] as string);
      else if (key === 'deepen') depth = Number.parseInt(rest[0] as string, 10);
    } else {
      if (key === 'have') haves.push(rest[0] as string);
    }
  }
  return { wants, haves, shallow, depth };
}

function v0FetchResponse(ctx: Ctx, repo: Repo, body: Buffer): void {
  const params = parseV0Fetch(body);
  const cacheKey = JSON.stringify(['v0', params.wants, params.haves, params.shallow, params.depth]);
  const cached = repo.fetchCache.get(cacheKey);
  if (cached !== undefined) {
    ctx.res.writeHead(200, {
      'content-type': 'application/x-git-upload-pack-result',
      'content-length': cached.length,
    });
    ctx.res.end(cached);
    return;
  }
  const result = computeFetch(repo, params);
  const parts: Buffer[] = [];
  if (result.acks.length > 0) {
    for (const ack of result.acks) parts.push(pktLine(`ACK ${ack}\n`));
  } else {
    parts.push(pktLine('NAK\n'));
  }
  for (const oid of result.shallowOut) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of result.unshallowOut) parts.push(pktLine(`unshallow ${oid}\n`));
  const pack = writePack([...result.objects.values()]);
  parts.push(sidebandPackets(pack, 1));
  const out = Buffer.concat(parts);
  if (repo.fetchCache.size > 64) repo.fetchCache.clear();
  repo.fetchCache.set(cacheKey, out);
  ctx.res.writeHead(200, {
    'content-type': 'application/x-git-upload-pack-result',
    'content-length': out.length,
  });
  ctx.res.end(out);
}

// ---------------------------------------------------------------- receive-pack

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

function receivePack(ctx: Ctx, repo: Repo, body: Buffer): void {
  let commands: PushCommand[] = [];
  let packStart = 0;
  try {
    // The command list ends at the first flush; the packfile follows it raw.
    const { packets, consumed } = decodePktLines(body, { stopAtFlush: true });
    packStart = consumed;
    for (const packet of packets) {
      if (packet.kind === 'flush') break;
      if (packet.kind !== 'data') continue;
      let line = packet.payload.toString('utf8').replace(/\n$/, '');
      const nul = line.indexOf('\0');
      if (nul >= 0) line = line.slice(0, nul);
      const [oldOid, newOid, ref] = line.split(' ');
      if (oldOid !== undefined && newOid !== undefined && ref !== undefined) {
        commands.push({ oldOid, newOid, ref });
      }
    }
  } catch {
    sendError(ctx.res, 400, 'malformed pkt-line stream');
    return;
  }
  const packBytes = body.subarray(packStart);
  let unpackError: string | null = null;
  let newObjects = new Map<string, GitObject>();
  if (packBytes.length > 0) {
    try {
      newObjects = readPack(packBytes);
    } catch (err) {
      unpackError = err instanceof Error ? err.message : 'unpack failed';
    }
  }
  const lines: string[] = [];
  if (unpackError !== null) {
    lines.push(`unpack ${unpackError}`);
    for (const command of commands) lines.push(`ng ${command.ref} unpack failed`);
  } else {
    lines.push('unpack ok');
    for (const command of commands) {
      const current = repo.refs.get(command.ref);
      let ok = false;
      let reason = 'non-fast-forward';
      if (command.newOid === ZERO_OID) {
        // Delete.
        if (current !== undefined && current === command.oldOid) ok = true;
      } else if (command.oldOid === ZERO_OID) {
        // Create.
        if (current === undefined) {
          const hasObject = repo.objects.has(command.newOid) || newObjects.has(command.newOid);
          if (hasObject) ok = true;
          else reason = 'object not found';
        }
      } else if (current === command.oldOid) {
        // Update: the new tip must descend from the old one.
        const hasObject = repo.objects.has(command.newOid) || newObjects.has(command.newOid);
        if (!hasObject) {
          reason = 'object not found';
        } else if (isAncestorWithPack(repo, newObjects, command.oldOid, command.newOid)) {
          ok = true;
        }
      }
      if (ok) {
        for (const [oid, object] of newObjects) repo.objects.set(oid, object);
        if (command.newOid === ZERO_OID) repo.refs.delete(command.ref);
        else repo.refs.set(command.ref, command.newOid);
        repo.fetchCache.clear();
        lines.push(`ok ${command.ref}`);
      } else {
        lines.push(`ng ${command.ref} ${reason}`);
      }
    }
  }
  const report = Buffer.concat([...lines.map((line) => pktLine(`${line}\n`)), PKT_FLUSH]);
  const out = sidebandPackets(report, 1);
  ctx.res.writeHead(200, {
    'content-type': 'application/x-git-receive-pack-result',
    'content-length': out.length,
  });
  ctx.res.end(out);
}

/** Ancestor check that also consults objects arriving in this push's pack. */
function isAncestorWithPack(repo: Repo, pack: Map<string, GitObject>, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>([descendant]);
  const queue = [descendant];
  for (let index = 0; index < queue.length; index += 1) {
    const oid = queue[index] as string;
    const object = pack.get(oid) ?? repo.objects.get(oid);
    if (object?.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) {
      if (parent === ancestor) return true;
      if (!seen.has(parent)) {
        seen.add(parent);
        queue.push(parent);
      }
    }
  }
  return false;
}

// ---------------------------------------------------------------- entry point

/** The entry point, given the owner, repo name and the path under /{owner}/{repo}.git/. */
export async function handleGitPath(
  store: Store,
  req: IncomingMessage,
  res: ServerResponse,
  owner: string,
  repoName: string,
  rest: string[],
  query: Record<string, string>,
): Promise<void> {
  const ctx: Ctx = { store, req, res };
  if (!isAuthenticated(req)) {
    sendError(res, 401, 'Bad credentials');
    return;
  }
  const repo = lookupRepo(ctx, owner, repoName);
  if (repo === null) {
    sendGit404(ctx);
    return;
  }
  const method = req.method ?? 'GET';
  if (method === 'GET' && rest[0] === 'info' && rest[1] === 'refs') {
    const service = query.service ?? '';
    if (service === 'git-upload-pack') {
      if ((req.headers['git-protocol'] ?? '') === 'version=2') v2Advertisement(ctx, repo);
      else v0Advertisement(ctx, repo, 'git-upload-pack');
      return;
    }
    if (service === 'git-receive-pack') {
      v0Advertisement(ctx, repo, 'git-receive-pack');
      return;
    }
    sendGit404(ctx);
    return;
  }
  if (method === 'POST' && rest.length === 1 && rest[0] === 'git-upload-pack') {
    let body: Buffer;
    try {
      body = await readBody(req);
    } catch {
      sendError(res, 400, 'request body too large');
      return;
    }
    try {
      if ((req.headers['git-protocol'] ?? '') === 'version=2') {
        const command = parseV2Request(body);
        if (command.command === 'ls-refs') lsRefsResponse(ctx, repo, command);
        else if (command.command === 'fetch') v2FetchResponse(ctx, repo, command);
        else sendError(res, 400, `unknown command ${command.command}`);
      } else {
        v0FetchResponse(ctx, repo, body);
      }
    } catch (err) {
      // A malformed request must not kill the server (repo-survives-errors).
      sendError(res, 400, err instanceof Error ? err.message : 'malformed request');
    }
    return;
  }
  if (method === 'POST' && rest.length === 1 && rest[0] === 'git-receive-pack') {
    let body: Buffer;
    try {
      body = await readBody(req);
    } catch {
      sendError(res, 400, 'request body too large');
      return;
    }
    try {
      receivePack(ctx, repo, body);
    } catch (err) {
      sendError(res, 400, err instanceof Error ? err.message : 'malformed request');
    }
    return;
  }
  sendGit404(ctx);
}
