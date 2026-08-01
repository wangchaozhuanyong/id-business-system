import {
  V2_DECIMAL_PLACES,
  V2_RAW_EXCHANGE_RATE_DECIMAL_PLACES,
  addDecimalStrings,
  divideDecimalStrings,
  multiplyDecimalStrings,
  roundDecimalString,
  v2UnsignedDecimalPattern
} from '@apple-business/shared';

export { V2_DECIMAL_PLACES, V2_RAW_EXCHANGE_RATE_DECIMAL_PLACES };
export const V2_DECIMAL_PATTERN = v2UnsignedDecimalPattern(V2_DECIMAL_PLACES);

export type V2DecimalInput = string | number | bigint | { toString(): string };

abstract class V2DecimalValue<TValue extends V2DecimalValue<TValue>> {
  protected constructor(
    private readonly value: string,
    private readonly scale: number
  ) {}

  protected abstract create(value: string): TValue;

  toString() {
    return this.value;
  }

  toJSON() {
    return this.value;
  }

  toFixed(decimalPlaces?: number) {
    if (decimalPlaces === undefined) return this.value;
    const rounded = roundDecimalString(this.value, decimalPlaces);
    const [integer, fraction = ''] = rounded.split('.');
    return decimalPlaces === 0 ? integer : `${integer}.${fraction.padEnd(decimalPlaces, '0')}`;
  }

  equals(other: V2DecimalInput) {
    return this.compare(other) === 0;
  }

  compare(other: V2DecimalInput) {
    const difference = addDecimalStrings(
      this.value,
      negateDecimalInput(normalizeDecimalInput(other, this.scale)),
      this.scale
    );
    if (difference === '0') return 0;
    return difference.startsWith('-') ? -1 : 1;
  }

  isZero() {
    return this.value === '0';
  }

  isNegative() {
    return this.value.startsWith('-');
  }

  gt(other: V2DecimalInput) {
    return this.compare(other) > 0;
  }

  gte(other: V2DecimalInput) {
    return this.compare(other) >= 0;
  }

  lt(other: V2DecimalInput) {
    return this.compare(other) < 0;
  }

  lte(other: V2DecimalInput) {
    return this.compare(other) <= 0;
  }

  add(other: V2DecimalInput) {
    return this.create(
      addDecimalStrings(this.value, normalizeDecimalInput(other, this.scale), this.scale)
    );
  }

  sub(other: V2DecimalInput) {
    return this.create(
      addDecimalStrings(
        this.value,
        negateDecimalInput(normalizeDecimalInput(other, this.scale)),
        this.scale
      )
    );
  }

  mul(other: V2DecimalInput) {
    return this.create(multiplyDecimalStrings(this.value, decimalInputToString(other), this.scale));
  }

  div(other: V2DecimalInput) {
    return this.create(divideDecimalStrings(this.value, decimalInputToString(other), this.scale));
  }

  abs() {
    return this.isNegative() ? this.negated() : this.create(this.value);
  }

  negated() {
    return this.create(negateDecimalInput(this.value));
  }
}

export class Amount4 extends V2DecimalValue<Amount4> {
  private constructor(value: string) {
    super(value, V2_DECIMAL_PLACES);
  }

  static from(value: V2DecimalInput) {
    return new Amount4(normalizeDecimalInput(value, V2_DECIMAL_PLACES));
  }

  static zero() {
    return new Amount4('0');
  }

  protected create(value: string) {
    return Amount4.from(value);
  }

  ratio(denominator: V2DecimalInput) {
    return Rate8.from(
      divideDecimalStrings(
        this.toString(),
        decimalInputToString(denominator),
        V2_RAW_EXCHANGE_RATE_DECIMAL_PLACES
      )
    );
  }
}

export class Rate8 extends V2DecimalValue<Rate8> {
  private constructor(value: string) {
    super(value, V2_RAW_EXCHANGE_RATE_DECIMAL_PLACES);
  }

  static from(value: V2DecimalInput) {
    return new Rate8(normalizeDecimalInput(value, V2_RAW_EXCHANGE_RATE_DECIMAL_PLACES));
  }

  static zero() {
    return new Rate8('0');
  }

  static one() {
    return new Rate8('1');
  }

  protected create(value: string) {
    return Rate8.from(value);
  }

  apply(amount: Amount4 | V2DecimalInput) {
    return Amount4.from(
      multiplyDecimalStrings(
        amount instanceof Amount4 ? amount.toString() : decimalInputToString(amount),
        this.toString(),
        V2_DECIMAL_PLACES
      )
    );
  }
}

function normalizeDecimalInput(value: V2DecimalInput, decimalPlaces: number) {
  try {
    return roundDecimalString(decimalInputToString(value), decimalPlaces);
  } catch (error) {
    throw new TypeError('无效的小数值', { cause: error });
  }
}

function decimalInputToString(value: V2DecimalInput) {
  if (value === null || value === undefined) {
    throw new TypeError('无效的小数值');
  }

  const normalized = String(value).trim();
  if (!normalized || normalized === '[object Object]') {
    throw new TypeError('无效的小数值');
  }
  return normalized;
}

function negateDecimalInput(value: V2DecimalInput) {
  const normalized = decimalInputToString(value);
  if (normalized.startsWith('-')) return normalized.slice(1);
  if (normalized.startsWith('+')) return `-${normalized.slice(1)}`;
  return `-${normalized}`;
}
