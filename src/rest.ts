// REST v3: repositories, issues, pull requests, contents, labels, git refs.
// Every reply is application/json with a non-empty X-GitHub-Request-Id; every
// error body is {message}; a request without the trial's token is 401.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { VIEWER, b64decode, decodeSegment, isAuthenticated, nextLink, nextRequestId, pageParams, paginate, parseJsonBody, readBody, sendError, sendJson } from './util.ts';
import { commentGlobalId, itemGlobalId, repoGlobalId, type Comment, type Issue, type Label, type Pull, type Repo, type Store } from './store.ts';
import { buildCommit, buildTree, hashObject, parseCommit, parseTree, type TreeEntry } from './gitcore.ts';
import { isAncestor } from './githttp.ts';

// ---------------------------------------------------------------- shapes

function userObject(login: string): Record<string, unknown> {
  const user = login === VIEWER.login ? VIEWER : { id: 0, login, name: login, email: `${login}@example.invalid` };
  return {
    login: user.login,
    id: user.id,
    node_id: Buffer.from(`User:${user.id}`).toString('base64'),
    avatar_url: '',
    type: 'User',
    site_admin: false,
    name: user.name,
    email: user.email,
    html_url: '',
    url: '',
  };
}

function repoObject(store: Store, repo: Repo): Record<string, unknown> {
  const openCount = repo.items.size - [...repo.items.values()].filter((item) => item.state === 'closed').length;
  return {
    id: repo.id,
    node_id: repoGlobalId(repo),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: userObject(repo.owner),
    private: repo.private,
    description: repo.description,
    default_branch: repo.default_branch,
    html_url: '',
    url: '',
    created_at: repo.created_at,
    updated_at: repo.updated_at,
    pushed_at: repo.pushed_at,
    git_url: '',
    ssh_url: '',
    clone_url: '',
    homepage: null,
    language: null,
    fork: false,
    forks_count: 0,
    stargazers_count: 0,
    watchers_count: 0,
    open_issues_count: openCount,
    license: null,
    topics: [],
    visibility: repo.private ? 'private' : 'public',
    has_issues: true,
    has_projects: true,
    has_wiki: true,
    archived: false,
    disabled: false,
  };
}

function labelObject(label: Label): Record<string, unknown> {
  return { id: label.id, node_id: label.node_id, name: label.name, color: label.color, default: false, description: '' };
}

function issueObject(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: issue.node_id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    user: userObject(issue.user),
    labels: issue.labels.map(labelObject),
    assignees: [],
    comments: issue.comments,
    created_at: issue.created_at,
    updated_at: issue.updated_at,
    closed_at: issue.closed_at,
    html_url: '',
    url: '',
    author_association: 'OWNER',
  };
}

function pullObject(repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    id: pull.id,
    node_id: pull.node_id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    user: userObject(pull.user),
    head: { ref: pull.headRef, sha: pull.headSha, label: `${repo.owner}:${pull.headRef}`, user: userObject(repo.owner) },
    base: { ref: pull.baseRef, sha: pull.baseSha, label: `${repo.owner}:${pull.baseRef}`, user: userObject(repo.owner) },
    merged: pull.merged,
    mergeable: !pullMergeConflict(repo, pull),
    merged_at: pull.merged_at,
    merge_commit_sha: pull.merge_commit_sha,
    created_at: pull.created_at,
    updated_at: pull.updated_at,
    closed_at: pull.state === 'closed' ? pull.updated_at : null,
    html_url: '',
    url: '',
    draft: false,
    comments: 0,
  };
}

function commentObject(repo: Repo, comment: Comment): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: comment.node_id,
    body: comment.body,
    user: userObject(comment.user),
    created_at: comment.created_at,
    updated_at: comment.updated_at,
    html_url: '',
    url: '',
  };
}

// ---------------------------------------------------------------- git helpers for REST

/** Flatten a tree into path -> {oid, mode}. */
export function flattenTree(repo: Repo, treeOid: string): Map<string, { oid: string; mode: string }> {
  const out = new Map<string, { oid: string; mode: string }>();
  const walk = (oid: string, prefix: string): void => {
    const object = repo.objects.get(oid);
    if (object?.type !== 'tree') return;
    for (const entry of parseTree(object.data)) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000') walk(entry.oid, path);
      else out.set(path, { oid: entry.oid, mode: entry.mode });
    }
  };
  walk(treeOid, '');
  return out;
}

/** The tree oid of a commit, or null. */
export function commitTree(repo: Repo, commitOid: string): string | null {
  const object = repo.objects.get(commitOid);
  if (object?.type !== 'commit') return null;
  return parseCommit(object.data).tree;
}

/** Set (or delete, when blobOid is null) one path in a tree, returning the
 *  new root tree oid. Intermediate trees are created as needed. */
export function setPathInTree(
  repo: Repo,
  baseTreeOid: string | null,
  parts: readonly string[],
  blobOid: string | null,
  mode = '100644',
): string {
  const setIn = (treeOid: string | null, depth: number): string => {
    const entries = new Map<string, TreeEntry>();
    if (treeOid !== null) {
      const object = repo.objects.get(treeOid);
      if (object?.type === 'tree') {
        for (const entry of parseTree(object.data)) entries.set(entry.name, entry);
      }
    }
    const name = parts[depth] as string;
    if (depth === parts.length - 1) {
      if (blobOid === null) entries.delete(name);
      else entries.set(name, { mode, name, oid: blobOid });
    } else {
      const child = entries.get(name);
      const childTree = setIn(child?.mode === '40000' ? child.oid : null, depth + 1);
      const childEntries = childTree === '' ? 0 : parseTree(repo.objects.get(childTree)?.data ?? Buffer.alloc(0)).length;
      if (childEntries === 0 && blobOid === null) entries.delete(name);
      else entries.set(name, { mode: '40000', name, oid: childTree });
    }
    const data = buildTree([...entries.values()]);
    const oid = hashObject('tree', data);
    repo.objects.set(oid, { type: 'tree', data });
    return oid;
  };
  return setIn(baseTreeOid, 0);
}

/** Create a commit on `branch` with `treeOid`, message `message`. */
export function commitOnBranch(
  store: Store,
  repo: Repo,
  branch: string,
  treeOid: string,
  message: string,
): string {
  const parent = repo.refs.get(`refs/heads/${branch}`);
  const timestamp = store.nowSec();
  const data = buildCommit({
    tree: treeOid,
    parents: parent === undefined ? [] : [parent],
    author: VIEWER,
    committer: VIEWER,
    timestamp,
    message,
  });
  const oid = hashObject('commit', data);
  repo.objects.set(oid, { type: 'commit', data });
  repo.refs.set(`refs/heads/${branch}`, oid);
  repo.pushed_at = store.nowIso();
  repo.fetchCache.clear();
  return oid;
}

/** The first common ancestor of two commits (BFS from both sides). */
export function mergeBase(repo: Repo, a: string, b: string): string | null {
  const ancestorsA = new Map<string, number>();
  const queueA = [a];
  ancestorsA.set(a, 0);
  for (let index = 0; index < queueA.length; index += 1) {
    const oid = queueA[index] as string;
    const object = repo.objects.get(oid);
    if (object?.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) {
      if (!ancestorsA.has(parent)) {
        ancestorsA.set(parent, (ancestorsA.get(oid) as number) + 1);
        queueA.push(parent);
      }
    }
  }
  const queueB = [b];
  const seenB = new Set<string>([b]);
  let best: string | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  for (let index = 0; index < queueB.length; index += 1) {
    const oid = queueB[index] as string;
    const distA = ancestorsA.get(oid);
    if (distA !== undefined) {
      const score = distA + index;
      if (score < bestScore) {
        bestScore = score;
        best = oid;
      }
    }
    const object = repo.objects.get(oid);
    if (object?.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) {
      if (!seenB.has(parent)) {
        seenB.add(parent);
        queueB.push(parent);
      }
    }
  }
  return best;
}

/** path -> {old, new} between two trees (null = absent). */
export function diffTrees(
  repo: Repo,
  baseTreeOid: string | null,
  headTreeOid: string | null,
): Map<string, { old: { oid: string; mode: string } | null; new: { oid: string; mode: string } | null }> {
  const base = baseTreeOid === null ? new Map() : flattenTree(repo, baseTreeOid);
  const head = headTreeOid === null ? new Map() : flattenTree(repo, headTreeOid);
  const out = new Map<string, { old: { oid: string; mode: string } | null; new: { oid: string; mode: string } | null }>();
  for (const [path, entry] of base) {
    const other = head.get(path);
    if (other === undefined) out.set(path, { old: entry, new: null });
    else if (other.oid !== entry.oid || other.mode !== entry.mode) out.set(path, { old: entry, new: other });
  }
  for (const [path, entry] of head) {
    if (!base.has(path)) out.set(path, { old: null, new: entry });
  }
  return out;
}

/** Line counts for a changed file: additions/deletions by multiset difference. */
export function lineDiff(oldData: Buffer | null, newData: Buffer | null): { additions: number; deletions: number } {
  const linesOf = (data: Buffer | null): string[] => {
    if (data === null) return [];
    const text = data.toString('utf8');
    if (text === '') return [];
    const lines = text.split('\n');
    if (lines[lines.length - 1] === '') lines.pop();
    return lines;
  };
  const oldLines = linesOf(oldData);
  const newLines = linesOf(newData);
  const oldCounts = new Map<string, number>();
  for (const line of oldLines) oldCounts.set(line, (oldCounts.get(line) ?? 0) + 1);
  let additions = 0;
  for (const line of newLines) {
    const left = oldCounts.get(line) ?? 0;
    if (left > 0) oldCounts.set(line, left - 1);
    else additions += 1;
  }
  let deletions = 0;
  for (const left of oldCounts.values()) deletions += left;
  return { additions, deletions };
}

/** The pull's base branch tip as it stands now (it may have moved since the
 *  pull was created: a merge is always computed against the live base). */
function currentBaseTip(repo: Repo, pull: Pull): string {
  return repo.refs.get(`refs/heads/${pull.baseRef}`) ?? pull.baseSha;
}

/** Whether merging this pull would conflict (both sides changed the same
 *  path differently since the merge base). */
export function pullMergeConflict(repo: Repo, pull: Pull): boolean {
  const baseTip = currentBaseTip(repo, pull);
  const base = mergeBase(repo, pull.headSha, baseTip);
  if (base === null) return false;
  const baseTree = commitTree(repo, base);
  const headTree = commitTree(repo, pull.headSha);
  const baseNowTree = commitTree(repo, baseTip);
  const headDiff = diffTrees(repo, baseTree, headTree);
  const baseDiff = diffTrees(repo, baseTree, baseNowTree);
  for (const [path, headChange] of headDiff) {
    const baseChange = baseDiff.get(path);
    if (baseChange === undefined) continue;
    const headNew = headChange.new?.oid ?? null;
    const baseNew = baseChange.new?.oid ?? null;
    if (headNew !== baseNew) return true;
  }
  return false;
}

/** The merged tree for a squash merge: the live base tree with the head's changes
 *  since the merge base applied. */
export function squashTree(repo: Repo, pull: Pull): string | null {
  const baseTip = currentBaseTip(repo, pull);
  const base = mergeBase(repo, pull.headSha, baseTip);
  const baseTree = commitTree(repo, baseTip);
  if (base === null) return commitTree(repo, pull.headSha);
  const headTree = commitTree(repo, pull.headSha);
  const baseBaseTree = commitTree(repo, base);
  const headDiff = diffTrees(repo, baseBaseTree, headTree);
  let tree = baseTree;
  for (const [path, change] of headDiff) {
    const parts = path.split('/');
    tree = setPathInTree(repo, tree, parts, change.new?.oid ?? null, change.new?.mode ?? '100644');
  }
  return tree;
}

// ---------------------------------------------------------------- routing

interface RestCtx {
  store: Store;
  req: IncomingMessage;
  res: ServerResponse;
  segments: string[];
  query: Record<string, string>;
}

function repoOr404(ctx: RestCtx, owner: string, name: string): Repo | null {
  if (owner !== VIEWER.login) {
    sendError(ctx.res, 404, 'Not Found');
    return null;
  }
  const repo = ctx.store.getRepo(owner, name);
  if (repo === undefined) {
    sendError(ctx.res, 404, 'Not Found');
    return null;
  }
  return repo;
}

/** Read and parse a JSON request body. Sends 400 on malformed JSON. */
async function jsonBody(ctx: RestCtx): Promise<{ ok: true; value: unknown } | { ok: false }> {
  let buf: Buffer;
  try {
    buf = await readBody(ctx.req);
  } catch {
    sendError(ctx.res, 400, 'request body too large');
    return { ok: false };
  }
  const parsed = parseJsonBody(buf);
  if (!parsed.ok) {
    sendError(ctx.res, 400, 'Invalid JSON');
    return { ok: false };
  }
  return { ok: true, value: parsed.value };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The repo-relative path after /contents/: segments joined, decoded. */
function contentsPath(segments: string[]): string {
  return segments.map(decodeSegment).join('/');
}

// ---------------------------------------------------------------- handlers

async function handleRoot(ctx: RestCtx): Promise<void> {
  sendJson(ctx.res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
}

async function handleMeta(ctx: RestCtx): Promise<void> {
  sendJson(ctx.res, 200, { installed_version: '1.0.0' });
}

async function handleUser(ctx: RestCtx): Promise<void> {
  sendJson(ctx.res, 200, userObject(VIEWER.login));
}

async function handleListUserRepos(ctx: RestCtx): Promise<void> {
  const { page, perPage } = pageParams(ctx.query);
  const repos = ctx.store.viewerRepos();
  const { pageItems, total } = paginate(repos, page, perPage);
  const extra: Record<string, string> = {};
  const next = nextLink(ctx.req, '/api/v3/user/repos', ctx.query, page, perPage, total);
  if (next !== null) extra.link = next;
  sendJson(ctx.res, 200, pageItems.map((repo) => repoObject(ctx.store, repo)), extra);
}

async function handleCreateUserRepo(ctx: RestCtx): Promise<void> {
  const body = await jsonBody(ctx);
  if (!body.ok) return;
  const value = body.value;
  if (!isRecord(value) || typeof value.name !== 'string' || value.name === '') {
    sendError(ctx.res, 422, 'name is required');
    return;
  }
  const name = value.name as string;
  if (ctx.store.getRepo(VIEWER.login, name) !== undefined) {
    sendError(ctx.res, 422, 'Repository already exists');
    return;
  }
  const repo = ctx.store.createRepo(
    VIEWER.login,
    name,
    typeof value.description === 'string' ? value.description : '',
    value.private === true,
  );
  sendJson(ctx.res, 201, repoObject(ctx.store, repo));
}

async function handleGetRepo(ctx: RestCtx, owner: string, name: string): Promise<void> {
  const repo = repoOr404(ctx, owner, name);
  if (repo === null) return;
  sendJson(ctx.res, 200, repoObject(ctx.store, repo));
}

async function handlePatchRepo(ctx: RestCtx, owner: string, name: string): Promise<void> {
  const repo = repoOr404(ctx, owner, name);
  if (repo === null) return;
  const body = await jsonBody(ctx);
  if (!body.ok) return;
  const value = body.value;
  if (isRecord(value)) {
    if (typeof value.description === 'string') repo.description = value.description;
    if (typeof value.private === 'boolean') repo.private = value.private;
    if (typeof value.default_branch === 'string' && repo.refs.has(`refs/heads/${value.default_branch}`)) {
      repo.default_branch = value.default_branch;
    }
    repo.updated_at = ctx.store.nowIso();
  }
  sendJson(ctx.res, 200, repoObject(ctx.store, repo));
}

async function handleDeleteRepo(ctx: RestCtx, owner: string, name: string): Promise<void> {
  const repo = repoOr404(ctx, owner, name);
  if (repo === null) return;
  ctx.store.deleteRepo(repo);
  ctx.res.writeHead(204, { 'x-github-request-id': nextRequestId() });
  ctx.res.end();
}

async function handleListBranches(ctx: RestCtx, owner: string, name: string): Promise<void> {
  const repo = repoOr404(ctx, owner, name);
  if (repo === null) return;
  const branches: Record<string, unknown>[] = [];
  for (const [ref, oid] of repo.refs) {
    if (!ref.startsWith('refs/heads/')) continue;
    branches.push({ name: ref.slice('refs/heads/'.length), commit: { sha: oid }, protected: false });
  }
  branches.sort((a, b) => String(a.name) < String(b.name) ? -1 : 1);
  sendJson(ctx.res, 200, branches);
}

async function handleGetBranch(ctx: RestCtx, owner: string, name: string, branch: string): Promise<void> {
  const repo = repoOr404(ctx, owner, name);
  if (repo === null) return;
  const oid = repo.refs.get(`refs/heads/${branch}`);
  if (oid === undefined) {
    sendError(ctx.res, 404, 'Branch not found');
    return;
  }
  sendJson(ctx.res, 200, { name: branch, commit: { sha: oid }, protected: false });
}

async function handleListCommits(ctx: RestCtx, owner: string, name: string): Promise<void> {
  const repo = repoOr404(ctx, owner, name);
  if (repo === null) return;
  const shaParam = ctx.query.sha;
  let tip: string | undefined;
  if (shaParam !== undefined && shaParam !== '') {
    tip = repo.refs.get(`refs/heads/${shaParam}`) ?? (repo.objects.has(shaParam) ? shaParam : undefined);
    if (tip === undefined) {
      sendError(ctx.res, 404, 'No commit found for SHA');
      return;
    }
  } else {
    tip = ctx.store.defaultTip(repo) ?? undefined;
    if (tip === undefined) {
      sendJson(ctx.res, 200, []);
      return;
    }
  }
  // Walk the DAG from the tip, newest first by author timestamp.
  const seen = new Set<string>();
  const order: string[] = [];
  const queue = [tip];
  seen.add(tip);
  for (let index = 0; index < queue.length; index += 1) {
    const oid = queue[index] as string;
    order.push(oid);
    const object = repo.objects.get(oid);
    if (object?.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) {
      if (!seen.has(parent)) {
        seen.add(parent);
        queue.push(parent);
      }
    }
  }
  const withTime = order.map((oid) => {
    const object = repo.objects.get(oid);
    const parsed = object !== undefined && object.type === 'commit' ? parseCommit(object.data) : null;
    const authorLine = parsed?.author ?? '';
    const match = / (\d+) \+0000$/.exec(authorLine);
    return { oid, time: match !== null ? Number(match[1]) : 0, parsed };
  });
  withTime.sort((a, b) => b.time - a.time);
  const out = withTime.map(({ oid, parsed }) => {
    const message = parsed?.message ?? '';
    const author = parseIdentity(parsed?.author ?? '');
    const committer = parseIdentity(parsed?.committer ?? '');
    return {
      sha: oid,
      commit: {
        message,
        author: { name: author.name, email: author.email, date: author.date },
        committer: { name: committer.name, email: committer.email, date: committer.date },
        tree: { sha: parsed?.tree ?? '' },
      },
      parents: (parsed?.parents ?? []).map((parent) => ({ sha: parent })),
      author: userObject(VIEWER.login),
      committer: userObject(VIEWER.login),
      url: '',
      html_url: '',
    };
  });
  sendJson(ctx.res, 200, out);
}

function parseIdentity(line: string): { name: string; email: string; date: string } {
  const match = /^(.*?) <(.*?)> (\d+) \+0000$/.exec(line);
  if (match === null) return { name: line, email: '', date: '' };
  return {
    name: match[1] as string,
    email: match[2] as string,
    date: new Date(Number(match[3]) * 1000).toISOString(),
  };
}

async function handleListRefs(ctx: RestCtx, owner: string, name: string): Promise<void> {
  const repo = repoOr404(ctx, owner, name);
  if (repo === null) return;
  const out: Record<string, unknown>[] = [];
  for (const [ref, oid] of repo.refs) {
    const object = repo.objects.get(oid);
    out.push({
      ref,
      node_id: Buffer.from(`Ref:${repo.id}:${ref}`).toString('base64'),
      url: '',
      object: { sha: oid, type: object?.type ?? 'commit', url: '' },
    });
  }
  sendJson(ctx.res, 200, out);
}

async function handleGetRef(ctx: RestCtx, owner: string, name: string, kind: string, refName: string): Promise<void> {
  const repo = repoOr404(ctx, owner, name);
  if (repo === null) return;
  const ref = `refs/${kind}/${refName}`;
  const oid = repo.refs.get(ref);
  if (oid === undefined) {
    sendError(ctx.res, 404, 'Reference does not exist');
    return;
  }
  const object = repo.objects.get(oid);
  sendJson(ctx.res, 200, {
    ref,
    node_id: Buffer.from(`Ref:${repo.id}:${ref}`).toString('base64'),
    url: '',
    object: { sha: oid, type: object?.type ?? 'commit', url: '' },
  });
}

async function handleCreateRef(ctx: RestCtx, owner: string, name: string): Promise<void> {
  const repo = repoOr404(ctx, owner, name);
  if (repo === null) return;
  const body = await jsonBody(ctx);
  if (!body.ok) return;
  const value = body.value;
  if (!isRecord(value) || typeof value.ref !== 'string' || typeof value.sha !== 'string') {
    sendError(ctx.res, 422, 'ref and sha are required');
    return;
  }
  const ref = value.ref as string;
  const sha = value.sha as string;
  if (!ref.startsWith('refs/')) {
    sendError(ctx.res, 422, 'Invalid reference name');
    return;
  }
  if (repo.refs.has(ref)) {
    sendError(ctx.res, 422, 'Reference already exists');
    return;
  }
  if (!repo.objects.has(sha)) {
    sendError(ctx.res, 422, 'Invalid sha');
    return;
  }
  repo.refs.set(ref, sha);
  repo.fetchCache.clear();
  const object = repo.objects.get(sha);
  sendJson(ctx.res, 201, {
    ref,
    node_id: Buffer.from(`Ref:${repo.id}:${ref}`).toString('base64'),
    url: '',
    object: { sha, type: object?.type ?? 'commit', url: '' },
  });
}

// ---------------------------------------------------------------- contents

/** The blob oid at `path` on the branch tip's tree, or null. */
function blobAtPath(repo: Repo, branch: string, path: string): { oid: string; mode: string } | null {
  const tip = repo.refs.get(`refs/heads/${branch}`);
  if (tip === undefined) return null;
  const tree = commitTree(repo, tip);
  if (tree === null) return null;
  const flat = flattenTree(repo, tree);
  return flat.get(path) ?? null;
}

async function handlePutContents(ctx: RestCtx, owner: string, name: string, pathParts: string[]): Promise<void> {
  const repo = repoOr404(ctx, owner, name);
  if (repo === null) return;
  const body = await jsonBody(ctx);
  if (!body.ok) return;
  const value = body.value;
  if (!isRecord(value) || typeof value.message !== 'string' || typeof value.content !== 'string') {
    sendError(ctx.res, 422, 'message and content are required');
    return;
  }
  const path = contentsPath(pathParts);
  const branch = typeof value.branch === 'string' && value.branch !== '' ? value.branch : repo.default_branch;
  let branchTip = repo.refs.get(`refs/heads/${branch}`);
  if (branchTip === undefined) {
    // A write on a branch that does not exist yet starts it at the default tip.
    const defaultTip = ctx.store.defaultTip(repo);
    if (defaultTip !== null) repo.refs.set(`refs/heads/${branch}`, defaultTip);
    branchTip = repo.refs.get(`refs/heads/${branch}`);
  }
  const current = blobAtPath(repo, branch, path);
  const isUpdate = current !== null;
  if (isUpdate && typeof value.sha === 'string' && value.sha !== current.oid) {
    sendError(ctx.res, 409, 'sha does not match the current blob');
    return;
  }
  if (isUpdate && typeof value.sha !== 'string') {
    sendError(ctx.res, 409, 'sha is required to update a file');
    return;
  }
  let content: Buffer;
  try {
    content = b64decode(value.content);
  } catch {
    sendError(ctx.res, 400, 'content is not valid base64');
    return;
  }
  const blobOid = hashObject('blob', content);
  repo.objects.set(blobOid, { type: 'blob', data: content });
  const baseTree = branchTip === undefined ? null : commitTree(repo, branchTip);
  const newTree = setPathInTree(repo, baseTree, path.split('/'), blobOid);
  const commitOid = commitOnBranch(ctx.store, repo, branch, newTree, value.message);
  const fileName = path.split('/').pop() as string;
  sendJson(ctx.res, isUpdate ? 200 : 201, {
    content: {
      name: fileName,
      path,
      sha: blobOid,
      size: content.length,
      encoding: 'base64',
      type: 'file',
      url: '',
      html_url: '',
    },
    commit: { sha: commitOid, message: value.message, author: userObject(VIEWER.login), committer: userObject(VIEWER.login) },
  });
}

async function handleGetContents(ctx: RestCtx, owner: string, name: string, pathParts: string[]): Promise<void> {
  const repo = repoOr404(ctx, owner, name);
  if (repo === null) return;
  const branch = typeof ctx.query.ref === 'string' && ctx.query.ref !== '' ? ctx.query.ref : repo.default_branch;
  const tip = repo.refs.get(`refs/heads/${branch}`);
  if (tip === undefined) {
    sendError(ctx.res, 404, 'Not Found');
    return;
  }
  const tree = commitTree(repo, tip);
  if (tree === null) {
    sendError(ctx.res, 404, 'Not Found');
    return;
  }
  const path = contentsPath(pathParts);
  if (path === '') {
    // Root listing.
    const object = repo.objects.get(tree);
    const entries = object?.type === 'tree' ? parseTree(object.data) : [];
    sendJson(ctx.res, 200, entries.map((entry) => ({
      type: entry.mode === '40000' ? 'dir' : 'file',
      size: entry.mode === '40000' ? undefined : (repo.objects.get(entry.oid)?.data.length ?? 0),
      name: entry.name,
      path: entry.name,
      sha: entry.oid,
    })));
    return;
  }
  const flat = flattenTree(repo, tree);
  const file = flat.get(path);
  if (file !== undefined) {
    const object = repo.objects.get(file.oid);
    const data = object?.data ?? Buffer.alloc(0);
    sendJson(ctx.res, 200, {
      type: 'file',
      encoding: 'base64',
      size: data.length,
      name: path.split('/').pop() as string,
      path,
      content: data.toString('base64'),
      sha: file.oid,
    });
    return;
  }
  // A directory: entries directly under it.
  const prefix = `${path}/`;
  const children = new Map<string, { type: 'file' | 'dir'; oid: string; mode: string }>();
  for (const [childPath, entry] of flat) {
    if (!childPath.startsWith(prefix)) continue;
    const rest = childPath.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash < 0) children.set(rest, { type: 'file', oid: entry.oid, mode: entry.mode });
    else {
      const dirName = rest.slice(0, slash);
      if (!children.has(dirName)) {
        // Find the tree oid for this directory.
        const dirTree = findTreeOid(repo, tree, path.split('/').concat([dirName]));
        children.set(dirName, { type: 'dir', oid: dirTree ?? '', mode: '40000' });
      }
    }
  }
  if (children.size === 0) {
    sendError(ctx.res, 404, 'Not Found');
    return;
  }
  const out: Record<string, unknown>[] = [];
  for (const [childName, child] of [...children.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    out.push({
      type: child.type,
      size: child.type === 'file' ? (repo.objects.get(child.oid)?.data.length ?? 0) : undefined,
      name: childName,
      path: `${path}/${childName}`,
      sha: child.oid,
    });
  }
  sendJson(ctx.res, 200, out);
}

/** The tree oid of a directory path under a root tree, or null. */
function findTreeOid(repo: Repo, rootTree: string, parts: readonly string[]): string | null {
  let current = rootTree;
  for (const part of parts) {
    const object = repo.objects.get(current);
    if (object?.type !== 'tree') return null;
    const entry = parseTree(object.data).find((candidate) => candidate.name === part && candidate.mode === '40000');
    if (entry === undefined) return null;
    current = entry.oid;
  }
  return current;
}

async function handleDeleteContents(ctx: RestCtx, owner: string, name: string, pathParts: string[]): Promise<void> {
  const repo = repoOr404(ctx, owner, name);
  if (repo === null) return;
  const body = await jsonBody(ctx);
  if (!body.ok) return;
  const value = body.value;
  if (!isRecord(value) || typeof value.message !== 'string') {
    sendError(ctx.res, 422, 'message is required');
    return;
  }
  const path = contentsPath(pathParts);
  const branch = typeof value.branch === 'string' && value.branch !== '' ? value.branch : repo.default_branch;
  const current = blobAtPath(repo, branch, path);
  if (current === null) {
    sendError(ctx.res, 404, 'Not Found');
    return;
  }
  if (typeof value.sha === 'string' && value.sha !== current.oid) {
    sendError(ctx.res, 409, 'sha does not match the current blob');
    return;
  }
  const branchTip = repo.refs.get(`refs/heads/${branch}`);
  const baseTree = branchTip === undefined ? null : commitTree(repo, branchTip);
  const newTree = setPathInTree(repo, baseTree, path.split('/'), null);
  const commitOid = commitOnBranch(ctx.store, repo, branch, newTree, value.message);
  sendJson(ctx.res, 200, {
    commit: { sha: commitOid, message: value.message, author: userObject(VIEWER.login), committer: userObject(VIEWER.login) },
  });
}

// ---------------------------------------------------------------- labels

async function handleListLabels(ctx: RestCtx, owner: string, name: string): Promise<void> {
  const repo = repoOr404(ctx, owner, name);
  if (repo === null) return;
  sendJson(ctx.res, 200, repo.labels.map(labelObject));
}

async function handleCreateLabel(ctx: RestCtx, owner: string, name: string): Promise<void> {
  const repo = repoOr404(ctx, owner, name);
  if (repo === null) return;
  const body = await jsonBody(ctx);
  if (!body.ok) return;
  const value = body.value;
  if (!isRecord(value) || typeof value.name !== 'string' || value.name === '') {
    sendError(ctx.res, 422, 'name is required');
    return;
  }
  const labelName = value.name as string;
  if (repo.labels.some((label) => label.name === labelName)) {
    sendError(ctx.res, 422, 'Label already exists');
    return;
  }
  const id = ctx.store.nextLabelObjectId();
  const label: Label = {
    id,
    node_id: Buffer.from(`Label:${repo.id}:${id}`).toString('base64'),
    name: labelName,
    color: typeof value.color === 'string' && value.color !== '' ? value.color : 'ededed',
  };
  repo.labels.push(label);
  sendJson(ctx.res, 201, labelObject(label));
}

// ---------------------------------------------------------------- issues

async function handleCreateIssue(ctx: RestCtx, owner: string, name: string): Promise<void> {
  const repo = repoOr404(ctx, owner, name);
  if (repo === null) return;
  const body = await jsonBody(ctx);
  if (!body.ok) return;
  const value = body.value;
  if (!isRecord(value) || typeof value.title !== 'string' || value.title === '') {
    sendError(ctx.res, 422, 'title is required');
    return;
  }
  const labelNames = Array.isArray(value.labels) ? value.labels.filter((entry): entry is string => typeof entry === 'string') : [];
  const labels: Label[] = [];
  for (const labelName of labelNames) {
    const found = repo.labels.find((label) => label.name === labelName);
    if (found === undefined) {
      sendError(ctx.res, 422, `Label '${labelName}' does not exist`);
      return;
    }
    labels.push(found);
  }
  const number = repo.nextNumber;
  repo.nextNumber += 1;
  const id = ctx.store.nextRestObjectId();
  const at = ctx.store.nowIso();
  const issue: Issue = {
    kind: 'issue',
    id,
    node_id: Buffer.from(`Issue:${repo.id}:${number}`).toString('base64'),
    number,
    title: value.title,
    body: typeof value.body === 'string' ? value.body : '',
    state: 'open',
    labels,
    user: VIEWER.login,
    comments: 0,
    created_at: at,
    updated_at: at,
    closed_at: null,
  };
  repo.items.set(number, issue);
  repo.issues.push(issue);
  sendJson(ctx.res, 201, issueObject(repo, issue));
}

async function handleListIssues(ctx: RestCtx, owner: string, name: string): Promise<void> {
  const repo = repoOr404(ctx, owner, name);
  if (repo === null) return;
  const state = ctx.query.state ?? 'open';
  const sort = ctx.query.sort ?? 'created';
  const direction = ctx.query.direction ?? 'desc';
  let issues = repo.issues;
  if (state !== 'all') issues = issues.filter((issue) => issue.state === state);
  const sorted = [...issues];
  if (sort === 'created') {
    sorted.sort((a, b) => {
      if (a.created_at === b.created_at) return direction === 'asc' ? a.number - b.number : b.number - a.number;
      return direction === 'asc'
        ? a.created_at < b.created_at ? -1 : 1
        : a.created_at > b.created_at ? -1 : 1;
    });
  }
  const { page, perPage } = pageParams(ctx.query);
  const { pageItems, total } = paginate(sorted, page, perPage);
  const extra: Record<string, string> = {};
  const next = nextLink(ctx.req, `/api/v3/repos/${owner}/${name}/issues`, ctx.query, page, perPage, total);
  if (next !== null) extra.link = next;
  sendJson(ctx.res, 200, pageItems.map((issue) => issueObject(repo, issue)), extra);
}

async function handleGetIssue(ctx: RestCtx, owner: string, name: string, number: number): Promise<void> {
  const repo = repoOr404(ctx, owner, name);
  if (repo === null) return;
  const item = repo.items.get(number);
  if (item === undefined || item.kind !== 'issue') {
    sendError(ctx.res, 404, 'Not Found');
    return;
  }
  sendJson(ctx.res, 200, issueObject(repo, item));
}

async function handlePatchIssue(ctx: RestCtx, owner: string, name: string, number: number): Promise<void> {
  const repo = repoOr404(ctx, owner, name);
  if (repo === null) return;
  const item = repo.items.get(number);
  if (item === undefined || item.kind !== 'issue') {
    sendError(ctx.res, 404, 'Not Found');
    return;
  }
  const body = await jsonBody(ctx);
  if (!body.ok) return;
  const value = body.value;
  if (isRecord(value)) {
    if (typeof value.title === 'string') item.title = value.title;
    if (typeof value.body === 'string') item.body = value.body;
    if (value.state === 'closed' && item.state !== 'closed') {
      item.state = 'closed';
      item.closed_at = ctx.store.nowIso();
    } else if (value.state === 'open' && item.state !== 'open') {
      item.state = 'open';
      item.closed_at = null;
    }
    item.updated_at = ctx.store.nowIso();
  }
  sendJson(ctx.res, 200, issueObject(repo, item));
}

async function handleListComments(ctx: RestCtx, owner: string, name: string, number: number): Promise<void> {
  const repo = repoOr404(ctx, owner, name);
  if (repo === null) return;
  const item = repo.items.get(number);
  if (item === undefined) {
    sendError(ctx.res, 404, 'Not Found');
    return;
  }
  const comments = repo.comments.filter((comment) => comment.issueNumber === number);
  const { page, perPage } = pageParams(ctx.query);
  const { pageItems, total } = paginate(comments, page, perPage);
  const extra: Record<string, string> = {};
  const next = nextLink(ctx.req, `/api/v3/repos/${owner}/${name}/issues/${number}/comments`, ctx.query, page, perPage, total);
  if (next !== null) extra.link = next;
  sendJson(ctx.res, 200, pageItems.map((comment) => commentObject(repo, comment)), extra);
}

async function handleCreateComment(ctx: RestCtx, owner: string, name: string, number: number): Promise<void> {
  const repo = repoOr404(ctx, owner, name);
  if (repo === null) return;
  const item = repo.items.get(number);
  if (item === undefined) {
    sendError(ctx.res, 404, 'Not Found');
    return;
  }
  const body = await jsonBody(ctx);
  if (!body.ok) return;
  const value = body.value;
  if (!isRecord(value) || typeof value.body !== 'string' || value.body === '') {
    sendError(ctx.res, 422, 'body is required');
    return;
  }
  const id = ctx.store.nextRestObjectId();
  const at = ctx.store.nowIso();
  const comment: Comment = {
    id,
    node_id: Buffer.from(`IssueComment:${repo.id}:${number}:${id}`).toString('base64'),
    issueNumber: number,
    body: value.body,
    user: VIEWER.login,
    created_at: at,
    updated_at: at,
  };
  repo.comments.push(comment);
  if (item.kind === 'issue') item.comments += 1;
  sendJson(ctx.res, 201, commentObject(repo, comment));
}

// ---------------------------------------------------------------- pulls

function stripOwnerPrefix(ref: string): string {
  const colon = ref.indexOf(':');
  return colon >= 0 ? ref.slice(colon + 1) : ref;
}

async function handleCreatePull(ctx: RestCtx, owner: string, name: string): Promise<void> {
  const repo = repoOr404(ctx, owner, name);
  if (repo === null) return;
  const body = await jsonBody(ctx);
  if (!body.ok) return;
  const value = body.value;
  if (!isRecord(value) || typeof value.title !== 'string' || typeof value.head !== 'string' || typeof value.base !== 'string') {
    sendError(ctx.res, 422, 'title, head and base are required');
    return;
  }
  const headRef = stripOwnerPrefix(value.head);
  const baseRef = stripOwnerPrefix(value.base);
  const headSha = repo.refs.get(`refs/heads/${headRef}`);
  if (headSha === undefined) {
    sendError(ctx.res, 422, 'Invalid head');
    return;
  }
  const baseSha = repo.refs.get(`refs/heads/${baseRef}`);
  if (baseSha === undefined) {
    sendError(ctx.res, 422, 'Invalid base');
    return;
  }
  if (repo.pulls.some((pull) => pull.state === 'open' && pull.headRef === headRef && pull.baseRef === baseRef)) {
    sendError(ctx.res, 422, 'A pull request already exists for this head and base');
    return;
  }
  const number = repo.nextNumber;
  repo.nextNumber += 1;
  const id = ctx.store.nextRestObjectId();
  const at = ctx.store.nowIso();
  const pull: Pull = {
    kind: 'pull',
    id,
    node_id: Buffer.from(`PullRequest:${repo.id}:${number}`).toString('base64'),
    number,
    title: value.title,
    body: typeof value.body === 'string' ? value.body : '',
    state: 'open',
    headRef,
    baseRef,
    headSha,
    baseSha,
    merged: false,
    merged_at: null,
    merge_commit_sha: null,
    user: VIEWER.login,
    created_at: at,
    updated_at: at,
  };
  repo.items.set(number, pull);
  repo.pulls.push(pull);
  sendJson(ctx.res, 201, pullObject(repo, pull));
}

async function handleListPulls(ctx: RestCtx, owner: string, name: string): Promise<void> {
  const repo = repoOr404(ctx, owner, name);
  if (repo === null) return;
  const state = ctx.query.state ?? 'open';
  let pulls = repo.pulls;
  if (state !== 'all') pulls = pulls.filter((pull) => pull.state === state);
  const sorted = [...pulls].sort((a, b) => b.number - a.number);
  const { page, perPage } = pageParams(ctx.query);
  const { pageItems, total } = paginate(sorted, page, perPage);
  const extra: Record<string, string> = {};
  const next = nextLink(ctx.req, `/api/v3/repos/${owner}/${name}/pulls`, ctx.query, page, perPage, total);
  if (next !== null) extra.link = next;
  sendJson(ctx.res, 200, pageItems.map((pull) => pullObject(repo, pull)), extra);
}

async function handleGetPull(ctx: RestCtx, owner: string, name: string, number: number): Promise<void> {
  const repo = repoOr404(ctx, owner, name);
  if (repo === null) return;
  const item = repo.items.get(number);
  if (item === undefined || item.kind !== 'pull') {
    sendError(ctx.res, 404, 'Not Found');
    return;
  }
  sendJson(ctx.res, 200, pullObject(repo, item));
}

async function handleListPullFiles(ctx: RestCtx, owner: string, name: string, number: number): Promise<void> {
  const repo = repoOr404(ctx, owner, name);
  if (repo === null) return;
  const item = repo.items.get(number);
  if (item === undefined || item.kind !== 'pull') {
    sendError(ctx.res, 404, 'Not Found');
    return;
  }
  const base = mergeBase(repo, item.headSha, item.baseSha);
  const baseTree = base === null ? null : commitTree(repo, base);
  const headTree = commitTree(repo, item.headSha);
  const diff = diffTrees(repo, baseTree, headTree);
  const files: Record<string, unknown>[] = [];
  for (const [path, change] of [...diff.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const oldData = change.old === null ? null : (repo.objects.get(change.old.oid)?.data ?? null);
    const newData = change.new === null ? null : (repo.objects.get(change.new.oid)?.data ?? null);
    const { additions, deletions } = lineDiff(oldData, newData);
    const status = change.old === null ? 'added' : change.new === null ? 'removed' : 'modified';
    files.push({
      sha: change.new?.oid ?? change.old?.oid ?? '',
      filename: path,
      status,
      additions,
      deletions,
      changes: additions + deletions,
    });
  }
  sendJson(ctx.res, 200, files);
}

async function handleMergePull(ctx: RestCtx, owner: string, name: string, number: number): Promise<void> {
  const repo = repoOr404(ctx, owner, name);
  if (repo === null) return;
  const item = repo.items.get(number);
  if (item === undefined || item.kind !== 'pull') {
    sendError(ctx.res, 404, 'Not Found');
    return;
  }
  // The body is optional; read and ignore it (a malformed body is still a 400).
  const body = await jsonBody(ctx);
  if (!body.ok) return;
  if (item.merged) {
    sendError(ctx.res, 405, 'Pull request already merged');
    return;
  }
  if (item.state === 'closed') {
    sendError(ctx.res, 405, 'Pull request is closed');
    return;
  }
  if (pullMergeConflict(repo, item)) {
    sendError(ctx.res, 405, 'Merge conflict');
    return;
  }
  const mergedTree = squashTree(repo, item);
  if (mergedTree === null) {
    sendError(ctx.res, 405, 'Merge conflict');
    return;
  }
  const message = `Merge pull request #${item.number} from ${item.headRef}`;
  const commitOid = commitOnBranch(ctx.store, repo, item.baseRef, mergedTree, message);
  const at = ctx.store.nowIso();
  item.merged = true;
  item.merged_at = at;
  item.merge_commit_sha = commitOid;
  item.state = 'closed';
  item.updated_at = at;
  sendJson(ctx.res, 200, { sha: commitOid, merged: true, message: 'Pull request successfully merged' });
}

// ---------------------------------------------------------------- dispatcher

/** Handle a /api/v3 request. Returns true when the path is under /api/v3. */
export async function handleRest(
  store: Store,
  req: IncomingMessage,
  res: ServerResponse,
  segments: string[],
  query: Record<string, string>,
): Promise<boolean> {
  const ctx: RestCtx = { store, req, res, segments, query };
  const method = req.method ?? 'GET';
  if (!isAuthenticated(req)) {
    sendError(res, 401, 'Bad credentials');
    return true;
  }
  // /api/v3/ and /api/v3/meta
  if (segments.length === 0) {
    if (method === 'GET') await handleRoot(ctx);
    else sendError(res, 404, 'Not Found');
    return true;
  }
  const [first] = segments as [string];
  if (first === 'meta' && segments.length === 1) {
    if (method === 'GET') await handleMeta(ctx);
    else sendError(res, 404, 'Not Found');
    return true;
  }
  if (first === 'user' && segments.length === 1) {
    if (method === 'GET') await handleUser(ctx);
    else sendError(res, 404, 'Not Found');
    return true;
  }
  if (first === 'user' && segments[1] === 'repos' && segments.length === 2) {
    if (method === 'GET') await handleListUserRepos(ctx);
    else if (method === 'POST') await handleCreateUserRepo(ctx);
    else sendError(res, 404, 'Not Found');
    return true;
  }
  if (first !== 'repos' || segments.length < 3) {
    sendError(res, 404, 'Not Found');
    return true;
  }
  const owner = decodeSegment(segments[1] as string);
  const name = decodeSegment(segments[2] as string);
  const rest = segments.slice(3);
  if (rest.length === 0) {
    if (method === 'GET') await handleGetRepo(ctx, owner, name);
    else if (method === 'PATCH') await handlePatchRepo(ctx, owner, name);
    else if (method === 'DELETE') await handleDeleteRepo(ctx, owner, name);
    else sendError(res, 404, 'Not Found');
    return true;
  }
  const [second] = rest as [string];
  if (second === 'branches' && rest.length === 1) {
    if (method === 'GET') await handleListBranches(ctx, owner, name);
    else sendError(res, 404, 'Not Found');
    return true;
  }
  if (second === 'branches' && rest.length >= 2) {
    const branch = rest.slice(1).map(decodeSegment).join('/');
    if (method === 'GET') await handleGetBranch(ctx, owner, name, branch);
    else sendError(res, 404, 'Not Found');
    return true;
  }
  if (second === 'commits' && rest.length === 1) {
    if (method === 'GET') await handleListCommits(ctx, owner, name);
    else sendError(res, 404, 'Not Found');
    return true;
  }
  if (second === 'git' && rest[1] === 'refs' && rest.length === 2) {
    if (method === 'GET') await handleListRefs(ctx, owner, name);
    else if (method === 'POST') await handleCreateRef(ctx, owner, name);
    else sendError(res, 404, 'Not Found');
    return true;
  }
  if (second === 'git' && rest[1] === 'refs' && rest.length >= 4 && (rest[2] === 'heads' || rest[2] === 'tags')) {
    const refName = rest.slice(3).map(decodeSegment).join('/');
    if (method === 'GET') await handleGetRef(ctx, owner, name, rest[2] as string, refName);
    else sendError(res, 404, 'Not Found');
    return true;
  }
  if (second === 'contents') {
    const pathParts = rest.slice(1);
    if (method === 'PUT') await handlePutContents(ctx, owner, name, pathParts);
    else if (method === 'GET') await handleGetContents(ctx, owner, name, pathParts);
    else if (method === 'DELETE') await handleDeleteContents(ctx, owner, name, pathParts);
    else sendError(res, 404, 'Not Found');
    return true;
  }
  if (second === 'labels' && rest.length === 1) {
    if (method === 'GET') await handleListLabels(ctx, owner, name);
    else if (method === 'POST') await handleCreateLabel(ctx, owner, name);
    else sendError(res, 404, 'Not Found');
    return true;
  }
  if (second === 'issues' && rest.length === 1) {
    if (method === 'GET') await handleListIssues(ctx, owner, name);
    else if (method === 'POST') await handleCreateIssue(ctx, owner, name);
    else sendError(res, 404, 'Not Found');
    return true;
  }
  if (second === 'issues' && rest.length === 2) {
    const number = Number(rest[1]);
    if (!Number.isInteger(number)) {
      sendError(res, 404, 'Not Found');
      return true;
    }
    if (method === 'GET') await handleGetIssue(ctx, owner, name, number);
    else if (method === 'PATCH') await handlePatchIssue(ctx, owner, name, number);
    else sendError(res, 404, 'Not Found');
    return true;
  }
  if (second === 'issues' && rest.length === 3 && rest[2] === 'comments') {
    const number = Number(rest[1]);
    if (!Number.isInteger(number)) {
      sendError(res, 404, 'Not Found');
      return true;
    }
    if (method === 'GET') await handleListComments(ctx, owner, name, number);
    else if (method === 'POST') await handleCreateComment(ctx, owner, name, number);
    else sendError(res, 404, 'Not Found');
    return true;
  }
  if (second === 'pulls' && rest.length === 1) {
    if (method === 'GET') await handleListPulls(ctx, owner, name);
    else if (method === 'POST') await handleCreatePull(ctx, owner, name);
    else sendError(res, 404, 'Not Found');
    return true;
  }
  if (second === 'pulls' && rest.length === 2) {
    const number = Number(rest[1]);
    if (!Number.isInteger(number)) {
      sendError(res, 404, 'Not Found');
      return true;
    }
    if (method === 'GET') await handleGetPull(ctx, owner, name, number);
    else sendError(res, 404, 'Not Found');
    return true;
  }
  if (second === 'pulls' && rest.length === 3 && rest[2] === 'files') {
    const number = Number(rest[1]);
    if (!Number.isInteger(number)) {
      sendError(res, 404, 'Not Found');
      return true;
    }
    if (method === 'GET') await handleListPullFiles(ctx, owner, name, number);
    else sendError(res, 404, 'Not Found');
    return true;
  }
  if (second === 'pulls' && rest.length === 3 && rest[2] === 'merge') {
    const number = Number(rest[1]);
    if (!Number.isInteger(number)) {
      sendError(res, 404, 'Not Found');
      return true;
    }
    if (method === 'PUT') await handleMergePull(ctx, owner, name, number);
    else sendError(res, 404, 'Not Found');
    return true;
  }
  sendError(res, 404, 'Not Found');
  return true;
}
