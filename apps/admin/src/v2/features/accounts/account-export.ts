import { exportRowsToCsv } from '@/utils/exportCsv';
import { calculateExchangeRate } from './account-form';
import type { V2Account } from './contracts';

export function exportAccountRowsToCsv(rows: V2Account[]) {
  exportRowsToCsv(
    'ID资料',
    [
      { header: 'ID账号（脱敏）', value: (row) => row.appleIdMasked },
      { header: 'ID密码', value: (row) => (row.hasPassword ? '已保存' : '') },
      { header: '手机号码（脱敏）', value: (row) => row.maskedPhone ?? '' },
      { header: '密保', value: (row) => (row.hasSecurityInfo ? '已保存' : '') },
      { header: '国家', value: (row) => row.country.name },
      { header: 'ID状态', value: (row) => row.status.name },
      { header: 'ID供应商', value: (row) => row.supplier?.name ?? '' },
      { header: '余额', value: (row) => row.currentBalance },
      {
        header: '汇率',
        value: (row) => calculateExchangeRate(row.currentBalance, row.balanceCostAmount) ?? ''
      },
      { header: '人民币成本', value: (row) => row.balanceCostAmount },
      { header: 'ID购买成本', value: (row) => row.purchaseCost },
      {
        header: '资料状态',
        value: (row) => (row.recordStatus === 'active' ? '启用' : '停用')
      },
      { header: '备注', value: (row) => row.remark ?? '' },
      { header: '创建时间', value: (row) => formatDate(row.createdAt) },
      { header: '更新时间', value: (row) => formatDate(row.updatedAt) }
    ],
    rows
  );
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).format(new Date(value));
}
