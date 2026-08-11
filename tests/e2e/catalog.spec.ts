import { test, expect, targets } from '../fixtures';

test.describe('catalog', () => {
  test(
    'formats every price to two decimal places',
    { annotation: targets('D003') },
    async ({ authedPage }) => {
      const prices = await authedPage.getByTestId('product-price').allTextContents();

      expect(prices.length).toBeGreaterThan(0);
      for (const price of prices) {
        expect(price).toMatch(/^\$\d+\.\d{2}$/);
      }
    }
  );

  test(
    'finds a product by lowercase search term',
    { annotation: targets('D004') },
    async ({ authedPage }) => {
      await authedPage.getByTestId('search-input').fill('laptop');
      await authedPage.getByTestId('search-submit').click();

      // The UI half of D004. The API spec asserts the same root cause from the other
      // side; a clustering system that does not collapse these two into one cluster is
      // reporting two bugs where there is one.
      await expect(authedPage.getByTestId('product-card')).toHaveCount(1);
      await expect(authedPage.getByTestId('product-name')).toHaveText('Laptop Stand');
    }
  );

  test(
    'adds a specific product to the cart from the catalog grid',
    { annotation: targets('D051') },
    async ({ authedPage }) => {
      // D051 — TEST BUG, not a product bug.
      //
      // This addresses the product by grid position rather than by identity. It is
      // correct today and wrong the moment catalog ordering changes for any reason —
      // a new sort option, a promotion, a merchandising rule. Run with
      // CATALOG_ORDER=reverse (a legitimate product change, not an injected defect) and
      // it fails while every well-written spec still passes.
      //
      // The correct locator is [data-product-id="p-003"], which exists on the same
      // element. Both the brittle selector and its known-good replacement are therefore
      // present in the DOM, so the self-healing project can be scored on whether it finds
      // the right one rather than merely a working one.
      await authedPage.locator('.product-card:nth-child(3) [data-testid="add-to-cart"]').click();

      await authedPage.getByTestId('nav-cart').click();
      await expect(authedPage.getByTestId('cart-line-name')).toHaveText(
        'Noise Cancelling Headphones'
      );
    }
  );

  test(
    'views a product from the catalog',
    { tag: '@shared-state' },
    async ({ authedPage }) => {
      await authedPage
        .locator('[data-product-id="p-003"] [data-testid="add-to-cart"]')
        .click();

      await expect(authedPage.getByTestId('cart-badge')).toHaveText('1');
    }
  );

  test(
    'lists the most recently viewed product first',
    { annotation: targets('D052'), tag: '@shared-state' },
    async ({ authedPage }) => {
      // D052 — TEST BUG. This asserts on server state that a *sibling test* created, and
      // never establishes that state itself. It passes when the file runs in order and
      // fails under sharding or shuffling.
      //
      // Both this and D012 (a genuine product bug) present as order dependence. They are
      // the deliberate confusion pair in the manifest: how often a classifier swaps them
      // is far more informative than its overall accuracy.
      await expect(authedPage.getByTestId('recent-item').first()).toHaveText(
        'Noise Cancelling Headphones'
      );
    }
  );
});
