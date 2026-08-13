import {
  addOneInclusiveMonthToV2DateTimeInput,
  parseV2DateTimeInput,
  toV2DateTimeInput
} from './dateTime';

export function calculateOneMonthInclusiveDueAt(openedAt: Date) {
  const openedAtInput = toV2DateTimeInput(openedAt);
  const openedAtMinute = parseV2DateTimeInput(openedAtInput);
  const dueAtMinute = parseV2DateTimeInput(addOneInclusiveMonthToV2DateTimeInput(openedAtInput));
  if (!openedAtMinute || !dueAtMinute) return new Date(Number.NaN);
  return new Date(dueAtMinute.getTime() + openedAt.getTime() - openedAtMinute.getTime());
}
