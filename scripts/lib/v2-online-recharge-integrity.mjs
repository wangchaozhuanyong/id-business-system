// 独立线上代充一致性规则；与正式发布冻结的 49 条规则分开维护。
export const V2_ONLINE_RECHARGE_INTEGRITY_CHECKS = Object.freeze([
  {
    code: 'online_bill_task_missing',
    severity: 'error',
    description: '线上代充账单没有可追溯的原始任务',
    sql: `SELECT b.id FROM online_recharge_bills b LEFT JOIN online_recharge_tasks t ON t.id=b.task_id WHERE t.id IS NULL`
  },
  {
    code: 'online_bill_status_invalid',
    severity: 'error',
    description: '账单状态超出成功、失败、结果未知的受控集合',
    sql: `SELECT id FROM online_recharge_bills WHERE status NOT IN ('success','failed','result_unknown')`
  },
  {
    code: 'online_bill_amount_invalid',
    severity: 'error',
    description: '实际金额或估算金额为负数',
    sql: `SELECT id FROM online_recharge_bills WHERE amount<0 OR estimated_amount<0`
  },
  {
    code: 'online_bill_currency_invalid',
    severity: 'error',
    description: '账单币种为空或不是规范的大写币种标签',
    sql: `SELECT id FROM online_recharge_bills WHERE NOT REGEXP_LIKE(currency,'^[A-Z]{3,8}$','c')`
  },
  {
    code: 'online_bill_plan_mismatch',
    severity: 'error',
    description: '账单套餐与原任务套餐不一致',
    sql: `SELECT b.id FROM online_recharge_bills b JOIN online_recharge_tasks t ON t.id=b.task_id WHERE b.plan<>t.plan`
  },
  {
    code: 'online_checkout_multiple_success_bills',
    severity: 'error',
    description: '同一结账编号存在多条成功账单，需排除重复消费汇总',
    sql: `SELECT checkout_id FROM online_recharge_bills WHERE status='success' AND checkout_id IS NOT NULL AND checkout_id<>'' GROUP BY checkout_id HAVING COUNT(*)>1`
  },
  {
    code: 'online_third_party_local_bill',
    severity: 'error',
    description: '第三方代充任务错误写入了本地银行卡消费账单',
    sql: `SELECT b.id FROM online_recharge_bills b JOIN online_recharge_tasks t ON t.id=b.task_id WHERE t.provider='third_party'`
  },
  {
    code: 'online_confirmed_payment_bill_missing',
    severity: 'error',
    description: '已确认付款并成功的本地充值任务缺少成功账单；不把订阅查询任务当作新付款',
    sql: `SELECT t.id FROM online_recharge_tasks t WHERE t.provider='local' AND t.operation IN ('recharge','debug','renewal') AND t.status='succeeded' AND t.confirmed_paid=1 AND NOT EXISTS (SELECT 1 FROM online_recharge_bills b WHERE b.task_id=t.id AND b.status='success')`
  },
  {
    code: 'online_success_actual_amount_missing',
    severity: 'warning',
    description: '成功账单缺少实际扣款金额；不得以估算金额或零补齐',
    sql: `SELECT id FROM online_recharge_bills WHERE status='success' AND amount IS NULL`
  },
  {
    code: 'online_payment_awaiting_review',
    severity: 'warning',
    description: '充值付款仍待核对；保留原任务保护，不自动重试付款或释放资产',
    sql: `SELECT id FROM online_recharge_tasks WHERE operation IN ('recharge','debug','renewal') AND status='awaiting_review'`
  },
  {
    code: 'online_success_bill_terminal_task_not_paid',
    severity: 'warning',
    description: '成功账单关联终态任务尚未确认付款，需逐笔核对事实',
    sql: `SELECT b.id FROM online_recharge_bills b JOIN online_recharge_tasks t ON t.id=b.task_id WHERE b.status='success' AND t.status IN ('succeeded','failed') AND t.confirmed_paid=0`
  }
]);
