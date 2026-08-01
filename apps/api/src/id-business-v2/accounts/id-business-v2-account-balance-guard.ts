import { ConflictException } from '@nestjs/common';
export function assertAccountLossNotReported(lossReportedAt: Date | null, message: string) {
  if (lossReportedAt) throw new ConflictException(message);
}
