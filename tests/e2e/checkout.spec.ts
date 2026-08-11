import { test, expect, targets, CREDENTIALS } from '../fixtures';

test.describe('checkout', () => {
  test(
    'shows an order confirmation number',
    { annotation: targets('D050') },
    async ({ authedPage }) => {
      await authedPage.locator('[data-product-id="p-001"] [data-testid="add-to-cart"]').click();
      await authedPage.getByTestId('nav-cart').click();
      await authedPage.getByTestId('proceed-to-checkout').click();
      await authedPage.getByTestId('place-order').click();

      // D050 — TEST BUG. A fixed sleep instead of waiting on the condition that actually
      // matters. It passes on an idle machine and times out intermittently under load, so
      // it presents as a flake while being entirely the test's fault. The product here is
      // correct; a triage system that files a product ticket for this is generating
      // exactly the false positive that destroys trust in automated triage.
      //
      // The correct form is the assertion below on its own, with no sleep at all —
      // Playwright's expect already retries.
      await authedPage.waitForTimeout(300);

      await expect(authedPage.getByTestId('confirmation-number')).toHaveText(/^CN-\d{6}$/);
    }
  );

  test(
    'does not create a duplicate order on double submit',
    { annotation: targets('D002') },
    async ({ authedPage, request }) => {
      await authedPage.locator('[data-product-id="p-001"] [data-testid="add-to-cart"]').click();
      await authedPage.getByTestId('nav-cart').click();
      await authedPage.getByTestId('proceed-to-checkout').click();

      const button = authedPage.getByTestId('place-order');

      // Two clicks with no await between them. Under D002 there is no in-flight guard, so
      // the second lands during submission and creates a second order. On a fast machine
      // it sometimes loses the race and this test passes — which is what makes D002 the
      // most instructive entry in the manifest: a serious, genuine product bug that
      // presents as intermittency.
      await Promise.all([
        button.click({ force: true }),
        button.click({ force: true, noWaitAfter: true }),
      ]);

      await expect(authedPage.getByTestId('confirmation-number')).toBeVisible();

      const login = await request.post('/api/auth/login', { data: CREDENTIALS });
      const { token } = await login.json();
      const orders = await request.get('/api/orders', {
        headers: { authorization: `Bearer ${token}` },
      });

      expect((await orders.json()).orders).toHaveLength(1);
    }
  );

  // The UI-side detector for D008. The API spec asserts the same root cause from the
  // other side, so the two should collapse into one cluster downstream.
  test(
    'applies a discount code to the order total',
    { annotation: targets('D008') },
    async ({ authedPage }) => {
      await authedPage.locator('[data-product-id="p-001"] [data-testid="add-to-cart"]').click();
      await authedPage.getByTestId('nav-cart').click();
      await authedPage.getByTestId('proceed-to-checkout').click();

      await authedPage.getByTestId('discount-code').fill('SAVE10');
      await authedPage.getByTestId('place-order').click();

      await expect(authedPage.getByTestId('confirmation-total')).toHaveText('$18.00');
    }
  );
});
