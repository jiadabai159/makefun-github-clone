// app.ts — one process: git smart HTTP, REST v3, GraphQL and MCP over one in-memory store.
// createApp() builds the server; main.ts owns the env lifecycle (bind, register, wait for done).

import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { Store } from './src/store.ts';
import { handleGitPath } from './src/githttp.ts';
import { handleRest } from './src/rest.ts';
import { handleGraphQL } from './src/graphql.ts';
import { handleMcp } from './src/mcp.ts';
import { sendError, sendJson, splitPath, parseQuery } from './src/util.ts';

export function createApp(): Server {
  const store = new Store();

  async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const url = req.url ?? '/';
      const [rawPath, rawQuery] = url.split('?', 2);
      const path = rawPath ?? '/';
      const query = parseQuery(rawQuery ?? '');
      const method = req.method ?? 'GET';

      if (path === '/healthz' && method === 'GET') {
        sendJson(res, 200, { ok: true });
        return;
      }
      if (path === '/api/graphql') {
        await handleGraphQL(store, req, res);
        return;
      }
      if (path === '/mcp') {
        await handleMcp(store, req, res);
        return;
      }
      const segments = splitPath(path);
      if (segments[0] === 'api' && segments[1] === 'v3') {
        await handleRest(store, req, res, segments.slice(2), query);
        return;
      }
      // Git smart HTTP: /{owner}/{repo}.git/{service}
      if (segments.length >= 2 && segments[1]?.endsWith('.git') === true) {
        const owner = segments[0] as string;
        const repoName = (segments[1] as string).slice(0, -4);
        const rest = segments.slice(2);
        await handleGitPath(store, req, res, owner, repoName, rest, query);
        return;
      }
      sendError(res, 404, 'Not Found');
    } catch (err) {
      // A handler must never kill the server: answer 500 JSON and keep serving.
      try {
        sendError(res, 500, err instanceof Error ? err.message : 'Internal Server Error');
      } catch {
        try {
          res.destroy();
        } catch {
          // ignore
        }
      }
    }
  }

  return createServer((req, res) => {
    void handler(req, res);
  });
}
