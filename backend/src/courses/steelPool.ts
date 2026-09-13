import Steel from 'steel-sdk';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';

interface SteelSession {
  sessionId: string;
  browser: Browser;
  context: BrowserContext;
  slots: PageSlot[];
  lastUsedAt: number;
  createdAt: number;
}

interface PageSlot {
  page: Page;
  busy: boolean;
  session: SteelSession;
  /** Caller-defined state that persists across reuses of this same tab (e.g. "have I already
   * navigated to ttb.utoronto.ca and picked a division on this tab?"), so a repeat lookup can
   * skip the full page-load/navigation cost instead of starting cold every time. */
  state: Record<string, unknown>;
}

// Steel bills per session-minute, not per page — so the cheap way to get concurrency is
// several browser tabs (pages) inside a FEW sessions, not one session per concurrent task.
// Steel usage isn't a cost concern here (unlike Claude API calls) — the constraint is real
// throughput, not billing — so these default higher than the bare minimum: 2 sessions x 8
// tabs = 16-way concurrency, spread across two actual Steel instances rather than piling all
// tab rendering onto a single one (which can itself become the bottleneck under load).
const SESSION_COUNT = Number(process.env.STEEL_SESSION_COUNT ?? 1);
const PAGES_PER_SESSION = Number(process.env.STEEL_PAGES_PER_SESSION ?? 10);

// Steel bills in whole-minute increments from session creation, so closing an idle session
// EARLY within an already-paid-for minute saves nothing (that minute is billed regardless) and
// actively risks costing MORE: if new work shows up moments later, it now needs a brand new
// session (a fresh minimum charge) instead of reusing the one already paid for. The economical
// move is the opposite — stay open through the whole paid minute in case something arrives,
// and only close, if still idle, in a short window just before the NEXT minute boundary would
// start a new charge. BOUNDARY_MS is the billing granularity; BUFFER_MS is how long before that
// boundary we act (with margin for the close call itself), not how soon after going idle.
const BOUNDARY_MS = Number(process.env.STEEL_BILLING_BOUNDARY_MS ?? 60_000);
const BUFFER_MS = Number(process.env.STEEL_CLOSE_BUFFER_MS ?? 7_000);

const sessions: SteelSession[] = [];
const waiters: ((slot: PageSlot) => void)[] = [];

async function createSession(): Promise<SteelSession> {
  const client = new Steel({ steelAPIKey: process.env.STEEL_API_KEY });
  const session = await client.sessions.create({ timeout: 15 * 60 * 1000 });
  const browser = await chromium.connectOverCDP(
    `wss://connect.steel.dev?apiKey=${process.env.STEEL_API_KEY}&sessionId=${session.id}`
  );
  const context = browser.contexts()[0]!;
  const firstPage = context.pages()[0] ?? (await context.newPage());
  const entry: SteelSession = { sessionId: session.id, browser, context, slots: [], lastUsedAt: Date.now(), createdAt: Date.now() };
  entry.slots.push({ page: firstPage, busy: false, session: entry, state: {} });
  return entry;
}

async function addSlot(session: SteelSession): Promise<PageSlot> {
  const page = await session.context.newPage();
  const slot: PageSlot = { page, busy: false, session, state: {} };
  session.slots.push(slot);
  return slot;
}

// Guards the check-then-create decisions below with a real mutex. Without it, several
// concurrent acquire() calls (e.g. from Promise.all over a semester's courses) would all see
// the same stale sessions.length/slots.length BEFORE any of their awaited createSession()/
// addSlot() calls resolve and push into the array — that race is exactly what let far more
// than SESSION_COUNT sessions get created in a single burst.
let lock: Promise<unknown> = Promise.resolve();
function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const result = lock.then(fn, fn);
  lock = result.then(
    () => undefined,
    () => undefined
  );
  return result;
}

async function acquire(): Promise<PageSlot> {
  // Only the bounded find-or-create decision runs under the lock; if nothing's available we
  // fall through to the waiter queue OUTSIDE the lock, so a caller waiting for a slot to free
  // up doesn't block every other acquire() behind it.
  const found = await withLock(async (): Promise<PageSlot | null> => {
    for (const session of sessions) {
      const free = session.slots.find((s) => !s.busy);
      if (free) {
        free.busy = true;
        session.lastUsedAt = Date.now();
        return free;
      }
    }
    for (const session of sessions) {
      if (session.slots.length < PAGES_PER_SESSION) {
        const slot = await addSlot(session);
        slot.busy = true;
        session.lastUsedAt = Date.now();
        return slot;
      }
    }
    if (sessions.length < SESSION_COUNT) {
      const session = await createSession();
      sessions.push(session);
      const slot = session.slots[0]!;
      slot.busy = true;
      return slot;
    }
    return null;
  });

  if (found) return found;

  return new Promise<PageSlot>((resolve) => {
    waiters.push((slot) => {
      slot.busy = true;
      resolve(slot);
    });
  });
}

function release(slot: PageSlot): void {
  slot.session.lastUsedAt = Date.now();
  const waiter = waiters.shift();
  if (waiter) {
    waiter(slot); // hand off directly, skip the busy=false/true round trip
  } else {
    slot.busy = false;
  }
}

async function closeSession(session: SteelSession): Promise<void> {
  const sIndex = sessions.indexOf(session);
  if (sIndex !== -1) sessions.splice(sIndex, 1);
  const client = new Steel({ steelAPIKey: process.env.STEEL_API_KEY });
  await session.browser.close().catch(() => {});
  await client.sessions.release(session.sessionId).catch(() => {});
}

async function dropDeadSlot(slot: PageSlot): Promise<void> {
  const session = slot.session;
  const index = session.slots.indexOf(slot);
  if (index !== -1) session.slots.splice(index, 1);
  await slot.page.close().catch(() => {});

  if (session.slots.length === 0) {
    // The whole session died, not just this tab — drop it entirely.
    const sIndex = sessions.indexOf(session);
    if (sIndex !== -1) sessions.splice(sIndex, 1);
    await session.browser.close().catch(() => {});
  }

  const waiter = waiters.shift();
  if (waiter) {
    acquire().then(waiter).catch(() => {});
  }
}

function msUntilNextBillingBoundary(session: SteelSession, now: number): number {
  const elapsed = now - session.createdAt;
  return BOUNDARY_MS - (elapsed % BOUNDARY_MS);
}

const idleCheckInterval = setInterval(() => {
  const now = Date.now();
  for (const session of [...sessions]) {
    const allIdle = session.slots.every((s) => !s.busy);
    if (allIdle && msUntilNextBillingBoundary(session, now) <= BUFFER_MS) {
      const idleSec = Math.round((now - session.lastUsedAt) / 1000);
      console.log(`Closing idle Steel session ${session.sessionId} just before its next billed minute (idle ${idleSec}s)`);
      closeSession(session).catch(() => {});
    }
  }
}, 2_000);
idleCheckInterval.unref(); // don't keep the process alive just for this timer

/**
 * Runs fn against a pooled, already-connected Steel/Playwright page (a tab within one of a
 * small number of persistent sessions) instead of spinning up a fresh Steel session per call.
 * Steel bills per session-minute regardless of how many tabs are open in it, so this gets
 * concurrency essentially for free — SESSION_COUNT x PAGES_PER_SESSION concurrent lookups for
 * the price of SESSION_COUNT sessions. Concurrent callers beyond that simply queue. An idle
 * session is closed automatically just before it would roll into its next billed minute
 * (rather than immediately on going idle, or left running until process shutdown) — the next
 * call just opens a fresh one.
 *
 * fn also receives a per-tab `state` object that survives across reuses of the SAME tab, so a
 * caller can skip redundant setup (e.g. re-navigating and re-selecting a dropdown) on repeat
 * calls that reuse this tab — see courses/ttb.ts.
 */
export async function withPooledPage<T>(fn: (page: Page, state: Record<string, unknown>) => Promise<T>): Promise<T> {
  const slot = await acquire();
  let result: T;
  try {
    result = await fn(slot.page, slot.state);
  } catch (err) {
    // Sessions have a max lifetime (15 min on this plan); a dead tab/session throws on use.
    // Drop it so the next acquire() opens a fresh one instead of reusing a corpse.
    const message = err instanceof Error ? err.message : String(err);
    if (/closed|disconnected|not found|timed? ?out/i.test(message)) {
      await dropDeadSlot(slot);
    } else {
      release(slot);
    }
    throw err;
  }
  release(slot);
  return result;
}

/** Closes every pooled session. Call this on process shutdown so paid Steel sessions don't leak. */
export async function closeSteelPool(): Promise<void> {
  clearInterval(idleCheckInterval);
  const closing = sessions.splice(0, sessions.length);
  const client = new Steel({ steelAPIKey: process.env.STEEL_API_KEY });
  await Promise.all(
    closing.map(async (s) => {
      await s.browser.close().catch(() => {});
      await client.sessions.release(s.sessionId).catch(() => {});
    })
  );
}
