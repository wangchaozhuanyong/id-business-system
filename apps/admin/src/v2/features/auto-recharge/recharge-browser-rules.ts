import type { FormItemRule, FormRules } from 'element-plus';
import type { BitBrowserSettingsForm } from './useRechargeBrowserSettings';

const supportedBrowserTimeZones = new Set(['UTC', ...Intl.supportedValuesOf('timeZone')]);

export function browserOptionRules(form: BitBrowserSettingsForm): FormRules {
  const options = form.browserOptions;
  const credentials: FormItemRule = {
    trigger: 'blur',
    validator: (_rule, _value, callback) =>
      callback(
        form.clearStaticProxyCredentials ||
          (!form.staticProxyUsername && !form.staticProxyPassword) ||
          (form.staticProxyUsername.trim() && form.staticProxyPassword.trim())
          ? undefined
          : new Error('代理账号和密码请一起填写，或一起留空')
      )
  };
  return {
    'browserOptions.coreVersion': [
      {
        required: true,
        trigger: 'blur',
        validator: (_rule, value, callback) =>
          callback(
            typeof value === 'string' && /^[1-9]\d{1,2}$/.test(value) && Number(value) >= 96
              ? undefined
              : new Error('请填写客户端已安装的内核版本号，至少为 96')
          )
      }
    ],
    'browserOptions.osVersion': [
      {
        trigger: 'change',
        validator: (_rule, value, callback) =>
          callback(
            (options.os === 'Win32' ? ['11', '10'].includes(value) : value === '')
              ? undefined
              : new Error('请选择有效的系统版本')
          )
      }
    ],
    'browserOptions.openWidth': [
      {
        required: true,
        type: 'integer',
        min: 800,
        max: 7680,
        message: '窗口宽度应为 800 至 7680 像素的整数',
        trigger: 'change'
      }
    ],
    'browserOptions.openHeight': [
      {
        required: true,
        type: 'integer',
        min: 600,
        max: 4320,
        message: '窗口高度应为 600 至 4320 像素的整数',
        trigger: 'change'
      }
    ],
    'browserOptions.sessionWaitMinutes': [
      {
        required: true,
        type: 'integer',
        min: 1,
        max: 10,
        message: '等待时间应为 1 至 10 分钟的整数',
        trigger: 'change'
      }
    ],
    'browserOptions.sessionRetryLimit': [
      {
        required: true,
        type: 'integer',
        min: 0,
        max: 9,
        message: '网络恢复次数应为 0 至 9 的整数',
        trigger: 'change'
      }
    ],
    'browserOptions.staticHost': [
      { required: options.proxyMode === 'static', message: '请填写固定代理主机', trigger: 'blur' }
    ],
    'browserOptions.staticPort': [
      {
        required: true,
        type: 'integer',
        min: 1,
        max: 65535,
        message: '端口应为 1 至 65535 的整数',
        trigger: 'blur'
      }
    ],
    'browserOptions.timezone': [
      {
        trigger: 'change',
        validator: (_rule, value, callback) => {
          try {
            if (
              typeof value !== 'string' ||
              !/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_+-]+)*$/.test(value) ||
              !supportedBrowserTimeZones.has(value)
            )
              throw new Error();
            callback();
          } catch {
            callback(new Error('请输入有效的完整时区名称'));
          }
        }
      }
    ],
    'browserOptions.latitude': [
      {
        required: true,
        type: 'number',
        min: -90,
        max: 90,
        message: '纬度范围为 -90 至 90',
        trigger: 'blur'
      }
    ],
    'browserOptions.longitude': [
      {
        required: true,
        type: 'number',
        min: -180,
        max: 180,
        message: '经度范围为 -180 至 180',
        trigger: 'blur'
      }
    ],
    'browserOptions.accuracy': [
      {
        required: true,
        type: 'number',
        min: 1,
        max: 100000,
        message: '精度范围为 1 至 100000 米',
        trigger: 'blur'
      }
    ],
    staticProxyUsername: [credentials],
    staticProxyPassword: [credentials]
  };
}
