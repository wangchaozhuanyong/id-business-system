ALTER TYPE "IdBusinessV2OptionType"
ADD VALUE IF NOT EXISTS 'income_category';

ALTER TYPE "IdBusinessV2FinanceJournalType"
ADD VALUE IF NOT EXISTS 'manual_operating_income';

ALTER TYPE "IdBusinessV2FinanceJournalType"
ADD VALUE IF NOT EXISTS 'capital_contribution';

ALTER TYPE "IdBusinessV2FinanceJournalType"
ADD VALUE IF NOT EXISTS 'borrowed_funds_received';

ALTER TYPE "IdBusinessV2FinanceSourceType"
ADD VALUE IF NOT EXISTS 'inflow';

ALTER TYPE "IdBusinessV2FinanceAccountCode"
ADD VALUE IF NOT EXISTS 'other_operating_revenue';

ALTER TYPE "IdBusinessV2FinanceAccountCode"
ADD VALUE IF NOT EXISTS 'contributed_capital';

ALTER TYPE "IdBusinessV2FinanceAccountCode"
ADD VALUE IF NOT EXISTS 'borrowed_funds_payable';

CREATE TYPE "IdBusinessV2FinanceInflowNature" AS ENUM (
  'operating_income',
  'capital_contribution',
  'borrowed_funds'
);
