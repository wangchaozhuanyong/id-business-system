import type { FieldEncryptionService } from '../../common/crypto/field-encryption.service';
import { buildIdBusinessV2BlindIndexTokens } from '../runtime/public-api';

export function chatgptEmailSearchTokens(email: string, encryption: FieldEncryptionService) {
  return buildIdBusinessV2BlindIndexTokens(email, 'chatgpt-email', (value) =>
    encryption.hash(value)
  );
}
