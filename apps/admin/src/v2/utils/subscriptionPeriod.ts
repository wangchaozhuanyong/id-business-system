export function calculateOneMonthInclusiveDueAt(openedAt: Date) {
  const dueAt = new Date(openedAt);
  const originalDay = dueAt.getDate();

  dueAt.setDate(1);
  dueAt.setMonth(dueAt.getMonth() + 1);

  const lastDayOfTargetMonth = new Date(dueAt.getFullYear(), dueAt.getMonth() + 1, 0).getDate();
  dueAt.setDate(Math.min(originalDay, lastDayOfTargetMonth));
  dueAt.setDate(dueAt.getDate() - 1);

  return dueAt;
}
