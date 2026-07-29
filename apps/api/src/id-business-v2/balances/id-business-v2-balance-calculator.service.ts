import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma as PrismaNamespace } from '@prisma/client';
import { V2_DECIMAL_PLACES, V2_DECIMAL_ROUNDING_MODE } from '../decimal-policy';

export interface IdBusinessV2BalanceSnapshotInput {
  currentBalance: PrismaNamespace.Decimal.Value;
  balanceCostAmount: PrismaNamespace.Decimal.Value;
}

export interface IdBusinessV2BalanceMovementSnapshot {
  balanceAmount: PrismaNamespace.Decimal;
  costAmount: PrismaNamespace.Decimal;
  balanceBefore: PrismaNamespace.Decimal;
  balanceAfter: PrismaNamespace.Decimal;
  costBefore: PrismaNamespace.Decimal;
  costAfter: PrismaNamespace.Decimal;
  averageCostBefore: PrismaNamespace.Decimal;
  averageCostAfter: PrismaNamespace.Decimal;
}

export interface IdBusinessV2NormalizedBalanceSnapshot {
  currentBalance: PrismaNamespace.Decimal;
  balanceCostAmount: PrismaNamespace.Decimal;
  averageCost: PrismaNamespace.Decimal;
}

export interface IdBusinessV2GiftCardCreditSnapshot extends IdBusinessV2BalanceMovementSnapshot {
  exchangeRate: PrismaNamespace.Decimal;
}

const AMOUNT_SCALE = V2_DECIMAL_PLACES;
const RATE_SCALE = V2_DECIMAL_PLACES;
const AVERAGE_COST_SCALE = V2_DECIMAL_PLACES;
const MAX_AMOUNT = new PrismaNamespace.Decimal('99999999999999.9999');
const MAX_RATE = new PrismaNamespace.Decimal('9999999999.99999999');
const ROUNDING_MODE = V2_DECIMAL_ROUNDING_MODE;

@Injectable()
export class IdBusinessV2BalanceCalculatorService {
  normalizeSnapshot(
    currentBalanceInput: PrismaNamespace.Decimal.Value,
    balanceCostAmountInput: PrismaNamespace.Decimal.Value
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
    faceValueInput: PrismaNamespace.Decimal.Value,
    exchangeRateInput: PrismaNamespace.Decimal.Value
  ): IdBusinessV2GiftCardCreditSnapshot {
    const balanceBefore = this.normalizeAmount(snapshot.currentBalance, '当前余额');
    const costBefore = this.normalizeAmount(snapshot.balanceCostAmount, '当前人民币总成本');
    const faceValue = this.normalizePositiveAmount(faceValueInput, '礼品卡面值');
    const exchangeRate = this.normalizePositiveRate(exchangeRateInput, '卡片汇率');
    const averageCostBefore = this.calculateAverageCost(balanceBefore, costBefore);
    const costAmount = faceValue.mul(exchangeRate).toDecimalPlaces(AMOUNT_SCALE, ROUNDING_MODE);

    if (costAmount.lessThanOrEqualTo(0)) {
      throw new BadRequestException('礼品卡人民币成本四舍五入后必须大于 0');
    }
    this.assertAmountWithinRange(costAmount, '礼品卡人民币成本');

    const balanceAfter = balanceBefore.plus(faceValue).toDecimalPlaces(AMOUNT_SCALE, ROUNDING_MODE);
    const costAfter = costBefore.plus(costAmount).toDecimalPlaces(AMOUNT_SCALE, ROUNDING_MODE);
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
    balanceAmountInput: PrismaNamespace.Decimal.Value
  ): IdBusinessV2BalanceMovementSnapshot {
    const balanceBefore = this.normalizeAmount(snapshot.currentBalance, '当前余额');
    const costBefore = this.normalizeAmount(snapshot.balanceCostAmount, '当前人民币总成本');
    const balanceAmount = this.normalizePositiveAmount(balanceAmountInput, '扣减余额');
    const averageCostBefore = this.calculateAverageCost(balanceBefore, costBefore);

    if (balanceAmount.greaterThan(balanceBefore)) {
      throw new BadRequestException('扣减余额不能超过当前余额');
    }

    const consumesAllBalance = balanceAmount.equals(balanceBefore);
    const calculatedCost = balanceAmount
      .mul(averageCostBefore)
      .toDecimalPlaces(AMOUNT_SCALE, ROUNDING_MODE);
    const costAmount = consumesAllBalance
      ? costBefore
      : calculatedCost.greaterThan(costBefore)
        ? costBefore
        : calculatedCost;
    const balanceAfter = balanceBefore
      .minus(balanceAmount)
      .toDecimalPlaces(AMOUNT_SCALE, ROUNDING_MODE);
    const costAfter = consumesAllBalance
      ? new PrismaNamespace.Decimal(0)
      : costBefore.minus(costAmount).toDecimalPlaces(AMOUNT_SCALE, ROUNDING_MODE);

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
    balanceAmountInput: PrismaNamespace.Decimal.Value,
    costAmountInput: PrismaNamespace.Decimal.Value
  ): IdBusinessV2BalanceMovementSnapshot {
    const balanceBefore = this.normalizeAmount(snapshot.currentBalance, '当前余额');
    const costBefore = this.normalizeAmount(snapshot.balanceCostAmount, '当前人民币总成本');
    const balanceAmount = this.normalizePositiveAmount(balanceAmountInput, '恢复余额');
    const costAmount = this.normalizeAmount(costAmountInput, '恢复人民币成本');
    const balanceAfter = balanceBefore
      .plus(balanceAmount)
      .toDecimalPlaces(AMOUNT_SCALE, ROUNDING_MODE);
    const costAfter = costBefore.plus(costAmount).toDecimalPlaces(AMOUNT_SCALE, ROUNDING_MODE);
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

  calculateAverageCost(
    currentBalanceInput: PrismaNamespace.Decimal.Value,
    balanceCostAmountInput: PrismaNamespace.Decimal.Value
  ) {
    const currentBalance = this.normalizeAmount(currentBalanceInput, '当前余额');
    const balanceCostAmount = this.normalizeAmount(balanceCostAmountInput, '当前人民币总成本');

    if (currentBalance.equals(0)) {
      if (!balanceCostAmount.equals(0)) {
        throw new BadRequestException('当前余额为 0 时人民币总成本也必须为 0');
      }
      return new PrismaNamespace.Decimal(0);
    }

    const averageCost = balanceCostAmount
      .div(currentBalance)
      .toDecimalPlaces(AVERAGE_COST_SCALE, ROUNDING_MODE);
    if (averageCost.greaterThan(MAX_RATE)) {
      throw new BadRequestException('平均成本数值过大');
    }
    return averageCost;
  }

  private normalizePositiveAmount(value: PrismaNamespace.Decimal.Value, label: string) {
    const amount = this.normalizeAmount(value, label);
    if (amount.lessThanOrEqualTo(0)) {
      throw new BadRequestException(`${label}必须大于 0`);
    }
    return amount;
  }

  private normalizeAmount(value: PrismaNamespace.Decimal.Value, label: string) {
    return this.normalizeDecimal(value, label, AMOUNT_SCALE, MAX_AMOUNT);
  }

  private normalizePositiveRate(value: PrismaNamespace.Decimal.Value, label: string) {
    const rate = this.normalizeDecimal(value, label, RATE_SCALE, MAX_RATE);
    if (rate.lessThanOrEqualTo(0)) {
      throw new BadRequestException(`${label}必须大于 0`);
    }
    return rate;
  }

  private normalizeDecimal(
    value: PrismaNamespace.Decimal.Value,
    label: string,
    scale: number,
    maximum: PrismaNamespace.Decimal
  ) {
    const normalized = String(value).trim();
    const pattern = new RegExp(`^\\d+(\\.\\d{1,${scale}})?$`);
    if (!pattern.test(normalized)) {
      throw new BadRequestException(`${label}必须是最多 ${scale} 位小数的非负数字`);
    }

    const decimal = new PrismaNamespace.Decimal(normalized).toDecimalPlaces(scale, ROUNDING_MODE);
    if (decimal.greaterThan(maximum)) {
      throw new BadRequestException(`${label}数值过大`);
    }
    return decimal;
  }

  private assertAmountWithinRange(value: PrismaNamespace.Decimal, label: string) {
    if (value.isNegative() || value.greaterThan(MAX_AMOUNT)) {
      throw new BadRequestException(`${label}数值超出数据库范围`);
    }
  }
}
