import { randomUUID } from 'node:crypto';

export const tenantCardLimit = 99;
export function stageInitialTenantCards(previous, next, existing = [], makeId = () => 'tenant:' + randomUUID()) {
  const prior = new Set((previous?.tenants || []).map(row => row.id));
  const additions = [], targets = [];
  for (const tenant of next?.tenants || []) {
    if (!Object.hasOwn(tenant, 'initialCards')) continue;
    if (prior.has(tenant.id)) throw new Error('已有租户请通过银行卡管理添加银行卡');
    if (!Array.isArray(tenant.initialCards) || tenant.initialCards.length > tenantCardLimit)
      throw new Error('每位租户最多登记 99 张银行卡');
    const seen = new Set(existing.filter(row => row.tenantId === tenant.id).map(row => row.number));
    for (const [index, item] of tenant.initialCards.entries()) {
      const number = typeof item?.number === 'string' ? item.number.replace(/[ -]/g, '') : '';
      const label = typeof item?.label === 'string' ? item.label.trim() : '';
      if (!item || Object.keys(item).some(key => !['number', 'label'].includes(key)) ||
          !/^\d{12,19}$/.test(number) || label.length > 80 || /[\x00-\x1f\x7f]/.test(label))
        throw new Error(`第 ${index + 1} 张银行卡格式不正确`);
      if (seen.has(number)) throw new Error('同一租户不能重复登记相同银行卡');
      seen.add(number);
      if (seen.size > tenantCardLimit) throw new Error('每位租户最多登记 99 张银行卡');
      additions.push({ id: makeId(), tenantId: tenant.id, number, label: label || `银行卡 ${index + 1}`, active: true });
    }
    targets.push(tenant);
  }
  for (const tenant of targets) delete tenant.initialCards;
  return { additions, targets: targets.map(row => row.id) };
}
