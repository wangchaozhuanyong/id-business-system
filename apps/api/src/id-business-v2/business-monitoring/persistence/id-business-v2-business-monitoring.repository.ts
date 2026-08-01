import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../common/prisma/prisma.service';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export interface BusinessMonitoringFindingRow {
  id: string;
  ruleKey: string;
  category: string;
  severity: string;
  subject: string;
  description: string;
  detectedAt: Date;
  sourceType: string;
  sourceId: string;
  route: string;
}

export interface BusinessMonitoringSummaryRow {
  severity: string;
  category: string;
  count: bigint;
}

export interface BusinessMonitoringPage {
  items: BusinessMonitoringFindingRow[];
  filteredCountRows: Array<{ count: bigint }>;
  summaryRows: BusinessMonitoringSummaryRow[];
}

@Injectable()
export class IdBusinessV2BusinessMonitoringRepository {
  constructor(private readonly prisma: PrismaService) {}

  async getRenewalWarningDays() {
    const setting = await this.prisma.idBusinessV2RenewalWarningSetting.findUnique({
      where: { scope: 'global' },
      select: { warningDays: true }
    });
    return Math.min(365, Math.max(1, setting?.warningDays ?? 3));
  }

  loadPage(input: {
    now: Date;
    warningDays: number;
    severity: string | null;
    category: string | null;
    skip: number;
    take: number;
  }): Promise<BusinessMonitoringPage> {
    const findings = this.findingsSql(input.now, input.warningDays);
    const filters = Prisma.sql`
      WHERE (${input.severity}::text IS NULL OR "severity" = ${input.severity})
        AND (${input.category}::text IS NULL OR "category" = ${input.category})
    `;

    return Promise.all([
      this.prisma.$queryRaw<BusinessMonitoringFindingRow[]>(Prisma.sql`
        WITH "findings" AS (${findings})
        SELECT "id", "ruleKey", "category", "severity", "subject", "description",
          "detectedAt", "sourceType", "sourceId", "route"
        FROM "findings"
        ${filters}
        ORDER BY "severityRank" ASC, "detectedAt" DESC, "id" ASC
        LIMIT ${input.take} OFFSET ${input.skip}
      `),
      this.prisma.$queryRaw<Array<{ count: bigint }>>(Prisma.sql`
        WITH "findings" AS (${findings})
        SELECT COUNT(*)::bigint AS "count" FROM "findings" ${filters}
      `),
      this.prisma.$queryRaw<BusinessMonitoringSummaryRow[]>(Prisma.sql`
        WITH "findings" AS (${findings})
        SELECT "severity", "category", COUNT(*)::bigint AS "count"
        FROM "findings"
        GROUP BY "severity", "category"
      `)
    ]).then(([items, filteredCountRows, summaryRows]) => ({
      items,
      filteredCountRows,
      summaryRows
    }));
  }

  private findingsSql(now: Date, warningDays: number) {
    const stalledBefore = new Date(now.getTime() - DAY_MS);
    const failedSince = new Date(now.getTime() - DAY_MS);
    const warningEnd = new Date(now.getTime() + warningDays * DAY_MS);
    return Prisma.sql`
      SELECT
        CONCAT('order:', o."id", ':failed') AS "id",
        'order_failed'::text AS "ruleKey",
        'order'::text AS "category",
        'critical'::text AS "severity",
        1::int AS "severityRank",
        o."order_no"::text AS "subject",
        '订单当前状态为失败，请复核并修正源订单。'::text AS "description",
        o."status_changed_at" AS "detectedAt",
        'order'::text AS "sourceType",
        o."id"::text AS "sourceId",
        '/v2/orders'::text AS "route"
      FROM "id_business_v2_orders" o
      WHERE o."deleted_at" IS NULL AND o."status"::text = 'failed'

      UNION ALL

      SELECT
        CONCAT('order:', o."id", ':stalled'), 'order_stalled', 'order', 'warning', 2,
        o."order_no"::text,
        '订单超过 24 小时未更新，请确认是否继续处理。',
        o."updated_at", 'order', o."id"::text, '/v2/orders'
      FROM "id_business_v2_orders" o
      WHERE o."deleted_at" IS NULL
        AND o."status"::text IN ('draft', 'pending', 'waiting_external', 'processing')
        AND o."updated_at" < ${stalledBefore}

      UNION ALL

      SELECT
        CONCAT('activation:', a."id", ':overdue'), 'renewal_overdue', 'renewal', 'critical', 1,
        CONCAT(c."name", ' · ', s."name"),
        '开通记录已超过到期时间，请续费或修正状态。',
        a."due_at", 'activation', a."id"::text, '/v2/workbench/renewals'
      FROM "id_business_v2_activations" a
      JOIN "id_business_v2_customers" c ON c."id" = a."customer_id"
      JOIN "id_business_v2_options" s ON s."id" = a."service_option_id"
      WHERE a."status"::text = 'active' AND a."due_at" < ${now}

      UNION ALL

      SELECT
        CONCAT('activation:', a."id", ':due-soon'), 'renewal_due_soon', 'renewal', 'warning', 2,
        CONCAT(c."name", ' · ', s."name"),
        '开通记录已进入续费预警窗口。',
        a."due_at", 'activation', a."id"::text, '/v2/workbench/renewals'
      FROM "id_business_v2_activations" a
      JOIN "id_business_v2_customers" c ON c."id" = a."customer_id"
      JOIN "id_business_v2_options" s ON s."id" = a."service_option_id"
      WHERE a."status"::text = 'active' AND a."due_at" >= ${now} AND a."due_at" < ${warningEnd}

      UNION ALL

      SELECT
        CONCAT('activation:', a."id", ':abnormal'), 'activation_abnormal', 'renewal', 'critical', 1,
        CONCAT(c."name", ' · ', s."name"),
        '开通记录当前状态为异常，请复核源订单和到期信息。',
        a."status_changed_at", 'activation', a."id"::text, '/v2/records/activations'
      FROM "id_business_v2_activations" a
      JOIN "id_business_v2_customers" c ON c."id" = a."customer_id"
      JOIN "id_business_v2_options" s ON s."id" = a."service_option_id"
      WHERE a."status"::text = 'abnormal'

      UNION ALL

      SELECT
        CONCAT('account:', a."id", ':negative-balance'), 'account_negative_balance', 'balance', 'warning', 2,
        a."apple_id_masked"::text,
        CONCAT('当前余额为 ', a."current_balance"::text, '，请核对余额流水。'),
        a."updated_at", 'account', a."id"::text, '/v2/accounts'
      FROM "id_business_v2_accounts" a
      WHERE a."deleted_at" IS NULL AND a."record_status"::text = 'active'
        AND a."sold_by_order_id" IS NULL AND a."loss_reported_at" IS NULL
        AND a."current_balance" < 0

      UNION ALL

      SELECT
        CONCAT('supplier-fund:', f."id", ':negative'), 'supplier_fund_negative', 'balance', 'critical', 1,
        o."name"::text,
        CONCAT('当前人民币余额为 ', f."current_balance_cny"::text, '，请核对付款、加卡和调账流水。'),
        f."updated_at", 'supplier_fund', f."id"::text, '/v2/records/topups'
      FROM "id_business_v2_topup_supplier_accounts" f
      JOIN "id_business_v2_options" o ON o."id" = f."supplier_option_id"
      WHERE f."status"::text = 'active' AND f."current_balance_cny" < 0

      UNION ALL

      SELECT
        CONCAT('exchange-run:', r."id", ':failed'), 'exchange_rate_failed', 'exchange_rate', 'warning', 2,
        CONCAT(r."asset", '/', r."fiat"),
        CONCAT('采集失败', CASE WHEN r."error_code" IS NULL THEN '' ELSE CONCAT('：', r."error_code") END),
        r."started_at", 'exchange_rate_run', r."id"::text, '/v2/exchange-rates'
      FROM "id_business_v2_exchange_rate_runs" r
      WHERE r."status"::text = 'failed' AND r."started_at" >= ${failedSince}

      UNION ALL

      SELECT
        CONCAT('finance-settings:', f."id", ':history'), 'finance_history_incomplete', 'finance', 'warning', 2,
        '财务历史基线',
        '历史回填、期初余额或遗漏开支尚未完整确认。',
        f."updated_at", 'finance_settings', f."id"::text, '/v2/finance/ledger'
      FROM "id_business_v2_finance_settings" f
      WHERE f."history_status"::text <> 'completed'
    `;
  }
}
