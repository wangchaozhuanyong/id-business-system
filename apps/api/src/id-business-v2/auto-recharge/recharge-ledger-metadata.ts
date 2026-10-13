import { ConflictException } from '@nestjs/common';

const resolutionKeys = [
  'operator_resolution',
  'resolved_at',
  'resolution_job_id',
  'source_job_id',
  'verification_job_id'
];

/** These fields originate in the server's authenticated resolution transaction. */
export function preserveRechargeResolutionMetadata(
  previous: Record<string, unknown> | undefined,
  input: Record<string, unknown>,
  replacingCycle: boolean
) {
  const metadata: Record<string, unknown> = {};
  for (const key of resolutionKeys) {
    if (input[key] !== undefined && (replacingCycle || input[key] !== previous?.[key]))
      throw new ConflictException('历史付款处理标记只能由服务端写入，不能伪造或变更');
    if (!replacingCycle && previous?.[key] !== undefined) metadata[key] = previous[key];
  }
  return metadata;
}
