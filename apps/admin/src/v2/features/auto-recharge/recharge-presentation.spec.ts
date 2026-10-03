import { describe, expect, it } from 'vitest';
import {
  browserFailureLabel,
  currencyOptions,
  failureReasonLabel,
  paymentFailureLabel,
  quotePlaceholder,
  rechargeIssueFeedback,
  statusLabel,
  subscriptionLabel,
  paymentStatusLabel,
  proxyAttemptLabel
} from './recharge-presentation';
import type { V2RechargeJob } from './contracts';

const job = (overrides: Partial<V2RechargeJob> = {}): V2RechargeJob => ({
  id: 'test',
  plan: 'plus',
  action: 'check',
  state: 'finished',
  result: { stage: 'session_verified', account_matched: true },
  createdAt: '',
  updatedAt: '',
  ...overrides
});
describe('recharge stage presentation', () => {
  it('升级可换卡，核实失败不再误称官网要求原付款卡', () => {
    expect(failureReasonLabel('upgrade_payment_method_unverified')).toContain('本次选择');
    expect(failureReasonLabel('upgrade_payment_method_unverified')).not.toContain('原付款卡');
    for (const reason of [
      'upgrade_payment_method_ambiguous',
      'official_upgrade_change_card_not_found',
      'official_upgrade_payment_method_not_found',
      'official_upgrade_add_card_not_found',
      'official_upgrade_add_card_submit_not_found',
      'upgrade_card_change_not_authorized',
      'upgrade_card_setup_failed',
      'upgrade_card_setup_unverified',
      'upgrade_card_bank_verification_required'
    ])
      expect(failureReasonLabel(reason)).not.toMatch(/^[a-z_]+$/);
    expect(statusLabel('upgrade_card_ready')).toContain('重新核价');
    expect(failureReasonLabel('upgrade_card_bank_verification_required')).toContain(
      '尚未提交升级付款'
    );
  });
  it('新增卡认证与升级付款分开提示，服务器不指向不存在的窗口或付款原单', () => {
    const server = job({
      action: 'server',
      result: {
        reason: 'upgrade_card_bank_verification_required',
        user_action_required: true,
        payment_attempted: false,
        payment_requests_sent: 0
      }
    });
    expect(rechargeIssueFeedback(server)?.action).toContain('尚未提交升级付款');
    expect(rechargeIssueFeedback(server)?.action).toContain('核对官网银行卡设置结果');
    expect(rechargeIssueFeedback(server)?.action).not.toContain('只读复查原订单');
    expect(rechargeIssueFeedback(job({ ...server, action: 'bitbrowser' }))?.action).toContain(
      '原官网窗口'
    );
  });
  it('服务器未核实的银行认证只建议原单复查，不指向官网窗口或声称需要本人验证码', () => {
    const server = job({
      action: 'server',
      result: {
        reason: 'three_ds_binding_unverified',
        payment_status: 'requires_action',
        three_ds_status: 'unsupported',
        payment_attempted: true
      }
    });
    expect(rechargeIssueFeedback(server)?.action).toContain('银行认证结果尚未确认');
    expect(rechargeIssueFeedback(server)?.action).toContain('只读复查');
    expect(rechargeIssueFeedback(server)?.action).not.toContain('当前官网窗口');
    expect(rechargeIssueFeedback(server)?.action).not.toContain('银行要求本人验证');
  });
  it('服务器银行挑战说明可执行路径，不指向不存在的可交互窗口', () => {
    const server = job({
      action: 'server',
      result: {
        reason: 'bank_verification_required',
        payment_status: 'requires_action',
        three_ds_status: 'awaiting_user',
        user_action_required: true,
        payment_attempted: true,
        payment_requests_sent: 1
      }
    });
    expect(rechargeIssueFeedback(server)?.action).toContain('服务器模式无法操作挑战页');
    expect(rechargeIssueFeedback(server)?.action).toContain('只读复查原订单');
    expect(rechargeIssueFeedback(server)?.action).not.toContain('当前官网窗口');
    expect(rechargeIssueFeedback(job({ ...server, action: 'bitbrowser' }))?.action).toContain(
      '当前官网窗口'
    );
  });
  it('显示代理连接次数与20秒预算，进入登录后不残留代理重试文案', () => {
    const progress = {
      proxy_attempt: 10,
      proxy_attempt_limit: 10 as const,
      proxy_wait_seconds: 20 as const
    };
    for (const stage of ['proxy_resolving', 'proxy_verifying', 'proxy_retrying'])
      expect(
        proxyAttemptLabel(
          job({ action: 'server', state: 'running', result: { ...progress, stage } })
        )
      ).toBe('代理连接第 10 / 10 次尝试，官网连接核验最多等待 20 秒。');
    for (const stage of [
      'session_restore',
      'login_email',
      'login_network_verifying',
      'checkout_create',
      'payment_request_sending'
    ])
      expect(proxyAttemptLabel(job({ action: 'server', result: { ...progress, stage } }))).toBe('');
    expect(
      proxyAttemptLabel(
        job({ action: 'bitbrowser', result: { ...progress, stage: 'proxy_verifying' } })
      )
    ).toBe('');
    expect(
      proxyAttemptLabel(
        job({
          action: 'server',
          result: { ...progress, proxy_attempt_limit: 1, stage: 'proxy_verifying' }
        })
      )
    ).toBe('');
    expect(
      proxyAttemptLabel(
        job({ action: 'server', result: { stage: 'proxy_verifying', proxy_attempt: 1 } })
      )
    ).toBe('');
  });
  it('代理重试终止原因显示中文，历史付款保护仍优先', () => {
    expect(statusLabel('proxy_retrying')).toContain('已关闭');
    for (const reason of [
      'proxy_retry_exhausted',
      'proxy_cleanup_failed',
      'fingerprint_start_timeout',
      'fingerprint_cleanup_failed'
    ]) {
      const issue = rechargeIssueFeedback(job({ action: 'server', result: { reason } }));
      expect(issue?.message).not.toContain(reason);
      expect(issue?.action).not.toContain('比特');
      expect(
        rechargeIssueFeedback(
          job({ action: 'server', result: { reason, payment_requests_sent: 1 } })
        )?.action
      ).toContain('只读复查原订单');
    }
  });
  it('服务器付款前各阶段显示明确中文位置', () => {
    expect(statusLabel('proxy_resolving')).toContain('提取');
    expect(statusLabel('proxy_verifying')).toContain('核实');
    expect(statusLabel('original_state_restore')).toContain('原订单');
    expect(statusLabel('login_network_verifying')).toContain('登录后');
  });
  it('代理出口国家错误只提示所选代理国家，不将账单国家视为冲突', () => {
    expect(failureReasonLabel('proxy_country_mismatch')).toBe(
      '代理实际出口国家与所选代理国家不一致，已限制登录'
    );
  });
  it('历史订阅标识按三种 Pro 使用额度显示，未核验的普通 Pro 不猜档位', () => {
    expect(statusLabel('promax')).toBe('Pro（最高使用额度）');
    expect(statusLabel('pro')).toBe('Pro（档位待核验）');
    for (const [plan, label] of [
      ['go', 'Go'],
      ['pro-5x', 'Pro（标准）'],
      ['pro-20x', 'Pro（更多使用额度）'],
      ['pro-500', 'Pro（最高使用额度）']
    ] as const) {
      expect(subscriptionLabel(job({ plan, result: { subscription_status: plan } }))).toBe(label);
    }
  });
  it('加载重试与底层错误显示中文，不显示内部异常原文', () => {
    expect(statusLabel('session_load_timeout')).toContain('等待时间');
    expect(statusLabel('bitbrowser_profile_rebuilding')).toContain('重新创建');
    expect(browserFailureLabel('TimeoutError')).toBe('等待超时');
    expect(browserFailureLabel('Error', 'net::ERR_PROXY_CONNECTION_FAILED')).toBe('代理连接失败');
    expect(browserFailureLabel('private=secret', 'private=secret')).toBe('浏览器操作异常');
    expect(browserFailureLabel('constructor', 'constructor')).toBe('浏览器操作异常');
  });
  it('默认将菲律宾比索放在首项并显示中文币种名称', () => {
    expect(currencyOptions[0]).toEqual({ value: 'PHP', label: '菲律宾比索（PHP）' });
    expect(currencyOptions.find((currency) => currency.value === 'USD')?.label).toBe('美元（USD）');
  });
  it('distinguishes unchecked, pending and failed quotes', () => {
    expect(quotePlaceholder(job())).toBe('待获取报价');
    expect(quotePlaceholder(job({ action: 'quote', state: 'running' }))).toBe('正在获取报价');
    expect(
      quotePlaceholder(job({ action: 'quote', result: { reason: 'official_plan_tier_not_found' } }))
    ).toBe('获取失败');
    expect(quotePlaceholder(job({ action: 'quote', state: 'unknown' }))).toBe('报价结果待核验');
  });
  it('报价空白与代理失败显示具体页面原因和处理方式', () => {
    const blank = job({
      action: 'bitbrowser',
      result: {
        reason: 'prepayment_retries_exhausted',
        stage: 'quote_read',
        page_state: 'blank',
        quote: { plan: 'plus', today: null, tax: null, renewal: null, renewal_interval: null },
        quote_elapsed_seconds: 120,
        quote_wait_seconds: 120,
        quote_refresh_count: 1,
        payment_requests_sent: 0
      }
    });
    expect(quotePlaceholder(blank)).toBe('报价页空白');
    expect(rechargeIssueFeedback(blank)).toMatchObject({
      title: '本次未完成原因',
      message: '报价页等待满本轮时间并自动刷新后，仍没有返回有效内容'
    });
    expect(rechargeIssueFeedback(blank)?.action).toContain('代理 IP 和等待时间');
    expect(statusLabel('quote_page_refreshing')).toBe('正在刷新当前报价页');
    expect(statusLabel('stale_profile_cleanup')).toBe('正在清理历史失败窗口');
  });
  it('keeps missing parts of an actual quote unknown', () => {
    expect(
      quotePlaceholder(
        job({
          result: {
            quote: { plan: 'plus', today: null, tax: null, renewal: null, renewal_interval: null }
          }
        })
      )
    ).toBe('未知');
  });
  it('服务器网络失败只指向可用的代理管理，不要求修改不存在的等待设置', () => {
    for (const reason of [
      'session_network_error',
      'session_load_timeout',
      'checkout_page_network_error'
    ]) {
      const feedback = rechargeIssueFeedback(job({ action: 'server', result: { reason } }));
      expect(feedback?.action).toContain('“代理 IP 管理”');
      expect(feedback?.action).toContain('暂不支持在页面调整等待时间');
      expect(feedback?.action).not.toContain('右上角设置');
      expect(feedback?.action).not.toContain('重新开始');
    }
  });
  it('does not describe an attempted or unknown payment as never attempted', () => {
    expect(subscriptionLabel(job())).toBe('尚未执行开通');
    expect(subscriptionLabel(job({ state: 'confirming' }))).toBe('结果待核验');
    expect(subscriptionLabel(job({ result: { payment_attempted: true } }))).toBe('结果待核验');
    expect(subscriptionLabel(job({ result: { payment_outcome: 'paid_pending_activation' } }))).toBe(
      '已付款，待开通'
    );
  });
  it('does not label a pending or completed payment outcome as unattempted', () => {
    expect(paymentStatusLabel(job({ state: 'confirming' }))).toBe('正在提交本次付款');
    expect(paymentStatusLabel(job({ result: { payment_outcome: 'subscription_activated' } }))).toBe(
      '付款结果待核验'
    );
    expect(paymentStatusLabel(job({ result: { payment_status: 'paid' } }))).toBe('已确认付款');
  });
  it('历史未知付款处理后保留处理语义，不再显示金额未知', () => {
    const resolved = job({
      action: 'bitbrowser',
      result: {
        status: 'payment_result_unknown',
        payment_status: 'unknown',
        payment_attempted: true,
        confirmation_requests_sent: 1,
        operator_resolution: 'confirmed_no_bank_request'
      }
    });
    expect(quotePlaceholder(resolved)).toBe('历史记录已处理');
    expect(paymentStatusLabel(resolved)).toBe('已确认银行卡未收到付款请求');
    expect(subscriptionLabel(resolved)).toBe('尚未开通');
  });
  it('shows a specific Chinese reason for the observed old Plus failure', () => {
    expect(statusLabel('official_plus_option_not_found')).toBe('未找到官网 Plus 选项');
    expect(statusLabel('official_plan_tier_not_found')).toBe('未识别到所选 Pro 档位');
    expect(statusLabel('official_pricing_plan_entry_not_found')).toBe(
      '未找到唯一的官网套餐定价入口'
    );
  });
  it('shows safe Chinese-only reasons for memory exhaustion and verification', () => {
    expect(statusLabel('browser_memory_exhausted')).toBe(
      '官网浏览器内存不足，本次未创建订单或付款'
    );
    expect(statusLabel('verification_required')).toBe('官网或银行验证尚未完成');
    expect(statusLabel('quote_needs_review_or_billing')).toBe(
      '官网初始总额或预估税费未完整读取，本次未付款'
    );
    expect(statusLabel('existing_checkout_unavailable')).toBe('原结算已失效，本次未付款');
    expect(statusLabel('bank_card_number_invalid')).toBe('银行卡号格式无效');
    expect(statusLabel('internal_unknown_reason')).toBe('待核验');
  });
  it('显示具体的银行拒付原因和处理方式', () => {
    const declined = job({
      action: 'bitbrowser',
      result: {
        status: 'payment_failed',
        payment_status: 'declined',
        payment_attempted: true,
        payment_requests_sent: 1,
        payment_failure_reason: 'insufficient_funds'
      }
    });
    expect(paymentFailureLabel('insufficient_funds')).toBe('银行卡余额或可用额度不足');
    expect(rechargeIssueFeedback(declined)).toEqual({
      title: '付款失败原因',
      message: '银行卡余额或可用额度不足',
      action: '请核对银行卡状态、余额、限额和银行限制；系统不会自动重复付款。'
    });
  });
  it('不暴露未知内部错误码，仍给出可操作提示', () => {
    const unknownFailure = job({
      action: 'bitbrowser',
      result: { reason: 'private_internal_error', payment_attempted: false }
    });
    expect(failureReasonLabel('private_internal_error')).toBe('系统未识别到具体失败原因');
    expect(rechargeIssueFeedback(unknownFailure)).toMatchObject({
      title: '本次未完成原因',
      message: '系统未识别到具体失败原因'
    });
    expect(JSON.stringify(rechargeIssueFeedback(unknownFailure))).not.toContain(
      'private_internal_error'
    );
  });
  it('付款结果未知时明确提示只读复查', () => {
    const pending = job({
      action: 'bitbrowser',
      state: 'unknown',
      result: {
        status: 'payment_result_unknown',
        payment_status: 'unknown',
        payment_attempted: true
      }
    });
    expect(rechargeIssueFeedback(pending)).toMatchObject({
      title: '结果待核验',
      message: '官网或本机连接器没有返回可确认的最终结果'
    });
    expect(rechargeIssueFeedback(pending)?.action).toContain('只读复查原订单');
  });
});
