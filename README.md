# makefun-github-clone

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/jiadabai159/makefun-github-clone/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/jiadabai159/makefun-github-clone/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible git forge in one Node 22 process, standard library only:
git smart HTTP (protocol v2 and v0), the REST v3 API, GraphQL v4 and MCP
(Streamable HTTP) over a single in-memory store. No UI, no database, no
dependencies — the sealed suite drives it as a client and scores conformance
plus four timed workloads.

## Grade-local result

120/120 conformance checks pass (git 30, repos 15, issues 15, pulls 20,
GraphQL 20, MCP 15, protocol 5); perf 167/200 (push 40, clone 33, read 48,
write 46) — about 967/1000 against the reference forge's ~900.

## Run it

```sh
MAKEFUN_ENV_URL=http://127.0.0.1:8080 MAKEFUN_SHOP_TOKEN=shpat_<token> node main.ts
```

`main.ts` binds an ephemeral port, registers it with the env, and exits when
the env says done. Requires Node 22.18+ (type stripping, no build step).

## Layout

- `main.ts` — the env lifecycle (starter, keep as-is)
- `app.ts` — the HTTP server and router
- `src/gitcore.ts` — SHA-1 objects, packfiles (plain write, delta-resolving read), pkt-lines
- `src/githttp.ts` — git smart HTTP: v0/v2 advertisements, upload-pack, receive-pack
- `src/rest.ts` — REST v3: repos, branches, commits, contents, labels, issues, pulls, merges
- `src/graphql.ts` — a minimal GraphQL executor for gh's v4 documents (viewer, repository, issues, pulls, mutations, `__type`, `node(id:)`, cursor pagination, batching)
- `src/mcp.ts` — MCP `server/discover` + `initialize`, `tools/list` and six tools over the same store
- `src/store.ts` — the in-memory store (repos, refs, objects, issues, pulls, comments)
- `src/util.ts` — auth, request ids, global ids, JSON helpers

Determinism: no wall clock or randomness in any response — a logical clock
(starting 2025-01-01T00:00:00Z, +1 s per mutation) and counter request ids,
so a trial replays byte for byte.

---

<sub>Entered on [make.fun](https://make.fun/bounty/github-core-clone-01) — a GitHub-compatible git forge.</sub>
