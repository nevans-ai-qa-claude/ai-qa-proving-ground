import { test, expect, targets } from '../fixtures';

test.describe('orders', () => {
  test('places an order and empties the cart', async ({ authedRequest }) => {
    await authedRequest.post('/api/cart', { data: { productId: 'p-001', quantity: 1 } });

    const response = await authedRequest.post('/api/orders', { data: {} });
    expect(response.status()).toBe(201);

    const order = await response.json();
    expect(order.confirmationNumber).toMatch(/^CN-\d{6}$/);
    expect(order.total).toBe(20);

    const cart = await (await authedRequest.get('/api/cart')).json();
    expect(cart.lines).toHaveLength(0);
  });

  test(
    'applies a percentage discount exactly once',
    { annotation: targets('D008') },
    async ({ authedRequest }) => {
      await authedRequest.post('/api/cart', { data: { productId: 'p-001', quantity: 1 } });

      const response = await authedRequest.post('/api/orders', {
        data: { discountCode: 'SAVE10' },
      });
      const order = await response.json();

      // 20.00 less 10% is 18.00. Under D008 it is 16.20 — a 19% reduction, because the
      // rate is applied in both reducers. Nothing throws; the number is simply wrong,
      // which is why this class of defect survives longest in production.
      expect(order.total).toBe(18);
      expect(order.discount).toBe(2);
    }
  );

  test(
    'decrements stock when an order is placed',
    { annotation: targets('D012') },
    async ({ authedRequest }) => {
      const before = await (await authedRequest.get('/api/products/p-002')).json();

      await authedRequest.post('/api/cart', { data: { productId: 'p-002', quantity: 2 } });
      await authedRequest.post('/api/orders', { data: {} });

      const after = await (await authedRequest.get('/api/products/p-002')).json();

      // The oversell guard. Under D012 stock never moves, which only becomes visible once
      // orders accumulate — so the symptom looks order-dependent and is easily mistaken
      // for the D052 test bug. Distinguishing the two is the sharpest discrimination task
      // in the corpus.
      expect(after.stock).toBe(before.stock - 2);
    }
  );

  test('refuses to place an order with an empty cart', async ({ authedRequest }) => {
    const response = await authedRequest.post('/api/orders', { data: {} });
    expect(response.status()).toBe(400);
  });
});
