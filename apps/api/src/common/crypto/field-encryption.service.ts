import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'node:crypto';

const ENCRYPTION_VERSION = 'v1';

@Injectable()
export class FieldEncryptionService {
  constructor(private readonly configService: ConfigService) {}

  encrypt(value: string | null | undefined) {
    if (value === null || value === undefined || value === '') {
      return null;
    }

    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.getKey(), iv);
    const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();

    return [
      ENCRYPTION_VERSION,
      iv.toString('base64url'),
      tag.toString('base64url'),
      ciphertext.toString('base64url')
    ].join(':');
  }

  decrypt(value: string | null | undefined) {
    if (!value) {
      return null;
    }

    const [version, iv, tag, ciphertext] = value.split(':');
    if (version !== ENCRYPTION_VERSION || !iv || !tag || !ciphertext) {
      throw new Error('Unsupported encrypted field format');
    }

    const decipher = createDecipheriv('aes-256-gcm', this.getKey(), Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));

    return Buffer.concat([
      decipher.update(Buffer.from(ciphertext, 'base64url')),
      decipher.final()
    ]).toString('utf8');
  }

  hash(value: string | null | undefined) {
    if (value === null || value === undefined || value === '') {
      return null;
    }

    return createHmac('sha256', this.getHashSecret()).update(value.trim()).digest('hex');
  }

  private getKey() {
    const secret =
      this.configService.get<string>('FIELD_ENCRYPTION_KEY') ?? 'development-field-key';
    return createHash('sha256').update(secret).digest();
  }

  private getHashSecret() {
    return this.configService.get<string>('HASH_SECRET') ?? 'development-hash-secret';
  }
}
