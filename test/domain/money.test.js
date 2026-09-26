import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  fromMicros,
  toMicros,
  add,
  subtract,
  allocate,
  formatMoney,
  canonicalCurrency,
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

// canonicalCurrency is the read-time boundary for a STORED row: the stored
// side of every currency comparison in the app goes through it, because
// tenants.create takes any string and the QA repro sets the column with raw
// SQL. The constructor is deliberately NOT loosened by any of this — see the
// last test, which pins that.
test('canonicalCurrency resolves a canonical stored code to itself', () => {
  assert.equal(canonicalCurrency('USD'), 'USD');
  assert.equal(canonicalCurrency('INR'), 'INR');
  assert.equal(canonicalCurrency('EUR'), 'EUR');
});

test('canonicalCurrency resolves a mis-cased stored code to the currency it names', () => {
  // 'usd' and 'USD' are the same unit of account. Reading them as different
  // ones is what made a USD tenant's own spend look foreign.
  assert.equal(canonicalCurrency('usd'), 'USD');
  assert.equal(canonicalCurrency('Usd'), 'USD');
  assert.equal(canonicalCurrency('uSd'), 'USD');
  assert.equal(canonicalCurrency('inr'), 'INR');
});

test('canonicalCurrency resolves a padded stored code to the currency it names', () => {
  assert.equal(canonicalCurrency(' USD '), 'USD');
  assert.equal(canonicalCurrency('\nINR\t'), 'INR');
});

test('canonicalCurrency returns null for a stored code that names no ISO currency', () => {
  assert.equal(canonicalCurrency('ZZZ'), null, 'an unknown code stays bad data');
  // A non-national code stays an error even once normalised: ISO_CURRENCIES
  // deliberately omits the fund codes (XTS, XXX), and canonicalising must not
  // quietly promote one into a renderable currency.
  assert.equal(canonicalCurrency('Xts'), null);
  assert.equal(canonicalCurrency('XTS'), null);
});

test('canonicalCurrency returns null without throwing for a non-string or a blank code', () => {
  for (const blank of [undefined, null, 42, {}, [], '', '   ']) {
    assert.equal(canonicalCurrency(blank), null, `${JSON.stringify(blank) ?? String(blank)} must resolve to null, not throw`);
  }
});

test('canonicalCurrency is a read-time boundary, not a second constructor', () => {
  // The write path stays strict: fromMicros still refuses a code it cannot
  // render, so a money value can never be built around a mis-cased code. If
  // this ever stops throwing, canonicalCurrency has been allowed to leak into
  // the constructor and the INVALID_CURRENCY contract has moved.
  assert.throws(() => fromMicros(1, 'usd'), (err) => err.code === 'INVALID_CURRENCY');
  assert.throws(() => fromMicros(1, ' USD '), (err) => err.code === 'INVALID_CURRENCY');
  assert.throws(() => toMicros({ amountMicros: 1, currency: 'Usd' }), (err) => err.code === 'INVALID_CURRENCY');
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
