#!/usr/bin/env node
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const rootDir = process.cwd();
const failures = [];
const sourceRoots = [
  'apps/admin/src/v2',
  'apps/admin/src/auth',
  'apps/api/src/id-business-v2',
  'apps/api/src/auth',
  'apps/api/src/v2-auth',
  'apps/api/src/audit-logs',
  'packages/shared/src'
];

for (const sourceRoot of sourceRoots) {
  for (const relativePath of listSourceFiles(sourceRoot)) {
    if (/\.(?:spec|test)\.[cm]?[jt]sx?$/.test(relativePath)) continue;
    if (relativePath.includes('/testing/')) continue;
    const source = readFileSync(path.join(rootDir, relativePath), 'utf8');
    checkForbiddenPatterns(source, relativePath);
    if (relativePath.startsWith('apps/admin/src/v2/')) {
      checkDateTimeFormatTimeZones(source, relativePath);
    }
  }
}

if (failures.length) {
  console.error(`V2 北京时间标准检查失败（${failures.length} 项）：`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log('V2 北京时间标准检查通过。');

function checkForbiddenPatterns(source, relativePath) {
  const rules = [
    [/Asia\/Kuala_Lumpur/g, '不允许继续使用旧业务时区 Asia/Kuala_Lumpur'],
    [/\.toLocale(?:String|DateString|TimeString)\s*\(/g, '日期展示必须显式指定 Asia/Shanghai'],
    [/getTimezoneOffset\s*\(/g, '不得按浏览器时区偏移计算业务时间']
  ];
  for (const [pattern, message] of rules) {
    for (const match of source.matchAll(pattern)) {
      failures.push(`${relativePath}:${lineAt(source, match.index)} ${message}`);
    }
  }
}

function checkDateTimeFormatTimeZones(source, relativePath) {
  const marker = 'new Intl.DateTimeFormat(';
  let index = source.indexOf(marker);
  while (index >= 0) {
    const expression = source.slice(index, index + 800);
    if (!/timeZone\s*:\s*(?:V2_BUSINESS_TIME_ZONE|'Asia\/Shanghai')/.test(expression)) {
      failures.push(
        `${relativePath}:${lineAt(source, index)} Intl.DateTimeFormat 必须显式指定 Asia/Shanghai`
      );
    }
    index = source.indexOf(marker, index + marker.length);
  }
}

function lineAt(source, index = 0) {
  return source.slice(0, index).split('\n').length;
}

function listSourceFiles(relativeRoot) {
  const absoluteRoot = path.join(rootDir, relativeRoot);
  return readdirSync(absoluteRoot, { withFileTypes: true }).flatMap((entry) => {
    const relativePath = path.join(relativeRoot, entry.name);
    if (entry.isDirectory()) return listSourceFiles(relativePath);
    return /\.(?:ts|tsx|vue|mjs)$/.test(entry.name) ? [relativePath] : [];
  });
}
