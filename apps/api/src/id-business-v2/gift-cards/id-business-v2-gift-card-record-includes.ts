import type { Prisma } from '@prisma/client';

export const GIFT_CARD_RECORD_INCLUDE = {
  account: {
    select: {
      id: true,
      appleIdMasked: true,
      lossReportedAt: true,
      countryOption: {
        select: {
          id: true,
          code: true,
          name: true
        }
      }
    }
  },
  supplierOption: {
    select: {
      id: true,
      code: true,
      name: true
    }
  },
  countryOption: {
    select: {
      id: true,
      code: true
    }
  },
  createdBy: {
    select: {
      id: true,
      username: true,
      displayName: true
    }
  },
  updatedBy: {
    select: {
      id: true,
      username: true,
      displayName: true
    }
  },
  ledgerEntries: {
    where: {
      entryType: 'gift_card_credit'
    },
    select: {
      id: true,
      balanceBefore: true,
      balanceAfter: true,
      costBefore: true,
      costAfter: true,
      averageCostBefore: true,
      averageCostAfter: true,
      createdAt: true,
      reversedByEntry: {
        select: {
          id: true,
          entryType: true,
          balanceAmount: true,
          costAmount: true,
          remark: true,
          createdAt: true
        }
      }
    },
    take: 1
  },
  supplierFundEntries: {
    where: {
      entryType: 'gift_card_debit'
    },
    select: {
      id: true,
      amountCny: true,
      balanceBeforeCny: true,
      balanceAfterCny: true,
      supplierNameSnapshot: true,
      createdAt: true,
      reversedBy: {
        select: {
          id: true,
          entryType: true,
          createdAt: true
        }
      }
    },
    orderBy: {
      createdAt: 'desc'
    },
    take: 1
  }
} satisfies Prisma.IdBusinessV2GiftCardInclude;

export type GiftCardRecord = Prisma.IdBusinessV2GiftCardGetPayload<{
  include: typeof GIFT_CARD_RECORD_INCLUDE;
}>;

export const BALANCE_LEDGER_INCLUDE = {
  account: {
    select: {
      id: true,
      appleIdMasked: true,
      countryOption: {
        select: {
          id: true,
          code: true,
          name: true
        }
      }
    }
  },
  giftCard: {
    select: {
      id: true,
      codeEncrypted: true,
      codeMasked: true,
      codeTail: true,
      faceValue: true,
      status: true,
      supplierOption: {
        select: {
          id: true,
          code: true,
          name: true
        }
      }
    }
  },
  reversalOfEntry: {
    select: {
      id: true,
      entryType: true,
      createdAt: true
    }
  },
  reversedByEntry: {
    select: {
      id: true,
      entryType: true,
      createdAt: true
    }
  },
  createdBy: {
    select: {
      id: true,
      username: true,
      displayName: true
    }
  }
} satisfies Prisma.IdBusinessV2BalanceLedgerInclude;

export type BalanceLedgerRecord = Prisma.IdBusinessV2BalanceLedgerGetPayload<{
  include: typeof BALANCE_LEDGER_INCLUDE;
}>;
