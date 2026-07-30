ALTER TYPE "IdBusinessV2OptionType"
ADD VALUE IF NOT EXISTS 'expense_category';

ALTER TYPE "IdBusinessV2TopupSupplierLedgerEntryType"
ADD VALUE IF NOT EXISTS 'supplier_refund';

ALTER TYPE "IdBusinessV2TopupSupplierLedgerEntryType"
ADD VALUE IF NOT EXISTS 'id_purchase_debit';

ALTER TYPE "IdBusinessV2TopupSupplierLedgerEntryType"
ADD VALUE IF NOT EXISTS 'gift_card_refund_received';

ALTER TYPE "IdBusinessV2TopupSupplierLedgerEntryType"
ADD VALUE IF NOT EXISTS 'refund_write_off';
