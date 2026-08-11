import { test, expect, targets, CREDENTIALS } from '../fixtures';

test.describe('auth', () => {
  test('issues a token for valid credentials', async ({ request }) => {
    const response = await request.post('/api/auth/login', { data: CREDENTIALS });
    expect(response.status()).toBe(200);

    const body = await response.json();
    expect(body.token).toBeTruthy();
    expect(body.email).toBe(CREDENTIALS.email);
  });

  test('rejects invalid credentials with 401', async ({ request }) => {
    const response = await request.post('/api/auth/login', {
      data: { ...CREDENTIALS, password: 'wrong' },
    });
    expect(response.status()).toBe(401);
  });

  test(
    'rejects an expired token with 401',
    { annotation: targets('D010') },
    async ({ request }) => {
      // Hand-rolled token whose expiry is already in the past. Building it here rather
      // than waiting out a real TTL keeps the test fast and, more importantly,
      // deterministic — a sleep-based version of this test would itself be a flake.
      const expired = Buffer.from(
        JSON.stringify({ email: CREDENTIALS.email, exp: Date.now() - 60_000 })
      ).toString('base64url');

      const response = await request.get('/api/cart', {
        headers: { authorization: `Bearer ${expired}` },
      });

      expect(response.status()).toBe(401);
    }
  );

  test(
    'accepts a freshly issued token',
    { annotation: targets('D081') },
    async ({ request }) => {
      const login = await request.post('/api/auth/login', { data: CREDENTIALS });
      const { token } = await login.json();

      const response = await request.get('/api/cart', {
        headers: { authorization: `Bearer ${token}` },
      });

      // Under D081 the server clock is shifted forward, so a token is already expired at
      // the moment it is issued. Note the deliberate symmetry with the test above: same
      // endpoint, opposite expectation, and the correct classification differs — D010 is
      // a product bug, D081 is an environment fault.
      expect(response.status()).toBe(200);
    }
  );

  test('rejects a request with no token', async ({ request }) => {
    const response = await request.get('/api/cart');
    expect(response.status()).toBe(401);
  });
});
