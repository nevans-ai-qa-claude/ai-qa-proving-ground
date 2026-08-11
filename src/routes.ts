/**
 * API routes.
 *
 * Every deliberate defect is annotated with its id from contracts/defects.json and gated
 * behind `defectOn()`. The annotations are load-bearing documentation: a reviewer should
 * be able to grep `D0` and see the complete inventory of what is wrong with this service
 * and why, without reading the manifest first.
 */

import { Router, type Request, type Response, type NextFunction } from 'express';
import { defectOn, flakeFires, flakeEnabled, jitter, sleep, injectionState } from './faults';
import {
  state,
  reset,
  nextId,
  cartFor,
  recentFor,
  DISCOUNT_CODES,
  type Product,
  type CartLine,
} from './store';

export const router = Router();

/* ========================================================================== */
/* Auth                                                                        */
/* ========================================================================== */

const TOKEN_TTL_MS = 30 * 60 * 1000;

/** Milliseconds the server clock is shifted forward. D081 pushes it past the token TTL. */
function clockSkewMs(): number {
  return defectOn('D081') ? TOKEN_TTL_MS + 60_000 : 0;
}

function serverNow(): number {
  return Date.now() + clockSkewMs();
}

function encodeToken(email: string, expiresAt: number): string {
  return Buffer.from(JSON.stringify({ email, exp: expiresAt })).toString('base64url');
}

function decodeToken(token: string): { email: string; exp: number } | null {
  try {
    const parsed = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
    if (typeof parsed?.email !== 'string' || typeof parsed?.exp !== 'number') return null;
    return parsed;
  } catch {
    return null;
  }
}

router.post('/auth/login', (req: Request, res: Response) => {
  const { email, password } = req.body ?? {};

  if (typeof email !== 'string' || typeof password !== 'string') {
    return res.status(400).json({ error: 'email and password are required' });
  }
  if (password !== 'correct-horse') {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  // D081 — environment fault. The server's clock is shifted forward, so a token issued
  // right now is already past its expiry the moment it is handed to the client. Note the
  // application logic below is entirely correct; only the clock is wrong. That is what
  // makes this an environment fault rather than a product bug, and it is the distinction
  // a triage classifier has to make.
  const issuedAt = serverNow();
  const expiresAt = issuedAt + TOKEN_TTL_MS - clockSkewMs();

  const token = encodeToken(email, expiresAt);
  state.sessions.set(token, { token, email, issuedAt, expiresAt });

  return res.status(200).json({ token, email, expiresAt: new Date(expiresAt).toISOString() });
});

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.header('authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';

  if (!token) return res.status(401).json({ error: 'Missing bearer token' });

  const claims = decodeToken(token);
  if (!claims) return res.status(401).json({ error: 'Malformed token' });

  // D010 — product bug, security relevant. The expiry claim is parsed and attached to the
  // request, but never actually compared against the clock, so expired tokens authorise.
  // The absence of a check is a good test of whether an LLM-based reviewer can reason
  // about code that is missing rather than code that is wrong.
  if (!defectOn('D010')) {
    if (claims.exp <= serverNow()) {
      return res.status(401).json({ error: 'Token expired' });
    }
  }

  (req as Request & { session?: { email: string; token: string } }).session = {
    email: claims.email,
    token,
  };
  return next();
}

function sessionToken(req: Request): string {
  return (req as Request & { session?: { token: string } }).session?.token ?? 'anonymous';
}

/**
 * Recently-viewed history is scoped to the *user*, not to the session token.
 *
 * That is the correct product behaviour — signing in again should not wipe your browsing
 * history — and it is also what allows D052 to be a genuine order-dependence bug. Keyed by
 * token, every test would log in fresh and read an empty list, so the spec would fail
 * unconditionally: an obvious bug rather than the subtle one it is meant to be, and
 * useless as a discrimination target against D012.
 */
function sessionEmail(req: Request): string {
  return (req as Request & { session?: { email: string } }).session?.email ?? 'anonymous';
}

/* ========================================================================== */
/* Products                                                                    */
/* ========================================================================== */

/**
 * Intended as a *character* limit. D011 is what happens when it gets applied to bytes.
 *
 * The value is load-bearing: at 50, the byte-based cut lands inside the second em-dash of
 * the seeded p-006 name (a 3-byte sequence at byte offsets 48-50), producing U+FFFD. At 64
 * it happened to land exactly on a character boundary and the defect silently did nothing
 * — the test passed with the defect enabled, which is the worst possible outcome for an
 * answer key, since it looks like success.
 */
const NAME_LIMIT = 50;

function truncateName(name: string): string {
  if (name.length <= NAME_LIMIT) return name;

  // D011 — product bug. Byte-based truncation cuts a multi-byte character in half and
  // yields U+FFFD. It reads like a charset or transport problem, which is the wrong
  // classification: the transport is fine, the application's string handling is not.
  if (defectOn('D011')) {
    return Buffer.from(name, 'utf8').subarray(0, NAME_LIMIT).toString('utf8') + '…';
  }

  // Correct: operate on code points, not bytes.
  return Array.from(name).slice(0, NAME_LIMIT).join('') + '…';
}

function present(product: Product) {
  return { ...product, name: truncateName(product.name) };
}

router.get('/products', (req: Request, res: Response) => {
  const search = typeof req.query.search === 'string' ? req.query.search : '';
  const rawLimit = typeof req.query.limit === 'string' ? Number(req.query.limit) : undefined;

  /**
   * CATALOG_ORDER is NOT a defect. It is a legitimate product configuration — the sort of
   * "newest first" merchandising change that ships every week — and it is deliberately
   * not in defects.json.
   *
   * Its purpose is to demonstrate that the D051 brittle positional selector is invisible
   * until an unrelated, entirely correct change lands. Under CATALOG_ORDER=reverse every
   * well-written spec still passes and only the positionally-addressed one breaks, which
   * is the cleanest possible signal that the fault is in the test rather than the product.
   */
  let results =
    process.env.CATALOG_ORDER === 'reverse' ? [...state.products].reverse() : state.products;

  if (search) {
    // D004 — product bug. Case is normalised on neither side, so 'laptop' finds nothing
    // while 'Laptop' finds one. Detected by both an API spec and a UI spec: two distinct
    // test failures sharing a single root cause, which is the collapse behaviour the
    // downstream clustering project is measured on.
    results = defectOn('D004')
      ? results.filter((p) => p.name.includes(search) || p.category.includes(search))
      : results.filter(
          (p) =>
            p.name.toLowerCase().includes(search.toLowerCase()) ||
            p.category.toLowerCase().includes(search.toLowerCase())
        );
  }

  if (rawLimit !== undefined && Number.isFinite(rawLimit) && rawLimit >= 0) {
    // D007 — product bug. Inclusive slice boundary returns limit + 1 items.
    results = defectOn('D007') ? results.slice(0, rawLimit + 1) : results.slice(0, rawLimit);
  }

  return res.json({ products: results.map(present), total: results.length });
});

router.get('/products/:id', (req: Request, res: Response) => {
  const product = state.products.find((p) => p.id === req.params.id);
  if (!product) return res.status(404).json({ error: 'Product not found' });
  return res.json(present(product));
});

/**
 * F003 injection point.
 *
 * With the flake enabled every session shares one process-global history list, so under
 * parallel workers tests observe one another's writes. With it disabled each session gets
 * its own, which is the correct behaviour.
 *
 * Gated on enablement rather than on a per-request dice roll: the nondeterminism here
 * comes from worker contention, not from probability. Rolling per request could send a
 * write to the shared list and the matching read to the session list, producing an
 * incoherent failure that models nothing that happens in a real system.
 */
function viewHistory(email: string): string[] {
  return flakeEnabled('F003') ? state.recentlyViewed : recentFor(email);
}

router.post('/products/:id/view', requireAuth, (req: Request, res: Response) => {
  const product = state.products.find((p) => p.id === req.params.id);
  if (!product) return res.status(404).json({ error: 'Product not found' });

  const history = viewHistory(sessionEmail(req));
  const next = [product.id, ...history.filter((id) => id !== product.id)].slice(0, 10);

  // Mutate in place so both backing stores are updated through one path.
  history.length = 0;
  history.push(...next);

  return res.status(204).end();
});

router.get('/recently-viewed', requireAuth, (req: Request, res: Response) => {
  const products = viewHistory(sessionEmail(req))
    .map((id) => state.products.find((p) => p.id === id))
    .filter((p): p is Product => Boolean(p));
  return res.json({ products: products.map(present) });
});

/* ========================================================================== */
/* Cart                                                                        */
/* ========================================================================== */

function lineTotal(line: CartLine): number {
  const product = state.products.find((p) => p.id === line.productId);
  return product ? product.price * line.quantity : 0;
}

function cartPayload(token: string) {
  const lines = cartFor(token);
  const subtotal = lines.reduce((sum, line) => sum + lineTotal(line), 0);
  return {
    lines: lines.map((line) => ({
      ...line,
      product: state.products.find((p) => p.id === line.productId) ?? null,
      lineTotal: Number(lineTotal(line).toFixed(2)),
    })),
    itemCount: lines.reduce((sum, line) => sum + line.quantity, 0),
    subtotal: Number(subtotal.toFixed(2)),
  };
}

router.get('/cart', requireAuth, (req: Request, res: Response) => {
  return res.json(cartPayload(sessionToken(req)));
});

router.post('/cart', requireAuth, async (req: Request, res: Response) => {
  const { productId, quantity } = req.body ?? {};
  const product = state.products.find((p) => p.id === productId);

  if (!product) return res.status(404).json({ error: 'Product not found' });
  if (typeof quantity !== 'number' || !Number.isFinite(quantity)) {
    return res.status(400).json({ error: 'quantity must be a number' });
  }

  // D006 — product bug. Quantity is checked as a number but not as a positive integer,
  // so a negative quantity is accepted and drives the order total below zero. The failure
  // surfaces as a status-code mismatch rather than a thrown exception, so there is no
  // stack trace to lean on — the classifier has to reason about API semantics.
  if (!defectOn('D006')) {
    if (!Number.isInteger(quantity) || quantity < 1) {
      return res.status(400).json({ error: 'quantity must be a positive integer' });
    }
  }

  // F001 — race. The write lands immediately but the response is delayed, so a client
  // that reads the total straight afterwards can observe the previous value.
  if (flakeFires('F001')) {
    await sleep(jitter(0, 400));
  }

  const line: CartLine = { id: nextId('line'), productId: product.id, quantity };
  cartFor(sessionToken(req)).push(line);

  return res.status(201).json(cartPayload(sessionToken(req)));
});

router.delete('/cart/:lineId', requireAuth, (req: Request, res: Response) => {
  const token = sessionToken(req);
  const lines = cartFor(token);
  const index = lines.findIndex((line) => line.id === req.params.lineId);

  // D009 — product bug. The handler reports success unconditionally, so deleting a line
  // that does not exist returns 200 instead of 404.
  if (index === -1 && !defectOn('D009')) {
    return res.status(404).json({ error: 'Cart line not found' });
  }

  if (index !== -1) lines.splice(index, 1);
  return res.status(200).json(cartPayload(token));
});

/* ========================================================================== */
/* Orders                                                                      */
/* ========================================================================== */

router.post('/orders', requireAuth, async (req: Request, res: Response) => {
  const token = sessionToken(req);
  const lines = cartFor(token);
  const { discountCode } = req.body ?? {};

  if (lines.length === 0) {
    return res.status(400).json({ error: 'Cannot place an order with an empty cart' });
  }

  /**
   * Simulated payment-gateway latency. Not a defect — no real checkout returns in under a
   * millisecond, and an in-memory store that does makes the D002 double-submit race
   * essentially unobservable: the first request completes before a second click can land,
   * so the defect stays hidden and never enters the corpus.
   *
   * It remains a genuine race rather than a guarantee. The window is simply wide enough
   * that a guard-less submit button actually loses it, which is what happens in production.
   */
  await sleep(120);

  const rate = typeof discountCode === 'string' ? DISCOUNT_CODES[discountCode] ?? 0 : 0;

  const grossSubtotal = lines.reduce((sum, line) => sum + lineTotal(line), 0);

  // D008 — product bug, highest business severity in the manifest. The discount is
  // applied once in the line reducer and then a second time to the order total, so a 10%
  // code takes 19% off. Nothing throws; the number is simply wrong, which is the kind of
  // defect that survives longest in real systems.
  const lineSum = defectOn('D008')
    ? lines.reduce((sum, line) => sum + lineTotal(line) * (1 - rate), 0)
    : grossSubtotal;

  const total = lineSum * (1 - rate);
  const discount = grossSubtotal - total;

  // D012 — product bug. Stock is never decremented, permitting oversell. The symptom only
  // appears once enough orders have accumulated within a run, so it presents as order
  // dependence — indistinguishable at a glance from the D052 test bug. That pair is the
  // sharpest discrimination task in the whole corpus.
  if (!defectOn('D012')) {
    for (const line of lines) {
      const product = state.products.find((p) => p.id === line.productId);
      if (product) product.stock = Math.max(0, product.stock - line.quantity);
    }
  }

  const order = {
    id: nextId('order'),
    confirmationNumber: `CN-${String(state.orders.length + 1).padStart(6, '0')}`,
    lines: [...lines],
    subtotal: Number(grossSubtotal.toFixed(2)),
    discount: Number(discount.toFixed(2)),
    total: Number(total.toFixed(2)),
    placedAt: new Date().toISOString(),
  };

  state.orders.push(order);
  state.carts.set(token, []);

  return res.status(201).json(order);
});

router.get('/orders', requireAuth, (_req: Request, res: Response) => {
  return res.json({ orders: state.orders });
});

/* ========================================================================== */
/* Test control surface                                                        */
/* ========================================================================== */

/**
 * Reset hook. Kept under an obvious `_test` prefix so nobody mistakes it for product
 * surface area, and so a reviewer can see at a glance that it is deliberate.
 */
router.post('/_test/reset', (_req: Request, res: Response) => {
  reset();
  return res.status(204).end();
});

/**
 * The server's own view of what faults are enabled.
 *
 * The reporter reads this rather than reading its own process.env. The test runner and
 * the server are separate processes and can be configured differently — if the reporter
 * trusted its own environment it would happily label a corpus with faults the server
 * never had enabled, and the mislabelling would be invisible until scoring.
 */
router.get('/_meta/injection', (_req: Request, res: Response) => {
  return res.json(injectionState());
});

/**
 * UI fault flags, fetched by the frontend on boot.
 *
 * The F002 roll happens here rather than in the browser so that it goes through the
 * seeded PRNG. Rolling it client-side with Math.random would be simpler, but it would put
 * one fault outside the seed and quietly undermine the claim that runs are reproducible.
 */
router.get('/_meta/ui-faults', (_req: Request, res: Response) => {
  return res.json({
    defects: injectionState().defects,
    f002Fires: flakeFires('F002'),
    f002DismissMs: jitter(800, 1600),
  });
});
