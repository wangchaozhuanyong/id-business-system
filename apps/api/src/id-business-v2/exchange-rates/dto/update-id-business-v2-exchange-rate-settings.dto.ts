export interface UpdateIdBusinessV2ExchangeRateSettingsDto {
  autoEnabled: boolean;
  intervalMinutes: number;
  targetAmountRmb: string | number;
  retentionDays?: number;
}
