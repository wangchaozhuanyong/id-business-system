import { FieldEncryptionService } from '../../common/crypto/field-encryption.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { toV2DecimalString } from '../decimal-policy';
import { normalizeOptionalString } from './id-business-v2-order-entry-support';

const MAX_CUSTOMERS = 50;

export async function getIdBusinessV2OrderEntryOptions(
  prisma: PrismaService,
  fieldEncryptionService: FieldEncryptionService,
  customerKeywordValue?: string
) {
  const customerKeyword = normalizeOptionalString(customerKeywordValue, '客户搜索', 160);
  const phoneHash = customerKeyword
    ? fieldEncryptionService.hash(customerKeyword.replace(/\s+/g, ''))
    : null;
  const [customers, countries, categories, services, settlementPlatforms] =
    await prisma.$transaction([
      prisma.idBusinessV2Customer.findMany({
        where: {
          deletedAt: null,
          recordStatus: 'active',
          OR: customerKeyword
            ? [
                { name: { contains: customerKeyword, mode: 'insensitive' } },
                { wechat: { contains: customerKeyword, mode: 'insensitive' } },
                {
                  phoneTail: {
                    contains: customerKeyword.slice(-8),
                    mode: 'insensitive'
                  }
                },
                { phoneHash: phoneHash ?? undefined }
              ]
            : undefined
        },
        select: {
          id: true,
          name: true,
          wechat: true,
          phoneMasked: true
        },
        take: MAX_CUSTOMERS,
        orderBy: [{ name: 'asc' }, { id: 'asc' }]
      }),
      prisma.idBusinessV2Option.findMany({
        where: { type: 'country', status: 'active', deletedAt: null },
        select: { id: true, code: true, name: true, currencyCode: true },
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }, { id: 'asc' }]
      }),
      prisma.idBusinessV2Option.findMany({
        where: {
          type: 'business_category',
          status: 'active',
          deletedAt: null,
          parentId: null
        },
        select: { id: true, code: true, name: true },
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }, { id: 'asc' }]
      }),
      prisma.idBusinessV2Option.findMany({
        where: {
          type: 'service',
          status: 'active',
          deletedAt: null,
          businessAmount: { gt: 0 },
          parent: {
            is: { type: 'business_category', status: 'active', deletedAt: null }
          },
          countryOption: {
            is: { type: 'country', status: 'active', deletedAt: null }
          }
        },
        select: {
          id: true,
          code: true,
          name: true,
          parentId: true,
          countryOptionId: true,
          businessAmount: true,
          countryOption: { select: { currencyCode: true } }
        },
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }, { id: 'asc' }]
      }),
      prisma.idBusinessV2Option.findMany({
        where: {
          type: 'settlement_platform',
          status: 'active',
          deletedAt: null
        },
        select: {
          id: true,
          code: true,
          name: true,
          fixedFee: true,
          percentageFee: true
        },
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }, { id: 'asc' }]
      })
    ]);

  return {
    customers: customers.map((customer) => ({
      id: customer.id,
      name: customer.name,
      wechat: customer.wechat,
      maskedPhone: customer.phoneMasked
    })),
    countries: countries.map((country) => ({
      ...country,
      children: categories
        .map((category) => ({
          ...category,
          children: services
            .filter(
              (service) =>
                service.countryOptionId === country.id && service.parentId === category.id
            )
            .map((service) => ({
              id: service.id,
              code: service.code,
              name: service.name,
              businessAmount:
                service.businessAmount === null ? '0' : toV2DecimalString(service.businessAmount),
              currencyCode: service.countryOption?.currencyCode ?? country.currencyCode
            }))
        }))
        .filter((category) => category.children.length > 0)
    })),
    settlementPlatforms: settlementPlatforms.map((platform) => ({
      id: platform.id,
      code: platform.code,
      name: platform.name,
      fixedFee: toV2DecimalString(platform.fixedFee),
      percentageFee: toV2DecimalString(platform.percentageFee)
    }))
  };
}
