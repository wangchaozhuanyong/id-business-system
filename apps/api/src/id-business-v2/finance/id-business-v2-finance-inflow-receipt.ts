import { BadRequestException, ConflictException } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { FieldEncryptionService } from '../../common/crypto/field-encryption.service';

export const FINANCE_INFLOW_RECEIPT_MAX_BYTES = 5 * 1024 * 1024;

const RECEIPT_MIME_TYPES = new Set(['application/pdf', 'image/jpeg', 'image/png', 'image/webp']);

export interface FinanceInflowReceiptUpload {
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}

export interface PreparedFinanceInflowReceipt {
  id: string;
  originalName: string;
  storageKey: string;
  mimeType: string;
  sizeBytes: bigint;
  contentEncrypted: string;
  contentSha256: string;
}

export function prepareFinanceInflowReceipt(
  file: FinanceInflowReceiptUpload | undefined,
  encryption: FieldEncryptionService
): PreparedFinanceInflowReceipt | null {
  if (!file) return null;
  const content = Buffer.from(file.buffer);
  if (!content.length) throw new BadRequestException('收款凭证文件为空');
  if (content.length > FINANCE_INFLOW_RECEIPT_MAX_BYTES) {
    throw new BadRequestException('收款凭证不能超过 5 MB');
  }
  if (file.size !== content.length) throw new BadRequestException('收款凭证文件大小不一致');

  const mimeType = file.mimetype.trim().toLowerCase();
  if (!RECEIPT_MIME_TYPES.has(mimeType) || !matchesReceiptSignature(content, mimeType)) {
    throw new BadRequestException('收款凭证仅支持 PDF、JPG、PNG 或 WebP 文件');
  }

  const originalName = normalizeReceiptFileName(file.originalname);
  const id = randomUUID();
  const contentEncrypted = encryption.encrypt(content.toString('base64'));
  if (!contentEncrypted) throw new BadRequestException('收款凭证加密失败');
  return {
    id,
    originalName,
    storageKey: `db-encrypted://finance-inflow/${id}`,
    mimeType,
    sizeBytes: BigInt(content.length),
    contentEncrypted,
    contentSha256: createHash('sha256').update(content).digest('hex')
  };
}

export function decryptFinanceInflowReceipt(
  input: {
    contentEncrypted: string | null;
    contentSha256: string | null;
    sizeBytes: bigint;
  },
  encryption: FieldEncryptionService
) {
  if (!input.contentEncrypted || !input.contentSha256) {
    throw new ConflictException('收款凭证文件内容不可用，请补充凭证');
  }
  const decrypted = encryption.decrypt(input.contentEncrypted);
  if (!decrypted) throw new ConflictException('收款凭证解密失败');
  const content = Buffer.from(decrypted, 'base64');
  const sha256 = createHash('sha256').update(content).digest('hex');
  if (sha256 !== input.contentSha256 || BigInt(content.length) !== input.sizeBytes) {
    throw new ConflictException('收款凭证完整性校验失败，请联系管理员');
  }
  return content;
}

function normalizeReceiptFileName(value: string) {
  const rawName = value.split(/[\\/]/).pop()?.trim() ?? '';
  const name = [...rawName]
    .filter((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint >= 32 && codePoint !== 127;
    })
    .join('');
  if (!name) throw new BadRequestException('收款凭证文件名不正确');
  return name.slice(0, 255);
}

function matchesReceiptSignature(content: Buffer, mimeType: string) {
  if (mimeType === 'application/pdf') return content.subarray(0, 5).toString('ascii') === '%PDF-';
  if (mimeType === 'image/jpeg') {
    return content[0] === 0xff && content[1] === 0xd8 && content[2] === 0xff;
  }
  if (mimeType === 'image/png') {
    return content
      .subarray(0, 8)
      .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  }
  return (
    mimeType === 'image/webp' &&
    content.subarray(0, 4).toString('ascii') === 'RIFF' &&
    content.subarray(8, 12).toString('ascii') === 'WEBP'
  );
}
