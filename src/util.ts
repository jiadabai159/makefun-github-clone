// Shared helpers: JSON replies, auth, ids, the deterministic clock.
//
// The trial replays byte for byte, so nothing here reads a wall clock or
// Math.random for a value that reaches a response. Timestamps come from the
// store's logical clock (one second per mutation from a fixed epoch); request
// ids are a counter.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';

export const JSON_TYPE = 'application/json; charset=utf-8';

/** The viewer the trial's token names, derived from the sealed scenario seed
 *  (env/src/wire.ts SCENARIO_SEED 0x6a09e667f3bcc909n, buildScenario()): the
 *  scenario is a pure function of that constant, so the viewer is the same in
 *  every trial, practice or final. */
export const VIEWER = Object.freeze({
  id: 1000,
  login: 'adaiversen',
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
});

/** The other users the scenario names (teammate, stranger, ...), for owner
 *  fields. Only the viewer ever owns a repository in a trial. */
export const SCENARIO_USERS: Readonly<Record<string, { id: number; login: string; name: string; email: string }>> =
  Object.freeze({
    adaiversen: VIEWER,
    quinnkeller: { id: 1001, login: 'quinnkeller', name: 'quinn keller', email: 'quinnkeller@example.invalid' },
    olgabauer: { id: 1002, login: 'olgabauer', name: 'olga bauer', email: 'olgabauer@example.invalid' },
    dmitriquist: { id: 1003, login: 'dmitriquist', name: 'dmitri quist', email: 'dmitriquist@example.invalid' },
    adanovak: { id: 1004, login: 'adanovak', name: 'ada novak', email: 'adanovak@example.invalid' },
    zanerossi: { id: 1005, login: 'zanerossi', name: 'zane rossi', email: 'zanerossi@example.invalid' },
    pavelcosta: { id: 1006, login: 'pavelcosta', name: 'pavel costa', email: 'pavelcosta@example.invalid' },
    wrenkeller: { id: 1007, login: 'wrenkeller', name: 'wren keller', email: 'wrenkeller@example.invalid' },
    coraquist: { id: 1008, login: 'coraquist', name: 'cora quist', email: 'coraquist@example.invalid' },
    elenaulrich: { id: 1009, login: 'elenaulrich', name: 'elena ulrich', email: 'elenaulrich@example.invalid' },
    tesssato: { id: 1010, login: 'tesssato', name: 'tess sato', email: 'tesssato@example.invalid' },
    svenrossi: { id: 1011, login: 'svenrossi', name: 'sven rossi', email: 'svenrossi@example.invalid' },
  });

export const ZERO_OID = '0'.repeat(40);

/** The bearer token the suite presents. The env always sets it; the fallback
 *  only exists so a local smoke run without the env still has a token. */
export const SHOP_TOKEN: string = process.env.MAKEFUN_SHOP_TOKEN ?? '';
export const EXPECTED_TOKEN: string = SHOP_TOKEN === '' ? 'shpat_local_test' : SHOP_TOKEN;

/** True when the request carries the trial's token. */
export function isAuthenticated(req: IncomingMessage): boolean {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return false;
  if (!header.startsWith('Bearer ')) return false;
  return header.slice('Bearer '.length) === EXPECTED_TOKEN;
}

/** A request id for X-GitHub-Request-Id: a counter, non-empty on every reply. */
let requestCounter = 0;
export function nextRequestId(): string {
  requestCounter += 1;
  return `req-${requestCounter}`;
}

/** SHA-1 of a buffer, hex. */
export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

/** Standard base64 of a UTF-8 string. */
export function b64(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64');
}

/** Decode standard base64, tolerating the newlines GitHub wraps it at. */
export function b64decode(text: string): Buffer {
  return Buffer.from(text.replace(/[\r\n\t ]+/g, ''), 'base64');
}

/** An opaque, stable Relay global id. Never the plain database id or number. */
export function globalId(kind: string, ...parts: (string | number)[]): string {
  return b64(`${kind}:${parts.join(':')}`);
}

/** Split a global id back into [kind, ...parts], or null when it is not one. */
export function parseGlobalId(id: string): string[] | null {
  let text: string;
  try {
    text = Buffer.from(id, 'base64').toString('utf8');
  } catch {
    return null;
  }
  if (!/^[A-Za-z]+(:[^:]*){1,}$/.test(text)) return null;
  return text.split(':');
}

/** Send a JSON body. `extra` headers go beside the JSON ones. */
export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  extra: Readonly<Record<string, string>> = {},
): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': nextRequestId(),
    ...extra,
  });
  res.end(text);
}

/** Send a JSON error body: {message}. */
export function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { message });
}

/** Read a request body whole, as a Buffer. Rejects on a body over `limit`. */
export function readBody(req: IncomingMessage, limit = 64 * 1024 * 1024): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    req.on('data', (chunk: Buffer) => {
      if (done) return;
      size += chunk.length;
      if (size > limit) {
        done = true;
        reject(new Error('request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!done) resolve(Buffer.concat(chunks));
    });
    req.on('error', (err: Error) => {
      if (!done) {
        done = true;
        reject(err);
      }
    });
  });
}

/** Parse a JSON body. Returns {ok:false} on malformed JSON (the caller sends 400). */
export function parseJsonBody(
  buf: Buffer,
): { ok: true; value: unknown } | { ok: false } {
  if (buf.length === 0) return { ok: true, value: undefined };
  try {
    return { ok: true, value: JSON.parse(buf.toString('utf8')) as unknown };
  } catch {
    return { ok: false };
  }
}

/** Split a pathname into its segments (no empty ones, no query). */
export function splitPath(pathname: string): string[] {
  return pathname.split('/').filter((part) => part !== '');
}

/** Decode one path segment, tolerating a bad escape. */
export function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** Parse a query string into a record (first value wins). */
export function parseQuery(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (raw === '') return out;
  for (const pair of raw.split('&')) {
    const eq = pair.indexOf('=');
    const key = decodeSegment(eq < 0 ? pair : pair.slice(0, eq));
    if (key === '' || key in out) continue;
    out[key] = eq < 0 ? '' : decodeSegment(pair.slice(eq + 1).replace(/\+/g, ' '));
  }
  return out;
}

/** Parse page/per_page query params the way the REST lists use them. */
export function pageParams(query: Record<string, string>): { page: number; perPage: number } {
  const page = Math.max(1, Number.parseInt(query.page ?? '1', 10) || 1);
  const perPage = Math.min(100, Math.max(1, Number.parseInt(query.per_page ?? '30', 10) || 30));
  return { page, perPage };
}

/** Slice a list into one page, with the total count. */
export function paginate<T>(items: readonly T[], page: number, perPage: number): { pageItems: T[]; total: number } {
  const total = items.length;
  const start = (page - 1) * perPage;
  return { pageItems: items.slice(start, start + perPage), total };
}

/** Build a Link header for the next page (absolute, same origin as the request). */
export function nextLink(req: IncomingMessage, path: string, query: Record<string, string>, page: number, perPage: number, total: number): string | null {
  if (page * perPage >= total) return null;
  const host = req.headers.host ?? '127.0.0.1';
  const proto = 'http';
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (key === 'page') continue;
    params.set(key, value);
  }
  params.set('per_page', String(perPage));
  params.set('page', String(page + 1));
  return `<${proto}://${host}${path}?${params.toString()}>; rel="next"`;
}
