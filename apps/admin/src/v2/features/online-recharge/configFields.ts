import type { OnlineField } from './contracts';
import { regionOptions } from './labels';
export const configGroups: {
  key: string;
  title: string;
  fields: OnlineField[];
  tests?: { key: string; label: string }[];
}[] = [
  {
    key: 'execution',
    title: '执行与容量',
    fields: [
      {
        key: 'maxConcurrent',
        label: '最大并发激活数',
        type: 'number',
        min: 1,
        max: 100,
        initial: 1
      },
      {
        key: 'cardMaxSubscriptionCount',
        label: '单卡订阅上限',
        type: 'number',
        min: 1,
        max: 100,
        initial: 2
      },
      {
        key: 'cardMaxDeclineCount',
        label: '单卡明确拒付上限',
        type: 'number',
        min: 1,
        max: 100,
        initial: 3
      },
      {
        key: 'maintenance',
        label: '维护模式',
        type: 'switch',
        initial: false,
        help: '立即拒绝新任务，当前任务按原规则完成后进入维护。'
      },
      {
        key: 'paymentRegion',
        label: '支付地区',
        type: 'select',
        options: regionOptions,
        initial: 'PH'
      }
    ]
  },
  {
    key: 'provider',
    title: '第三方代充',
    tests: [
      { key: 'gpt_api', label: '检测供应商连接' },
      { key: 'gpt_status', label: '查询余额与套餐' }
    ],
    fields: [
      { key: 'gptApiEnabled', label: '启用第三方代充', type: 'switch', initial: false },
      { key: 'gptApiBaseUrl', label: '供应商接口地址' },
      {
        key: 'gptApiKey',
        label: '供应商密钥',
        type: 'secret',
        transient: true,
        help: '留空保留已保存密钥。'
      }
    ]
  },
  {
    key: 'telegram',
    title: 'Telegram 通知',
    tests: [{ key: 'telegram', label: '发送测试通知' }],
    fields: [
      { key: 'telegramEnabled', label: '启用通知', type: 'switch', initial: false },
      { key: 'telegramBotToken', label: '机器人密钥', type: 'secret', transient: true },
      { key: 'telegramAdminChatId', label: '管理员接收编号', type: 'secret', transient: true },
      { key: 'telegramGroupChatId', label: '群组接收编号', type: 'secret', transient: true },
      { key: 'telegramAdminEnabled', label: '通知管理员', type: 'switch', initial: false },
      { key: 'telegramGroupEnabled', label: '通知群组', type: 'switch', initial: false },
      { key: 'telegramNotifySuccess', label: '成功时通知', type: 'switch', initial: false },
      { key: 'telegramNotifyFailure', label: '失败时通知', type: 'switch', initial: false },
      { key: 'telegramNotifyCardEmpty', label: '卡池为空时通知', type: 'switch', initial: false },
      {
        key: 'telegramOnAdminLogin',
        label: '登录安全事件通知',
        type: 'switch',
        initial: true,
        help: '按原规则包括登录成功、登录失败和二次验证失败；仍受启用通知及接收方开关控制。'
      }
    ]
  },
  {
    key: 'webhook',
    title: '银行卡补货回调',
    fields: [
      {
        key: 'cardSupplierWebhookSecret',
        label: '回调签名密钥',
        type: 'secret',
        transient: true,
        help: '留空保留已保存值；验签后才接收补货。'
      },
      { key: 'externalCardsApiKey', label: '外部导卡密钥', type: 'secret', transient: true }
    ]
  },
  {
    key: 'captcha',
    title: '验证码处理',
    tests: [
      { key: 'solver', label: '检测求解器' },
      { key: 'vlm', label: '检测视觉模型' },
      { key: 'captcha_platform', label: '检测打码平台' },
      { key: 'solver_logs', label: '查看求解器日志' }
    ],
    fields: [
      { key: 'hcaptchaEnabled', label: '启用验证码求解', type: 'switch', initial: true },
      { key: 'hcaptchaDisableVlm', label: '禁用视觉模型', type: 'switch', initial: false },
      { key: 'captchaPlatformApiKey', label: '打码平台密钥', type: 'secret', transient: true },
      {
        key: 'captchaPlatformBaseUrl',
        label: '打码平台地址',
        initial: ''
      },
      {
        key: 'captchaPlatformTimeoutMs',
        label: '平台超时（毫秒）',
        type: 'number',
        min: 30000,
        max: 600000,
        initial: 120000
      },
      { key: 'vlmApiKey', label: '视觉模型密钥', type: 'secret', transient: true },
      { key: 'vlmBaseUrl', label: '视觉模型地址', initial: 'https://api.openai.com/v1' },
      { key: 'vlmModel', label: '视觉模型名称', initial: 'gpt-5.5' },
      {
        key: 'vlmTimeoutMs',
        label: '模型超时（毫秒）',
        type: 'number',
        min: 10000,
        max: 600000,
        initial: 45000
      },
      {
        key: 'hcaptchaSolverTimeoutMs',
        label: '求解超时（毫秒）',
        type: 'number',
        min: 60000,
        max: 600000,
        initial: 240000
      },
      {
        key: 'cdpPort',
        label: '浏览器调试端口',
        type: 'number',
        min: 1024,
        max: 65535,
        initial: 9222
      }
    ]
  },
  {
    key: 'plans',
    title: '原版套餐标识',
    fields: [
      { key: 'planNamePlus', label: 'Plus 套餐标识', initial: 'chatgptplusplan' },
      { key: 'planNamePro5x', label: 'Pro 5 倍标识', initial: 'chatgptprolite' },
      { key: 'planNamePro20x', label: 'Pro 20 倍标识', initial: 'chatgptpro' }
    ]
  }
];
