import { Amount4, Rate8, type V2DecimalInput } from './id-business-v2-decimal';

export class V2RowMappingError extends Error {
  readonly code = 'V2_PERSISTENCE_DECIMAL_INVALID';

  constructor(
    readonly field: string,
    options?: ErrorOptions
  ) {
    super(`持久化金额字段 ${field} 无法读取`, options);
    this.name = 'V2RowMappingError';
  }
}

export function mapAmount4(value: unknown, field = 'decimal amount') {
  return mapDecimal(value, field, Amount4.from);
}

export function mapOptionalAmount4(value: unknown, field = 'optional decimal amount') {
  if (value === null || value === undefined) return null;
  return mapAmount4(value, field);
}

export function mapRate8(value: unknown, field = 'decimal rate') {
  return mapDecimal(value, field, Rate8.from);
}

export function mapOptionalRate8(value: unknown, field = 'optional decimal rate') {
  if (value === null || value === undefined) return null;
  return mapRate8(value, field);
}

function mapDecimal<TValue>(
  value: unknown,
  field: string,
  factory: (input: V2DecimalInput) => TValue
) {
  try {
    return factory(value as V2DecimalInput);
  } catch (error) {
    throw new V2RowMappingError(field, { cause: error });
  }
}
