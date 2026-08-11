import express, { type Request, type Response, type NextFunction } from 'express';
import path from 'node:path';
import { router } from './routes';
import { defectOn, flakeFires } from './faults';

export function createApp() {
  const app = express();
  app.use(express.json());

  /**
   * Infrastructure fault layer.
   *
   * Deliberately mounted *before* the router so the failure happens at the transport
   * level, with no application code on the stack. That is what makes it look like an
   * environment fault to a downstream classifier: the stack trace has no product frames
   * in it at all, which is exactly the signal a human triager uses.
   *
   * The `_test` and `_meta` control surface is exempt. If fault injection could break the
   * reset hook, a run with D080 enabled would be unable to restore state between tests
   * and every subsequent failure would be a cascade artefact rather than a real
   * observation — which would silently corrupt the labelled corpus.
   */
  app.use('/api', (req: Request, res: Response, next: NextFunction) => {
    const isControlSurface = req.path.startsWith('/_test') || req.path.startsWith('/_meta');
    if (isControlSurface) return next();

    // D080 — deterministic environment fault. Every request fails while enabled.
    if (defectOn('D080')) {
      res.setHeader('retry-after', '5');
      return res.status(503).json({ error: 'Service Unavailable', source: 'upstream' });
    }

    // F004 — the probabilistic cousin of D080. Classified as environment rather than
    // flake: nondeterminism is a property of the symptom, but classification depends on
    // where the fault actually lives, and this one lives in the infrastructure.
    if (flakeFires('F004')) {
      res.setHeader('retry-after', '1');
      return res.status(503).json({ error: 'Service Unavailable', source: 'upstream' });
    }

    return next();
  });

  app.use('/api', router);

  app.use(express.static(path.join(__dirname, 'public')));

  // Terminal error handler. Returns JSON rather than Express's default HTML page, so a
  // failing API test captures a parseable body instead of a stack-trace document.
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    console.error('[unhandled]', err);
    res.status(500).json({ error: 'Internal Server Error', message: err.message });
  });

  return app;
}
