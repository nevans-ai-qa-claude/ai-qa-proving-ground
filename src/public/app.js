/*
 * Proving Ground storefront.
 *
 * Deliberately plain: no framework, no build step, hand-authored DOM. That is a design
 * decision rather than laziness. The self-healing-locator project needs a DOM whose
 * structure you control precisely, so that a brittle selector and its known-good
 * replacement both exist and heal accuracy can be measured rather than eyeballed. A
 * framework's generated markup would make that far harder to reason about.
 *
 * UI defects are gated on flags fetched from the server on boot, so the browser and the
 * API always agree about what is enabled.
 */

const app = {
  token: null,
  email: null,
  cart: { lines: [], itemCount: 0, subtotal: 0 },
  faults: { defects: [], f002Fires: false, f002DismissMs: 1200 },
  badgeInitialised: false,
};

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));
const byTestId = (id) => document.querySelector(`[data-testid="${id}"]`);

const defectOn = (id) => app.faults.defects.includes(id);

/* -------------------------------------------------------------------------- */
/* Formatting                                                                  */
/* -------------------------------------------------------------------------- */

function money(value) {
  const n = Number(value) || 0;

  // D003 — product bug. String coercion drops the cents on whole numbers, so a product
  // priced at 20 renders as "$20" rather than "$20.00". Cosmetic, deterministic, low
  // severity: a useful control for checking that a triage system ranks by impact and not
  // by how loud the failure is.
  if (defectOn('D003')) return `$${n}`;

  // Locale-aware currency formatting. Correct product behaviour — a store shipping in a
  // second locale formats its prices for that locale. Under LOCALE=de-DE this renders
  // "20,00 €" rather than "$20.00", which is exactly what fires D053: a spec that
  // hard-codes the dollar string instead of asserting on the value behind it.
  const locale = app.faults.locale || 'en-US';
  const currency = app.faults.currency || 'USD';
  if (locale !== 'en-US') {
    return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(n);
  }

  return `$${n.toFixed(2)}`;
}

/* -------------------------------------------------------------------------- */
/* Transport                                                                   */
/* -------------------------------------------------------------------------- */

async function api(pathname, options = {}) {
  const headers = { 'content-type': 'application/json', ...(options.headers || {}) };
  if (app.token) headers.authorization = `Bearer ${app.token}`;

  const response = await fetch(`/api${pathname}`, { ...options, headers });
  const isJson = (response.headers.get('content-type') || '').includes('application/json');
  const body = isJson ? await response.json() : null;

  if (!response.ok) {
    const error = new Error((body && body.error) || `HTTP ${response.status}`);
    error.status = response.status;
    error.body = body;
    throw error;
  }
  return body;
}

/* -------------------------------------------------------------------------- */
/* Views                                                                       */
/* -------------------------------------------------------------------------- */

function showView(name) {
  $$('.view').forEach((section) => {
    section.hidden = section.id !== `view-${name}`;
  });
}

function renderAuthState() {
  const who = byTestId('current-user');
  const logout = byTestId('logout');
  if (app.token) {
    who.textContent = app.email;
    who.hidden = false;
    logout.hidden = false;
  } else {
    who.hidden = true;
    logout.hidden = true;
  }
}

/* ------------------------------------------------------------------ catalog */

async function renderCatalog(searchTerm = '') {
  const query = searchTerm ? `?search=${encodeURIComponent(searchTerm)}` : '';
  const { products } = await api(`/products${query}`);

  const grid = $('#catalog-grid');
  grid.innerHTML = '';

  for (const product of products) {
    const card = document.createElement('article');
    card.className = 'product-card';
    card.dataset.testid = 'product-card';
    card.dataset.productId = product.id;
    card.innerHTML = `
      <h3 class="product-name" data-testid="product-name">${escapeHtml(product.name)}</h3>
      <p class="product-desc">${escapeHtml(product.description)}</p>
      <p class="product-price" data-testid="product-price">${money(product.price)}</p>
      <p class="product-stock" data-testid="product-stock">${product.stock} in stock</p>
      <button type="button" data-testid="add-to-cart" data-product-id="${product.id}">Add to cart</button>
    `;
    grid.appendChild(card);
  }

  byTestId('catalog-status').textContent = searchTerm
    ? `${products.length} result${products.length === 1 ? '' : 's'} for “${searchTerm}”`
    : `${products.length} products`;

  await renderRecentlyViewed();
}

async function renderRecentlyViewed() {
  const { products } = await api('/recently-viewed');
  const list = byTestId('recently-viewed');
  list.innerHTML = '';
  for (const product of products) {
    const item = document.createElement('li');
    item.dataset.testid = 'recent-item';
    item.dataset.productId = product.id;
    item.textContent = product.name;
    list.appendChild(item);
  }
}

/* --------------------------------------------------------------------- cart */

function renderCartBadge() {
  const badge = byTestId('cart-badge');

  // D001 — product bug. The badge is bound to cart *creation* rather than cart mutation,
  // so it paints once and then never again. The first add looks correct, which is what
  // makes it survive manual testing.
  if (defectOn('D001') && app.badgeInitialised) return;

  badge.textContent = String(app.cart.itemCount);

  // Mark initialised only once a real item has been painted. Marking it on the initial
  // empty render at login would freeze the badge at zero and break it for the *first*
  // add too — a much louder bug than D001 is meant to be, and one that would show up
  // instantly in manual testing. The whole point of D001 is that the first add looks
  // right, which is why it survives.
  if (app.cart.itemCount > 0) app.badgeInitialised = true;
}

function renderCart() {
  const body = byTestId('cart-lines');
  body.innerHTML = '';

  for (const line of app.cart.lines) {
    const row = document.createElement('tr');
    row.dataset.testid = 'cart-line';
    row.dataset.lineId = line.id;
    row.innerHTML = `
      <td data-testid="cart-line-name">${escapeHtml(line.product ? line.product.name : 'Unknown')}</td>
      <td data-testid="cart-line-qty">${line.quantity}</td>
      <td class="num" data-testid="cart-line-total">${money(line.lineTotal)}</td>
      <td><button type="button" data-testid="remove-line" data-line-id="${line.id}">Remove</button></td>
    `;
    body.appendChild(row);
  }

  byTestId('cart-empty').hidden = app.cart.lines.length > 0;
  byTestId('cart-subtotal').textContent = money(app.cart.subtotal);

  const checkoutButton = byTestId('proceed-to-checkout');

  // D005 — product bug. The guard checks that a cart object exists rather than that it
  // has any contents, so checkout stays available with zero items.
  checkoutButton.disabled = defectOn('D005') ? false : app.cart.lines.length === 0;

  renderCartBadge();
}

async function refreshCart() {
  app.cart = await api('/cart');
  renderCart();
}

/* ----------------------------------------------------------------- checkout */

function renderCheckout() {
  byTestId('checkout-total').textContent = money(app.cart.subtotal);
  byTestId('checkout-error').hidden = true;
}

/* -------------------------------------------------------------------------- */
/* Events                                                                      */
/* -------------------------------------------------------------------------- */

byTestId('login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const error = byTestId('login-error');
  error.hidden = true;

  try {
    const result = await api('/auth/login', {
      method: 'POST',
      body: JSON.stringify({
        email: byTestId('login-email').value,
        password: byTestId('login-password').value,
      }),
    });
    app.token = result.token;
    app.email = result.email;
    renderAuthState();
    await refreshCart();
    await renderCatalog();
    showView('catalog');
  } catch (err) {
    error.textContent = err.message;
    error.hidden = false;
  }
});

byTestId('logout').addEventListener('click', () => {
  app.token = null;
  app.email = null;
  app.badgeInitialised = false;
  renderAuthState();
  showView('login');
});

byTestId('search-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const term = event.target.querySelector('[data-testid="search-input"]').value.trim();
  await renderCatalog(term);
  showView('catalog');
});

document.addEventListener('click', async (event) => {
  const target = event.target;

  if (target.matches('[data-testid="add-to-cart"]')) {
    await api('/products/' + target.dataset.productId + '/view', { method: 'POST' });
    app.cart = await api('/cart', {
      method: 'POST',
      body: JSON.stringify({ productId: target.dataset.productId, quantity: 1 }),
    });
    renderCart();
    await renderRecentlyViewed();
    return;
  }

  if (target.matches('[data-testid="remove-line"]')) {
    app.cart = await api('/cart/' + target.dataset.lineId, { method: 'DELETE' });
    renderCart();
    return;
  }

  if (target.matches('[data-view]')) {
    event.preventDefault();
    const view = target.dataset.view;
    if (view === 'cart') await refreshCart();
    if (view === 'catalog') await renderCatalog();
    showView(view);
    return;
  }

  if (target.matches('[data-testid="proceed-to-checkout"]')) {
    renderCheckout();
    showView('checkout');
    return;
  }

  if (target.matches('[data-testid="back-to-catalog"]')) {
    await renderCatalog();
    showView('catalog');
    return;
  }

  if (target.matches('[data-testid="promo-close"]')) {
    byTestId('promo-banner').hidden = true;
  }
});

byTestId('checkout-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = byTestId('place-order');
  const error = byTestId('checkout-error');
  error.hidden = true;

  // D002 — product bug, and the most instructive entry in the manifest. With no in-flight
  // guard, a second click during submission places a second order. On a fast machine the
  // second click often loses the race and the test passes, so the defect presents as a
  // flake while being a genuine duplicate-order bug. Any triage system that treats
  // intermittency as sufficient evidence of flakiness will misclassify this — which is
  // exactly the mistake human triagers make too.
  if (!defectOn('D002')) {
    if (button.disabled) return;
    button.disabled = true;
  }

  try {
    const order = await api('/orders', {
      method: 'POST',
      body: JSON.stringify({ discountCode: byTestId('discount-code').value.trim() || undefined }),
    });
    byTestId('confirmation-number').textContent = order.confirmationNumber;
    byTestId('confirmation-total').textContent = money(order.total);
    await refreshCart();
    showView('confirmation');
  } catch (err) {
    error.textContent = err.message;
    error.hidden = false;
  } finally {
    if (!defectOn('D002')) button.disabled = false;
  }
});

/* -------------------------------------------------------------------------- */
/* Boot                                                                        */
/* -------------------------------------------------------------------------- */

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (ch) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]
  );
}

async function boot() {
  try {
    app.faults = await api('/_meta/ui-faults');
  } catch {
    // If the meta endpoint is unreachable the app still runs, just with no injected UI
    // defects. Failing soft here matters: D080 makes every non-control request 503, and a
    // hard failure would blank the page and mask the actual environment fault behind a
    // generic render error.
  }

  // F002 — the promotional banner overlays the header for a randomised interval before
  // dismissing itself, intercepting clicks on the cart link beneath it.
  if (app.faults.f002Fires) {
    const banner = byTestId('promo-banner');
    banner.hidden = false;
    banner.classList.add('intercepting');
    setTimeout(() => {
      banner.hidden = true;
      banner.classList.remove('intercepting');
    }, app.faults.f002DismissMs);
  }

  renderAuthState();
  showView('login');
}

boot();
