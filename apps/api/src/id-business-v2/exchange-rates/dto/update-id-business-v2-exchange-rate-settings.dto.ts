export interface UpdateIdBusinessV2ExchangeRateSettingsDto {
  expectedUpdatedAt?: string;
  autoEnabled: boolean;
  intervalMinutes: number;
  targetAmountRmb: string | number;
  retentionDays?: number;
}
