// Money is integer micros of the currency's major unit (1 INR = 10^6 micros,
// 1 paise = 10^4 micros). Floats never enter storage, APIs or this module.
// Errors cross module boundaries as {code, message, details} per conventions.

/** Active ISO 4217 currency codes. Superseded and fund codes (XXX, XTS, ...)
 * are deliberately absent: an unknown or non-national code is a data error. */
export const ISO_CURRENCIES = [
  'AED', 'AFN', 'ALL', 'AMD', 'ANG', 'AOA', 'ARS', 'AUD', 'AWG', 'AZN',
  'BAM', 'BBD', 'BDT', 'BGN', 'BHD', 'BIF', 'BMD', 'BND', 'BOB', 'BRL',
  'BSD', 'BTN', 'BWP', 'BYN', 'BZD', 'CAD', 'CDF', 'CHF', 'CLP', 'CNY',
  'COP', 'CRC', 'CUP', 'CVE', 'CZK', 'DJF', 'DKK', 'DOP', 'DZD', 'EGP',
  'ERN', 'ETB', 'EUR', 'FJD', 'FKP', 'GBP', 'GEL', 'GHS', 'GIP', 'GMD',
  'GNF', 'GTQ', 'GYD', 'HKD', 'HNL', 'HRK', 'HTG', 'HUF', 'IDR', 'ILS',
  'INR', 'IQD', 'IRR', 'ISK', 'JMD', 'JOD', 'JPY', 'KES', 'KGS', 'KHR',
  'KMF', 'KPW', 'KRW', 'KWD', 'KYD', 'KZT', 'LAK', 'LBP', 'LKR', 'LRD',
  'LSL', 'LYD', 'MAD', 'MDL', 'MGA', 'MKD', 'MMK', 'MNT', 'MOP', 'MRU',
  'MUR', 'MVR', 'MWK', 'MXN', 'MYR', 'MZN', 'NAD', 'NGN', 'NIO', 'NOK',
  'NPR', 'NZD', 'OMR', 'PAB', 'PEN', 'PGK', 'PHP', 'PKR', 'PLN', 'PYG',
  'QAR', 'RON', 'RSD', 'RUB', 'RWF', 'SAR', 'SBD', 'SCR', 'SDG', 'SEK',
  'SGD', 'SHP', 'SLE', 'SOS', 'SRD', 'SSP', 'STN', 'SVC', 'SYP', 'SZL',
  'THB', 'TJS', 'TMT', 'TND', 'TOP', 'TRY', 'TTD', 'TWD', 'TZS', 'UAH',
  'UGX', 'USD', 'UYU', 'UZS', 'VES', 'VND', 'VUV', 'WST', 'XAF', 'XCD',
  'XOF', 'XPF', 'YER', 'ZAR', 'ZMW', 'ZWG',
];

export function moneyError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  return error;
}

function assertValidCurrency(currency) {
  if (typeof currency !== 'string' || !ISO_CURRENCIES.includes(currency)) {
    throw moneyError('INVALID_CURRENCY', `currency must be a known ISO 4217 code, got ${JSON.stringify(currency)}`);
  }
}

function assertValidMicros(amountMicros) {
  if (typeof amountMicros !== 'number' || !Number.isSafeInteger(amountMicros)) {
    throw moneyError(
      'INVALID_MONEY',
      `amount must be an integer number of micros, got ${JSON.stringify(amountMicros)}`,
      { received: typeof amountMicros === 'number' ? String(amountMicros) : typeof amountMicros },
    );
  }
}

/** Build a money value from integer micros. Never accepts floats. */
export function fromMicros(amountMicros, currency) {
  assertValidMicros(amountMicros);
  assertValidCurrency(currency);
  return Object.freeze({ amountMicros, currency });
}

/** Read the integer micros back out of a money value. */
export function toMicros(money) {
  if (!money || typeof money !== 'object') {
    throw moneyError('INVALID_MONEY', `not a money value: ${JSON.stringify(money)}`);
  }
  assertValidMicros(money.amountMicros);
  assertValidCurrency(money.currency);
  return money.amountMicros;
}

function assertSameCurrency(a, b) {
  if (a.currency !== b.currency) {
    throw moneyError('CURRENCY_MISMATCH', `cannot mix ${a.currency} and ${b.currency}`);
  }
}

/** Exact integer addition in micros. */
export function add(a, b) {
  toMicros(a);
  toMicros(b);
  assertSameCurrency(a, b);
  return fromMicros(a.amountMicros + b.amountMicros, a.currency);
}

/** Exact integer subtraction in micros; results may be negative. */
export function subtract(a, b) {
  toMicros(a);
  toMicros(b);
  assertSameCurrency(a, b);
  return fromMicros(a.amountMicros - b.amountMicros, a.currency);
}

/** Minor-unit exponent per ISO 4217 (default 2, e.g. the paise). */
const MINOR_EXPONENTS = { JPY: 0, KRW: 0, VND: 0, ISK: 0, UGX: 0, CLP: 0, BHD: 3, JOD: 3, KWD: 3, OMR: 3, TND: 3, IQD: 3, LYD: 3 };

function microsPerMinorUnit(currency) {
  return 10 ** (6 - (MINOR_EXPONENTS[currency] ?? 2));
}

/**
 * Split a money value into `parts` shares. Shares are whole minor units
 * (one paise, for INR); the minor-unit remainder is handed out one minor
 * unit at a time to the earliest parts, and any sub-minor micros left over
 * are spread one micro at a time after that, so the shares always sum to
 * the input exactly. Splitting 10000 paise across 3 yields 3334/3333/3333.
 */
export function allocate(money, parts) {
  const micros = toMicros(money);
  if (typeof parts !== 'number' || !Number.isSafeInteger(parts) || parts < 1) {
    throw moneyError('INVALID_MONEY', `parts must be a positive integer, got ${JSON.stringify(parts)}`);
  }
  const perMinor = microsPerMinorUnit(money.currency);
  const sign = micros < 0 ? -1 : 1;
  const absolute = Math.abs(micros);

  const minorTotal = Math.trunc(absolute / perMinor);
  const subMinorLeftover = absolute % perMinor;

  const base = Math.trunc(minorTotal / parts);
  const minorRemainder = minorTotal % parts;
  const subBase = Math.trunc(subMinorLeftover / parts);
  const subRemainder = subMinorLeftover % parts;
  return Array.from({ length: parts }, (_, index) => {
    let amount = (base + (index < minorRemainder ? 1 : 0)) * perMinor;
    amount += subBase + (index < subRemainder ? 1 : 0); // then sub-minor micros
    return fromMicros(sign * amount, money.currency);
  });
}

const MINOR_PER_MICRO = 10_000; // 1 paise = 10^4 micros

/** Format integer micros as a major-unit string without touching floats. */
export function formatMoney(money) {
  const micros = toMicros(money);
  const sign = micros < 0 ? '-' : '';
  const abs = Math.abs(micros);
  const major = Math.trunc(abs / 1_000_000);
  const minor = Math.trunc((abs % 1_000_000) / MINOR_PER_MICRO);
  const symbols = { INR: '₹', USD: '$', EUR: '€', GBP: '£' };
  const symbol = symbols[money.currency] ?? `${money.currency} `;
  return `${sign}${symbol}${major.toLocaleString('en-US')}.${String(minor).padStart(2, '0')}`;
}
