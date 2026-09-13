import Steel from 'steel-sdk';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';

interface SteelSession {
  sessionId: string;
  browser: Browser;
  context: BrowserContext;
  slots: PageSlot[];
}

interface PageSlot {
  page: Page;
  busy: boolean;
  session: SteelSession;
}

// Steel bills per session-minute, not per page — so the cheap way to get concurrency is
// several browser tabs (pages) inside a FEW sessions, not one session per concurrent task.
// Default: 1 session x 6 tabs = 6-way concurrency for the price of one session.
const SESSION_COUNT = Number(process.env.STEEL_SESSION_COUNT ?? 1);
const PAGES_PER_SESSION = Number(process.env.STEEL_PAGES_PER_SESSION ?? 6);

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
  const entry: SteelSession = { sessionId: session.id, browser, context, slots: [] };
  entry.slots.push({ page: firstPage, busy: false, session: entry });
  return entry;
}

async function addSlot(session: SteelSession): Promise<PageSlot> {
  const page = await session.context.newPage();
  const slot: PageSlot = { page, busy: false, session };
  session.slots.push(slot);
  return slot;
}

async function acquire(): Promise<PageSlot> {
  for (const session of sessions) {
    const free = session.slots.find((s) => !s.busy);
    if (free) {
      free.busy = true;
      return free;
    }
  }
  for (const session of sessions) {
    if (session.slots.length < PAGES_PER_SESSION) {
      const slot = await addSlot(session);
      slot.busy = true;
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
  return new Promise((resolve) => {
    waiters.push((slot) => {
      slot.busy = true;
      resolve(slot);
    });
  });
}

function release(slot: PageSlot): void {
  const waiter = waiters.shift();
  if (waiter) {
    waiter(slot); // hand off directly, skip the busy=false/true round trip
  } else {
    slot.busy = false;
  }
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

/**
 * Runs fn against a pooled, already-connected Steel/Playwright page (a tab within one of a
 * small number of persistent sessions) instead of spinning up a fresh Steel session per call.
 * Steel bills per session-minute regardless of how many tabs are open in it, so this gets
 * concurrency essentially for free — SESSION_COUNT x PAGES_PER_SESSION concurrent lookups for
 * the price of SESSION_COUNT sessions. Concurrent callers beyond that simply queue.
 */
export async function withPooledPage<T>(fn: (page: Page) => Promise<T>): Promise<T> {
  const slot = await acquire();
  let result: T;
  try {
    result = await fn(slot.page);
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
  const client = new Steel({ steelAPIKey: process.env.STEEL_API_KEY });
  const closing = sessions.splice(0, sessions.length);
  await Promise.all(
    closing.map(async (s) => {
      await s.browser.close().catch(() => {});
      await client.sessions.release(s.sessionId).catch(() => {});
    })
  );
}
