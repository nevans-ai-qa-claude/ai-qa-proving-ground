/**
 * In-memory data store.
 *
 * No database, on purpose. A proving ground whose setup instructions begin "install
 * Postgres" is a proving ground nobody clones. Everything here resets in microseconds,
 * which also means each test can start from a known state without fixture teardown cost.
 */

export type Product = {
  id: string;
  name: string;
  price: number;
  stock: number;
  category: string;
  description: string;
};

export type CartLine = {
  id: string;
  productId: string;
  quantity: number;
};

export type Order = {
  id: string;
  confirmationNumber: string;
  lines: CartLine[];
  subtotal: number;
  discount: number;
  total: number;
  placedAt: string;
};

export type Session = {
  token: string;
  email: string;
  issuedAt: number;
  expiresAt: number;
};

const SEED_PRODUCTS: Product[] = [
  {
    id: 'p-001',
    name: 'Laptop Stand',
    price: 20,
    stock: 12,
    category: 'accessories',
    description: 'Aluminium, adjustable, holds up to 16 inch machines.',
  },
  {
    id: 'p-002',
    name: 'Mechanical Keyboard',
    price: 89.99,
    stock: 5,
    category: 'peripherals',
    description: 'Tactile switches, hot-swappable, no backlight.',
  },
  {
    id: 'p-003',
    name: 'Noise Cancelling Headphones',
    price: 249.5,
    stock: 3,
    category: 'audio',
    description: 'Over-ear, thirty hour battery.',
  },
  {
    id: 'p-004',
    name: 'USB-C Hub',
    price: 45,
    stock: 20,
    category: 'accessories',
    description: 'Seven ports, 100W passthrough charging.',
  },
  {
    id: 'p-005',
    name: 'Monitor Light Bar',
    price: 62.75,
    stock: 8,
    category: 'accessories',
    description: 'Asymmetric optics, no screen glare.',
  },
  {
    id: 'p-006',
    // Deliberate D011 fixture: multi-byte characters positioned so that a naive
    // byte-based truncation at 64 bytes lands mid-grapheme and emits U+FFFD.
    name: 'Café Ergonomic Cushion — Premium Memory Foam — Extra Large — 特大サイズ',
    price: 34.25,
    stock: 15,
    category: 'accessories',
    description: 'Contoured support with a breathable cover.',
  },
];

type State = {
  products: Product[];
  carts: Map<string, CartLine[]>;
  orders: Order[];
  sessions: Map<string, Session>;
  /**
   * The F003 injection point. Process-global rather than per-session: when F003 is
   * enabled, every session reads and writes this one list, so under parallel workers
   * tests observe each other's history.
   */
  recentlyViewed: string[];
  /** The correct, per-user version, keyed by email. Used whenever F003 is not enabled. */
  recentlyViewedByUser: Map<string, string[]>;
  counter: number;
};

function freshState(): State {
  return {
    products: SEED_PRODUCTS.map((p) => ({ ...p })),
    carts: new Map(),
    orders: [],
    sessions: new Map(),
    recentlyViewed: [],
    recentlyViewedByUser: new Map(),
    counter: 0,
  };
}

export const state: State = freshState();

/** Restores seed data. Exposed over HTTP at POST /api/_test/reset for test isolation. */
export function reset(): void {
  const next = freshState();
  state.products = next.products;
  state.carts = next.carts;
  state.orders = next.orders;
  state.sessions = next.sessions;
  state.recentlyViewed = next.recentlyViewed;
  state.recentlyViewedByUser = next.recentlyViewedByUser;
  state.counter = next.counter;
}

/**
 * The recently-viewed list for a session.
 *
 * When F003 is enabled the caller passes the shared list instead, which is the whole
 * point: same read and write path, different backing store, so the fault is a single
 * substitution rather than a divergent code path.
 */
export function recentFor(email: string): string[] {
  let list = state.recentlyViewedByUser.get(email);
  if (!list) {
    list = [];
    state.recentlyViewedByUser.set(email, list);
  }
  return list;
}

export function nextId(prefix: string): string {
  state.counter += 1;
  return `${prefix}-${String(state.counter).padStart(4, '0')}`;
}

export function cartFor(sessionToken: string): CartLine[] {
  let cart = state.carts.get(sessionToken);
  if (!cart) {
    cart = [];
    state.carts.set(sessionToken, cart);
  }
  return cart;
}

export const DISCOUNT_CODES: Record<string, number> = {
  SAVE10: 0.1,
  SAVE25: 0.25,
};
