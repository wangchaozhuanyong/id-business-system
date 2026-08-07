-- Keep the runtime permission catalog aligned with current V2 modules.
-- This is data-only: it does not change tables or remove permissions from custom roles.

WITH permission_catalog("name", "code", "module", "action") AS (
  VALUES
    ('查看 ID', 'apple.account.view', 'apple.account', 'view'),
    ('新增 ID', 'apple.account.create', 'apple.account', 'create'),
    ('导入 ID', 'apple.account.import', 'apple.account', 'import'),
    ('修改 ID', 'apple.account.update', 'apple.account', 'update'),
    ('删除 ID', 'apple.account.delete', 'apple.account', 'delete'),
    ('查看完整 ID', 'apple.account.view_full', 'apple.account', 'view_full'),
    ('查看 ID 密码', 'apple.secret.view_password', 'apple.secret', 'view_password'),
    ('查看 ID 手机号', 'apple.secret.view_phone', 'apple.secret', 'view_phone'),
    ('查看 ID 密保', 'apple.secret.view_security', 'apple.secret', 'view_security'),
    ('查看余额', 'apple.balance.view', 'apple.balance', 'view'),
    ('余额入账', 'apple.balance.topup', 'apple.balance', 'topup'),
    ('调整余额', 'apple.balance.adjust', 'apple.balance', 'adjust'),
    ('查看加卡供应商资金', 'apple.topup_supplier_fund.view', 'apple.topup_supplier_fund', 'view'),
    ('管理加卡供应商资金', 'apple.topup_supplier_fund.manage', 'apple.topup_supplier_fund', 'manage'),
    ('查看完整礼品卡号', 'apple.gift_card.view_full', 'apple.gift_card', 'view_full'),
    ('查看订单', 'apple.order.view', 'apple.order', 'view'),
    ('订单录入', 'apple.order.create', 'apple.order', 'create'),
    ('修改订单', 'apple.order.update', 'apple.order', 'update'),
    ('删除订单', 'apple.order.delete', 'apple.order', 'delete'),
    ('查看开通记录', 'apple.activation.view', 'apple.activation', 'view'),
    ('查看续费', 'apple.renewal_task.view', 'apple.renewal_task', 'view'),
    ('执行续费', 'apple.renewal_task.update', 'apple.renewal_task', 'update'),
    ('查看汇率', 'apple.exchange_rate.view', 'apple.exchange_rate', 'view'),
    ('录入汇率', 'apple.exchange_rate.create', 'apple.exchange_rate', 'create'),
    ('采集汇率', 'apple.exchange_rate.collect', 'apple.exchange_rate', 'collect'),
    ('管理汇率设置', 'apple.exchange_rate.manage', 'apple.exchange_rate', 'manage'),
    ('查看客户', 'customer.view', 'customer', 'view'),
    ('新增客户', 'customer.create', 'customer', 'create'),
    ('修改客户', 'customer.update', 'customer', 'update'),
    ('删除客户', 'customer.delete', 'customer', 'delete'),
    ('查看客户手机号', 'customer.view_phone', 'customer', 'view_phone'),
    ('管理业务选项', 'data.dictionary.manage', 'data.dictionary', 'manage'),
    ('查看审计日志', 'audit_log.view', 'audit_log', 'view'),
    ('管理续费预警', 'id_business_v2.renewal_warning.manage', 'id_business_v2.renewal_warning', 'manage'),
    ('查看经营分析', 'data.analytics.view', 'data.analytics', 'view'),
    ('查看财务', 'finance.view', 'finance', 'view'),
    ('财务记账', 'finance.post', 'finance', 'post'),
    ('财务调整', 'finance.adjust', 'finance', 'adjust'),
    ('管理财务', 'finance.manage', 'finance', 'manage'),
    ('财务关账', 'finance.close', 'finance', 'close')
)
INSERT INTO "permissions" ("id", "name", "code", "module", "action")
SELECT gen_random_uuid(), "name", "code", "module", "action"
FROM permission_catalog
ON CONFLICT ("code") DO UPDATE SET
  "name" = EXCLUDED."name",
  "module" = EXCLUDED."module",
  "action" = EXCLUDED."action";

INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT admin_role."id", permission."id"
FROM "roles" admin_role
CROSS JOIN "permissions" permission
WHERE admin_role."code" = 'admin'
ON CONFLICT DO NOTHING;
