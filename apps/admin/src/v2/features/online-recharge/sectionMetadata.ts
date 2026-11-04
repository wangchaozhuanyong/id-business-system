import type { OnlineSection } from './contracts';

export const sectionTitles: Record<OnlineSection, string> = {
  overview: '概览中心',
  config: '系统配置',
  proxies: '代理池',
  'browser-pool': '浏览器池',
  addresses: '免税地址',
  'checkout-debug': '支付链接调试',
  cards: '银行卡共享池',
  cdks: '兑换码管理',
  sessions: 'Session 管理',
  renewal: '续费管理',
  jobs: '任务管理',
  automation: '自动化任务',
  billing: '账单记录',
  'runtime-logs': '运行日志',
  'login-logs': '登录日志'
};
export const sectionDescriptions: Record<OnlineSection, string> = {
  overview: '查看线上代充任务、独立资源和执行器运行状态。',
  config: '保存原软件的执行、地区、供应商、通知和验证码配置。',
  proxies: '管理线上代充独立代理池，检测连通性并调整可用状态。',
  'browser-pool':
    '查看最近一次检测的浏览器槽位快照、连接状态和独立／池化运行模式；需要时重新检测。',
  addresses: '管理银行卡关联的免税地址，生成美国地址并清理未绑定记录。',
  'checkout-debug': '使用原套餐和地区生成支付链接，执行在付款前停止。',
  cards:
    '比特浏览器充值与线上代充共用，按适用套餐匹配；安全码仅在执行器内存临时保留，最长24小时，任务结束、失去租约或重启后提前清除。',
  cdks: '生成、导入、出库和查询兑换码；已被任务占用的兑换码受保护。',
  sessions:
    '使用最新会话资料单独查询订阅，不提交充值或付款；查看已保存会话需要填写原因并记录审计。',
  renewal: '查询订阅到期和续费状态，按原逻辑取消或恢复自动续费。',
  jobs: '按目标套餐自动识别首次开通或升级，查看进度、官网应付、原单核对及执行文件。',
  automation: '查看实际自动化任务及执行阶段；待核对任务不能重复发起付款。',
  billing:
    '查看结账记录；失败或待核对记录的金额不代表已扣款。成功账单保留，消费汇总会提示金额待核对笔数。',
  'runtime-logs': '查看完整业务日志和错误详情；截图与录像请在对应任务中查看。',
  'login-logs': '使用现有用户系统的安全日志，查看线上代充权限相关事件。'
};
