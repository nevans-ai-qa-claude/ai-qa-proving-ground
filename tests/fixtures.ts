/**
 * Shared fixtures.
 *
 * Two jobs: give every test a clean server state, and remove the login boilerplate so the
 * specs read as statements about behaviour rather than as sequences of HTTP calls.
 */

import fs from 'node:fs';

import { test as base, expect, type APIRequestContext, type Page } from '@playwright/test';

export const CREDENTIALS = { email: 'qa@example.com', password: 'correct-horse' };

type Fixtures = {
  /** Auto-applied. Restores seed data before every test in every project. */
  resetState: void;
  /** An API context with a valid bearer token already attached. */
  authedRequest: APIRequestContext;
  /** A page that has completed the login flow and is sitting on the catalog. */
  authedPage: Page;
  /** The raw token, for tests that need to manipulate or invalidate it. */
  token: string;
};

export const test = base.extend<Fixtures>({
  /**
   * Reset runs before every test, automatically.
   *
   * Declared `auto` rather than hung off the `page` fixture, because the API project
   * never instantiates a page — hanging it off `page` would leave every API test running
   * against whatever state the previous one left behind.
   *
   * This is safe only because the suite defaults to a single worker. The reset endpoint
   * is global, so under parallel workers it would wipe state out from under sibling
   * tests. See the workers note in playwright.config.ts.
   */
  resetState: [
    async ({ request }, use, testInfo) => {
      // Tests tagged @shared-state opt out, because they exist specifically to depend on
      // state a sibling test created. That is the D052 test bug, and it has to be able to
      // actually happen — an unconditional reset would make it fail every time, turning a
      // subtle order-dependence bug into an obvious one and destroying its value as a
      // discrimination target against D012.
      if (!testInfo.tags.includes('@shared-state')) {
        await request.post('/api/_test/reset');
      }
      await use();
    },
    { auto: true },
  ],

  /**
   * Captures the DOM whenever a browser test does not pass.
   *
   * The contract has declared `artifacts.dom` since 1.0.0 — "required input for locator
   * healing" — and no producer ever populated it. A healer cannot propose a replacement
   * selector without the markup the original one failed against, so the field being
   * declared and empty made the downstream project unbuildable without anyone noticing.
   *
   * Written to a file and attached by path rather than inline. Playwright keeps
   * body-attachments in the report only, with no `path`, and the reporter reads paths.
   *
   * Runs after `use()` so `testInfo.status` is final. Wrapped in try/catch because the
   * page may already be closed on a crash or timeout, and failing to capture evidence
   * must never turn a real failure into a fixture error.
   */
  token: async ({ request }, use) => {
    const response = await request.post('/api/auth/login', { data: CREDENTIALS });
    const body = await response.json();
    await use(body.token);
  },

  authedRequest: async ({ playwright, baseURL, token }, use) => {
    const context = await playwright.request.newContext({
      baseURL,
      extraHTTPHeaders: { authorization: `Bearer ${token}` },
    });
    await use(context);
    await context.dispose();
  },

  authedPage: async ({ page }, use, testInfo) => {
    await page.goto('/');
    await page.getByTestId('login-email').fill(CREDENTIALS.email);
    await page.getByTestId('login-password').fill(CREDENTIALS.password);
    await page.getByTestId('login-submit').click();
    await expect(page.getByTestId('view-catalog')).toBeVisible();

    await use(page);

    /**
     * Capture the DOM whenever a browser test does not pass.
     *
     * The contract has declared `artifacts.dom` since 1.0.0 — "required input for locator
     * healing" — and no producer ever populated it. A healer cannot propose a replacement
     * selector without the markup the original one failed against, so the field sat
     * declared and empty, quietly making the downstream project unbuildable.
     *
     * Hung off `authedPage` rather than made an auto fixture, because an auto fixture
     * depending on `page` would launch a browser for every API test too — instantiating a
     * dependency is what triggers it, and a guard inside the body comes too late.
     *
     * Written to a file and attached by path: Playwright keeps body-attachments in the
     * report with no `path`, and the reporter reads paths.
     *
     * Wrapped in try/catch because the page may already be gone after a crash or timeout.
     * Failing to capture evidence must never convert a real failure into a fixture error.
     */
    if (testInfo.status !== testInfo.expectedStatus) {
      try {
        const html = await page.content();
        const file = testInfo.outputPath('dom.html');
        fs.writeFileSync(file, html, 'utf8');
        await testInfo.attach('dom', { path: file, contentType: 'text/html' });
      } catch {
        // Page gone. Nothing to capture, and nothing worth failing over.
      }
    }
  },
});

export { expect };

/**
 * Declares which manifest entry a test is designed to catch.
 *
 * The reporter reads these annotations and joins them against the run's active injection
 * set to derive `groundTruth` for each result. Doing it this way rather than with a
 * hand-maintained mapping file means the labels cannot drift away from the tests: if you
 * move or rename a test, its label moves with it.
 */
export function targets(...defectIds: string[]) {
  return defectIds.map((id) => ({ type: 'defect', description: id }));
}
