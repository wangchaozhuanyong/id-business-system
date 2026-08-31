import type { PaginatedResult, V2FinanceCurrency, V2PageQuery } from '@apple-business/shared';
import type { V2OptionSelector } from './options';

export type V2RecordStatus = 'active' | 'disabled';

export interface V2OperatorSummary {
  id: string;
  username: string;
  displayName: string;
}

export interface V2Customer {
  id: string;
  name: string;
  maskedPhone: string | null;
  displayPhone: string | null;
  phoneTail: string | null;
  hasPhone: boolean;
  wechat: string | null;
  hasWechat: boolean;
  qq: string | null;
  hasQq: boolean;
  maskedWhatsapp: string | null;
  displayWhatsapp: string | null;
  whatsappTail: string | null;
  hasWhatsapp: boolean;
  contactDisplayModes: Record<
    'phone' | 'wechat' | 'qq' | 'whatsapp',
    'hidden' | 'masked' | 'reveal_direct' | 'reveal_approval' | 'full'
  >;
  sourceOptionId: string | null;
  source: Pick<V2OptionSelector, 'id' | 'code' | 'name'> | null;
  tagOptionIds: string[];
  tags: Array<Pick<V2OptionSelector, 'id' | 'code' | 'name'>>;
  serviceOptionIds: string[];
  services: Array<
    Pick<V2OptionSelector, 'id' | 'code' | 'name'> & {
      parent: { id: string; name: string } | null;
      firstOpenedAt: string;
      lastOpenedAt: string;
      activationCount: number;
    }
  >;
  recordStatus: V2RecordStatus;
  remark: string | null;
  createdBy: V2OperatorSummary | null;
  createdAt: string;
  updatedAt: string;
}

export interface V2CustomerDeletePreview {
  entityId: string;
  entityName: string;
  canDelete: boolean;
  blockingReasons: string[];
  impact: {
    orderCount: number;
    activeOrderCount: number;
    activationCount: number;
    activeActivationCount: number;
  };
  fingerprint: string;
}

export type V2CustomerListResult = PaginatedResult<V2Customer>;

export interface V2CustomerListQuery extends V2PageQuery {
  keyword?: string;
  sourceOptionId?: string;
  tagOptionId?: string;
  serviceOptionId?: string;
  recordStatus?: V2RecordStatus | '';
  sortBy?: 'name' | 'wechat' | 'recordStatus' | 'createdAt' | 'updatedAt';
  sortOrder?: 'asc' | 'desc';
}

export interface CreateV2CustomerInput {
  name: string;
  phone?: string | null;
  wechat?: string | null;
  qq?: string | null;
  whatsapp?: string | null;
  sourceOptionId?: string | null;
  tagOptionIds?: string[];
  recordStatus?: V2RecordStatus;
  remark?: string | null;
}

export type UpdateV2CustomerInput = Partial<CreateV2CustomerInput> & {
  expectedUpdatedAt: string;
};

export interface V2Account {
  id: string;
  appleIdMasked: string;
  displayAppleId: string | null;
  hasPassword: boolean;
  hasPhone: boolean;
  maskedPhone: string | null;
  displayPhone: string | null;
  phoneTail: string | null;
  hasSecurityInfo: boolean;
  countryOptionId: string;
  country: Pick<V2OptionSelector, 'id' | 'code' | 'name'>;
  statusOptionId: string;
  status: Pick<V2OptionSelector, 'id' | 'code' | 'name'> & { isSystem: boolean };
  supplierOptionId: string | null;
  supplier: Pick<V2OptionSelector, 'id' | 'code' | 'name'> | null;
  currentBalance: string;
  balanceCostAmount: string;
  purchaseCost: string;
  purchaseOriginalAmount: string;
  purchaseCurrency: V2FinanceCurrency;
  purchaseFxRateToCny: string;
  purchaseFxSnapshotId: string | null;
  purchaseFinanceAccountId: string | null;
  purchaseSupplierAccountId: string | null;
  purchasedAt: string;
  saleState: 'available' | 'sold';
  soldAt: string | null;
  soldByOrder: {
    id: string;
    orderNo: string;
  } | null;
  lossStatus: 'active' | 'reported';
  lossReportedAt: string | null;
  activeLossId: string | null;
  recordStatus: V2RecordStatus;
  disabledReason: string | null;
  disabledAt: string | null;
  remark: string | null;
  createdBy: V2OperatorSummary | null;
  createdAt: string;
  updatedAt: string;
}

export interface RecoverV2SoldAccountResult {
  accountId: string;
  orderId: string;
  recoveredAt: string;
  lockReleased: boolean;
  financeJournalId: string | null;
}

export interface V2SoldAccountRecoveryPreview {
  canRecover: boolean;
  currentBalance: string;
  balanceCostAmount: string;
  recordStatus: V2RecordStatus;
  counts: {
    pendingAfterSalesOrders: number;
    activeActivations: number;
    activeLocks: number;
  };
  blockers: Array<{
    code: 'loss_reported';
    message: string;
  }>;
}

export type V2AccountListResult = PaginatedResult<V2Account>;

export interface V2AccountListQuery extends V2PageQuery {
  keyword?: string;
  countryOptionId?: string;
  statusOptionId?: string;
  supplierOptionId?: string;
  recordStatus?: V2RecordStatus | '';
  saleState?: 'available' | 'sold' | '';
  lifecycle?: V2AccountLifecycle | '';
  sortBy?:
    | 'appleId'
    | 'currentBalance'
    | 'balanceCostAmount'
    | 'purchaseCost'
    | 'recordStatus'
    | 'createdAt'
    | 'updatedAt';
  sortOrder?: 'asc' | 'desc';
}

export type V2AccountLifecycle = 'available' | 'disabled' | 'sold' | 'reported';

export interface CreateV2AccountInput {
  appleId: string;
  password?: string | null;
  phone?: string | null;
  securityInfo?: string | null;
  countryOptionId: string;
  statusOptionId: string;
  supplierOptionId?: string | null;
  currentBalance?: string | number;
  balanceCostAmount?: string | number;
  purchaseCost?: string | number;
  purchaseOriginalAmount?: string | number;
  purchaseCurrency?: V2FinanceCurrency;
  purchaseFxRateToCny?: string | number;
  purchaseFxSnapshotId?: string | null;
  purchaseFinanceAccountId?: string | null;
  purchaseSupplierAccountId?: string | null;
  purchaseManualRateReason?: string | null;
  purchasedAt?: string | null;
  recordStatus?: V2RecordStatus;
  disabledReason?: string | null;
  remark?: string | null;
}

export interface V2AccountPurchaseSources {
  financeAccounts: Array<{
    id: string;
    name: string;
    currency: V2FinanceCurrency;
    currentBalance: string;
  }>;
  supplierWallets: Array<{
    id: string;
    supplierOptionId: string;
    supplierName: string;
    currency: V2FinanceCurrency;
    currentBalance: string;
  }>;
}

export interface UpdateV2AccountInput extends Partial<CreateV2AccountInput> {
  expectedUpdatedAt: string;
  expectedCurrentBalance?: string | number;
  expectedBalanceCostAmount?: string | number;
  balanceAdjustmentReason?: string;
  balanceAdjustmentIdempotencyKey?: string;
}

export interface ChangeV2AccountStatusInput {
  expectedUpdatedAt: string;
  recordStatus: V2RecordStatus;
  reason: string;
}

export interface ImportV2AccountRowInput extends CreateV2AccountInput {
  rowNumber: number;
}

export interface V2AccountImportResult {
  totalCount: number;
  successCount: number;
  failedCount: number;
  failures: Array<{
    rowNumber: number;
    reason: string;
  }>;
}

export interface V2AccountExportResult {
  items: V2Account[];
  total: number;
  containsSensitiveFields: boolean;
  exportedAt: string;
}

export interface ReportV2AccountLossInput {
  reason: string;
  expectedCurrentBalance: string | number;
  expectedBalanceCostAmount: string | number;
  idempotencyKey: string;
}

export interface UnfreezeV2AccountLossInput {
  reason: string;
  expectedLossId: string;
  idempotencyKey: string;
}

export interface V2AccountLossRecord {
  rowNumber?: number;
  id: string;
  accountId: string;
  ledgerEntryId: string;
  status: 'active' | 'reversed';
  appleIdMasked: string;
  displayAppleId: string | null;
  countryOptionId: string;
  countryName: string;
  currencyCode: string | null;
  supplierOptionId: string | null;
  supplierName: string | null;
  saleState: 'available' | 'sold';
  soldOrderId: string | null;
  soldOrderNo: string | null;
  lossBalance: string;
  lossCostAmount: string;
  idPurchaseCostLossAmount: string;
  reason: string;
  reportedByName: string | null;
  reportedBy: V2OperatorSummary | null;
  reportedAt: string;
  previousStatusOptionId: string | null;
  previousStatusName: string | null;
  previousRecordStatus: V2RecordStatus | null;
  financeJournalId: string | null;
  reversalFinanceJournalId: string | null;
  reversalReason: string | null;
  reversedAt: string | null;
  reversedByName: string | null;
  reversedBy: V2OperatorSummary | null;
}

export type V2AccountLossListResult = PaginatedResult<V2AccountLossRecord>;

export interface V2AccountLossListQuery extends V2PageQuery {
  keyword?: string;
  countryOptionId?: string;
  saleState?: 'available' | 'sold' | '';
  status?: 'active' | 'reversed' | '';
  reportedFrom?: string;
  reportedTo?: string;
  sortBy?: 'reportedAt' | 'lossBalance' | 'lossCostAmount';
  sortOrder?: 'asc' | 'desc';
}

export interface ReportV2AccountLossResult {
  lossRecord: V2AccountLossRecord;
  account: Pick<
    V2Account,
    | 'id'
    | 'appleIdMasked'
    | 'lossStatus'
    | 'lossReportedAt'
    | 'activeLossId'
    | 'currentBalance'
    | 'balanceCostAmount'
  >;
  idempotentReplay: boolean;
}

export type UnfreezeV2AccountLossResult = ReportV2AccountLossResult;

export type V2AccountSecretField = 'appleId' | 'password' | 'phone' | 'securityInfo';

export interface V2RevealInput {
  reason: string;
  approvalId?: string | null;
}
