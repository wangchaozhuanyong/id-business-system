import { BadRequestException } from '@nestjs/common';
import type { AuditLogsService } from '../../audit-logs/audit-logs.service';
import type { AuthenticatedUser } from '../../auth/auth.types';
import type { CreateIdBusinessV2AccountDto } from './dto/create-id-business-v2-account.dto';
import type { ImportIdBusinessV2AccountsDto } from './dto/import-id-business-v2-accounts.dto';
import { toAuditJson } from './id-business-v2-account-support';

const MAX_ACCOUNT_IMPORT_ROWS = 500;

export async function importAccountRows(
  dto: ImportIdBusinessV2AccountsDto,
  createAccount: (
    input: CreateIdBusinessV2AccountDto,
    operator?: AuthenticatedUser
  ) => Promise<unknown>,
  auditLogsService: AuditLogsService,
  operator?: AuthenticatedUser
) {
  if (!Array.isArray(dto?.rows) || dto.rows.length === 0) {
    throw new BadRequestException('导入数据不能为空');
  }
  if (dto.rows.length > MAX_ACCOUNT_IMPORT_ROWS) {
    throw new BadRequestException(`单次最多导入 ${MAX_ACCOUNT_IMPORT_ROWS} 条 ID 资料`);
  }

  const failures: Array<{ rowNumber: number; reason: string }> = [];
  let successCount = 0;
  for (const [index, input] of dto.rows.entries()) {
    const rowNumber = normalizeImportRowNumber(input?.rowNumber, index);
    try {
      if (!input || typeof input !== 'object') {
        throw new BadRequestException('行数据格式无效');
      }
      const accountDto = { ...input };
      delete accountDto.rowNumber;
      await createAccount(accountDto, operator);
      successCount += 1;
    } catch (error) {
      failures.push({ rowNumber, reason: getImportErrorMessage(error) });
    }
  }

  await auditLogsService.create({
    userId: operator?.id,
    module: 'id_business_v2_accounts',
    action: 'id_business_v2.account.import',
    objectType: 'id_business_v2_account',
    afterData: toAuditJson({
      totalCount: dto.rows.length,
      successCount,
      failedCount: failures.length,
      failedRowNumbers: failures.map((item) => item.rowNumber)
    }),
    remark: `导入 V2 ID：成功 ${successCount} 条，失败 ${failures.length} 条`
  });

  return {
    totalCount: dto.rows.length,
    successCount,
    failedCount: failures.length,
    failures
  };
}

function normalizeImportRowNumber(value: unknown, index: number) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 2 ? parsed : index + 2;
}

function getImportErrorMessage(error: unknown) {
  const message = error instanceof Error ? error.message.trim() : '导入失败';
  return (message || '导入失败').slice(0, 300);
}
