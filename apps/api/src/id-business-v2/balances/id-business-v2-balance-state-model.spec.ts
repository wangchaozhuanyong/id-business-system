import { describe, expect, it } from 'vitest';
import { IdBusinessV2BalanceCalculatorService } from './id-business-v2-balance-calculator.service';

const AMOUNT_SCALE = 10_000n;
const RATE_SCALE = 100_000_000n;

interface ReferenceState {
  balance: bigint;
  cost: bigint;
}

interface ReferenceMovement {
  balance: bigint;
  cost: bigint;
}

describe('IdBusinessV2BalanceCalculatorService deterministic state model', () => {
  const calculator = new IdBusinessV2BalanceCalculatorService();

  it('matches an independent BigInt algorithm through 32,768 credit/consume/cancel transitions', () => {
    for (let seed = 1; seed <= 128; seed += 1) {
      const random = createDeterministicRandom(seed);
      const state: ReferenceState = { balance: 0n, cost: 0n };
      const ledger: ReferenceMovement[] = [];

      for (let step = 0; step < 256; step += 1) {
        const operation = random() % 100;
        if (state.balance === 0n || operation < 45) {
          const faceValue = BigInt((random() % 100_000) + 1);
          const rate = BigInt((random() % 950_000_001) + 50_000_000);
          const expectedCost = roundHalfUp(faceValue * rate, RATE_SCALE);
          const result = calculator.calculateGiftCardCredit(
            snapshot(state),
            fixedPoint(faceValue, 4),
            fixedPoint(rate, 8)
          );

          expect(amountUnits(result.costAmount.toString())).toBe(expectedCost);
          expect(amountUnits(result.balanceAfter.toString())).toBe(state.balance + faceValue);
          expect(amountUnits(result.costAfter.toString())).toBe(state.cost + expectedCost);
          state.balance += faceValue;
          state.cost += expectedCost;
          ledger.push({ balance: faceValue, cost: expectedCost });
        } else {
          const consumedBalance = BigInt((random() % Number(state.balance)) + 1);
          const stateBefore = { ...state };
          const expectedCost = referenceConsumptionCost(state, consumedBalance);
          const consumed = calculator.calculateConsumption(
            snapshot(state),
            fixedPoint(consumedBalance, 4)
          );

          expect(amountUnits(consumed.costAmount.toString())).toBe(expectedCost);
          expect(amountUnits(consumed.balanceAfter.toString())).toBe(
            state.balance - consumedBalance
          );
          expect(amountUnits(consumed.costAfter.toString())).toBe(state.cost - expectedCost);
          state.balance -= consumedBalance;
          state.cost -= expectedCost;
          ledger.push({ balance: -consumedBalance, cost: -expectedCost });

          if (operation >= 80) {
            const reversed = calculator.calculateReversalCredit(
              snapshot(state),
              fixedPoint(consumedBalance, 4),
              fixedPoint(expectedCost, 4)
            );
            expect(amountUnits(reversed.balanceAfter.toString())).toBe(stateBefore.balance);
            expect(amountUnits(reversed.costAfter.toString())).toBe(stateBefore.cost);
            state.balance += consumedBalance;
            state.cost += expectedCost;
            ledger.push({ balance: consumedBalance, cost: expectedCost });
          }
        }

        const rebuilt = ledger.reduce<ReferenceState>(
          (total, movement) => ({
            balance: total.balance + movement.balance,
            cost: total.cost + movement.cost
          }),
          { balance: 0n, cost: 0n }
        );
        expect(rebuilt, `seed=${seed}, step=${step}`).toEqual(state);
        expect(state.balance).toBeGreaterThanOrEqual(0n);
        expect(state.cost).toBeGreaterThanOrEqual(0n);
        if (state.balance === 0n) expect(state.cost).toBe(0n);
      }
    }
  }, 20_000);
});

function referenceConsumptionCost(state: ReferenceState, consumedBalance: bigint) {
  if (consumedBalance === state.balance) return state.cost;
  const averageRate = roundHalfUp(state.cost * RATE_SCALE, state.balance);
  const calculatedCost = roundHalfUp(consumedBalance * averageRate, RATE_SCALE);
  return calculatedCost > state.cost ? state.cost : calculatedCost;
}

function roundHalfUp(numerator: bigint, denominator: bigint) {
  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  return remainder * 2n >= denominator ? quotient + 1n : quotient;
}

function snapshot(state: ReferenceState) {
  return {
    currentBalance: fixedPoint(state.balance, 4),
    balanceCostAmount: fixedPoint(state.cost, 4)
  };
}

function amountUnits(value: string) {
  const [integer, fraction = ''] = value.split('.');
  return BigInt(integer) * AMOUNT_SCALE + BigInt(fraction.padEnd(4, '0'));
}

function fixedPoint(value: bigint, scale: number) {
  const base = 10n ** BigInt(scale);
  const integer = value / base;
  const fraction = (value % base).toString().padStart(scale, '0').replace(/0+$/, '');
  return fraction ? `${integer}.${fraction}` : integer.toString();
}

function createDeterministicRandom(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state;
  };
}
