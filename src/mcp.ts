// mcp.ts — Model Context Protocol, Streamable HTTP at /mcp.
// Speaks both eras the suite accepts: modern 2026-07-28 (server/discover, no handshake)
// and legacy (initialize + notifications/initialized). Plain JSON responses, no SSE.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { VIEWER, isAuthenticated, readBody, parseJsonBody, sendJson, sendError } from './util.ts';
import { Store, type Repo, type Issue, type Pull } from './store.ts';
import { commitOnBranch, pullMergeConflict, squashTree } from './rest.ts';

const SERVER_NAME = 'github-core-clone-forge';
const SERVER_VERSION = '1.0.0';
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

/** One constant, so two tools/list answers are byte-identical. */
const TOOLS: readonly ToolDef[] = Object.freeze([
  Object.freeze({
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    inputSchema: Object.freeze({
      type: 'object' as const,
      properties: Object.freeze({
        name: Object.freeze({ type: 'string', description: 'The repository name.' }),
        description: Object.freeze({ type: 'string', description: 'A short description of the repository.' }),
        private: Object.freeze({ type: 'boolean', description: 'Whether the repository is private.' }),
      }),
      required: Object.freeze(['name']),
    }),
  }),
  Object.freeze({
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: Object.freeze({
      type: 'object' as const,
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string', description: 'The repository owner login.' }),
        repo: Object.freeze({ type: 'string', description: 'The repository name.' }),
      }),
      required: Object.freeze(['owner', 'repo']),
    }),
  }),
  Object.freeze({
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: Object.freeze({
      type: 'object' as const,
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string', description: 'The repository owner login.' }),
        repo: Object.freeze({ type: 'string', description: 'The repository name.' }),
        title: Object.freeze({ type: 'string', description: 'The issue title.' }),
        body: Object.freeze({ type: 'string', description: 'The issue body.' }),
      }),
      required: Object.freeze(['owner', 'repo', 'title']),
    }),
  }),
  Object.freeze({
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: Object.freeze({
      type: 'object' as const,
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string', description: 'The repository owner login.' }),
        repo: Object.freeze({ type: 'string', description: 'The repository name.' }),
        state: Object.freeze({ type: 'string', description: 'Issue state filter: open, closed or all.' }),
      }),
      required: Object.freeze(['owner', 'repo']),
    }),
  }),
  Object.freeze({
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: Object.freeze({
      type: 'object' as const,
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string', description: 'The repository owner login.' }),
        repo: Object.freeze({ type: 'string', description: 'The repository name.' }),
        title: Object.freeze({ type: 'string', description: 'The pull request title.' }),
        body: Object.freeze({ type: 'string', description: 'The pull request body.' }),
        head: Object.freeze({ type: 'string', description: 'The head branch name.' }),
        base: Object.freeze({ type: 'string', description: 'The base branch name.' }),
      }),
      required: Object.freeze(['owner', 'repo', 'title', 'head', 'base']),
    }),
  }),
  Object.freeze({
    name: 'merge_pull_request',
    description: 'Merge a pull request by number, with a squash merge.',
    inputSchema: Object.freeze({
      type: 'object' as const,
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string', description: 'The repository owner login.' }),
        repo: Object.freeze({ type: 'string', description: 'The repository name.' }),
        pull_number: Object.freeze({ type: 'number', description: 'The pull request number.' }),
      }),
      required: Object.freeze(['owner', 'repo', 'pull_number']),
    }),
  }),
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function toolResult(data: Record<string, unknown>): Record<string, unknown> {
  const text = JSON.stringify(data);
  return { content: [{ type: 'text', text }], structuredContent: data };
}

function toolError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: Buffer.from(`Repository:${repo.id}`).toString('base64'),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: VIEWER.id, type: 'User' },
    private: repo.private,
    description: repo.description,
    default_branch: repo.default_branch,
    created_at: repo.created_at,
    updated_at: repo.updated_at,
  };
}

function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: issue.node_id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    user: { login: issue.user, type: 'User' },
    labels: issue.labels.map((label) => ({ name: label.name, color: label.color })),
    comments: issue.comments,
    created_at: issue.created_at,
    updated_at: issue.updated_at,
    closed_at: issue.closed_at,
    repository_url: `/api/v3/repos/${repo.owner}/${repo.name}`,
  };
}

function pullJson(repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    id: pull.id,
    node_id: pull.node_id,
    number: pull.number,
    pull_number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.merged_at,
    merge_commit_sha: pull.merge_commit_sha,
    head: { ref: pull.headRef, sha: pull.headSha, label: `${repo.owner}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: pull.baseSha, label: `${repo.owner}:${pull.baseRef}` },
    user: { login: pull.user, type: 'User' },
    created_at: pull.created_at,
    updated_at: pull.updated_at,
  };
}

function resolveRepo(store: Store, args: Record<string, unknown>): Repo | null {
  const owner = typeof args.owner === 'string' ? args.owner : typeof args.owner_login === 'string' ? args.owner_login : null;
  const repoName =
    typeof args.repo === 'string' ? args.repo
    : typeof args.repository === 'string' ? args.repository
    : typeof args.full_name === 'string' ? args.full_name.split('/').pop() ?? null
    : null;
  if (owner === null || repoName === null) return null;
  return store.getRepo(owner, repoName) ?? null;
}

function missingRequired(tool: ToolDef, args: Record<string, unknown>): string[] {
  return tool.inputSchema.required.filter((name) => args[name] === undefined || args[name] === null || args[name] === '');
}

/** Run one tool. Returns a tool-result object, or null when the tool name is unknown. */
function callTool(store: Store, name: string, args: Record<string, unknown>): Record<string, unknown> | null {
  const tool = TOOLS.find((entry) => entry.name === name);
  if (tool === undefined) return null;
  const missing = missingRequired(tool, args);
  if (missing.length > 0) {
    return toolError(`missing required argument(s): ${missing.join(', ')}`);
  }
  switch (name) {
    case 'create_repo': {
      const repoName = args.name as string;
      if (store.getRepo(VIEWER.login, repoName) !== undefined) {
        return toolError(`Repository ${VIEWER.login}/${repoName} already exists`);
      }
      const repo = store.createRepo(
        VIEWER.login,
        repoName,
        typeof args.description === 'string' ? args.description : '',
        args.private === true,
      );
      return toolResult(repoJson(repo));
    }
    case 'get_repo': {
      const repo = resolveRepo(store, args);
      if (repo === null) return toolError(`Repository ${String(args.owner ?? '')}/${String(args.repo ?? '')} not found`);
      return toolResult(repoJson(repo));
    }
    case 'create_issue': {
      const repo = resolveRepo(store, args);
      if (repo === null) return toolError(`Repository ${String(args.owner ?? '')}/${String(args.repo ?? '')} not found`);
      const number = repo.nextNumber;
      repo.nextNumber += 1;
      const id = store.nextRestObjectId();
      const at = store.nowIso();
      const issue: Issue = {
        kind: 'issue',
        id,
        node_id: Buffer.from(`Issue:${repo.id}:${number}`).toString('base64'),
        number,
        title: args.title as string,
        body: typeof args.body === 'string' ? args.body : '',
        state: 'open',
        labels: [],
        user: VIEWER.login,
        comments: 0,
        created_at: at,
        updated_at: at,
        closed_at: null,
      };
      repo.items.set(number, issue);
      repo.issues.push(issue);
      return toolResult(issueJson(repo, issue));
    }
    case 'list_issues': {
      const repo = resolveRepo(store, args);
      if (repo === null) return toolError(`Repository ${String(args.owner ?? '')}/${String(args.repo ?? '')} not found`);
      const state = typeof args.state === 'string' ? args.state : 'open';
      const issues = state === 'all' ? repo.issues : repo.issues.filter((issue) => issue.state === state);
      return toolResult({ issues: issues.map((issue) => issueJson(repo, issue)) });
    }
    case 'create_pull_request': {
      const repo = resolveRepo(store, args);
      if (repo === null) return toolError(`Repository ${String(args.owner ?? '')}/${String(args.repo ?? '')} not found`);
      const headRef = args.head as string;
      const baseRef = args.base as string;
      const headSha = repo.refs.get(`refs/heads/${headRef}`);
      const baseSha = repo.refs.get(`refs/heads/${baseRef}`);
      if (headSha === undefined || baseSha === undefined) {
        return toolError('head or base branch not found');
      }
      if (repo.pulls.some((pull) => pull.state === 'open' && pull.headRef === headRef && pull.baseRef === baseRef)) {
        return toolError('A pull request already exists for this head and base');
      }
      const number = repo.nextNumber;
      repo.nextNumber += 1;
      const id = store.nextRestObjectId();
      const at = store.nowIso();
      const pull: Pull = {
        kind: 'pull',
        id,
        node_id: Buffer.from(`PullRequest:${repo.id}:${number}`).toString('base64'),
        number,
        title: args.title as string,
        body: typeof args.body === 'string' ? args.body : '',
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
      return toolResult(pullJson(repo, pull));
    }
    case 'merge_pull_request': {
      const repo = resolveRepo(store, args);
      if (repo === null) return toolError(`Repository ${String(args.owner ?? '')}/${String(args.repo ?? '')} not found`);
      const number = typeof args.pull_number === 'number' ? args.pull_number : Number(args.pull_number);
      const item = repo.items.get(number);
      if (item === undefined || item.kind !== 'pull') return toolError(`Pull request #${String(args.pull_number)} not found`);
      if (item.merged) return toolError(`Pull request #${number} is already merged`);
      if (pullMergeConflict(repo, item)) return toolError('Merge conflict');
      const mergedTree = squashTree(repo, item);
      if (mergedTree === null) return toolError('Merge conflict');
      const message = `Merge pull request #${item.number} from ${item.headRef}`;
      const commitOid = commitOnBranch(store, repo, item.baseRef, mergedTree, message);
      const at = store.nowIso();
      item.merged = true;
      item.merged_at = at;
      item.merge_commit_sha = commitOid;
      item.state = 'closed';
      item.updated_at = at;
      return toolResult({ sha: commitOid, merged: true, message: 'Pull request successfully merged', ...pullJson(repo, item) });
    }
    default:
      return null;
  }
}

function rpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function rpcError(id: unknown, code: number, message: string, data?: unknown): Record<string, unknown> {
  const error: Record<string, unknown> = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: '2.0', id: id ?? null, error };
}

export async function handleMcp(store: Store, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!isAuthenticated(req)) {
    sendError(res, 401, 'Bad credentials');
    return;
  }
  if ((req.method ?? 'GET') !== 'POST') {
    sendError(res, 405, 'Method not allowed');
    return;
  }
  const raw = await readBody(req);
  const parsed = parseJsonBody(raw);
  if (!parsed.ok) {
    sendJson(res, 400, rpcError(null, -32700, 'Parse error'));
    return;
  }
  const body = parsed.value;
  if (!isRecord(body) || typeof body.method !== 'string') {
    sendJson(res, 400, rpcError(isRecord(body) ? body.id : null, -32600, 'Invalid Request'));
    return;
  }
  const id = body.id ?? null;
  const method = body.method as string;
  const params = isRecord(body.params) ? body.params : {};
  // Notifications (no id) are answered with an empty 202.
  if (id === null && body.id === undefined) {
    if (method === 'notifications/initialized' || method.startsWith('notifications/')) {
      res.writeHead(202);
      res.end();
      return;
    }
  }
  if (method === 'server/discover') {
    sendJson(res, 200, rpcResult(id, {
      resultType: 'discover',
      supportedVersions: SUPPORTED_VERSIONS,
      capabilities: { tools: {} },
      instructions: 'A GitHub-compatible git forge: git smart HTTP, REST v3, GraphQL and MCP over one store.',
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      _meta: {
        'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION },
        'io.modelcontextprotocol/protocolVersion': '2026-07-28',
      },
    }));
    return;
  }
  if (method === 'initialize') {
    const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
    const negotiated = SUPPORTED_VERSIONS.includes(offered) ? offered : '2025-11-25';
    sendJson(res, 200, rpcResult(id, {
      protocolVersion: negotiated,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    }));
    return;
  }
  if (method === 'notifications/initialized') {
    res.writeHead(202);
    res.end();
    return;
  }
  if (method === 'tools/list') {
    sendJson(res, 200, rpcResult(id, { tools: TOOLS }));
    return;
  }
  if (method === 'tools/call') {
    const toolName = typeof params.name === 'string' ? params.name : '';
    const args = isRecord(params.arguments) ? params.arguments : {};
    const result = callTool(store, toolName, args);
    if (result === null) {
      sendJson(res, 200, rpcError(id, -32602, `Unknown tool: ${toolName}`));
      return;
    }
    sendJson(res, 200, rpcResult(id, result));
    return;
  }
  if (method === 'ping') {
    sendJson(res, 200, rpcResult(id, {}));
    return;
  }
  sendJson(res, 200, rpcError(id, -32601, `Method not found: ${method}`));
}
