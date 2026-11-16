// Entry: the bridge between the trial env and the forge in app.ts.
// The env is the authority on when a trial ends; this process only
// exposes the forge on an ephemeral port, tells the env that port,
// and stays alive until the env says the trial is done.

import { createApp } from './app.ts';

const envBase = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
if (!envBase) {
  console.error('[entry] MAKEFUN_ENV_URL is not set, so there is no env to register with');
  process.exit(1);
}

// One request may take this long before it is abandoned and retried.
const TIMEOUT_MS = 30_000;
// Retries back off exponentially from here, up to this cap.
const FIRST_BACKOFF_MS = 250;
const MAX_BACKOFF_MS = 2_000;

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

function backoff(n: number): number {
  return Math.min(MAX_BACKOFF_MS, FIRST_BACKOFF_MS * 2 ** Math.min(n, 8));
}

// Tell the env which port the forge listens on. 200 means accepted;
// 409 means another entry registered first, which is fine — this
// process just waits like any other. 400/405 mean the request itself
// is wrong, so there is nothing to retry; anything else is retried,
// because the env may still be starting up.
async function register(port: number): Promise<void> {
  let n = 0;
  for (;;) {
    try {
      const res = await fetch(`${envBase}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (res.status === 200 || res.status === 409) return;
      if (res.status === 400 || res.status === 405) {
        throw new Error(`register rejected with HTTP ${res.status}: ${await res.text()}`);
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('register rejected with HTTP ')) throw err;
    }
    await wait(backoff(n++));
  }
}

// Keep asking the env whether the trial is over; return only on {"done": true}.
// A failed poll just means "not yet", so it is retried the same way.
async function waitDone(): Promise<void> {
  let n = 0;
  for (;;) {
    try {
      const res = await fetch(`${envBase}/done`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (res.ok) {
        const body = (await res.json()) as { done?: unknown };
        if (body.done === true) return;
      }
    } catch {
      // The env is not answering yet: keep polling.
    }
    await wait(backoff(n++));
  }
}

async function run(): Promise<void> {
  const server = createApp();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve());
  });
  const addr = server.address();
  if (addr === null || typeof addr === 'string') {
    throw new Error('the forge did not bind an ephemeral TCP port');
  }
  console.log(`[entry] forge listening on port ${addr.port}`);

  await register(addr.port);
  console.log('[entry] registered; waiting for the env to end the trial');

  await waitDone();
  server.close();
  console.log('[entry] trial done');
}

try {
  await run();
  process.exit(0);
} catch (err) {
  console.error(`[entry] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
