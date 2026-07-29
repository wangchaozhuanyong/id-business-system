import type { CreateIdBusinessV2AccountDto } from './create-id-business-v2-account.dto';

export interface ImportIdBusinessV2AccountRowDto extends CreateIdBusinessV2AccountDto {
  rowNumber?: number;
}

export interface ImportIdBusinessV2AccountsDto {
  rows?: ImportIdBusinessV2AccountRowDto[];
}
