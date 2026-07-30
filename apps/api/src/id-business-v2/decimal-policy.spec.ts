import { Prisma } from '@prisma/client';
import { Prisma as CloudflarePrisma } from '../generated/prisma-cloudflare/client';
import { roundV2Decimal, toV2Decimal } from './decimal-policy';

describe('ID Business V2 Decimal policy', () => {
  it('normalizes a Cloudflare Prisma Decimal into the current Prisma runtime', () => {
    const cloudflareValue = new CloudflarePrisma.Decimal('4');
    const normalized = toV2Decimal(cloudflareValue as unknown as Prisma.Decimal.Value);

    expect(normalized).toBeInstanceOf(Prisma.Decimal);
    expect(normalized).not.toBe(cloudflareValue);
    expect(new Prisma.Decimal('128').mul(normalized).div(100).toString()).toBe('5.12');
  });

  it('keeps four decimal places and half-up rounding after normalization', () => {
    const cloudflareValue = new CloudflarePrisma.Decimal('1.23445');

    expect(roundV2Decimal(cloudflareValue as unknown as Prisma.Decimal.Value).toFixed(4)).toBe(
      '1.2345'
    );
  });
});
