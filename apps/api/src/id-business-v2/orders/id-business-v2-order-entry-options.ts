import { FieldEncryptionService } from '../../common/crypto/field-encryption.service';
import { buildIdBusinessV2BlindQueryTokens } from '../runtime/public-api';
import { normalizeOptionalString } from './id-business-v2-order-entry-support';
import { IdBusinessV2OrdersRepository } from './persistence/id-business-v2-orders.repository';

const MAX_CUSTOMERS = 50;

export async function getIdBusinessV2OrderEntryOptions(
  repository: IdBusinessV2OrdersRepository,
  fieldEncryptionService: FieldEncryptionService,
  customerKeywordValue?: string
) {
  const customerKeyword = normalizeOptionalString(customerKeywordValue, '客户搜索', 160);
  const normalizedContact = customerKeyword ? customerKeyword.replace(/[\s()-]/g, '') : null;
  const contactHash = fieldEncryptionService.hash(normalizedContact);
  return repository.getEntryOptions({
    customerKeyword,
    normalizedContact,
    contactHash,
    phoneSearchTokens: buildIdBusinessV2BlindQueryTokens(
      normalizedContact,
      'customer-phone',
      (value) => fieldEncryptionService.hash(value)
    ),
    wechatSearchTokens: buildIdBusinessV2BlindQueryTokens(
      customerKeyword,
      'customer-wechat',
      (value) => fieldEncryptionService.hash(value)
    ),
    qqSearchTokens: buildIdBusinessV2BlindQueryTokens(customerKeyword, 'customer-qq', (value) =>
      fieldEncryptionService.hash(value)
    ),
    whatsappSearchTokens: buildIdBusinessV2BlindQueryTokens(
      normalizedContact,
      'customer-whatsapp',
      (value) => fieldEncryptionService.hash(value)
    ),
    maximumCustomers: MAX_CUSTOMERS
  });
}
