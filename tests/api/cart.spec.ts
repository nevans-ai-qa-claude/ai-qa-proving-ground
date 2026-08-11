import { test, expect, targets } from '../fixtures';

test.describe('cart', () => {
  test('adds an item and reports the subtotal', async ({ authedRequest }) => {
    const response = await authedRequest.post('/api/cart', {
      data: { productId: 'p-001', quantity: 2 },
    });
    expect(response.status()).toBe(201);

    const cart = await response.json();
    expect(cart.itemCount).toBe(2);
    expect(cart.subtotal).toBe(40);
  });

  test(
    'rejects a negative quantity with 400',
    { annotation: targets('D006') },
    async ({ authedRequest }) => {
      const response = await authedRequest.post('/api/cart', {
        data: { productId: 'p-001', quantity: -5 },
      });

      // A status-code mismatch rather than a thrown exception, so there is no stack trace
      // for a classifier to lean on. It has to reason about API semantics instead, which
      // is a meaningfully different capability.
      expect(response.status()).toBe(400);
    }
  );

  test(
    'returns 404 when removing an unknown line',
    { annotation: targets('D009') },
    async ({ authedRequest }) => {
      const response = await authedRequest.delete('/api/cart/line-does-not-exist');
      expect(response.status()).toBe(404);
    }
  );

  test('removes a line that exists', async ({ authedRequest }) => {
    const added = await authedRequest.post('/api/cart', {
      data: { productId: 'p-002', quantity: 1 },
    });
    const cart = await added.json();
    const lineId = cart.lines[0].id;

    const response = await authedRequest.delete(`/api/cart/${lineId}`);
    expect(response.status()).toBe(200);

    const after = await response.json();
    expect(after.lines).toHaveLength(0);
  });
});
