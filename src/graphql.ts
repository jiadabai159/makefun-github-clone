// graphql.ts — a minimal GraphQL executor for exactly the documents the suite sends
// (gh's v4 shapes: viewer/repository/issues/pulls/mutations, __type probes, node(id:),
// cursor pagination, operation batching). No external dependency.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { VIEWER, isAuthenticated, sendJson, sendError, readBody, parseJsonBody } from './util.ts';
import { Store, repoGlobalId, itemGlobalId, commentGlobalId, type Repo, type Issue, type Pull, type Comment } from './store.ts';
import { commitOnBranch, commitTree, diffTrees, mergeBase, pullMergeConflict, squashTree } from './rest.ts';

// ---------------------------------------------------------------- tokenizer

type Token =
  | { kind: 'punct'; value: string }
  | { kind: 'name'; value: string }
  | { kind: 'int'; value: string }
  | { kind: 'string'; value: string };

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < source.length) {
    const ch = source[index] as string;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      index += 1;
      continue;
    }
    if (ch === '#') {
      while (index < source.length && source[index] !== '\n') index += 1;
      continue;
    }
    if ('{}()[]:!=$@'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      index += 1;
      continue;
    }
    if (source.startsWith('...', index)) {
      tokens.push({ kind: 'punct', value: '...' });
      index += 3;
      continue;
    }
    if (ch === '"') {
      let value = '';
      index += 1;
      while (index < source.length && source[index] !== '"') {
        if (source[index] === '\\' && index + 1 < source.length) {
          const escaped = source[index + 1] as string;
          value += escaped === 'n' ? '\n' : escaped === 't' ? '\t' : escaped === 'r' ? '\r' : escaped;
          index += 2;
          continue;
        }
        value += source[index];
        index += 1;
      }
      index += 1; // closing quote
      tokens.push({ kind: 'string', value });
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let end = index;
      while (end < source.length && /[0-9.]/.test(source[end] as string)) end += 1;
      tokens.push({ kind: 'int', value: source.slice(index, end) });
      index = end;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let end = index;
      while (end < source.length && /[A-Za-z0-9_]/.test(source[end] as string)) end += 1;
      tokens.push({ kind: 'name', value: source.slice(index, end) });
      index = end;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} in GraphQL document`);
  }
  tokens.push({ kind: 'punct', value: '' }); // EOF marker
  return tokens;
}

// ---------------------------------------------------------------- parser

interface ValueNode {
  kind: 'variable' | 'int' | 'float' | 'string' | 'boolean' | 'null' | 'enum' | 'list' | 'object';
  name?: string;
  value?: string | number | boolean;
  items?: ValueNode[];
  fields?: { name: string; value: ValueNode }[];
}

interface FieldNode {
  alias: string | null;
  name: string;
  args: { name: string; value: ValueNode }[];
  selections: SelectionNode[];
}

type SelectionNode =
  | { kind: 'field'; field: FieldNode }
  | { kind: 'inlineFragment'; typeCondition: string | null; selections: SelectionNode[] };

interface OperationNode {
  kind: 'query' | 'mutation';
  name: string | null;
  selections: SelectionNode[];
}

class Parser {
  private readonly tokens: Token[];
  private pos = 0;

  constructor(source: string) {
    this.tokens = tokenize(source);
  }

  private peek(): Token {
    return this.tokens[this.pos] as Token;
  }

  private next(): Token {
    const token = this.tokens[this.pos] as Token;
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) {
      throw new Error(`expected ${value}, got ${token.kind === 'name' ? token.value : token.value}`);
    }
  }

  private expectName(what = 'a name'): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error(`expected ${what}`);
    return token.value;
  }

  parseDocument(): OperationNode[] {
    const operations: OperationNode[] = [];
    while (this.peek().value !== '') {
      operations.push(this.parseOperation());
    }
    return operations;
  }

  private parseOperation(): OperationNode {
    let kind: 'query' | 'mutation' = 'query';
    let name: string | null = null;
    const token = this.peek();
    if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation')) {
      kind = token.value;
      this.next();
      if (this.peek().kind === 'name') name = this.expectName('an operation name');
    }
    if (this.peek().kind === 'punct' && this.peek().value === '(') {
      this.skipVariableDefinitions();
    }
    const selections = this.parseSelectionSet();
    return { kind, name, selections };
  }

  private skipVariableDefinitions(): void {
    this.expectPunct('(');
    let depth = 1;
    while (depth > 0) {
      const token = this.next();
      if (token.kind === 'punct' && token.value === '(') depth += 1;
      if (token.kind === 'punct' && token.value === ')') depth -= 1;
      if (token.kind === 'punct' && token.value === '') throw new Error('unterminated variable definitions');
    }
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
      if (this.peek().kind === 'punct' && this.peek().value === '') throw new Error('unterminated selection set');
      selections.push(this.parseSelection());
    }
    this.expectPunct('}');
    return selections;
  }

  private parseSelection(): SelectionNode {
    if (this.peek().kind === 'punct' && this.peek().value === '...') {
      this.next();
      let typeCondition: string | null = null;
      const token = this.peek();
      if (token.kind === 'name' && token.value === 'on') {
        this.next();
        typeCondition = this.expectName('a type condition');
      } else if (token.kind === 'name') {
        throw new Error(`named fragment spreads are not supported: ${token.value}`);
      }
      return { kind: 'inlineFragment', typeCondition, selections: this.parseSelectionSet() };
    }
    const first = this.expectName('a field name');
    let alias: string | null = null;
    let name = first;
    if (this.peek().kind === 'punct' && this.peek().value === ':') {
      this.next();
      alias = first;
      name = this.expectName('a field name');
    }
    const args: { name: string; value: ValueNode }[] = [];
    if (this.peek().kind === 'punct' && this.peek().value === '(') {
      this.next();
      while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
        const argName = this.expectName('an argument name');
        this.expectPunct(':');
        args.push({ name: argName, value: this.parseValue() });
      }
      this.expectPunct(')');
    }
    // Directives (@include/@skip) are not used by the suite; skip them if present.
    while (this.peek().kind === 'punct' && this.peek().value === '@') {
      this.next();
      this.expectName('a directive name');
      if (this.peek().kind === 'punct' && this.peek().value === '(') {
        let depth = 0;
        do {
          const token = this.next();
          if (token.kind === 'punct' && token.value === '(') depth += 1;
          if (token.kind === 'punct' && token.value === ')') depth -= 1;
        } while (depth > 0);
      }
    }
    const selections: SelectionNode[] =
      this.peek().kind === 'punct' && this.peek().value === '{' ? this.parseSelectionSet() : [];
    return { kind: 'field', field: { alias, name, args, selections } };
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') {
      return { kind: 'variable', name: this.expectName('a variable name') };
    }
    if (token.kind === 'punct' && token.value === '[') {
      const items: ValueNode[] = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === ']')) items.push(this.parseValue());
      this.expectPunct(']');
      return { kind: 'list', items };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: { name: string; value: ValueNode }[] = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
        const name = this.expectName('an input field name');
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'int') {
      const asNumber = Number(token.value);
      return Number.isInteger(asNumber) ? { kind: 'int', value: asNumber } : { kind: 'float', value: asNumber };
    }
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error(`unexpected token ${token.value} in a value`);
  }
}

// ---------------------------------------------------------------- values

function resolveValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name as string] ?? null;
    case 'int':
    case 'float':
    case 'string':
    case 'boolean':
    case 'enum':
      return node.value;
    case 'null':
      return null;
    case 'list':
      return (node.items ?? []).map((item) => resolveValue(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields ?? []) out[field.name] = resolveValue(field.value, variables);
      return out;
    }
  }
}

function argValue(field: FieldNode, name: string, variables: Record<string, unknown>): unknown {
  const arg = field.args.find((entry) => entry.name === name);
  if (arg === undefined) return undefined;
  return resolveValue(arg.value, variables);
}

// ---------------------------------------------------------------- nodes

type GqlNode =
  | { __typename: 'User'; login: string }
  | { __typename: 'Repository'; repo: Repo }
  | { __typename: 'Issue'; repo: Repo; issue: Issue }
  | { __typename: 'PullRequest'; repo: Repo; pull: Pull }
  | { __typename: 'IssueConnection'; nodes: { repo: Repo; issue: Issue }[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } }
  | { __typename: 'PullRequestConnection'; nodes: { repo: Repo; pull: Pull }[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } }
  | { __typename: 'PullRequestChangedFileConnection'; nodes: { path: string }[] }
  | { __typename: 'PageInfo'; hasNextPage: boolean; endCursor: string | null }
  | { __typename: '__Type'; name: string; kind: string; fields: string[]; enumValues: string[] }
  | { __typename: '__Field'; name: string }
  | { __typename: '__EnumValue'; name: string }
  | { __typename: 'IssueComment'; repo: Repo; comment: Comment }
  | { __typename: 'CommentEdge'; node: GqlNode }
  | { __typename: 'CreateIssuePayload'; issue: GqlNode }
  | { __typename: 'CloseIssuePayload'; issue: GqlNode }
  | { __typename: 'CreatePullRequestPayload'; pullRequest: GqlNode }
  | { __typename: 'MergePullRequestPayload'; pullRequest: GqlNode }
  | { __typename: 'AddCommentPayload'; commentEdge: GqlNode }
  | { __typename: 'BranchRef'; name: string };

const ISSUE_TYPE_FIELDS = ['id', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt', 'closedAt', 'author', 'comments', 'labels', 'url'];
const PULL_TYPE_FIELDS = ['id', 'number', 'title', 'state', 'body', 'headRefName', 'baseRefName', 'mergeable', 'merged', 'files', 'createdAt', 'updatedAt', 'mergedAt', 'author', 'url'];
const REPO_TYPE_FIELDS = ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'private', 'createdAt', 'updatedAt'];
const SEARCH_TYPE_VALUES = ['ISSUE', 'REPOSITORY', 'USER', 'COMMIT', 'CODE', 'DISCUSSION', 'MILESTONE', 'WIKI'];

function typeInfo(name: string): { kind: string; fields: string[]; enumValues: string[] } | null {
  switch (name) {
    case 'Issue':
      return { kind: 'OBJECT', fields: ISSUE_TYPE_FIELDS, enumValues: [] };
    case 'PullRequest':
      return { kind: 'OBJECT', fields: PULL_TYPE_FIELDS, enumValues: [] };
    case 'Repository':
      return { kind: 'OBJECT', fields: REPO_TYPE_FIELDS, enumValues: [] };
    case 'SearchType':
      return { kind: 'ENUM', fields: [], enumValues: SEARCH_TYPE_VALUES };
    case 'IssueState':
      return { kind: 'ENUM', fields: [], enumValues: ['OPEN', 'CLOSED'] };
    case 'PullRequestState':
      return { kind: 'ENUM', fields: [], enumValues: ['OPEN', 'CLOSED', 'MERGED'] };
    case 'MergeableState':
      return { kind: 'ENUM', fields: [], enumValues: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'] };
    case 'RepositoryPermission':
      return { kind: 'ENUM', fields: [], enumValues: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'] };
    default:
      return null;
  }
}

// ---------------------------------------------------------------- executor

interface ExecCtx {
  store: Store;
  variables: Record<string, unknown>;
  errors: { message: string }[];
}

function encodeCursor(number: number): string {
  return Buffer.from(`cursor:${number}`).toString('base64');
}

function decodeCursor(cursor: string): number | null {
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match === null ? null : Number(match[1]);
  } catch {
    return null;
  }
}

function issueConnection(ctx: ExecCtx, repo: Repo, field: FieldNode): GqlNode {
  const firstRaw = argValue(field, 'first', ctx.variables);
  const first = typeof firstRaw === 'number' && firstRaw > 0 ? Math.floor(firstRaw) : 100;
  const statesRaw = argValue(field, 'states', ctx.variables);
  const orderByRaw = argValue(field, 'orderBy', ctx.variables);
  const afterRaw = argValue(field, 'after', ctx.variables);
  let issues = repo.issues;
  if (Array.isArray(statesRaw)) {
    const wanted = new Set(statesRaw.map((state) => String(state).toLowerCase()));
    issues = issues.filter((issue) => wanted.has(issue.state));
  }
  const sorted = [...issues];
  const orderField = typeof orderByRaw === 'object' && orderByRaw !== null ? String((orderByRaw as Record<string, unknown>).field ?? '') : '';
  const orderDirection = typeof orderByRaw === 'object' && orderByRaw !== null ? String((orderByRaw as Record<string, unknown>).direction ?? '') : '';
  if (orderField === 'CREATED_AT') {
    const direction = orderDirection === 'ASC' ? 1 : -1;
    sorted.sort((a, b) => {
      if (a.created_at === b.created_at) return direction * (a.number - b.number);
      return direction * (a.created_at < b.created_at ? -1 : 1);
    });
  } else {
    sorted.sort((a, b) => a.number - b.number);
  }
  let startIndex = 0;
  if (typeof afterRaw === 'string' && afterRaw !== '') {
    const afterNumber = decodeCursor(afterRaw);
    if (afterNumber !== null) {
      const found = sorted.findIndex((issue) => issue.number === afterNumber);
      startIndex = found >= 0 ? found + 1 : 0;
    }
  }
  const page = sorted.slice(startIndex, startIndex + first);
  const hasNextPage = startIndex + first < sorted.length;
  const endCursor = page.length > 0 ? encodeCursor((page[page.length - 1] as Issue).number) : null;
  return {
    __typename: 'IssueConnection',
    nodes: page.map((issue) => ({ __typename: 'Issue' as const, repo, issue })),
    pageInfo: { hasNextPage, endCursor },
  };
}

function pullFiles(ctx: ExecCtx, repo: Repo, pull: Pull, field: FieldNode): GqlNode {
  const firstRaw = argValue(field, 'first', ctx.variables);
  const first = typeof firstRaw === 'number' && firstRaw > 0 ? Math.floor(firstRaw) : 100;
  const base = mergeBase(repo, pull.headSha, pull.baseSha);
  const baseTree = base === null ? null : commitTree(repo, base);
  const headTree = commitTree(repo, pull.headSha);
  const diff = diffTrees(repo, baseTree, headTree);
  const paths = [...diff.keys()].sort().slice(0, first);
  return {
    __typename: 'PullRequestChangedFileConnection',
    nodes: paths.map((path) => ({ path })),
  };
}

function mergeableOf(repo: Repo, pull: Pull): string {
  if (pull.merged) return 'MERGEABLE';
  return pullMergeConflict(repo, pull) ? 'CONFLICTING' : 'MERGEABLE';
}

function resolveField(ctx: ExecCtx, node: GqlNode, field: FieldNode): unknown {
  const name = field.name;
  switch (node.__typename) {
    case 'User':
      if (name === 'login') return node.login;
      break;
    case 'Repository': {
      const repo = node.repo;
      switch (name) {
        case 'id': return repoGlobalId(repo);
        case 'databaseId': return repo.id;
        case 'name': return repo.name;
        case 'nameWithOwner': return `${repo.owner}/${repo.name}`;
        case 'owner': return { __typename: 'User' as const, login: repo.owner };
        case 'defaultBranchRef': {
          const tip = repo.refs.get(`refs/heads/${repo.default_branch}`);
          return tip === undefined ? null : { __typename: 'BranchRef' as const, name: repo.default_branch };
        }
        case 'viewerPermission': return 'ADMIN';
        case 'hasIssuesEnabled': return true;
        case 'description': return repo.description;
        case 'private': return repo.private;
        case 'issue': {
          const number = argValue(field, 'number', ctx.variables);
          if (typeof number !== 'number') return null;
          const item = repo.items.get(number);
          return item !== undefined && item.kind === 'issue' ? { __typename: 'Issue' as const, repo, issue: item } : null;
        }
        case 'issues':
          return issueConnection(ctx, repo, field);
        case 'pullRequests': {
          const firstRaw = argValue(field, 'first', ctx.variables);
          const first = typeof firstRaw === 'number' && firstRaw > 0 ? Math.floor(firstRaw) : 100;
          const sorted = [...repo.pulls].sort((a, b) => b.number - a.number);
          const page = sorted.slice(0, first);
          return {
            __typename: 'PullRequestConnection' as const,
            nodes: page.map((pull) => ({ __typename: 'PullRequest' as const, repo, pull })),
            pageInfo: { hasNextPage: sorted.length > first, endCursor: null },
          };
        }
        case 'pullRequest': {
          const number = argValue(field, 'number', ctx.variables);
          if (typeof number !== 'number') return null;
          const item = repo.items.get(number);
          return item !== undefined && item.kind === 'pull' ? { __typename: 'PullRequest' as const, repo, pull: item } : null;
        }
      }
      break;
    }
    case 'Issue': {
      const issue = node.issue;
      switch (name) {
        case 'id': return itemGlobalId(node.repo, issue);
        case 'number': return issue.number;
        case 'title': return issue.title;
        case 'state': return issue.state === 'open' ? 'OPEN' : 'CLOSED';
        case 'body': return issue.body;
        case 'createdAt': return issue.created_at;
        case 'updatedAt': return issue.updated_at;
        case 'closedAt': return issue.closed_at;
      }
      break;
    }
    case 'PullRequest': {
      const pull = node.pull;
      switch (name) {
        case 'id': return itemGlobalId(node.repo, pull);
        case 'number': return pull.number;
        case 'title': return pull.title;
        case 'state': return pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED';
        case 'body': return pull.body;
        case 'headRefName': return pull.headRef;
        case 'baseRefName': return pull.baseRef;
        case 'mergeable': return mergeableOf(node.repo, pull);
        case 'merged': return pull.merged;
        case 'files': return pullFiles(ctx, node.repo, pull, field);
        case 'createdAt': return pull.created_at;
        case 'updatedAt': return pull.updated_at;
        case 'mergedAt': return pull.merged_at;
      }
      break;
    }
    case 'IssueConnection':
    case 'PullRequestConnection':
      if (name === 'nodes') return node.nodes;
      if (name === 'pageInfo') return { __typename: 'PageInfo' as const, ...node.pageInfo };
      if (name === 'totalCount') return node.nodes.length;
      break;
    case 'PullRequestChangedFileConnection':
      if (name === 'nodes') return node.nodes;
      break;
    case 'PageInfo':
      if (name === 'hasNextPage') return node.hasNextPage;
      if (name === 'endCursor') return node.endCursor;
      break;
    case '__Type':
      if (name === 'name') return node.name;
      if (name === 'kind') return node.kind;
      if (name === 'fields') return node.fields.map((fieldName) => ({ __typename: '__Field' as const, name: fieldName }));
      if (name === 'enumValues') return node.enumValues.map((value) => ({ __typename: '__EnumValue' as const, name: value }));
      break;
    case '__Field':
    case '__EnumValue':
      if (name === 'name') return node.name;
      break;
    case 'IssueComment':
      if (name === 'id') return commentGlobalId(node.repo, node.comment);
      if (name === 'body') return node.comment.body;
      break;
    case 'CommentEdge':
      if (name === 'node') return node.node;
      break;
    case 'CreateIssuePayload':
    case 'CloseIssuePayload':
      if (name === 'issue') return node.issue;
      break;
    case 'CreatePullRequestPayload':
    case 'MergePullRequestPayload':
      if (name === 'pullRequest') return node.pullRequest;
      break;
    case 'AddCommentPayload':
      if (name === 'commentEdge') return node.commentEdge;
      break;
    case 'BranchRef':
      if (name === 'name') return node.name;
      break;
  }
  ctx.errors.push({ message: `Cannot query field "${name}" on type "${node.__typename}".` });
  return null;
}

/** Resolve a selection set against a node, returning the JSON value (or null). */
function executeSelections(ctx: ExecCtx, node: GqlNode, selections: SelectionNode[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'inlineFragment') {
      if (selection.typeCondition !== null && selection.typeCondition !== node.__typename) continue;
      Object.assign(out, executeSelections(ctx, node, selection.selections));
      continue;
    }
    const field = selection.field;
    const key = field.alias ?? field.name;
    const value = resolveField(ctx, node, field);
    if (value === null || value === undefined) {
      out[key] = null;
      continue;
    }
    if (typeof value === 'object' && '__typename' in value && field.selections.length > 0) {
      out[key] = executeSelections(ctx, value as GqlNode, field.selections);
    } else if (Array.isArray(value) && field.selections.length > 0) {
      out[key] = value.map((entry) => {
        if (entry !== null && typeof entry === 'object' && '__typename' in entry) {
          return executeSelections(ctx, entry as GqlNode, field.selections);
        }
        return entry;
      });
    } else {
      out[key] = value;
    }
  }
  return out;
}

// ---------------------------------------------------------------- mutations

function createIssueFromInput(ctx: ExecCtx, input: Record<string, unknown>): GqlNode | null {
  const parsed = typeof input.repositoryId === 'string' ? ctx.store.resolveGlobalId(input.repositoryId) : null;
  if (parsed === null || parsed.kind !== 'Repository') {
    ctx.errors.push({ message: 'createIssue: repositoryId is not a repository global id' });
    return null;
  }
  const repo = parsed.repo;
  if (repo === undefined) {
    ctx.errors.push({ message: 'createIssue: repository not found' });
    return null;
  }
  if (typeof input.title !== 'string' || input.title === '') {
    ctx.errors.push({ message: 'createIssue: title is required' });
    return null;
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
    title: input.title,
    body: typeof input.body === 'string' ? input.body : '',
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
  return { __typename: 'CreateIssuePayload', issue: { __typename: 'Issue', repo, issue } };
}

function closeIssueFromInput(ctx: ExecCtx, input: Record<string, unknown>): GqlNode | null {
  const parsed = typeof input.issueId === 'string' ? ctx.store.resolveGlobalId(input.issueId) : null;
  if (parsed === null || parsed.kind !== 'Issue' || parsed.number === undefined) {
    ctx.errors.push({ message: 'closeIssue: issueId is not an issue global id' });
    return null;
  }
  const repo = parsed.repo;
  if (repo === undefined) {
    ctx.errors.push({ message: 'closeIssue: repository not found' });
    return null;
  }
  const item = repo.items.get(parsed.number);
  if (item === undefined || item.kind !== 'issue') {
    ctx.errors.push({ message: 'closeIssue: issue not found' });
    return null;
  }
  item.state = 'closed';
  item.closed_at = ctx.store.nowIso();
  item.updated_at = item.closed_at;
  return { __typename: 'CloseIssuePayload', issue: { __typename: 'Issue', repo, issue: item } };
}

function createPullFromInput(ctx: ExecCtx, input: Record<string, unknown>): GqlNode | null {
  const parsed = typeof input.repositoryId === 'string' ? ctx.store.resolveGlobalId(input.repositoryId) : null;
  if (parsed === null || parsed.kind !== 'Repository') {
    ctx.errors.push({ message: 'createPullRequest: repositoryId is not a repository global id' });
    return null;
  }
  const repo = parsed.repo;
  if (repo === undefined) {
    ctx.errors.push({ message: 'createPullRequest: repository not found' });
    return null;
  }
  const headRef = typeof input.headRefName === 'string' ? input.headRefName : '';
  const baseRef = typeof input.baseRefName === 'string' ? input.baseRefName : '';
  const headSha = repo.refs.get(`refs/heads/${headRef}`);
  const baseSha = repo.refs.get(`refs/heads/${baseRef}`);
  if (headSha === undefined || baseSha === undefined || typeof input.title !== 'string') {
    ctx.errors.push({ message: 'createPullRequest: head, base and title are required' });
    return null;
  }
  if (repo.pulls.some((pull) => pull.state === 'open' && pull.headRef === headRef && pull.baseRef === baseRef)) {
    ctx.errors.push({ message: 'createPullRequest: a pull request already exists for this head and base' });
    return null;
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
    title: input.title,
    body: typeof input.body === 'string' ? input.body : '',
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
  return { __typename: 'CreatePullRequestPayload', pullRequest: { __typename: 'PullRequest', repo, pull } };
}

function mergePullFromInput(ctx: ExecCtx, input: Record<string, unknown>): GqlNode | null {
  const parsed = typeof input.pullRequestId === 'string' ? ctx.store.resolveGlobalId(input.pullRequestId) : null;
  if (parsed === null || parsed.kind !== 'PullRequest' || parsed.number === undefined) {
    ctx.errors.push({ message: 'mergePullRequest: pullRequestId is not a pull request global id' });
    return null;
  }
  const repo = parsed.repo;
  if (repo === undefined) {
    ctx.errors.push({ message: 'mergePullRequest: repository not found' });
    return null;
  }
  const item = repo.items.get(parsed.number);
  if (item === undefined || item.kind !== 'pull') {
    ctx.errors.push({ message: 'mergePullRequest: pull request not found' });
    return null;
  }
  if (item.merged) {
    ctx.errors.push({ message: 'mergePullRequest: pull request already merged' });
    return null;
  }
  if (pullMergeConflict(repo, item)) {
    ctx.errors.push({ message: 'mergePullRequest: merge conflict' });
    return null;
  }
  const mergedTree = squashTree(repo, item);
  if (mergedTree === null) {
    ctx.errors.push({ message: 'mergePullRequest: merge conflict' });
    return null;
  }
  const message = `Merge pull request #${item.number} from ${item.headRef}`;
  const commitOid = commitOnBranch(ctx.store, repo, item.baseRef, mergedTree, message);
  const at = ctx.store.nowIso();
  item.merged = true;
  item.merged_at = at;
  item.merge_commit_sha = commitOid;
  item.state = 'closed';
  item.updated_at = at;
  return { __typename: 'MergePullRequestPayload', pullRequest: { __typename: 'PullRequest', repo, pull: item } };
}

function addCommentFromInput(ctx: ExecCtx, input: Record<string, unknown>): GqlNode | null {
  const parsed = typeof input.subjectId === 'string' ? ctx.store.resolveGlobalId(input.subjectId) : null;
  if (parsed === null || parsed.kind !== 'Issue' || parsed.number === undefined) {
    ctx.errors.push({ message: 'addComment: subjectId is not an issue global id' });
    return null;
  }
  const repo = parsed.repo;
  if (repo === undefined) {
    ctx.errors.push({ message: 'addComment: repository not found' });
    return null;
  }
  const item = repo.items.get(parsed.number);
  if (item === undefined) {
    ctx.errors.push({ message: 'addComment: subject not found' });
    return null;
  }
  if (typeof input.body !== 'string' || input.body === '') {
    ctx.errors.push({ message: 'addComment: body is required' });
    return null;
  }
  const id = ctx.store.nextRestObjectId();
  const at = ctx.store.nowIso();
  const comment: Comment = {
    id,
    node_id: Buffer.from(`IssueComment:${repo.id}:${parsed.number}:${id}`).toString('base64'),
    issueNumber: parsed.number,
    body: input.body,
    user: VIEWER.login,
    created_at: at,
    updated_at: at,
  };
  repo.comments.push(comment);
  if (item.kind === 'issue') item.comments += 1;
  return {
    __typename: 'AddCommentPayload',
    commentEdge: { __typename: 'CommentEdge', node: { __typename: 'IssueComment', repo, comment } },
  };
}

// ---------------------------------------------------------------- root

function resolveRootField(ctx: ExecCtx, field: FieldNode): unknown {
  const name = field.name;
  if (name === 'viewer') return { __typename: 'User' as const, login: VIEWER.login };
  if (name === 'repository') {
    const owner = argValue(field, 'owner', ctx.variables);
    const repoName = argValue(field, 'name', ctx.variables);
    if (typeof owner !== 'string' || typeof repoName !== 'string') return null;
    const repo = ctx.store.getRepo(owner, repoName);
    return repo === undefined ? null : { __typename: 'Repository' as const, repo };
  }
  if (name === 'node') {
    const id = argValue(field, 'id', ctx.variables);
    if (typeof id !== 'string') return null;
    const parsed = ctx.store.resolveGlobalId(id);
    if (parsed === null) return null;
    const repo = parsed.repo;
    if (parsed.kind === 'Repository') return { __typename: 'Repository' as const, repo };
    if (parsed.number !== undefined) {
      const item = repo.items.get(parsed.number);
      if (parsed.kind === 'Issue' && item !== undefined && item.kind === 'issue') return { __typename: 'Issue' as const, repo, issue: item };
      if (parsed.kind === 'PullRequest' && item !== undefined && item.kind === 'pull') return { __typename: 'PullRequest' as const, repo, pull: item };
    }
    return null;
  }
  if (name === '__type') {
    const typeName = argValue(field, 'name', ctx.variables);
    if (typeof typeName !== 'string') return null;
    const info = typeInfo(typeName);
    return info === null ? null : { __typename: '__Type' as const, name: typeName, kind: info.kind, fields: info.fields, enumValues: info.enumValues };
  }
  if (name === 'createIssue') {
    const input = argValue(field, 'input', ctx.variables);
    return typeof input === 'object' && input !== null ? createIssueFromInput(ctx, input as Record<string, unknown>) : null;
  }
  if (name === 'closeIssue') {
    const input = argValue(field, 'input', ctx.variables);
    return typeof input === 'object' && input !== null ? closeIssueFromInput(ctx, input as Record<string, unknown>) : null;
  }
  if (name === 'createPullRequest') {
    const input = argValue(field, 'input', ctx.variables);
    return typeof input === 'object' && input !== null ? createPullFromInput(ctx, input as Record<string, unknown>) : null;
  }
  if (name === 'mergePullRequest') {
    const input = argValue(field, 'input', ctx.variables);
    return typeof input === 'object' && input !== null ? mergePullFromInput(ctx, input as Record<string, unknown>) : null;
  }
  if (name === 'addComment') {
    const input = argValue(field, 'input', ctx.variables);
    return typeof input === 'object' && input !== null ? addCommentFromInput(ctx, input as Record<string, unknown>) : null;
  }
  ctx.errors.push({ message: `Cannot query field "${name}" on type "Query".` });
  return null;
}

function executeOperation(store: Store, operation: OperationNode, variables: Record<string, unknown>): { data: Record<string, unknown> | null; errors: { message: string }[] } {
  const ctx: ExecCtx = { store, variables, errors: [] };
  const data: Record<string, unknown> = {};
  for (const selection of operation.selections) {
    if (selection.kind === 'inlineFragment') {
      // A root inline fragment applies to Query/Mutation itself.
      for (const inner of selection.selections) {
        if (inner.kind !== 'field') continue;
        const field = inner.field;
        const value = resolveRootField(ctx, field);
        data[field.alias ?? field.name] = value === null || value === undefined ? null
          : typeof value === 'object' && '__typename' in value && field.selections.length > 0
            ? executeSelections(ctx, value as GqlNode, field.selections)
            : value;
      }
      continue;
    }
    const field = selection.field;
    const value = resolveRootField(ctx, field);
    const key = field.alias ?? field.name;
    if (value === null || value === undefined) {
      data[key] = null;
      continue;
    }
    if (typeof value === 'object' && '__typename' in value && field.selections.length > 0) {
      data[key] = executeSelections(ctx, value as GqlNode, field.selections);
    } else {
      data[key] = value;
    }
  }
  return { data, errors: ctx.errors };
}

// ---------------------------------------------------------------- HTTP

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export async function handleGraphQL(store: Store, req: IncomingMessage, res: ServerResponse): Promise<void> {
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
    sendJson(res, 400, { data: null, errors: [{ message: 'Request body is not valid JSON' }] });
    return;
  }
  const runOne = (entry: unknown): Record<string, unknown> => {
    if (!isRecord(entry) || typeof entry.query !== 'string') {
      return { data: null, errors: [{ message: 'query is required' }] };
    }
    const variables = isRecord(entry.variables) ? entry.variables : {};
    let operations: OperationNode[];
    try {
      operations = new Parser(entry.query).parseDocument();
    } catch (err) {
      return { data: null, errors: [{ message: err instanceof Error ? err.message : 'GraphQL parse error' }] };
    }
    if (operations.length === 0) {
      return { data: null, errors: [{ message: 'no operation in document' }] };
    }
    const operation = operations[0] as OperationNode;
    // operationName selection when several operations are present.
    const named = typeof entry.operationName === 'string' ? operations.find((op) => op.name === entry.operationName) : undefined;
    const chosen = named ?? operation;
    const result = executeOperation(store, chosen, variables);
    return result.errors.length > 0 ? { data: result.data, errors: result.errors } : { data: result.data };
  };
  if (Array.isArray(parsed.value)) {
    sendJson(res, 200, parsed.value.map(runOne));
    return;
  }
  sendJson(res, 200, runOne(parsed.value));
}
