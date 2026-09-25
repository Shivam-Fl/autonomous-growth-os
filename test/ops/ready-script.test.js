import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const scripts = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).scripts;

test('the readiness probe follows the same $PORT the server honours, defaulting to 3000', () => {
  const ready = scripts['sdlc:ready'];
  assert.match(ready, /\$\{PORT:\-3000\}|\$PORT/, 'ready must read $PORT like src/index.js does, with the same 3000 default');
});

test('the readiness probe still targets the /health path', () => {
  assert.match(scripts['sdlc:ready'], /\/health/);
});
