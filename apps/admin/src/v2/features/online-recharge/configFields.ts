import type { OnlineField } from './contracts';
import { regionOptions } from './labels';
import { planRegionFields } from './planRegionFields';
export const configGroups: {
  key: string;
  title: string;
  help: string | string[];
  fields: (OnlineField & { explanation: string })[];
  tests?: { key: string; label: string }[];
}[] = [
  {
    key: 'execution',
    title: '执行与容量',
    help: [
      '设置一次处理多少笔充值、每张银行卡用到什么程度后停用，以及充值使用的地区和网络。',
      '拿不准时先保留现有数量。支付地区决定官网结算地区，代理国家决定上网出口，两项要分别选择。'
    ],
    fields: [
      {
        key: 'maxConcurrent',
        label: '最大并发激活数',
        explanation:
          '同一时间最多处理几笔充值。例如填 1，就一次处理一笔；调大前需要有足够的银行卡、代理和浏览器资源。',
        type: 'number',
        min: 1,
        max: 100,
        initial: 1
      },
      {
        key: 'cardMaxSubscriptionCount',
        label: '单卡订阅上限',
        explanation:
          '一张银行卡累计成功充值多少次后，系统就暂停使用这张卡。例如填 2，成功两次后不再安排新充值。调整后会重新判断卡片是否达到上限。',
        type: 'number',
        min: 1,
        max: 100,
        initial: 2
      },
      {
        key: 'cardMaxDeclineCount',
        label: '单卡明确拒付上限',
        explanation:
          '同一张卡被银行明确拒绝付款多少次后停止使用。例如填 3，明确拒付累计三次就停用；普通网络故障不按明确拒付计算。',
        type: 'number',
        min: 1,
        max: 100,
        initial: 3
      },
      {
        key: 'maintenance',
        label: '维护模式',
        explanation:
          '临时暂停接收新充值时打开。已经开始的任务仍按原规则处理；准备恢复接单时再关闭。',
        type: 'switch',
        initial: false,
        help: '立即拒绝新任务，当前任务按原规则完成后进入维护。'
      },
      {
        key: 'paymentRegion',
        label: '支付地区',
        explanation:
          '告诉官网按哪个国家或地区结算，会影响币种和价格。例如菲律宾通常使用菲律宾比索，最终以官网结算页为准。这里不会同时修改代理国家。',
        type: 'select',
        options: regionOptions,
        initial: 'PH'
      },
      {
        key: 'proxyCountryCode',
        label: '代理国家',
        explanation:
          '选择充值时从哪个国家的网络访问官网。国家来自“账号设置 → 代理 IP 管理”中已启用的代理；只在所选国家内轮换，没有可用代理时停止创建新任务，不会自动换国家。',
        type: 'select',
        initial: '',
        help: '只使用所选国家的启用代理，同国多条可轮换；未设置或没有可用代理时无法创建新任务，不切换其他国家。代理国家与支付地区分别设置。'
      }
    ]
  },
  {
    key: 'plan-regions',
    title: '套餐地区规则',
    help: '按套餐分别设置上网出口与官网结算地区。默认 Plus／Pro 200 为菲律宾，Pro 100／Pro 500 为智利。保存并开启后只影响新任务；升级币种不符时停止，Pro 500 付款保护保留。',
    fields: planRegionFields
  },
  {
    key: 'provider',
    title: '第三方代充',
    help: [
      '对接外部代充供应商时使用。自己用银行卡在官网充值时，不需要为了充值而打开这一项。',
      '地址和密钥由供应商提供。检测连接、查询余额与套餐使用已保存的配置，修改后请先保存。'
    ],
    tests: [
      { key: 'gpt_api', label: '检测供应商连接' },
      { key: 'gpt_status', label: '查询余额与套餐' }
    ],
    fields: [
      {
        key: 'gptApiEnabled',
        label: '启用第三方代充',
        explanation:
          '允许系统使用外部供应商的代充服务。只有已经对接供应商时才打开；不使用第三方代充就保持关闭。',
        type: 'switch',
        initial: false
      },
      {
        key: 'gptApiBaseUrl',
        label: '供应商接口地址',
        explanation:
          '填写供应商提供的服务接口地址，不是供应商的登录页面。没有对接供应商时可以不填。'
      },
      {
        key: 'gptApiKey',
        label: '供应商密钥',
        explanation:
          '供应商发给你的连接凭证，系统靠它查询和使用供应商服务。留空不会清除已保存的密钥，只有需要更换时才填写。',
        type: 'secret',
        transient: true,
        help: '留空保留已保存密钥。'
      }
    ]
  },
  {
    key: 'telegram',
    title: 'Telegram 通知',
    help: [
      '把充值结果、银行卡不足或登录安全事件发送到 Telegram 私聊或群组。不需要消息通知时保持关闭。',
      '需要同时打开“启用通知”、对应接收方和需要的事件开关。“发送测试通知”会向已配置的接收方实际发消息，请先保存配置。'
    ],
    tests: [{ key: 'telegram', label: '发送测试通知' }],
    fields: [
      {
        key: 'telegramEnabled',
        label: '启用通知',
        type: 'switch',
        initial: false,
        explanation:
          '所有 Telegram 通知的总开关。关闭后，即使下面的事件开关已打开，也不会发送通知。'
      },
      {
        key: 'telegramBotToken',
        label: '机器人密钥',
        type: 'secret',
        transient: true,
        explanation:
          '填写创建 Telegram 机器人后获得的密钥，系统用这个机器人发消息。留空保留已保存值。'
      },
      {
        key: 'telegramAdminChatId',
        label: '管理员接收编号',
        type: 'secret',
        transient: true,
        explanation:
          '接收通知的 Telegram 私聊编号，不是手机号或用户名。使用前需要接收人先与机器人开始聊天；留空保留已保存值。'
      },
      {
        key: 'telegramGroupChatId',
        label: '群组接收编号',
        type: 'secret',
        transient: true,
        explanation:
          '接收通知的 Telegram 群组编号，不是群名称。机器人需要已加入该群并能发消息；留空保留已保存值。'
      },
      {
        key: 'telegramAdminEnabled',
        label: '通知管理员',
        type: 'switch',
        initial: false,
        explanation:
          '把已选事件发送到上面填写的管理员私聊。还需要打开“启用通知”，并填好机器人密钥和管理员接收编号。'
      },
      {
        key: 'telegramGroupEnabled',
        label: '通知群组',
        type: 'switch',
        initial: false,
        explanation:
          '把已选事件发送到上面填写的群组。还需要打开“启用通知”，并填好机器人密钥和群组接收编号。'
      },
      {
        key: 'telegramNotifySuccess',
        label: '成功时通知',
        type: 'switch',
        initial: false,
        explanation: '充值任务成功后发送消息。仅在通知总开关和至少一个接收方已开启时生效。'
      },
      {
        key: 'telegramNotifyFailure',
        label: '失败时通知',
        type: 'switch',
        initial: false,
        explanation:
          '充值任务失败时发送消息，方便及时查看原因。仅在通知总开关和至少一个接收方已开启时生效。'
      },
      {
        key: 'telegramNotifyCardEmpty',
        label: '卡池为空时通知',
        type: 'switch',
        initial: false,
        explanation:
          '系统发现没有可用银行卡时发送补卡提醒。仅在通知总开关和至少一个接收方已开启时生效。'
      },
      {
        key: 'telegramOnAdminLogin',
        label: '登录安全事件通知',
        explanation:
          '系统登录成功、登录失败或二次验证失败时发送提醒，方便发现异常登录。仍需要开启通知总开关和接收方。',
        type: 'switch',
        initial: true,
        help: '按原规则包括登录成功、登录失败和二次验证失败；仍受启用通知及接收方开关控制。'
      }
    ]
  },
  {
    key: 'webhook',
    title: '银行卡补货回调',
    help: [
      '让外部供卡系统自动把新银行卡送进本系统。只是自己手动添加银行卡时，不需要对接这里。',
      '回调地址给供卡方使用；下面两种密钥分别用于不同的补货接入方式，按供卡方对接要求配置。'
    ],
    fields: [
      {
        key: 'cardSupplierWebhookSecret',
        label: '回调签名密钥',
        explanation:
          '与供卡方约定的一段密钥，用来检查自动补货消息是否可信。双方必须一致，验证通过才接收卡片；留空保留已保存值。',
        type: 'secret',
        transient: true,
        help: '留空保留已保存值；验签后才接收补货。'
      },
      {
        key: 'externalCardsApiKey',
        label: '外部导卡密钥',
        type: 'secret',
        transient: true,
        explanation:
          '外部程序调用导入银行卡功能时使用的通行凭证，不是银行卡密码或安全码。手动加卡不需要填写；留空保留已保存值。'
      }
    ]
  },
  {
    key: 'captcha',
    title: '验证码处理',
    help: [
      '官网出现图片验证等人机验证时，供充值执行器尝试自动处理。相关服务地址、密钥和模型名称由服务提供方给出。',
      '超时是最多等待多久，不是处理速度：1000 毫秒等于 1 秒。通常先保留现有数值，检测按钮使用已保存的配置。'
    ],
    tests: [
      { key: 'solver', label: '检测求解器' },
      { key: 'vlm', label: '检测视觉模型' },
      { key: 'captcha_platform', label: '检测打码平台' },
      { key: 'solver_logs', label: '查看求解器日志' }
    ],
    fields: [
      {
        key: 'hcaptchaEnabled',
        label: '启用验证码求解',
        type: 'switch',
        initial: true,
        explanation:
          '允许执行器尝试自动处理官网的人机验证码。关闭后不再使用这项自动处理能力，遇到验证可能无法继续。'
      },
      {
        key: 'hcaptchaDisableVlm',
        label: '禁用视觉模型',
        type: 'switch',
        initial: false,
        explanation:
          '视觉模型就是能看图的 AI。这个开关打开表示不让它参与验证码识别；关闭才允许使用，仍需配置可用的模型服务。'
      },
      {
        key: 'captchaPlatformApiKey',
        label: '打码平台密钥',
        type: 'secret',
        transient: true,
        explanation:
          '外部验证码处理平台提供的连接凭证。使用该平台时填写，服务可能按平台规则计费；留空保留已保存值。'
      },
      {
        key: 'captchaPlatformBaseUrl',
        label: '打码平台地址',
        explanation:
          '外部验证码处理平台提供的接口地址，不是平台的登录页面。需要与上面的平台密钥配套使用。',
        initial: ''
      },
      {
        key: 'captchaPlatformTimeoutMs',
        label: '平台超时（毫秒）',
        explanation:
          '一次请求外部验证码平台最多等待多久。例如 120000 毫秒是 2 分钟；数值越大只表示愿意等更久，不会让识别更快。',
        type: 'number',
        min: 30000,
        max: 600000,
        initial: 120000
      },
      {
        key: 'vlmApiKey',
        label: '视觉模型密钥',
        type: 'secret',
        transient: true,
        explanation:
          '看图 AI 服务提供的连接凭证，需要与模型地址配套。使用服务可能产生模型费用；留空保留已保存值。'
      },
      {
        key: 'vlmBaseUrl',
        label: '视觉模型地址',
        initial: 'https://api.openai.com/v1',
        explanation:
          '看图 AI 服务的接口地址。使用哪个服务，就填写该服务提供的地址；不要填写聊天网页的网址。'
      },
      {
        key: 'vlmModel',
        label: '视觉模型名称',
        initial: 'gpt-5.5',
        explanation:
          '填写模型服务支持的、能识别图片的模型名称。名称必须与服务提供方要求一致，不能随便填写一个显示名称。'
      },
      {
        key: 'vlmTimeoutMs',
        label: '模型超时（毫秒）',
        explanation:
          '一次请求看图 AI 最多等待多久。例如 45000 毫秒是 45 秒，超过这个时间还没有结果就按超时处理。',
        type: 'number',
        min: 10000,
        max: 600000,
        initial: 45000
      },
      {
        key: 'hcaptchaSolverTimeoutMs',
        label: '求解超时（毫秒）',
        explanation:
          '一次验证码处理流程最多等待多久。例如 240000 毫秒是 4 分钟。这是处理流程的等待上限，和单次平台、模型请求的超时分别设置。',
        type: 'number',
        min: 60000,
        max: 600000,
        initial: 240000
      },
      {
        key: 'cdpPort',
        label: '浏览器调试端口',
        explanation:
          '充值执行器连接浏览器时使用的内部连接编号，通常保留 9222。只有部署或浏览器连接方式调整时才需要由维护人员修改。',
        type: 'number',
        min: 1024,
        max: 65535,
        initial: 9222
      }
    ]
  },
  {
    key: 'plans',
    title: '官网套餐标识',
    help: [
      '这是系统向官网选择套餐时使用的内部代号，不是给客户看的套餐名称，也不是售价。',
      '已有可用值请保留，只在核实官网代号后修改。填错可能选错套餐或无法继续充值。'
    ],
    fields: [
      {
        key: 'planNamePlus',
        label: 'Plus 套餐标识',
        initial: 'chatgptplusplan',
        explanation:
          '系统选择 Plus 套餐时提交给官网的内部代号。正常使用时保留现有值，不要改成套餐价格或中文名称。'
      },
      {
        key: 'planNamePro5x',
        label: 'Pro 100 标识',
        initial: 'chatgptprolite',
        explanation:
          '系统选择 Pro 100 套餐时提交给官网的内部代号。正常使用时保留现有值，只有核实官网发生变化后才修改。'
      },
      {
        key: 'planNamePro20x',
        label: 'Pro 200 标识',
        initial: 'chatgptpro',
        explanation:
          '系统选择 Pro 200 套餐时提交给官网的内部代号。正常使用时保留现有值，只有核实官网发生变化后才修改。'
      },
      {
        key: 'planNamePro500',
        label: 'Pro 500 标识',
        explanation:
          '只有核实 Pro 500 对应的官网内部代号后才能填写。目前留空可以做付款前调试，但系统会暂停自动付款，也不会改充其他档位。',
        initial: '',
        help: '仅填写已核实的官网标识；留空可做 Pro 500 付款前调试，自动付款暂停，不改用其他档位。'
      }
    ]
  }
];
