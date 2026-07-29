import { exportRowsToCsv } from '@/utils/exportCsv';
import { resolveAccountCountryCsvHeader } from '@/v2/utils/csv';
import { V2_DECIMAL_PLACES, isV2UnsignedDecimal } from '@/v2/utils/decimal';
import {
  calculateBalanceCost,
  isNonNegativeExchangeRate,
  normalizeDecimalInput
} from './account-form';
import type { ImportV2AccountRowInput, V2OptionSelector, V2RecordStatus } from './contracts';

export interface AccountImportFailure {
  rowNumber: number;
  reason: string;
}

interface AccountImportOptions {
  countries: V2OptionSelector[];
  statuses: V2OptionSelector[];
  suppliers: V2OptionSelector[];
}

const ACCOUNT_IMPORT_HEADERS = [
  'ID账号',
  'ID密码',
  '手机号码',
  '密保',
  '国家',
  'ID状态',
  'ID供应商',
  '余额',
  '汇率',
  '人民币成本',
  'ID购买成本',
  '资料状态',
  '备注'
] as const;

export function downloadAccountImportTemplate() {
  exportRowsToCsv<Record<string, string>>(
    'ID录入导入模板',
    ACCOUNT_IMPORT_HEADERS.map((header) => ({
      header,
      value: () => ''
    })),
    []
  );
}

export function prepareAccountImport(csvRows: string[][], options: AccountImportOptions) {
  if (!csvRows.length) {
    throw new Error('CSV 文件不能为空');
  }

  const headers = csvRows[0]!.map((header) => header.trim());
  const duplicateHeader = headers.find(
    (header, index) => header && headers.indexOf(header) !== index
  );
  if (duplicateHeader) {
    throw new Error(`CSV 表头重复：${duplicateHeader}`);
  }
  for (const requiredHeader of ['ID账号', 'ID状态']) {
    if (!headers.includes(requiredHeader)) {
      throw new Error(`CSV 缺少必填表头：${requiredHeader}`);
    }
  }
  const countryHeader = resolveAccountCountryCsvHeader(headers);
  if (!countryHeader) {
    throw new Error('CSV 缺少必填表头：国家');
  }

  const sourceRows = csvRows.slice(1).filter((row) => row.some((cell) => cell.trim()));
  if (!sourceRows.length) {
    throw new Error('CSV 文件没有可导入的数据');
  }
  if (sourceRows.length > 500) {
    throw new Error('单次最多导入 500 条 ID 资料，请拆分文件');
  }

  const rows: ImportV2AccountRowInput[] = [];
  const failures: AccountImportFailure[] = [];
  const seenAppleIds = new Set<string>();

  sourceRows.forEach((row, index) => {
    const rowNumber = index + 2;
    const value = (header: string) => row[headers.indexOf(header)]?.trim() ?? '';

    try {
      const appleId = value('ID账号').toLocaleLowerCase('en-US');
      if (!appleId) throw new Error('ID账号不能为空');
      if (seenAppleIds.has(appleId)) throw new Error('本次导入文件内 ID账号重复');
      seenAppleIds.add(appleId);

      const currentBalance = parseImportDecimal(value('余额'), '余额');
      const exchangeRate = parseImportExchangeRate(value('汇率'));
      const calculatedBalanceCost = exchangeRate
        ? calculateBalanceCost(currentBalance, exchangeRate)
        : null;

      rows.push({
        rowNumber,
        appleId,
        password: value('ID密码') || null,
        phone: value('手机号码') || null,
        securityInfo: value('密保') || null,
        countryOptionId: resolveRequiredImportOption(
          value(countryHeader),
          options.countries,
          '国家'
        ),
        statusOptionId: resolveRequiredImportOption(value('ID状态'), options.statuses, 'ID状态'),
        supplierOptionId: resolveOptionalImportOption(
          value('ID供应商'),
          options.suppliers,
          'ID供应商'
        ),
        currentBalance,
        balanceCostAmount:
          calculatedBalanceCost ?? parseImportDecimal(value('人民币成本'), '人民币成本'),
        purchaseCost: parseImportDecimal(value('ID购买成本'), 'ID购买成本'),
        recordStatus: parseImportRecordStatus(value('资料状态')),
        remark: value('备注') || null
      });
    } catch (error) {
      failures.push({
        rowNumber,
        reason: error instanceof Error ? error.message : '数据格式无效'
      });
    }
  });

  return { sourceRowCount: sourceRows.length, rows, failures };
}

function findImportOption(rawValue: string, options: V2OptionSelector[]) {
  const normalized = rawValue.trim().toLocaleLowerCase('zh-CN');
  if (!normalized) return null;
  return (
    options.find(
      (item) =>
        item.id.toLocaleLowerCase('en-US') === normalized ||
        item.code.toLocaleLowerCase('en-US') === normalized ||
        item.name.toLocaleLowerCase('zh-CN') === normalized
    ) ?? null
  );
}

function resolveRequiredImportOption(rawValue: string, options: V2OptionSelector[], label: string) {
  if (!rawValue.trim()) throw new Error(`${label}不能为空`);
  const option = findImportOption(rawValue, options);
  if (!option) throw new Error(`${label}“${rawValue}”不存在或已停用`);
  return option.id;
}

function resolveOptionalImportOption(rawValue: string, options: V2OptionSelector[], label: string) {
  if (!rawValue.trim()) return null;
  return resolveRequiredImportOption(rawValue, options, label);
}

function parseImportDecimal(rawValue: string, label: string) {
  const value = rawValue || '0';
  if (!isV2UnsignedDecimal(value)) {
    throw new Error(`${label}必须是最多 ${V2_DECIMAL_PLACES} 位小数的非负数字`);
  }
  return value;
}

function parseImportExchangeRate(rawValue: string) {
  if (!rawValue) return '';
  if (!isNonNegativeExchangeRate(rawValue)) {
    throw new Error(`汇率必须是最多 ${V2_DECIMAL_PLACES} 位小数的非负数字`);
  }
  return normalizeDecimalInput(rawValue);
}

function parseImportRecordStatus(rawValue: string): V2RecordStatus {
  const value = rawValue.trim().toLocaleLowerCase('zh-CN');
  if (!value || value === '启用' || value === 'active') return 'active';
  if (value === '停用' || value === 'disabled') return 'disabled';
  throw new Error('资料状态只能填写“启用”或“停用”');
}
