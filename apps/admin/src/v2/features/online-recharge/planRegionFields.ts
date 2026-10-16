import type { OnlineField } from './contracts';
import { regionOptions } from './labels';

const plans = [
  ['Plus', 'Plus', 'PH'],
  ['Pro 100', 'Pro5x', 'CL'],
  ['Pro 200', 'Pro20x', 'PH'],
  ['Pro 500', 'Pro500', 'CL']
] as const;

type PlanRegionField = OnlineField & { explanation: string };
export const planRegionFields: PlanRegionField[] = [
  {
    key: 'planRegionRoutingEnabled',
    label: '按套餐选择地区',
    explanation:
      '打开并保存后，系统会根据充值的目标套餐自动选择下面对应的代理国家和支付地区；关闭时仍使用上面的全局设置。已经创建的任务不受影响。',
    type: 'switch',
    initial: false,
    help: '保存并开启后，新充值和付款前调试会按目标套餐自动选择地区；关闭时沿用全局设置。已有任务不受修改影响。'
  },
  ...plans.flatMap(([label, suffix, initial]): PlanRegionField[] => [
    {
      key: `planProxyCountry${suffix}`,
      label: `${label} 代理国家`,
      explanation: `为 ${label} 充值选择上网出口。只使用这个国家已启用的代理，没有可用代理时会停止；不会自动切换其他国家，也不会修改账单地址。`,
      type: 'select',
      initial,
      help: '只使用所选国家的已启用代理；没有可用代理时停止，不自动换国家。'
    },
    {
      key: `planPaymentRegion${suffix}`,
      label: `${label} 支付地区`,
      explanation: `为 ${label} 选择官网结算地区，对应币种显示在输入框下方。已有有效订阅升级时，官网可能沿用原币种；不符合本次规则就暂停，不会自动取消原订阅。`,
      type: 'select',
      initial,
      options: regionOptions
    }
  ])
];

export const paymentCurrencyLabels: Record<string, string> = {
  PH: 'PHP',
  CL: 'CLP',
  US: 'USD',
  SG: 'SGD',
  MY: 'MYR'
};
