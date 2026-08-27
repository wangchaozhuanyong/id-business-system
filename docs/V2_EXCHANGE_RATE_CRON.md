# V2 汇率定时任务

## 运行方式

汇率任务在 AWS EC2 的 NestJS API 进程内运行，不依赖外部数据库 Cron。

- 平均售出汇率按系统设置周期运行，默认 30 分钟。
- 收购汇率每日按设置领取到期任务。
- 数据库唯一约束和任务领取逻辑防止并发重复采集。
- 失败不会覆盖最后一份有效报价。

## 生产变量

```text
ID_BUSINESS_V2_EXCHANGE_RATE_AUTO_ENABLED=true
ID_BUSINESS_V2_EXCHANGE_RATE_RUN_ON_STARTUP=false
ID_BUSINESS_V2_EXCHANGE_RATE_NETWORK_ENABLED=true
ID_BUSINESS_V2_EXCHANGE_RATE_STALE_MS=600000
CURRENCY_RATE_PROVIDER=exchange_rate_api
CURRENCY_RATE_REQUEST_TIMEOUT_MS=10000
```

紧急停止网络采集时只需设置
`ID_BUSINESS_V2_EXCHANGE_RATE_NETWORK_ENABLED=false` 并重建 API 容器；不删除历史汇率数据。

## 验证

1. 检查 API 容器日志中无连续采集错误。
2. 访问汇率总览、有效汇率和收购报价接口。
3. 确认新记录与审计日志在同一 MySQL 生产库。
4. 检查异常报价不会替换最后有效值。
