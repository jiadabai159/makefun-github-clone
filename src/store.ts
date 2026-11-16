// The forge's store: one in-memory map per kind, no persistence. The trial
// process stays up for the whole run, so nothing needs to survive it, and the
// replay runs the same requests in the same order, so the logical clock below
// keeps every timestamp deterministic.

import { VIEWER, globalId } from './util.ts';

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: GitObjectType;
  data: Buffer;
}

export interface Label {
  id: number;
  node_id: string;
  name: string;
  color: string;
}

export interface Issue {
  kind: 'issue';
  id: number;
  node_id: string;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  user: string;
  comments: number;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
}

export interface Pull {
  kind: 'pull';
  id: number;
  node_id: string;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  merged: boolean;
  merged_at: string | null;
  merge_commit_sha: string | null;
  user: string;
  created_at: string;
  updated_at: string;
}

export interface Comment {
  id: number;
  node_id: string;
  issueNumber: number;
  body: string;
  user: string;
  created_at: string;
  updated_at: string;
}

export interface Repo {
  id: number;
  owner: string;
  name: string;
  description: string;
  private: boolean;
  default_branch: string;
  created_at: string;
  updated_at: string;
  pushed_at: string;
  /** ref name -> commit oid (heads and tags). */
  refs: Map<string, string>;
  /** oid -> object. */
  objects: Map<string, GitObject>;
  /** issue and pull numbers share one sequence, as on GitHub. */
  nextNumber: number;
  /** number -> issue or pull. */
  items: Map<number, Issue | Pull>;
  issues: Issue[];
  pulls: Pull[];
  labels: Label[];
  comments: Comment[];
  nextCommentId: number;
  /** Pack/response cache for fetches, keyed by the request's shape. Cleared on any mutation. */
  fetchCache: Map<string, Buffer>;
  /** Counter for the repo's own REST ids (labels). */
  nextLabelId: number;
}

/** Fixed epoch for the logical clock: 2025-01-01T00:00:00Z, the scenario's epoch. */
const CLOCK_EPOCH_SEC = 1735689600;

export class Store {
  /** owner/name -> repo. */
  repos = new Map<string, Repo>();
  /** database id -> repo, for global-id resolution. */
  reposById = new Map<number, Repo>();
  private nextRepoId = 5000;
  private nextRestId = 60000;
  private nextLabelId = 1;
  /** Logical clock: one second per timestamp taken. */
  private clockTick = 0;

  /** The next timestamp, ISO, deterministic. */
  nowIso(): string {
    const sec = CLOCK_EPOCH_SEC + this.clockTick;
    this.clockTick += 1;
    return new Date(sec * 1000).toISOString();
  }

  /** The next timestamp as epoch seconds, deterministic. */
  nowSec(): number {
    const sec = CLOCK_EPOCH_SEC + this.clockTick;
    this.clockTick += 1;
    return sec;
  }

  nextRestObjectId(): number {
    const id = this.nextRestId;
    this.nextRestId += 1;
    return id;
  }

  nextLabelObjectId(): number {
    const id = this.nextLabelId;
    this.nextLabelId += 1;
    return id;
  }

  key(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.key(owner, name));
  }

  createRepo(owner: string, name: string, description: string, isPrivate: boolean): Repo {
    const id = this.nextRepoId;
    this.nextRepoId += 1;
    const at = this.nowIso();
    const repo: Repo = {
      id,
      owner,
      name,
      description,
      private: isPrivate,
      default_branch: 'main',
      created_at: at,
      updated_at: at,
      pushed_at: at,
      refs: new Map(),
      objects: new Map(),
      nextNumber: 1,
      items: new Map(),
      issues: [],
      pulls: [],
      labels: [],
      comments: [],
      nextCommentId: 1,
      fetchCache: new Map(),
      nextLabelId: 1,
    };
    this.repos.set(this.key(owner, name), repo);
    this.reposById.set(id, repo);
    return repo;
  }

  deleteRepo(repo: Repo): void {
    this.repos.delete(this.key(repo.owner, repo.name));
    this.reposById.delete(repo.id);
  }

  /** Every repo the viewer owns, in creation order. */
  viewerRepos(): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) {
      if (repo.owner === VIEWER.login) out.push(repo);
    }
    return out;
  }

  /** A repo's default branch tip, or null when it has no commits. */
  defaultTip(repo: Repo): string | null {
    return repo.refs.get(`refs/heads/${repo.default_branch}`) ?? null;
  }

  /** Resolve a Relay global id to its object, or null. */
  resolveGlobalId(id: string): { kind: string; repo: Repo; number?: number; commentId?: number } | null {
    let text: string;
    try {
      text = Buffer.from(id, 'base64').toString('utf8');
    } catch {
      return null;
    }
    const parts = text.split(':');
    if (parts.length < 2) return null;
    const kind = parts[0] as string;
    if (kind === 'Repository' && parts.length === 2) {
      const repo = this.reposById.get(Number(parts[1]));
      if (repo === undefined) return null;
      return { kind, repo };
    }
    if ((kind === 'Issue' || kind === 'PullRequest') && parts.length === 3) {
      const repo = this.reposById.get(Number(parts[1]));
      if (repo === undefined) return null;
      return { kind, repo, number: Number(parts[2]) };
    }
    if (kind === 'IssueComment' && parts.length === 4) {
      const repo = this.reposById.get(Number(parts[1]));
      if (repo === undefined) return null;
      return { kind, repo, number: Number(parts[2]), commentId: Number(parts[3]) };
    }
    return null;
  }
}

/** The global id of a repository. */
export function repoGlobalId(repo: Repo): string {
  return globalId('Repository', repo.id);
}

/** The global id of an issue or pull request. */
export function itemGlobalId(repo: Repo, item: Issue | Pull): string {
  return globalId(item.kind === 'issue' ? 'Issue' : 'PullRequest', repo.id, item.number);
}

/** The global id of a comment. */
export function commentGlobalId(repo: Repo, comment: Comment): string {
  return globalId('IssueComment', repo.id, comment.issueNumber, comment.id);
}
