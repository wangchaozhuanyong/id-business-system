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
5. 创建 `id-business-v2-purchase-rate-daily` Cron job，在 UTC 每天 01:05（北京时间 09:05）调用同一受保护入口；业务层只在
   收购汇率任务到期时领取设置并执行，数据库部分唯一索引阻止并发采集。

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
收购汇率使用 ExchangeRate-API 免费开放接口，不需要 API Key。可选配置
`CURRENCY_RATE_PROVIDER=exchange_rate_api` 和 `CURRENCY_RATE_REQUEST_TIMEOUT_MS=10000`。

Supabase Edge Function 的启动包装层显式传入 Provider 和超时配置，并校验 Provider 固定为
`exchange_rate_api`、请求超时为 1000–30000 毫秒。发布前还必须通过 `npm run prod:env:check`；
仅在 Supabase Secrets 中写入变量、但未重新部署 Edge Function 时，运行中的 API 仍不会获得新配置。

收购汇率成功边界要求所有已启用币种同时返回正数、方向转换和 Decimal 计算全部成功，并且供应商时间
没有超过后台配置的有效时限。缺失、零值、无效时间、过期数据或异常波动均不会覆盖最后有效报价；其中
异常波动进入人工审核，其余情况记录失败批次。

## 部署和验证

配置密钥后重新部署 V2 Edge Function。然后在 Supabase SQL Editor 只读核验：

```sql
SELECT "jobid", "jobname", "schedule", "active"
FROM cron.job
WHERE "jobname" = 'id-business-v2-exchange-rate-every-30-minutes';

SELECT "jobid", "jobname", "schedule", "active"
FROM cron.job
WHERE "jobname" = 'id-business-v2-purchase-rate-daily';

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
- 收购汇率 Cron job 为 `active=true`，计划表达式为 `5 1 * * *`。
- 新批次的 `trigger_type=scheduled`。
- 成功批次有完整四方向快照和有效样本。
- 汇率页面的 `latestReceiptFxRates` 固定显示 `CNY、MYR、USD、USDT`；`MYR、USD、USDT` 自动记录里各有按币种快照。
- 发生实际删除后，审计日志存在 `id_business_v2.exchange_rate.retention_cleanup`；无数据可删时不会重复写空审计。

仅有 Cron job、HTTP 200 或历史成功记录，不能单独作为当前自动采集成功证据。
