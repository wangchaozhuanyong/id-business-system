import {
  V2_DECIMAL_PLACES,
  V2_RAW_EXCHANGE_RATE_DECIMAL_PLACES,
  v2UnsignedDecimalPattern
} from '@apple-business/shared';
import { Prisma } from '@prisma/client';

export { V2_DECIMAL_PLACES, V2_RAW_EXCHANGE_RATE_DECIMAL_PLACES };

export const V2_DECIMAL_PATTERN = v2UnsignedDecimalPattern(V2_DECIMAL_PLACES);
export const V2_DECIMAL_ROUNDING_MODE = Prisma.Decimal.ROUND_HALF_UP;

export function toV2Decimal(value: Prisma.Decimal.Value) {
  return new Prisma.Decimal(String(value));
}

export function roundV2Decimal(value: Prisma.Decimal.Value) {
  return toV2Decimal(value).toDecimalPlaces(V2_DECIMAL_PLACES, V2_DECIMAL_ROUNDING_MODE);
}

export function toV2DecimalString(value: Prisma.Decimal.Value) {
  return roundV2Decimal(value).toString();
}
