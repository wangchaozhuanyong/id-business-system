import { BadRequestException, Injectable } from '@nestjs/common';
import {
  V2_DECIMAL_PLACES,
  V2_RAW_EXCHANGE_RATE_DECIMAL_PLACES,
  v2UnsignedDecimalPattern
} from '@apple-business/shared';
import { Amount4, Rate8, type V2DecimalInput } from '../runtime/public-api';

export interface IdBusinessV2BalanceSnapshotInput {
  currentBalance: V2DecimalInput;
  balanceCostAmount: V2DecimalInput;
}

export interface IdBusinessV2BalanceMovementSnapshot {
  balanceAmount: Amount4;
  costAmount: Amount4;
  balanceBefore: Amount4;
  balanceAfter: Amount4;
  costBefore: Amount4;
  costAfter: Amount4;
  averageCostBefore: Rate8;
  averageCostAfter: Rate8;
}

export interface IdBusinessV2NormalizedBalanceSnapshot {
  currentBalance: Amount4;
  balanceCostAmount: Amount4;
  averageCost: Rate8;
}

export interface IdBusinessV2GiftCardCreditSnapshot extends IdBusinessV2BalanceMovementSnapshot {
  exchangeRate: Rate8;
}

const AMOUNT_PATTERN = v2UnsignedDecimalPattern(V2_DECIMAL_PLACES);
const RATE_PATTERN = v2UnsignedDecimalPattern(V2_RAW_EXCHANGE_RATE_DECIMAL_PLACES);
const MAX_AMOUNT = Amount4.from('99999999999999.9999');
const MAX_RATE = Rate8.from('9999999999.99999999');

@Injectable()
export class IdBusinessV2BalanceCalculatorService {
  normalizeSnapshot(
    currentBalanceInput: V2DecimalInput,
    balanceCostAmountInput: V2DecimalInput
  ): IdBusinessV2NormalizedBalanceSnapshot {
    const currentBalance = this.normalizeAmount(currentBalanceInput, '当前余额');
    const balanceCostAmount = this.normalizeAmount(balanceCostAmountInput, '当前人民币总成本');

    return {
      currentBalance,
      balanceCostAmount,
      averageCost: this.calculateAverageCost(currentBalance, balanceCostAmount)
    };
  }

  calculateGiftCardCredit(
    snapshot: IdBusinessV2BalanceSnapshotInput,
    faceValueInput: V2DecimalInput,
    exchangeRateInput: V2DecimalInput
  ): IdBusinessV2GiftCardCreditSnapshot {
    const balanceBefore = this.normalizeAmount(snapshot.currentBalance, '当前余额');
    const costBefore = this.normalizeAmount(snapshot.balanceCostAmount, '当前人民币总成本');
    const faceValue = this.normalizePositiveAmount(faceValueInput, '礼品卡面值');
    const exchangeRate = this.normalizePositiveRate(exchangeRateInput, '卡片汇率');
    const averageCostBefore = this.calculateAverageCost(balanceBefore, costBefore);
    const costAmount = exchangeRate.apply(faceValue);

    if (costAmount.lte(0)) {
      throw new BadRequestException('礼品卡人民币成本四舍五入后必须大于 0');
    }
    this.assertAmountWithinRange(costAmount, '礼品卡人民币成本');

    const balanceAfter = balanceBefore.add(faceValue);
    const costAfter = costBefore.add(costAmount);
    this.assertAmountWithinRange(balanceAfter, '加卡后余额');
    this.assertAmountWithinRange(costAfter, '加卡后人民币总成本');

    return {
      balanceAmount: faceValue,
      costAmount,
      balanceBefore,
      balanceAfter,
      costBefore,
      costAfter,
      averageCostBefore,
      averageCostAfter: this.calculateAverageCost(balanceAfter, costAfter),
      exchangeRate
    };
  }

  calculateConsumption(
    snapshot: IdBusinessV2BalanceSnapshotInput,
    balanceAmountInput: V2DecimalInput
  ): IdBusinessV2BalanceMovementSnapshot {
    const balanceBefore = this.normalizeAmount(snapshot.currentBalance, '当前余额');
    const costBefore = this.normalizeAmount(snapshot.balanceCostAmount, '当前人民币总成本');
    const balanceAmount = this.normalizePositiveAmount(balanceAmountInput, '扣减余额');
    const averageCostBefore = this.calculateAverageCost(balanceBefore, costBefore);

    if (balanceAmount.gt(balanceBefore)) {
      throw new BadRequestException('扣减余额不能超过当前余额');
    }

    const consumesAllBalance = balanceAmount.equals(balanceBefore);
    const calculatedCost = averageCostBefore.apply(balanceAmount);
    const costAmount = consumesAllBalance
      ? costBefore
      : calculatedCost.gt(costBefore)
        ? costBefore
        : calculatedCost;
    const balanceAfter = balanceBefore.sub(balanceAmount);
    const costAfter = consumesAllBalance ? Amount4.zero() : costBefore.sub(costAmount);

    return {
      balanceAmount,
      costAmount,
      balanceBefore,
      balanceAfter,
      costBefore,
      costAfter,
      averageCostBefore,
      averageCostAfter: this.calculateAverageCost(balanceAfter, costAfter)
    };
  }

  calculateReversalCredit(
    snapshot: IdBusinessV2BalanceSnapshotInput,
    balanceAmountInput: V2DecimalInput,
    costAmountInput: V2DecimalInput
  ): IdBusinessV2BalanceMovementSnapshot {
    const balanceBefore = this.normalizeAmount(snapshot.currentBalance, '当前余额');
    const costBefore = this.normalizeAmount(snapshot.balanceCostAmount, '当前人民币总成本');
    const balanceAmount = this.normalizePositiveAmount(balanceAmountInput, '恢复余额');
    const costAmount = this.normalizeAmount(costAmountInput, '恢复人民币成本');
    const balanceAfter = balanceBefore.add(balanceAmount);
    const costAfter = costBefore.add(costAmount);
    this.assertAmountWithinRange(balanceAfter, '恢复后余额');
    this.assertAmountWithinRange(costAfter, '恢复后人民币总成本');

    return {
      balanceAmount,
      costAmount,
      balanceBefore,
      balanceAfter,
      costBefore,
      costAfter,
      averageCostBefore: this.calculateAverageCost(balanceBefore, costBefore),
      averageCostAfter: this.calculateAverageCost(balanceAfter, costAfter)
    };
  }

  calculateExactReversalDebit(
    snapshot: IdBusinessV2BalanceSnapshotInput,
    balanceAmountInput: V2DecimalInput,
    costAmountInput: V2DecimalInput
  ): IdBusinessV2BalanceMovementSnapshot {
    const balanceBefore = this.normalizeAmount(snapshot.currentBalance, '当前余额');
    const costBefore = this.normalizeAmount(snapshot.balanceCostAmount, '当前人民币总成本');
    const balanceAmount = this.normalizePositiveAmount(balanceAmountInput, '撤销退回余额');
    const costAmount = this.normalizeAmount(costAmountInput, '撤销人民币成本');
    if (balanceAmount.gt(balanceBefore)) {
      throw new BadRequestException('ID 当前余额不足，不能撤销升级退币');
    }
    if (costAmount.gt(costBefore)) {
      throw new BadRequestException('ID 当前人民币成本不足，不能撤销升级退币');
    }
    const balanceAfter = balanceBefore.sub(balanceAmount);
    const costAfter = costBefore.sub(costAmount);
    if (balanceAfter.isZero() && !costAfter.isZero()) {
      throw new BadRequestException('撤销后余额为 0 但仍有人民币成本，请先核对后续余额流水');
    }
    return {
      balanceAmount,
      costAmount,
      balanceBefore,
      balanceAfter,
      costBefore,
      costAfter,
      averageCostBefore: this.calculateAverageCost(balanceBefore, costBefore),
      averageCostAfter: this.calculateAverageCost(balanceAfter, costAfter)
    };
  }

  calculateAverageCost(
    currentBalanceInput: V2DecimalInput,
    balanceCostAmountInput: V2DecimalInput
  ): Rate8 {
    const currentBalance = this.normalizeAmount(currentBalanceInput, '当前余额');
    const balanceCostAmount = this.normalizeAmount(balanceCostAmountInput, '当前人民币总成本');

    if (currentBalance.isZero()) {
      if (!balanceCostAmount.isZero()) {
        throw new BadRequestException('当前余额为 0 时人民币总成本也必须为 0');
      }
      return Rate8.zero();
    }

    const averageCost = balanceCostAmount.ratio(currentBalance);
    if (averageCost.gt(MAX_RATE)) {
      throw new BadRequestException('平均成本数值过大');
    }
    return averageCost;
  }

  private normalizePositiveAmount(value: V2DecimalInput, label: string) {
    const amount = this.normalizeAmount(value, label);
    if (amount.lte(0)) {
      throw new BadRequestException(`${label}必须大于 0`);
    }
    return amount;
  }

  private normalizeAmount(value: V2DecimalInput, label: string) {
    return this.normalizeDecimal(value, label, AMOUNT_PATTERN, Amount4.from, MAX_AMOUNT);
  }

  private normalizePositiveRate(value: V2DecimalInput, label: string) {
    const rate = this.normalizeDecimal(value, label, RATE_PATTERN, Rate8.from, MAX_RATE);
    if (rate.lte(0)) {
      throw new BadRequestException(`${label}必须大于 0`);
    }
    return rate;
  }

  private normalizeDecimal<T extends Amount4 | Rate8>(
    value: V2DecimalInput,
    label: string,
    pattern: RegExp,
    create: (input: V2DecimalInput) => T,
    maximum: T
  ) {
    const normalized = String(value).trim();
    if (!pattern.test(normalized)) {
      const scale =
        maximum instanceof Amount4 ? V2_DECIMAL_PLACES : V2_RAW_EXCHANGE_RATE_DECIMAL_PLACES;
      throw new BadRequestException(`${label}必须是最多 ${scale} 位小数的非负数字`);
    }

    const decimal = create(normalized);
    if (decimal.gt(maximum)) {
      throw new BadRequestException(`${label}数值过大`);
    }
    return decimal;
  }

  private assertAmountWithinRange(value: Amount4, label: string) {
    if (value.isNegative() || value.gt(MAX_AMOUNT)) {
      throw new BadRequestException(`${label}数值超出数据库范围`);
    }
  }
}
