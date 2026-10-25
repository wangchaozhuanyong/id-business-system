import { formatV2DateTime } from '@/v2/utils/dateTime';
const stages: Record<string, string> = {
  input: '输入检查',
  proxy: '代理连接',
  login: '登录核验',
  preflight: '订阅前检',
  checkout_create: '创建结账单',
  checkout_open: '打开原结账单',
  card_readiness: '卡号控件检查',
  card_fill: '填写卡片',
  billing_fill: '填写账单',
  button_ready: '付款按钮检查',
  cleanup: '清理任务资源'
};
const outcomes: Record<string, string> = {
  ready_before_payment: '付款前就绪，未提交',
  failed_with_class: '已分类失败',
  challenge_blocked: '官网验证阻断，已结束'
};
const failures: Record<string, string> = {
  NONE: '无',
  INPUT_MISSING: '所需资料缺失或已失效',
  PROXY_UNAVAILABLE: '代理检查未通过',
  BROWSER_PROFILE_UNAVAILABLE: '专用浏览器不可用',
  LOGIN_READ_FAILED: '登录页面读取失败',
  LOGIN_UNCONFIRMED: '登录状态未确认',
  CHECKOUT_REJECTED: '官网拒绝建单',
  CHECKOUT_CREATION_UNKNOWN: '建单响应未确认，未重复创建',
  PAYMENT_COMPONENT_NOT_LOADED: '支付组件未加载',
  CARD_NOT_READY: '卡号控件或填写未就绪',
  BILLING_FILL_FAILED: '账单填写或回读失败',
  BUTTON_NOT_READY: '付款按钮未就绪',
  READ_INCOMPLETE: '控件读取未完成',
  CHALLENGE_BLOCKED: '官网验证未完成',
  EXECUTOR_INTERRUPTED: '执行器中断',
  OTHER: '其他执行异常，详见诊断'
};
const failureDetails: Record<string, string> = {
  PROXY_CONNECTION_FAILED: '代理连通性检测已用尽5次，仍未完成核验，已停止后续操作',
  PROFILE_IDENTITY_MISSING: '缺少账号及用户标识，不能复用浏览器会话',
  PROFILE_PROXY_INVALID: '代理绑定格式无效，未继续执行',
  PROFILE_BUSY: '同一账号与代理的浏览器正在使用，本次未继续',
  PROFILE_EXIT_CHANGED: '代理出口与浏览器会话绑定不一致，已停止；未切换代理',
  PROFILE_BINDING_INVALID: '浏览器出口绑定记录无效，已停止',
  PROFILE_DIRECTORY_INVALID: '浏览器会话目录无效，已停止',
  PROFILE_LAUNCH_FAILED: '专用浏览器启动未完成，请检查运行环境',
  PROFILE_CLEANUP_FAILED: '浏览器关闭未确认，会话尚未释放'
};
export function unpaidValidationEntries(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const report = value as Record<string, unknown>;
  if (report.format !== 'unpaid-validation-v1') return [];
  const rows = [
    { label: '不付款验收结果', value: outcomes[String(report.outcome)] ?? '结果未确认' },
    { label: '最后执行阶段', value: stages[String(report.lastStage)] ?? '阶段未确认' },
    {
      label: '停止分类',
      value:
        failureDetails[String(report.failureCode)] ??
        failures[String(report.failureClass)] ??
        '分类未确认'
    },
    { label: '卡片回读', value: report.cardVerified === true ? '通过' : '尚未通过' },
    { label: '账单回读', value: report.billingVerified === true ? '通过' : '尚未通过' },
    { label: '付款按钮', value: report.buttonReady === true ? '已就绪，未点击' : '尚未确认就绪' },
    {
      label: '诊断文件',
      value: report.diagnosticUploaded === true ? '已保存' : '保存未确认，详见任务结果'
    }
  ];
  if (Array.isArray(report.missing) && report.missing.length) {
    const fields: Record<string, string> = {
      number: '卡号',
      expiry: '有效期',
      cvc: '安全码',
      country: '国家',
      line1: '街道',
      city: '城市',
      postal: '邮编',
      name: '姓名',
      state: '州省'
    };
    rows.push({
      label: '未就绪字段',
      value: report.missing.map((key) => fields[String(key)] || '未知字段').join('、')
    });
  }
  if (Number.isInteger(report.httpStatus))
    rows.push({ label: '官网建单响应', value: `HTTP ${report.httpStatus}` });
  if (Array.isArray(report.timeline))
    report.timeline.slice(0, 32).forEach((item, index) => {
      if (!item || typeof item !== 'object' || !stages[item.stage]) return;
      const elapsed = Date.parse(item.endedAt) - Date.parse(item.startedAt);
      rows.push({
        label: `阶段 ${index + 1}：${stages[item.stage]}`,
        value: `${formatV2DateTime(item.startedAt)}，${Number.isFinite(elapsed) ? Math.max(0, elapsed) : '未知'} 毫秒`
      });
    });
  return rows;
}
