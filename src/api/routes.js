// HTTP surface: GET /health, the five server-rendered pages, static assets,
// and a {code,message} error envelope for every API path that has no handler.
// Failed handlers never leak a stack trace to the response.

import express from 'express';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { renderPage } from '../web/pages.js';
import { FakeMetaAdsProvider, FAILURE_MODES } from '../integrations/meta_ads/fake.js';

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// ?meta_error=quota|revoked drives the fake provider's failure injection for
// simulation; anything else is ignored, exactly like an unknown ?state=.
const META_ERROR_PARAMS = new Set([...FAILURE_MODES].filter((mode) => mode !== 'ok'));

function packageVersion() {
  return JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8')).version;
}

export function buildApp({ repositories }) {
  const app = express();
  app.disable('x-powered-by');

  app.get('/health', (request, response) => {
    response.status(200).json({ status: 'ok', version: packageVersion() });
  });

  app.get('/assets/styles.css', (request, response) => {
    response.type('text/css').sendFile(join(PACKAGE_ROOT, 'src', 'web', 'styles.css'));
  });
  app.get('/assets/client.js', (request, response) => {
    response.type('application/javascript').sendFile(join(PACKAGE_ROOT, 'src', 'web', 'client.js'));
  });

  for (const route of ['/', '/journal', '/opportunities', '/experiments', '/approvals']) {
    app.get(route, async (request, response) => {
      // A per-request provider: the fake holds no state across requests, so
      // one browser tab cannot see another's simulated failure.
      const metaError = META_ERROR_PARAMS.has(request.query.meta_error)
        ? request.query.meta_error
        : null;
      const metaProvider = new FakeMetaAdsProvider({ failureMode: metaError ?? 'ok' });
      response
        .type('html')
        .send(await renderPage(route, {
          repositories,
          override: request.query.state ?? null,
          metaProvider,
          metaError,
        }));
    });
  }

  // The versioned API: only /health exists in this slice; unknown /v1 paths
  // return the error envelope, never a stack trace. Express strips the mount
  // prefix from request.path, so the reported path is rebuilt from baseUrl.
  app.use('/v1', (request, response) => {
    response.status(404).json({ code: 'NOT_FOUND', message: `no API route for ${request.method} ${request.baseUrl}${request.path}` });
  });

  app.use((request, response) => {
    response.status(404).json({ code: 'NOT_FOUND', message: `no route for ${request.method} ${request.path}` });
  });

  // eslint-disable-next-line no-unused-vars
  app.use((error, request, response, next) => {
    console.error('unhandled request error:', error);
    response.status(500).json({ code: 'INTERNAL', message: 'internal error' });
  });

  return app;
}
