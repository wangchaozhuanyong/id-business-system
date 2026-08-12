import { BadRequestException } from '@nestjs/common';
import { createHash } from 'node:crypto';

const PREVIEW_FINGERPRINT_PATTERN = /^[a-f0-9]{64}$/;

export function createV2DeletePreviewFingerprint<TImpact extends object>(
  entityType: 'customer' | 'option',
  entityId: string,
  updatedAt: Date,
  impact: TImpact
) {
  return createHash('sha256')
    .update(
      JSON.stringify({
        entityType,
        entityId,
        updatedAt: updatedAt.toISOString(),
        impact: Object.fromEntries(
          Object.entries(impact).sort(([left], [right]) => left.localeCompare(right))
        )
      })
    )
    .digest('hex');
}

export function normalizeV2DeletePreviewFingerprint(value: unknown) {
  const fingerprint = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!PREVIEW_FINGERPRINT_PATTERN.test(fingerprint)) {
    throw new BadRequestException('删除预览已失效，请重新预览后再确认');
  }
  return fingerprint;
}
