# V2 汇率自动采集部署

## 目标

- 系统固定支持 `CNY、MYR、USD、USDT` 四种财务币种。
- `CNY=1` 是固定主币种，不采集入库；`MYR、USD、USDT` 每次自动采集都生成财务汇率快照。
- Binance / OKX 负责 `USDT/CNY` P2P 综合价；ECB 参考汇率负责 `MYR、USD` 交叉折算到 CNY。
- 联网自动快照按页面设置的保留天数清理，默认 30 天，可设置 7–3650 天。
- 人工汇率记录不清理。
- 被订单、加卡、财务流水、供应商付款或报表历史引用的自动汇率快照不清理。
- Apple 官网、加卡和续费自动化继续关闭。

## 数据库迁移

使用目标 Supabase 数据库连接执行：

```bash
npm run prisma:migrate:deploy --workspace @apple-business/api
```

迁移会：

1. 把汇率设置默认周期和当前单例设置更新为 30 分钟。
2. 给汇率设置增加 `retention_days`，默认 30，并安装受控的保留清理函数。
3. 在 Supabase 支持扩展时启用 `pg_net` 和 `pg_cron`。
4. 创建 `id-business-v2-exchange-rate-every-30-minutes` Cron job。

普通 PostgreSQL 没有 `pg_net` 或 `pg_cron` 时，迁移会保留业务表和清理函数，但跳过外部 Cron。

## 私密配置

生成一份至少 32 字符的随机 Cron 密钥。不要把真实值写入仓库、聊天、工单或前端环境变量。

在 Supabase Edge Function Secrets 配置：

```text
ID_BUSINESS_V2_EXCHANGE_RATE_CRON_SECRET
```

在 Supabase Vault 配置两项：

```text
id_business_v2_exchange_rate_cron_url
id_business_v2_exchange_rate_cron_secret
```

其中 URL 必须是：

```text
https://<project-ref>.supabase.co/functions/v1/v2-api/api/id-business-v2/exchange-rates/cron
```

Vault 的 `id_business_v2_exchange_rate_cron_secret` 必须与 Edge Function Secret 完全一致。

## 部署和验证

配置密钥后重新部署 V2 Edge Function。然后在 Supabase SQL Editor 只读核验：

```sql
SELECT "jobid", "jobname", "schedule", "active"
FROM cron.job
WHERE "jobname" = 'id-business-v2-exchange-rate-every-30-minutes';

SELECT "status", "trigger_type", "started_at", "finished_at", "error_code"
FROM "id_business_v2_exchange_rate_runs"
ORDER BY "started_at" DESC
LIMIT 10;

SELECT *
FROM cron.job_run_details
WHERE "jobid" = (
  SELECT "jobid"
  FROM cron.job
  WHERE "jobname" = 'id-business-v2-exchange-rate-every-30-minutes'
)
ORDER BY "start_time" DESC
LIMIT 10;
```

上线完成必须同时看到：

- Cron job 为 `active=true`，计划表达式为 `*/30 * * * *`。
- 新批次的 `trigger_type=scheduled`。
- 成功批次有完整四方向快照和有效样本。
- 汇率页面的 `latestReceiptFxRates` 固定显示 `CNY、MYR、USD、USDT`；`MYR、USD、USDT` 自动记录里各有按币种快照。
- 发生实际删除后，审计日志存在 `id_business_v2.exchange_rate.retention_cleanup`；无数据可删时不会重复写空审计。

仅有 Cron job、HTTP 200 或历史成功记录，不能单独作为当前自动采集成功证据。
