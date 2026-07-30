export interface InitializeIdBusinessV2TopupSupplierFundDto {
  targetBalanceCny: string | number;
  reason: string;
  idempotencyKey: string;
}

export interface CreateIdBusinessV2TopupSupplierPaymentDto {
  receivedUsdt: string | number;
  networkFeeUsdt?: string | number | null;
  settlementRateCnyUsdt: string | number;
  network?: string | null;
  transactionHash?: string | null;
  paidAt: string;
  remark?: string | null;
  idempotencyKey: string;
}

export interface AdjustIdBusinessV2TopupSupplierFundDto {
  targetBalanceCny: string | number;
  reason: string;
  idempotencyKey: string;
}

export interface ReverseIdBusinessV2TopupSupplierPaymentDto {
  reason: string;
  idempotencyKey: string;
}

export interface ReassignIdBusinessV2GiftCardSupplierDto {
  supplierOptionId: string;
  reason: string;
  idempotencyKey: string;
}

export interface RevealIdBusinessV2GiftCardCodeDto {
  reason: string;
  approvalId?: string | null;
}
