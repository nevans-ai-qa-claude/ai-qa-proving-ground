import { test, expect, targets } from '../fixtures';

test.describe('products', () => {
  test('lists the seeded catalog', async ({ request }) => {
    const response = await request.get('/api/products');
    expect(response.status()).toBe(200);

    const { products } = await response.json();
    expect(products.length).toBeGreaterThan(0);
  });

  test(
    'matches product names irrespective of case',
    { annotation: targets('D004') },
    async ({ request }) => {
      const upper = await request.get('/api/products?search=Laptop');
      const lower = await request.get('/api/products?search=laptop');

      const upperBody = await upper.json();
      const lowerBody = await lower.json();

      expect(upperBody.products.length).toBeGreaterThan(0);
      // The interesting assertion. Under D004 the two searches disagree, and the same
      // root cause also fails a UI spec in catalog.spec.ts — one defect, two failures,
      // which is the collapse behaviour the clustering project is scored on.
      expect(lowerBody.products.length).toBe(upperBody.products.length);
    }
  );

  test(
    'honours the limit parameter exactly',
    { annotation: targets('D007') },
    async ({ request }) => {
      const response = await request.get('/api/products?limit=3');
      const { products } = await response.json();

      expect(products).toHaveLength(3);
    }
  );

  test(
    'preserves multi-byte characters in long names',
    { annotation: targets('D011') },
    async ({ request }) => {
      const response = await request.get('/api/products/p-006');
      const product = await response.json();

      // U+FFFD is the replacement character. Its presence means a multi-byte sequence was
      // cut in half. The failure text will look like an encoding problem, which is the
      // wrong classification — the transport is fine, the truncation logic is not.
      expect(product.name).not.toContain('�');
    }
  );

  test('returns 404 for an unknown product', async ({ request }) => {
    const response = await request.get('/api/products/p-does-not-exist');
    expect(response.status()).toBe(404);
  });
});
