import { test, after } from 'node:test';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../../src/data/db.js';
import { createRepositories } from '../../src/data/repositories.js';
import { buildApp } from '../../src/api/routes.js';

const dir = mkdtempSync(join(tmpdir(), 'health-'));
const db = openDatabase(join(dir, 'app.db'));
const app = buildApp({ db, repositories: createRepositories(db) });
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const port = server.address().port;
after(() => server.close());

const url = (path) => `http://127.0.0.1:${port}${path}`;

test('GET /health returns 200 with status ok', async () => {
  const response = await fetch(url('/health'));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.status, 'ok');
  assert.equal(typeof body.version, 'string');
});

test('unknown API path returns the {code,message} envelope, never a stack trace', async () => {
  const response = await fetch(url('/v1/does-not-exist'));
  assert.equal(response.status, 404);
  const body = await response.json();
  assert.equal(typeof body.code, 'string');
  assert.equal(typeof body.message, 'string');
  assert.ok(!('stack' in body));
  assert.ok(!JSON.stringify(body).includes('at '), 'error body must not carry a stack');
});

test('the 404 envelope names the full path the client called, including the /v1 prefix', async () => {
  // POST /v1/events is a real route since #17; the /v1/events GET is not.
  const response = await fetch(url('/v1/events'));
  assert.equal(response.status, 404);
  const body = await response.json();
  assert.equal(body.code, 'NOT_FOUND');
  assert.ok(body.message.includes('/v1/events'), `message must carry the client path, got: ${body.message}`);

  const getResponse = await fetch(url('/v1/foo'));
  assert.equal(getResponse.status, 404);
  const getBody = await getResponse.json();
  assert.ok(getBody.message.includes('/v1/foo'), `message must carry the client path, got: ${getBody.message}`);
  assert.ok(!('stack' in getBody));
  assert.ok(!JSON.stringify(getBody).includes('at '), 'error body must not carry a stack');

  const postResponse = await fetch(url('/v1/foo'), { method: 'POST' });
  assert.equal(postResponse.status, 404, 'unknown POST paths still 404 with the envelope');
  assert.ok((await postResponse.json()).message.includes('/v1/foo'));
});

test('the five pages are served as HTML', async () => {
  for (const path of ['/', '/journal', '/opportunities', '/experiments', '/approvals']) {
    const response = await fetch(url(path));
    assert.equal(response.status, 200, `${path} must render`);
    assert.match(response.headers.get('content-type') ?? '', /text\/html/);
    assert.match(await response.text(), /<html/);
  }
});
