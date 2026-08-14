import { test, expect, targets } from '../fixtures';

test.describe('cart', () => {
  test(
    'shows a running item count in the header badge',
    { annotation: targets('D001') },
    async ({ authedPage }) => {
      await authedPage.locator('[data-product-id="p-001"] [data-testid="add-to-cart"]').click();
      await expect(authedPage.getByTestId('cart-badge')).toHaveText('1');

      // The second add is where D001 shows itself. The first one repaints correctly,
      // which is exactly why this defect survives manual testing.
      await authedPage.locator('[data-product-id="p-002"] [data-testid="add-to-cart"]').click();
      await expect(authedPage.getByTestId('cart-badge')).toHaveText('2');
    }
  );

  test(
    'disables checkout while the cart is empty',
    { annotation: targets('D005') },
    async ({ authedPage }) => {
      await authedPage.getByTestId('nav-cart').click();

      await expect(authedPage.getByTestId('cart-empty')).toBeVisible();
      await expect(authedPage.getByTestId('proceed-to-checkout')).toBeDisabled();
    }
  );

  test(
    'shows the cart subtotal in the header',
    { annotation: targets('D053') },
    async ({ authedPage }) => {
      await authedPage.locator('[data-product-id="p-001"] [data-testid="add-to-cart"]').click();
      await authedPage.getByTestId('nav-cart').click();

      // D053 — TEST BUG. Asserts on the rendered presentation string rather than the
      // value behind it. Correct today, wrong the moment the storefront ships in a second
      // locale where the same amount renders as "20,00 €".
      //
      // The locale rollout is correct product work, which is what makes this the test's
      // fault. A locale-agnostic version would assert on a numeric data attribute, or via
      // the API.
      await expect(authedPage.getByTestId('cart-subtotal')).toHaveText('$20.00');
    }
  );

  // Annotated for D003 as well as its own purpose. Its subtotal assertions are
  // cent-sensitive, so it genuinely detects the price-formatting defect as collateral.
  // Declaring that is more accurate than leaving the failure unlabelled — real suites
  // catch defects incidentally all the time, and the ground truth should say so.
  test(
    'removes a line and updates the subtotal',
    { annotation: targets('D003') },
    async ({ authedPage }) => {
      await authedPage.locator('[data-product-id="p-001"] [data-testid="add-to-cart"]').click();
      await authedPage.getByTestId('nav-cart').click();

      await expect(authedPage.getByTestId('cart-subtotal')).toHaveText('$20.00');

      await authedPage.getByTestId('remove-line').click();
      await expect(authedPage.getByTestId('cart-line')).toHaveCount(0);
      await expect(authedPage.getByTestId('cart-subtotal')).toHaveText('$0.00');
    }
  );
});
