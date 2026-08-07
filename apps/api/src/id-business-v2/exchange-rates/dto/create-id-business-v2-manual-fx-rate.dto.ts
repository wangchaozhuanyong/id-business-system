export interface CreateIdBusinessV2ManualFxRateDto {
  currency: 'MYR' | 'USD' | 'USDT';
  rateToCny: string | number;
  recordedAt: string;
  reason: string;
  sourceReference?: string | null;
}
