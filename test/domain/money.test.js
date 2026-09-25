import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  fromMicros,
  toMicros,
  add,
  subtract,
  allocate,
  formatMoney,
} from '../../src/domain/money.js';

// 1 paise = 10^4 micros; 1 rupee = 10^6 micros.
const PAISE = 10_000;

test('integer construction and add/subtract stay exact in micros', () => {
  const a = fromMicros(1_250_000, 'INR');
  const b = fromMicros(75_000, 'INR');
  assert.equal(toMicros(a), 1_250_000);
  assert.equal(toMicros(add(a, b)), 1_325_000);
  assert.equal(toMicros(subtract(a, b)), 1_175_000);
  assert.equal(toMicros(subtract(b, a)), -1_175_000, 'negative results are valid money');
});

test('float, NaN and non-integer inputs throw INVALID_MONEY at the boundary', () => {
  for (const bad of [10.5, Number.NaN, Number.POSITIVE_INFINITY, '1000', null, {}]) {
    assert.throws(() => fromMicros(bad, 'INR'), (err) => err.code === 'INVALID_MONEY');
  }
  assert.throws(() => add(fromMicros(1, 'INR'), 5), (err) => err.code === 'INVALID_MONEY');
  const overflow = Number.MAX_SAFE_INTEGER;
  assert.throws(
    () => add(fromMicros(overflow, 'INR'), fromMicros(overflow, 'INR')),
    (err) => err.code === 'INVALID_MONEY',
  );
});

test('10000 paise across 3 members yields 3334/3333/3333 and sums to the input exactly', () => {
  const total = fromMicros(10_000 * PAISE, 'INR'); // 10000 paise
  const shares = allocate(total, 3);
  assert.deepEqual(
    shares.map((share) => toMicros(share) / PAISE),
    [3334, 3333, 3333],
  );
  const sum = shares.reduce((acc, share) => acc + toMicros(share), 0);
  assert.equal(sum, toMicros(total), 'allocated parts sum exactly to the input');
});

test('allocate handles remainder sizes larger than one part and rejects bad part counts', () => {
  const total = fromMicros(10, 'USD');
  const parts = allocate(total, 4);
  assert.deepEqual(parts.map((p) => toMicros(p)), [3, 3, 2, 2]);
  const sum = parts.reduce((acc, p) => acc + toMicros(p), 0);
  assert.equal(sum, 10);
  assert.throws(() => allocate(total, 0), (err) => err.code === 'INVALID_MONEY');
  assert.throws(() => allocate(total, 2.5), (err) => err.code === 'INVALID_MONEY');
});

test('unknown or malformed ISO currency codes are rejected', () => {
  for (const bad of ['us', 'EURO', 'usd', 'XYZ', 'XXX', '']) {
    assert.throws(() => fromMicros(100, bad), (err) => err.code === 'INVALID_CURRENCY');
  }
  assert.equal(fromMicros(100, 'INR').currency, 'INR');
  assert.equal(fromMicros(100, 'USD').currency, 'USD');
});

test('add and subtract reject cross-currency arithmetic', () => {
  const inr = fromMicros(100, 'INR');
  const usd = fromMicros(100, 'USD');
  for (const op of [() => add(inr, usd), () => subtract(inr, usd)]) {
    assert.throws(op, (err) => err.code === 'CURRENCY_MISMATCH');
  }
});

test('formatMoney renders integer micros into major units without float math on stored values', () => {
  assert.equal(formatMoney(fromMicros(1_234_500_000, 'INR')), '₹1,234.50');
  assert.equal(formatMoney(fromMicros(50_000, 'INR')), '₹0.05');
  assert.equal(formatMoney(fromMicros(-2_000_000, 'INR')), '-₹2.00');
});
