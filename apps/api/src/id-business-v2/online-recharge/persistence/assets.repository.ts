import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException
} from '@nestjs/common';
import { randomInt } from 'node:crypto';
import type { AuthenticatedUser } from '../../../auth/auth.types';
import { FieldEncryptionService } from '../../../common/crypto/field-encryption.service';
import { ONLINE_RECHARGE_PERMISSION } from '../contracts';
import { OnlineRechargeEphemeralCredentials } from '../ephemeral-credentials.service';
import { OnlineRechargeRepository } from './online-recharge.repository';
import { id, ids, integer, object, plan, text, activeTaskStatuses } from '../validation';
import { createOnlineRechargeCodes } from '../cdk-generator';
import { parseOnlineRechargeProxy } from '../proxy-input';

const locations: [string, string, string[]][] = [
  ['Portland', 'Oregon', ['97201', '97205', '97209', '97214']],
  ['Salem', 'Oregon', ['97301', '97302', '97306']],
  ['Eugene', 'Oregon', ['97401', '97402', '97404']],
  ['Wilmington', 'Delaware', ['19801', '19802', '19805']],
  ['Dover', 'Delaware', ['19901', '19904']],
  ['Billings', 'Montana', ['59101', '59102', '59105']],
  ['Missoula', 'Montana', ['59801', '59802']],
  ['Manchester', 'New Hampshire', ['03101', '03102', '03104']],
  ['Nashua', 'New Hampshire', ['03060', '03062']],
  ['Anchorage', 'Alaska', ['99501', '99503', '99508']],
  ['Fairbanks', 'Alaska', ['99701', '99709']]
];
const streets = [
  'Main St',
  'Oak Ave',
  'Maple Dr',
  'Cedar Ln',
  'Park Blvd',
  'Washington St',
  'Lake View Rd',
  'Highland Ave',
  'Pine St',
  'Elm St'
];

export function assertOnlineSensitive(operator: AuthenticatedUser) {
  if (
    !operator.roles.includes('admin') &&
    !operator.permissions.includes(ONLINE_RECHARGE_PERMISSION.sensitive)
  )
    throw new ForbiddenException('没有查看敏感资料的权限');
  if (
    !operator.roles.includes('admin') &&
    operator.sensitiveApprovalPermissionCodes?.includes(ONLINE_RECHARGE_PERMISSION.sensitive)
  )
    throw new ForbiddenException('该角色取密必须经过审批，请由管理员处理本次资料查看');
}

@Injectable()
export class OnlineRechargeAssetsRepository {
  constructor(
    private readonly repository: OnlineRechargeRepository,
    private readonly encryption: FieldEncryptionService,
    private readonly memory: OnlineRechargeEphemeralCredentials
  ) {}
  async action(section: string, action: string, raw: unknown, operator: AuthenticatedUser) {
    const input = object(raw);
    if (section === 'cards') return this.cards(action, input, operator);
    if (section === 'proxies') return this.proxies(action, input, operator);
    if (section === 'addresses') return this.addresses(action, input, operator);
    if (section === 'cdks') return this.codes(action, input, operator);
    throw new BadRequestException('不支持该资源操作');
  }
  async importCards(raw: unknown, operator?: AuthenticatedUser) {
    if (!Array.isArray(raw) || !raw.length || raw.length > 500)
      throw new BadRequestException('每次须导入1至500张卡');
    const parsed = raw.map((value) => {
      const row = object(value);
      const number = text(row.number ?? row.card_number, '卡号', 32).replace(/[\s-]/g, '');
      if (!/^\d{13,19}$/.test(number)) throw new BadRequestException('卡号须为13至19位数字');
      const expiry = typeof row.card_expiry === 'string' ? row.card_expiry.split('/') : [];
      const expiryMonth = integer(row.expiryMonth ?? expiry[0], '有效月份', 1, 12);
      let expiryYear = integer(row.expiryYear ?? expiry[1], '有效年份', 0, 9999);
      if (expiryYear < 100) expiryYear += 2000;
      const cvc = row.cvc ?? row.card_cvc;
      if (cvc !== undefined && (typeof cvc !== 'string' || !/^\d{3,4}$/.test(cvc)))
        throw new BadRequestException('安全码格式无效');
      return {
        number,
        expiryMonth,
        expiryYear,
        holderName: text(row.holderName ?? row.card_holder ?? '', '持卡姓名', 120, false),
        addressId: row.addressId ? id(row.addressId) : null,
        cvc: cvc as string | undefined
      };
    });
    const saved = await this.repository.transaction('cards-import', async (tx) => {
      const rows: { id: string; cvc?: string; inserted: boolean }[] = [];
      for (const card of parsed) {
        const numberHash = this.encryption.hash(card.number)!;
        let row = await tx.onlineRechargeCard.findUnique({ where: { numberHash } });
        if (
          card.addressId &&
          !(await tx.onlineRechargeAddress.findFirst({
            where: { id: card.addressId, active: true }
          }))
        )
          throw new BadRequestException('账单地址不存在');
        const inserted = !row;
        if (!row)
          row = await tx.onlineRechargeCard.create({
            data: {
              numberHash,
              numberEncrypted: this.encryption.encrypt(card.number)!,
              last4: card.number.slice(-4),
              expiryMonth: card.expiryMonth,
              expiryYear: card.expiryYear,
              holderName: card.holderName,
              addressId: card.addressId
            }
          });
        rows.push({ id: row.id, cvc: card.cvc, inserted });
      }
      await this.repository.log(tx, 'cards.import', operator, undefined, {
        count: rows.filter((row) => row.inserted).length,
        duplicates: rows.filter((row) => !row.inserted).length
      });
      return rows;
    });
    let credentialsAvailable = true;
    try {
      await this.memory.putCards(
        saved
          .filter((row): row is typeof row & { cvc: string } => Boolean(row.cvc))
          .map((row) => ({ id: row.id, cvc: row.cvc }))
      );
    } catch {
      credentialsAvailable = false;
    }
    return {
      success: true,
      inserted: saved.filter((row) => row.inserted).length,
      duplicates: saved.filter((row) => !row.inserted).length,
      ids: saved.map((row) => row.id),
      credentialsAvailable,
      ...(credentialsAvailable
        ? {}
        : { message: '银行卡已入库；执行器未连接，安全码未保存，启动执行器后请重新补充' })
    };
  }
  private async cards(action: string, input: Record<string, unknown>, operator: AuthenticatedUser) {
    if (action === 'import') return this.importCards(input.cards, operator);
    const rowId = id(input.id);
    if (action === 'cvc') {
      const row = await this.repository.read((db) =>
        db.onlineRechargeCard.findUnique({ where: { id: rowId } })
      );
      if (!row) throw new NotFoundException('银行卡不存在');
      await this.memory.putCvc(rowId, input.cvc);
      await this.repository.transaction(`card:${rowId}`, async (tx) => {
        await tx.onlineRechargeTask.updateMany({
          where: { status: 'awaiting_credentials', cardId: rowId, paymentStarted: false },
          data: { status: 'queued', message: '安全码已补充，等待执行' }
        });
        await this.repository.log(tx, 'cards.credentials', operator, rowId);
      });
      return { success: true, hasCvc: true };
    }
    return this.repository.transaction(`card:${rowId}`, async (tx) => {
      const row = await tx.onlineRechargeCard.findUnique({ where: { id: rowId } });
      if (!row) throw new NotFoundException('银行卡不存在');
      if (action === 'reveal') {
        assertOnlineSensitive(operator);
        text(input.reason, '查看原因', 500);
        await this.repository.log(tx, 'cards.reveal', operator, rowId, {
          reason: input.reason,
          fields: ['卡号']
        });
        return {
          number: this.encryption.decrypt(row.numberEncrypted),
          expiryMonth: row.expiryMonth,
          expiryYear: row.expiryYear,
          holderName: row.holderName
        };
      }
      if (
        row.leaseOwner ||
        (await tx.onlineRechargeTask.count({
          where: { cardId: rowId, status: { in: [...activeTaskStatuses] } }
        }))
      )
        throw new ConflictException('银行卡关联执行中或待核对任务，不能更改');
      if (action === 'delete') {
        await tx.onlineRechargeCard.delete({ where: { id: rowId } });
        await this.memory.forgetCvc(rowId);
      } else if (action === 'update' || action === 'status') {
        const status = input.status ?? row.status;
        if (!['active', 'disabled', 'exhausted', 'retired'].includes(String(status)))
          throw new BadRequestException('银行卡状态无效');
        const addressId =
          input.addressId === null ? null : input.addressId ? id(input.addressId) : row.addressId;
        if (
          addressId &&
          !(await tx.onlineRechargeAddress.findFirst({ where: { id: addressId, active: true } }))
        )
          throw new BadRequestException('地址不存在');
        await tx.onlineRechargeCard.update({
          where: { id: rowId },
          data: { status: status as typeof row.status, addressId }
        });
      } else throw new BadRequestException('不支持该银行卡操作');
      await this.repository.log(tx, `cards.${action}`, operator, rowId);
      return { success: true };
    });
  }
  private async proxies(
    action: string,
    input: Record<string, unknown>,
    operator: AuthenticatedUser
  ) {
    if (action === 'import') {
      const values = input.proxies;
      if (!Array.isArray(values) || !values.length || values.length > 500)
        throw new BadRequestException('每次须导入1至500条代理');
      const parsed = values.map((value) => {
        const proxy = parseOnlineRechargeProxy(value);
        return {
          connectionEncrypted: this.encryption.encrypt(proxy.raw)!,
          connectionHash: this.encryption.hash(proxy.raw)!,
          displayHost: proxy.displayHost,
          protocol: proxy.protocol
        };
      });
      return this.repository.transaction('proxies-import', async (tx) => {
        const result = await tx.onlineRechargeProxy.createMany({
          data: parsed,
          skipDuplicates: true
        });
        await this.repository.log(tx, 'proxies.import', operator, undefined, {
          count: result.count
        });
        return { success: true, inserted: result.count, duplicates: values.length - result.count };
      });
    }
    const selected = ids(input);
    return this.repository.transaction('proxies-update', async (tx) => {
      if (action === 'delete')
        await tx.onlineRechargeProxy.deleteMany({ where: { id: { in: selected } } });
      else if (action === 'update' || action === 'status') {
        if (!['active', 'disabled'].includes(String(input.status)))
          throw new BadRequestException('代理状态无效');
        await tx.onlineRechargeProxy.updateMany({
          where: { id: { in: selected } },
          data: { status: input.status as 'active' | 'disabled' }
        });
      } else throw new BadRequestException('不支持该代理操作');
      await this.repository.log(tx, `proxies.${action}`, operator, undefined, { ids: selected });
      return { success: true };
    });
  }
  private address(value: Record<string, unknown>) {
    const region = text(value.region ?? 'US', '支付地区', 2);
    if (!['US', 'PH', 'SG', 'MY'].includes(region)) throw new BadRequestException('支付地区无效');
    const country = text(value.country ?? 'US', '国家', 2);
    if (!/^[A-Z]{2}$/.test(country)) throw new BadRequestException('国家格式无效');
    return {
      region,
      country,
      firstName: text(value.firstName ?? '', '名字', 80, false),
      lastName: text(value.lastName ?? '', '姓氏', 80, false),
      street: text(value.street ?? value.line1, '街道', 200),
      city: text(value.city, '城市', 100),
      state: text(value.state, '州', 100),
      postalCode: text(value.postalCode ?? value.postal_code, '邮编', 20)
    };
  }
  private async addresses(
    action: string,
    input: Record<string, unknown>,
    operator: AuthenticatedUser
  ) {
    return this.repository.transaction('addresses-update', async (tx) => {
      let result: unknown;
      if (action === 'create')
        result = await tx.onlineRechargeAddress.create({ data: this.address(input) });
      else if (action === 'generate') {
        const count = integer(input.count ?? 10, '生成数量', 1, 100),
          generated: string[] = [];
        for (let n = 0; n < count; n++) {
          const [city, state, postalCodes] = locations[randomInt(locations.length)];
          const row = await tx.onlineRechargeAddress.create({
            data: {
              street: `${randomInt(100, 9000)} ${streets[randomInt(streets.length)]}`,
              city,
              state,
              postalCode: postalCodes[randomInt(postalCodes.length)],
              country: 'US'
            }
          });
          generated.push(row.id);
        }
        result = { success: true, count, ids: generated };
      } else {
        const selected =
          action === 'clear-unbound'
            ? (
                await tx.onlineRechargeAddress.findMany({
                  where: { active: true, successCount: 0, region: String(input.region ?? 'US') },
                  select: { id: true }
                })
              ).map((row) => row.id)
            : ids(input);
        if (
          await tx.onlineRechargeCard.count({
            where: { addressId: { in: selected }, leaseOwner: { not: null } }
          })
        )
          throw new ConflictException('地址正在使用中');
        if (
          await tx.onlineRechargeAddress.count({
            where: { id: { in: selected }, successCount: { gt: 0 } }
          })
        )
          throw new ConflictException('已绑定成功支付的地址不能修改或删除');
        if (action === 'update') {
          const existing = await tx.onlineRechargeAddress.findFirst({
            where: { id: selected[0], active: true }
          });
          if (!existing) throw new NotFoundException('地址不存在');
          result = await tx.onlineRechargeAddress.update({
            where: { id: selected[0] },
            data: this.address({ ...existing, ...input })
          });
        } else if (action === 'delete' || action === 'clear-unbound')
          result = await tx.onlineRechargeAddress.updateMany({
            where: { id: { in: selected } },
            data: { active: false }
          });
        else throw new BadRequestException('不支持该地址操作');
      }
      await this.repository.log(tx, `addresses.${action}`, operator);
      return result;
    });
  }
  private async codes(action: string, input: Record<string, unknown>, operator: AuthenticatedUser) {
    return this.repository.transaction('codes-update', async (tx) => {
      if (action === 'generate' || action === 'import') {
        const targetPlan = plan(input.plan);
        const values = action === 'generate' ? createOnlineRechargeCodes(input.count) : input.codes;
        if (!Array.isArray(values) || !values.length || values.length > 500)
          throw new BadRequestException('每次须导入1至500个兑换码');
        const codes = values.map((value) => text(value, '兑换码', 190));
        const result = await tx.onlineRechargeCode.createMany({
          data: codes.map((code) => ({
            codeEncrypted: this.encryption.encrypt(code)!,
            codeHash: this.encryption.hash(code)!,
            codeLast4: code.slice(-4),
            plan: targetPlan
          })),
          skipDuplicates: true
        });
        const createdRows = await tx.onlineRechargeCode.findMany({
          where: { codeHash: { in: codes.map((code) => this.encryption.hash(code)!) } },
          select: { id: true }
        });
        await this.repository.log(tx, `cdks.${action}`, operator, undefined, {
          count: result.count,
          plan: targetPlan
        });
        return {
          success: true,
          inserted: result.count,
          duplicates: codes.length - result.count,
          ids: createdRows.map((row) => row.id),
          codes: action === 'generate' ? codes : undefined
        };
      }
      const selected = ids(input),
        rows = await tx.onlineRechargeCode.findMany({ where: { id: { in: selected } } });
      if (rows.length !== selected.length) throw new NotFoundException('兑换码不存在');
      if (action === 'reveal' || action === 'export') {
        assertOnlineSensitive(operator);
        await this.repository.log(tx, `cdks.${action}`, operator, undefined, {
          ids: selected,
          reason: text(input.reason ?? '出库复制', '查看原因', 500)
        });
        const codes = rows.map((row) => this.encryption.decrypt(row.codeEncrypted)!);
        return { codes, code: codes[0], content: codes.join('\n'), filename: '线上代充兑换码.txt' };
      }
      if (rows.some((row) => row.status === 'reserved'))
        throw new ConflictException('兑换码正在执行或待核对');
      if (action === 'dispatch')
        await tx.onlineRechargeCode.updateMany({
          where: { id: { in: selected } },
          data: { dispatched: true }
        });
      else if (action === 'delete') {
        await tx.onlineRechargeCode.updateMany({
          where: { id: { in: selected } },
          data: { deletedAt: new Date() }
        });
      } else throw new BadRequestException('不支持该兑换码操作');
      await this.repository.log(tx, `cdks.${action}`, operator, undefined, { ids: selected });
      return { success: true };
    });
  }
}
