import { BadRequestException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import type { IdBusinessV2FinanceCurrency, Prisma } from '@prisma/client';
import { Prisma as PrismaNamespace } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import type { AuthenticatedUser } from '../../auth/auth.types';
import { PrismaService } from '../../common/prisma/prisma.service';
import { toKualaLumpurBusinessDate } from './id-business-v2-finance-input';

interface ResolveFinanceRateInput {
  currency: IdBusinessV2FinanceCurrency;
  occurredAt: Date;
  fxRateSnapshotId?: string | null;
  manualRate?: PrismaNamespace.Decimal | null;
  manualReason?: string | null;
  operator?: AuthenticatedUser;
}

@Injectable()
export class IdBusinessV2FinanceFxService {
  constructor(private readonly prisma: PrismaService) {}

  async resolve(input: ResolveFinanceRateInput) {
    if (input.currency === 'CNY') {
      return {
        id: null,
        currency: 'CNY' as const,
        rateToCny: new PrismaNamespace.Decimal(1),
        source: 'cny_fixed' as const
      };
    }
    if (input.fxRateSnapshotId) {
      const existing = await this.prisma.idBusinessV2FinanceFxRateSnapshot.findUnique({
        where: { id: input.fxRateSnapshotId }
      });
      if (!existing || existing.currency !== input.currency) {
        throw new BadRequestException('汇率快照不存在或币种不一致');
      }
      if (existing.expiresAt && existing.expiresAt.getTime() < input.occurredAt.getTime()) {
        throw new BadRequestException('汇率快照已过期，请重新获取或填写人工汇率');
      }
      return existing;
    }
    if (input.manualRate) {
      const reason = input.manualReason?.trim();
      if (!reason || reason.length < 2) {
        throw new BadRequestException('人工汇率必须填写原因');
      }
      return this.prisma.$transaction(async (tx) => {
        const snapshot = await tx.idBusinessV2FinanceFxRateSnapshot.create({
          data: {
            id: randomUUID(),
            currency: input.currency,
            rateToCny: input.manualRate!,
            source: 'manual',
            businessDate: toKualaLumpurBusinessDate(input.occurredAt).date,
            capturedAt: new Date(),
            manualReason: reason,
            createdByUserId: input.operator?.id
          }
        });
        await this.writeAudit(tx, input.operator, snapshot.id, {
          currency: input.currency,
          rateToCny: input.manualRate!.toString(),
          reason
        });
        return snapshot;
      });
    }
    return input.currency === 'USDT'
      ? this.snapshotLatestUsdtRate(input)
      : this.collectMyrCrossRate(input);
  }

  async createManual(
    currency: IdBusinessV2FinanceCurrency,
    rateToCny: PrismaNamespace.Decimal,
    businessDate: Date,
    reason: string,
    sourceReference: string | null,
    operator?: AuthenticatedUser
  ) {
    if (currency === 'CNY' && !rateToCny.equals(1)) {
      throw new BadRequestException('CNY 汇率固定为 1');
    }
    return this.prisma.$transaction(async (tx) => {
      const snapshot = await tx.idBusinessV2FinanceFxRateSnapshot.create({
        data: {
          id: randomUUID(),
          currency,
          rateToCny,
          source: currency === 'CNY' ? 'cny_fixed' : 'manual',
          sourceReference,
          businessDate,
          manualReason: currency === 'CNY' ? null : reason,
          createdByUserId: operator?.id
        }
      });
      await this.writeAudit(tx, operator, snapshot.id, {
        currency,
        rateToCny: rateToCny.toString(),
        businessDate: businessDate.toISOString(),
        reason
      });
      return snapshot;
    });
  }

  async listLatest() {
    const items = await Promise.all(
      (['CNY', 'MYR', 'USDT'] as const).map(async (currency) => {
        if (currency === 'CNY') {
          return {
            id: null,
            currency,
            rateToCny: '1',
            source: 'cny_fixed',
            capturedAt: new Date(),
            expiresAt: null
          };
        }
        const item = await this.prisma.idBusinessV2FinanceFxRateSnapshot.findFirst({
          where: { currency },
          orderBy: [{ capturedAt: 'desc' }, { id: 'desc' }]
        });
        return item
          ? { ...item, rateToCny: item.rateToCny.toString() }
          : {
              id: null,
              currency,
              rateToCny: null,
              source: null,
              capturedAt: null,
              expiresAt: null
            };
      })
    );
    return { items, generatedAt: new Date().toISOString() };
  }

  private async snapshotLatestUsdtRate(input: ResolveFinanceRateInput) {
    const source = await this.prisma.idBusinessV2ExchangeRateSnapshot.findFirst({
      where: {
        asset: 'USDT',
        fiat: 'CNY'
      },
      orderBy: [{ averagedAt: 'desc' }, { id: 'desc' }]
    });
    if (!source) {
      throw new ServiceUnavailableException('缺少 USDT/CNY 汇率，请先完成汇率采集或填写人工汇率');
    }
    const ageMs = input.occurredAt.getTime() - source.averagedAt.getTime();
    if (ageMs > 2 * 60 * 60 * 1000) {
      throw new ServiceUnavailableException('USDT/CNY 汇率已过期，请重新采集或填写人工汇率');
    }
    return this.prisma.idBusinessV2FinanceFxRateSnapshot.create({
      data: {
        id: randomUUID(),
        currency: 'USDT',
        rateToCny: source.midRateToRmb,
        source: 'combined_p2p',
        sourceReference: source.id,
        sourceEvidence: {
          legacySnapshotId: source.id,
          averagedAt: source.averagedAt.toISOString()
        },
        businessDate: toKualaLumpurBusinessDate(input.occurredAt).date,
        capturedAt: source.averagedAt,
        expiresAt: new Date(source.averagedAt.getTime() + 2 * 60 * 60 * 1000),
        createdByUserId: input.operator?.id
      }
    });
  }

  private async collectMyrCrossRate(input: ResolveFinanceRateInput) {
    const [cny, myr] = await Promise.all([
      this.fetchEcbReferenceRate('CNY'),
      this.fetchEcbReferenceRate('MYR')
    ]);
    if (cny.businessDate !== myr.businessDate) {
      throw new ServiceUnavailableException('ECB CNY 与 MYR 参考汇率日期不一致');
    }
    const crossRate = cny.rate
      .div(myr.rate)
      .toDecimalPlaces(8, PrismaNamespace.Decimal.ROUND_HALF_UP);
    return this.prisma.idBusinessV2FinanceFxRateSnapshot.create({
      data: {
        id: randomUUID(),
        currency: 'MYR',
        rateToCny: crossRate,
        source: 'ecb_cross',
        sourceReference: 'ECB EXR.D.CNY.EUR.SP00.A / EXR.D.MYR.EUR.SP00.A',
        sourceEvidence: {
          cnyPerEur: cny.rate.toString(),
          myrPerEur: myr.rate.toString(),
          referenceDate: cny.businessDate
        },
        businessDate: new Date(`${cny.businessDate}T00:00:00.000Z`),
        capturedAt: new Date(),
        expiresAt: new Date(Date.now() + 36 * 60 * 60 * 1000),
        createdByUserId: input.operator?.id
      }
    });
  }

  private async fetchEcbReferenceRate(currency: 'CNY' | 'MYR') {
    const url =
      `https://data-api.ecb.europa.eu/service/data/EXR/D.${currency}.EUR.SP00.A` +
      '?format=csvdata&detail=dataonly&lastNObservations=1';
    let response: Response;
    try {
      response = await fetch(url, { headers: { accept: 'text/csv' } });
    } catch {
      throw new ServiceUnavailableException(`ECB ${currency}/EUR 汇率采集失败`);
    }
    if (!response.ok) {
      throw new ServiceUnavailableException(`ECB ${currency}/EUR 返回 ${response.status}`);
    }
    const csv = await response.text();
    const lines = csv.trim().split(/\r?\n/);
    const headers = this.parseCsvLine(lines[0] ?? '');
    const values = this.parseCsvLine(lines.at(-1) ?? '');
    const dateIndex = headers.indexOf('TIME_PERIOD');
    const valueIndex = headers.indexOf('OBS_VALUE');
    const businessDate = values[dateIndex]?.trim();
    const value = values[valueIndex]?.trim();
    if (!businessDate || !value) {
      throw new ServiceUnavailableException(`ECB ${currency}/EUR 响应缺少有效数据`);
    }
    return { businessDate, rate: new PrismaNamespace.Decimal(value) };
  }

  private parseCsvLine(line: string) {
    const values: string[] = [];
    let current = '';
    let quoted = false;
    for (const character of line) {
      if (character === '"') quoted = !quoted;
      else if (character === ',' && !quoted) {
        values.push(current);
        current = '';
      } else current += character;
    }
    values.push(current);
    return values;
  }

  private writeAudit(
    tx: Prisma.TransactionClient,
    operator: AuthenticatedUser | undefined,
    objectId: string,
    afterData: Prisma.InputJsonValue
  ) {
    return tx.auditLog.create({
      data: {
        userId: operator?.id,
        module: 'id_business_v2_finance',
        action: 'id_business_v2.finance.fx_rate.manual',
        objectType: 'id_business_v2_finance_fx_rate_snapshot',
        objectId,
        afterData,
        remark: '记录财务人工汇率'
      }
    });
  }
}
