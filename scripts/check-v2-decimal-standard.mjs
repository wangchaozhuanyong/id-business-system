#!/usr/bin/env node
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const rootDir = process.cwd();
const failures = [];
const sourceRoots = ['apps/admin/src', 'apps/api/src/id-business-v2', 'packages/shared/src'];
const maxExchangeRateDecimalPlaces = 8;
const forbiddenPatterns = [
  {
    pattern: /toFixed\(\s*(?:[5-9]|\d{2,})\s*\)/g,
    message: '不允许把页面数值格式化为超过 4 位小数'
  },
  {
    pattern: /maximumFractionDigits\s*:\s*(?:[5-9]|\d{2,})/g,
    message: '不允许设置超过 4 位的小数展示精度'
  },
  {
    pattern: /:precision="(?:[5-9]|\d{2,})"/g,
    message: '输入组件精度必须使用全局四位精度常量'
  },
  {
    pattern: /\\d\{1,(?:[5-9]|\d{2,})\}/g,
    message: '业务数值校验不允许接受超过 4 位小数'
  },
  {
    pattern: /最多\s*(?:[5-9]|\d{2,})\s*位小数/g,
    message: '业务提示不允许声明超过 4 位小数'
  },
  {
    pattern: /toDecimalPlaces\(\s*(?:[5-9]|\d{2,})\s*[,)]/g,
    message: '业务计算不允许舍入到超过 4 位小数'
  }
];

for (const sourceRoot of sourceRoots) {
  for (const relativePath of listSourceFiles(sourceRoot)) {
    if (/\.(?:spec|test)\.[cm]?[jt]sx?$/.test(relativePath)) continue;
    const source = readFileSync(path.join(rootDir, relativePath), 'utf8');
    for (const rule of forbiddenPatterns) {
      for (const match of source.matchAll(rule.pattern)) {
        if (isAllowedExchangeRatePrecision(source, match.index, match[0])) continue;
        const line = source.slice(0, match.index).split('\n').length;
        failures.push(`${relativePath}:${line} ${rule.message}：${match[0]}`);
      }
    }
  }
}

if (failures.length) {
  console.error(`V2 金额四位、汇率八位小数标准检查失败（${failures.length} 项）：`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log('V2 金额四位、汇率八位小数标准检查通过。');

function isAllowedExchangeRatePrecision(source, matchIndex, matchedText) {
  const requestedPlaces = Math.max(
    ...Array.from(matchedText.matchAll(/\d+/g), ([digits]) => Number(digits))
  );
  if (!Number.isFinite(requestedPlaces) || requestedPlaces > maxExchangeRateDecimalPlaces) {
    return false;
  }

  const context = source.slice(
    Math.max(0, matchIndex - 240),
    Math.min(source.length, matchIndex + matchedText.length + 240)
  );
  return /exchange.?rate|settlement.?rate|effective.?rate|weightedAverage(?:Settlement)?Rate|RATE_PATTERN|汇率|\bfx\b/i.test(
    context
  );
}

function listSourceFiles(relativeRoot) {
  const absoluteRoot = path.join(rootDir, relativeRoot);
  return readdirSync(absoluteRoot, { withFileTypes: true }).flatMap((entry) => {
    const relativePath = path.join(relativeRoot, entry.name);
    if (entry.isDirectory()) return listSourceFiles(relativePath);
    return /\.(?:ts|tsx|vue|mjs)$/.test(entry.name) ? [relativePath] : [];
  });
}
