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
