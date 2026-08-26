ALTER TYPE "IdBusinessV2BalanceLedgerEntryType"
ADD VALUE IF NOT EXISTS 'order_upgrade_balance_return';

ALTER TYPE "IdBusinessV2BalanceLedgerEntryType"
ADD VALUE IF NOT EXISTS 'order_upgrade_balance_return_reversal';

CREATE TYPE "IdBusinessV2OrderBalanceReturnStatus" AS ENUM ('active', 'reversed');

ALTER TYPE "IdBusinessV2FinanceJournalType"
ADD VALUE IF NOT EXISTS 'order_upgrade_balance_return';
