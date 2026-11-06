import { get } from 'node:http';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import { legacyWebsiteVisitIngest } from './legacy-public-routes.mjs';
import { createMicrosoftMailbox, legacyMicrosoftMailboxCallback } from './mailbox-microsoft.mjs';
import { mediaWorkerOrigin } from './media-resolver.mjs';
import { readToolConfig } from './read-tool-config.mjs';
import { parseToolPublicOrigin } from './request-origin.mjs';
import { createWebsiteAnalytics } from './website-analytics.mjs';
import { createWebsiteVisits } from './website-visits.mjs';

const healthTimeoutMs = 2000;
const healthMaxBytes = 1024;
const reservedPreviewPort = '4348';
const tools = {
  websiteAnalytics: {
    label: 'GA4 访问统计',
    option: 'website-analytics-config',
    kind: 'website-analytics',
    validate: (config) => createWebsiteAnalytics({ config }),
    fields: (config) => [
      ['propertyId', config.propertyId], ['streamId', config.streamId], ['hosts', config.hosts],
      ['serviceAccount.type', config.serviceAccount?.type],
      ['serviceAccount.client_email', config.serviceAccount?.client_email],
      ['serviceAccount.private_key', config.serviceAccount?.private_key]
    ],
    needs: ['FLASH CAST 媒体资源的只读服务账号文件', '可核对的真实报表日期范围']
  },
  websiteVisits: {
    label: '网站访问明细采集',
    option: 'website-visits-secret-file',
    kind: 'website-visits',
    validate: (secret, publicOrigin) => createWebsiteVisits({ secret, publicOrigin }),
    needs: ['独立新版签名文件', '可访问新版接收端的授权采集器及一条测试事件']
  },
  mediaResolver: {
    label: '抖音媒体执行器',
    option: 'media-resolver-url',
    needs: ['独立媒体执行器已运行，部署约定端口为 8787', '公开作品的解析与下载验收']
  },
  microsoftMailbox: {
    label: 'Microsoft 邮箱',
    option: 'microsoft-mailbox-config',
    kind: 'microsoft-mailbox',
    validate: (config, publicOrigin) => createMicrosoftMailbox({ config, publicOrigin }),
    fields: (config) => [['clientId', config.clientId], ['clientSecret', config.clientSecret], ['redirectUri', config.redirectUri]],
    needs: ['获准供新版使用的应用客户端 ID 与客户端密钥', '与实际访问地址匹配的已登记回调', '启用 IMAP 的授权测试邮箱']
  }
};

const optionNames = Object.values(tools).map(({ option }) => option);

function item(tool, status, checks, issues = []) {
  return {
    label: tool.label, option: '--' + tool.option, status,
    checks, issues, needsForRealIntegration: tool.needs,
    realIntegration: 'not_verified'
  };
}

function missing(tool) {
  return item(tool, 'missing', {}, [{
    code: 'OPTION_MISSING', message: '缺少显式配置参数'
  }]);
}

function loopbackPreview(value) {
  if (typeof value !== 'string' || !/^http:\/\/(?:127\.0\.0\.1|localhost):\d{1,5}\/?$/.test(value))
    throw new Error();
  const url = new URL(value);
  if (!url.port || Number(url.port) < 1) throw new Error();
  return url;
}

const absent = (value) => value == null || (typeof value === 'string' && !value.trim()) ||
  (Array.isArray(value) && !value.length);

async function checkFile(tool, input, preview, publicOrigin) {
  if (input === undefined) return missing(tool);
  let config;
  try {
    config = await readToolConfig(input, tool.kind);
  } catch (error) {
    const formatInvalid = error.code === 'CONFIG_FORMAT_INVALID';
    return item(tool, 'invalid', { file: 'failed' }, [{
      code: formatInvalid ? 'CONFIG_FORMAT_INVALID' : 'CONFIG_FILE_REJECTED',
      message: formatInvalid ? '配置内容格式无效' : '配置文件无法安全读取，请核对文件类型、所有者和权限'
    }]);
  }
  const checks = { file: 'passed' };
  const missingFields = tool.fields?.(config).filter(([, value]) => absent(value)).map(([name]) => name);
  if (missingFields?.length) {
    return item(tool, 'invalid', { ...checks, runtimeConfig: 'failed' }, [{
      code: 'CONFIG_FIELDS_MISSING', message: '缺少必填字段', fields: missingFields
    }]);
  }
  try {
    tool.validate(config, publicOrigin?.origin);
  } catch {
    return item(tool, 'invalid', { ...checks, runtimeConfig: 'failed' }, [{
      code: 'RUNTIME_CONFIG_INVALID', message: '字段值不符合工具的启动契约'
    }]);
  }
  checks.runtimeConfig = 'passed';
  if (tool.kind === 'microsoft-mailbox') {
    if (preview && new URL(config.redirectUri).origin !== preview.origin) {
      return item(tool, 'invalid', { ...checks, callbackOrigin: 'failed' }, [{
        code: 'CALLBACK_ORIGIN_MISMATCH', message: '回调主机或端口与计划使用的预览地址不一致'
      }]);
    }
    checks.callbackOrigin = preview || publicOrigin ? 'passed' : 'not_requested';
  }
  return item(tool, 'valid', checks);
}

// Use a direct socket to the literal loopback host. No redirects, proxies,
// credentials, API mutations, external requests, or response text in the report.
function probeMediaHealth(port) {
  return new Promise((resolve) => {
    const request = get({
      hostname: '127.0.0.1', port, path: '/health', agent: false,
      signal: AbortSignal.timeout(healthTimeoutMs), headers: { Accept: 'application/json' }
    }, (response) => {
      if (response.statusCode !== 200 ||
          !/^application\/json(?:\s*;|$)/i.test(response.headers['content-type'] || '')) {
        resolve('invalid_response');
        response.destroy();
        return;
      }
      let bytes = 0;
      const chunks = [];
      response.on('error', () => resolve('unavailable'));
      response.on('aborted', () => resolve('unavailable'));
      response.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > healthMaxBytes) {
          resolve('invalid_response');
          response.destroy();
        } else chunks.push(chunk);
      });
      response.on('end', () => {
        try {
          const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          resolve(payload?.ok === true ? 'passed' : 'invalid_response');
        } catch {
          resolve('invalid_response');
        }
      });
    });
    request.on('error', () => resolve('unavailable'));
  });
}

async function checkMedia(input, preview, probe) {
  const tool = tools.mediaResolver;
  if (input === undefined) return missing(tool);
  let port;
  try {
    if (typeof input !== 'string' || !/^http:\/\/127\.0\.0\.1:\d{1,5}\/?$/.test(input)) throw new Error();
    port = new URL(mediaWorkerOrigin(input)).port;
    if (Number(port) < 1) throw new Error();
  } catch {
    return item(tool, 'invalid', { runtimeConfig: 'failed' }, [{
      code: 'MEDIA_ORIGIN_INVALID', message: '执行器须使用独立的 127.0.0.1 HTTP 端口'
    }]);
  }
  if (port === reservedPreviewPort || port === preview?.port) {
    return item(tool, 'invalid', { runtimeConfig: 'failed' }, [{
      code: 'MEDIA_PORT_CONFLICT', message: '执行器端口与本机业务预览端口冲突'
    }]);
  }
  const checks = { runtimeConfig: 'passed', loopbackHealth: 'not_requested' };
  if (!probe) return item(tool, 'valid', checks);
  const result = await probeMediaHealth(port);
  checks.loopbackHealth = result;
  if (result === 'passed') return item(tool, 'valid', checks);
  return item(tool, 'unavailable', checks, [{
    code: result === 'invalid_response' ? 'MEDIA_HEALTH_INVALID' : 'MEDIA_HEALTH_UNAVAILABLE',
    message: result === 'invalid_response' ? '回环健康响应不符合执行器契约' : '未能在超时内读取回环健康响应'
  }]);
}

async function probePublicToolRoutes(publicOrigin, fetchImpl) {
  async function check(path, expectedStatus, expectedHeader, headerMatches) {
    try {
      const response = await fetchImpl(new URL(path, publicOrigin), {
        method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(3000)
      });
      await response.body?.cancel();
      if (response.status !== expectedStatus || !headerMatches(response.headers.get(expectedHeader)))
        return 'unexpected_response';
      return 'passed';
    } catch {
      return 'unavailable';
    }
  }
  const [microsoftCallback, visitIngest] = await Promise.all([
    check(legacyMicrosoftMailboxCallback, 400, 'Content-Type',
      (value) => /^text\/html(?:;|$)/i.test(value || '')),
    check(legacyWebsiteVisitIngest, 405, 'Allow', (value) => value === 'POST')
  ]);
  return { microsoftCallback, visitIngest };
}

export async function preflightOnlineTools(options = {}, { fetchImpl = fetch } = {}) {
  let preview;
  const publicOrigin = parseToolPublicOrigin(options['public-origin']);
  const probePublic = options['probe-public-routes'] === true;
  if (probePublic && !publicOrigin) throw new Error('检查公开路由需要指定 HTTPS 地址');
  if (options['preview-origin'] !== undefined) {
    if (publicOrigin) throw new Error('计划预览地址和公网地址只能指定一项');
    try {
      preview = loopbackPreview(options['preview-origin']);
    } catch {
      throw new Error('计划预览地址须为 localhost 或 127.0.0.1 的 HTTP 回环地址，并含端口');
    }
  }
  const [websiteAnalytics, websiteVisits, mediaResolver, microsoftMailbox, publicRoutes] = await Promise.all([
    checkFile(tools.websiteAnalytics, options[tools.websiteAnalytics.option], preview),
    checkFile(tools.websiteVisits, options[tools.websiteVisits.option], preview, publicOrigin),
    checkMedia(options[tools.mediaResolver.option], preview, options['probe-media'] === true),
    checkFile(tools.microsoftMailbox, options[tools.microsoftMailbox.option], preview, publicOrigin),
    probePublic ? probePublicToolRoutes(publicOrigin, fetchImpl) : undefined
  ]);
  const results = { websiteAnalytics, websiteVisits, mediaResolver, microsoftMailbox };
  const counts = { valid: 0, missing: 0, invalid: 0, unavailable: 0 };
  for (const result of Object.values(results)) counts[result.status]++;
  return { scope: publicOrigin ? 'public_config_preflight' : 'local_preflight', counts, tools: results, publicRoutes };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    const { values } = parseArgs({
      options: {
        ...Object.fromEntries(optionNames.map((name) => [name, { type: 'string' }])),
        'preview-origin': { type: 'string' },
        'public-origin': { type: 'string' },
        'probe-media': { type: 'boolean' },
        'probe-public-routes': { type: 'boolean' },
        help: { type: 'boolean' }
      }
    });
    if (values.help) {
      process.stdout.write(
        'node server/tools/online-tools-preflight.mjs [--website-analytics-config 文件] [--website-visits-secret-file 文件]\n' +
        '  [--media-resolver-url 回环地址] [--microsoft-mailbox-config 文件]\n' +
        '  [--preview-origin 计划预览地址 | --public-origin 正式 HTTPS 地址] [--probe-media]\n' +
        '  [--probe-public-routes]\n'
      );
    } else {
      const result = await preflightOnlineTools(values);
      process.stdout.write(JSON.stringify(result, null, 2) + '\n');
      if (result.counts.valid !== optionNames.length ||
          Object.values(result.publicRoutes || {}).some((status) => status !== 'passed')) process.exitCode = 2;
    }
  } catch {
    process.stderr.write('预检参数无效，请使用 --help 查看用法，并核对计划使用的地址。\n');
    process.exitCode = 1;
  }
}
