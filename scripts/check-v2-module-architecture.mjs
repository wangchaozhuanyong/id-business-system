#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const rootDir = process.cwd();
const frontendRoot = 'apps/admin/src/v2/features';
const backendRoot = 'apps/api/src/id-business-v2';
const issues = [];

const expectedFeatures = [
  'account-losses',
  'accounts',
  'activations',
  'audit-logs',
  'branding',
  'business-monitoring',
  'customers',
  'dashboard',
  'data-analytics',
  'data-governance',
  'employees',
  'exchange-rates',
  'finance-expenses',
  'finance-ledger',
  'options',
  'order-entry',
  'orders',
  'profile',
  'renewals',
  'roles',
  'security',
  'system-monitoring',
  'topup-records',
  'topups'
];
const plannedFeatures = new Set();
const expectedBackendDomains = [
  'accounts',
  'activations',
  'balances',
  'branding',
  'business-monitoring',
  'change-sync',
  'customers',
  'data-governance',
  'dashboard',
  'exchange-rates',
  'finance',
  'gift-cards',
  'options',
  'orders',
  'renewals',
  'runtime',
  'sensitive-access',
  'system-monitoring',
  'table-preferences',
  'topup-supplier-funds',
  'workspace'
];

checkFrontendFeatures();
const frontendGraph = checkFrontendBoundaries();
checkDependencyCycles(frontendGraph, '前端 feature');
const backendGraph = checkBackendBoundaries();
checkDependencyCycles(backendGraph, '后端业务域');
checkLineBudgets();

if (issues.length) {
  console.error('V2 module architecture check failed:');
  for (const issue of issues) console.error(`- ${issue}`);
  process.exitCode = 1;
} else {
  console.log(
    JSON.stringify({
      ok: true,
      frontendFeatures: expectedFeatures.length,
      backendDomains: expectedBackendDomains.length,
      crossFeatureImports: [...frontendGraph.values()].reduce(
        (total, imports) => total + imports.size,
        0
      ),
      crossDomainImports: [...backendGraph.values()].reduce(
        (total, imports) => total + imports.size,
        0
      ),
      policy: {
        featureViewMaxLines: 500,
        featureUnitMaxLines: 600,
        backendServiceMaxLines: 600,
        backendUnitMaxLines: 600,
        crossFeatureImports: 'public-api-only',
        crossDomainImports: 'public-api-only',
        dependencyCycles: 'forbidden'
      }
    })
  );
}

function checkFrontendFeatures() {
  const registryPath = `${frontendRoot}/registry.ts`;
  const registrySource = read(registryPath);
  const keys = new Map();
  const routes = new Map();

  for (const feature of expectedFeatures) {
    const featurePath = `${frontendRoot}/${feature}`;
    const requiredFiles = plannedFeatures.has(feature)
      ? ['manifest.ts']
      : ['manifest.ts', 'api.ts', 'contracts.ts'];
    for (const file of requiredFiles) {
      requireFile(`${featurePath}/${file}`);
    }

    const manifestPath = `${featurePath}/manifest.ts`;
    if (!exists(manifestPath)) continue;
    const manifestSource = read(manifestPath);
    const viewName = manifestSource.match(
      /loadView:\s*\(\)\s*=>\s*import\('\.\/(V2[A-Za-z0-9]+View\.vue)'\)/
    )?.[1];
    const key = manifestSource.match(/^\s{2}key:\s*'([^']+)',/m)?.[1];
    const route = manifestSource.match(/^\s{2}route:\s*'([^']+)',/m)?.[1];

    if (!viewName) {
      issues.push(`${manifestPath}: loadView 必须加载当前 feature 目录内的 V2 页面`);
    } else {
      const viewPath = `${featurePath}/${viewName}`;
      requireFile(viewPath);
      if (exists(viewPath)) {
        const viewSource = read(viewPath);
        if (/from\s+['"]@\/v2\/(?:api|types)\//.test(viewSource)) {
          issues.push(`${viewPath}: 页面必须通过本 feature 的 api.ts/contracts.ts 访问共享实现`);
        }
        if (/from\s+['"]\.\.\/\.\.\/(?:api|types)\//.test(viewSource)) {
          issues.push(`${viewPath}: 页面禁止相对路径绕过 feature 门面`);
        }
      }
    }

    if (!key) {
      issues.push(`${manifestPath}: 缺少模块 key`);
    } else if (keys.has(key)) {
      issues.push(`${manifestPath}: 模块 key ${key} 与 ${keys.get(key)} 重复`);
    } else {
      keys.set(key, manifestPath);
    }
    if (!route) {
      issues.push(`${manifestPath}: 缺少 route`);
    } else if (routes.has(route)) {
      issues.push(`${manifestPath}: route ${route} 与 ${routes.get(route)} 重复`);
    } else {
      routes.set(route, manifestPath);
    }
    for (const field of [
      'title',
      'group',
      'sourceSheet',
      'kind',
      'freshnessPolicy',
      'filters',
      'tables'
    ]) {
      if (!new RegExp(`\\b${field}:`).test(manifestSource)) {
        issues.push(`${manifestPath}: 缺少 ${field}`);
      }
    }
    if (plannedFeatures.has(feature)) {
      for (const snippet of ["status: 'planned'", "kind: 'planned'", 'plannedSections:']) {
        if (!manifestSource.includes(snippet)) {
          issues.push(`${manifestPath}: 规划模块缺少 ${snippet}`);
        }
      }
    }
    if (!registrySource.includes(`@/v2/features/${feature}/manifest`)) {
      issues.push(`${registryPath}: 未注册 ${feature} feature`);
    }
  }

  const actualFeatureDirs = readdirSync(absolute(frontendRoot), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  for (const feature of actualFeatureDirs) {
    if (!expectedFeatures.includes(feature)) {
      issues.push(`${frontendRoot}/${feature}: 新 feature 必须加入架构门禁清单`);
    }
  }
}

function checkFrontendBoundaries() {
  const graph = new Map(expectedFeatures.map((feature) => [feature, new Set()]));

  for (const feature of expectedFeatures) {
    const featurePath = `${frontendRoot}/${feature}`;
    for (const filePath of recursiveFiles(featurePath).filter(isFrontendSourceFile)) {
      if (isTestFile(filePath)) continue;
      const source = read(filePath);
      const basename = path.posix.basename(filePath);
      if (!['api.ts', 'contracts.ts', 'public-api.ts'].includes(basename)) {
        if (/from\s+['"]@\/v2\/(?:api|types)\//.test(source)) {
          issues.push(`${filePath}: feature 实现必须通过本模块 api.ts/contracts.ts 访问共享实现`);
        }
        if (/from\s+['"](?:\.\.\/)+\.\.\/(?:api|types)\//.test(source)) {
          issues.push(`${filePath}: feature 实现禁止使用相对路径绕过本模块门面`);
        }
      }

      for (const specifier of importSpecifiers(source)) {
        const target = resolveFrontendFeatureImport(filePath, specifier);
        if (!target || target.feature === feature) continue;
        graph.get(feature).add(target.feature);
        if (target.entry !== 'public-api' && target.entry !== 'public-api.ts') {
          issues.push(
            `${filePath}: 跨 feature 依赖 ${target.feature}/${target.entry} 必须改为 ${target.feature}/public-api`
          );
        }
      }
    }
  }

  return graph;
}

function checkBackendBoundaries() {
  const graph = new Map(expectedBackendDomains.map((domain) => [domain, new Set()]));

  for (const domain of expectedBackendDomains) {
    const domainPath = `${backendRoot}/${domain}`;
    requireFile(`${domainPath}/public-api.ts`);
    for (const filePath of recursiveFiles(domainPath).filter((file) => file.endsWith('.ts'))) {
      if (isTestFile(filePath)) continue;
      const source = read(filePath);
      for (const specifier of importSpecifiers(source)) {
        const target = resolveBackendDomainImport(filePath, specifier);
        if (!target || target.domain === domain) continue;
        graph.get(domain).add(target.domain);
        if (target.entry !== 'public-api' && target.entry !== 'public-api.ts') {
          issues.push(
            `${filePath}: 跨域依赖 ${target.domain}/${target.entry} 必须改为 ${target.domain}/public-api`
          );
        }
      }
    }
  }

  const actualBackendDomains = readdirSync(absolute(backendRoot), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  for (const domain of actualBackendDomains) {
    if (!expectedBackendDomains.includes(domain)) {
      issues.push(`${backendRoot}/${domain}: 新后端 domain 必须加入架构门禁清单`);
    }
  }

  return graph;
}

function checkDependencyCycles(graph, label) {
  const visiting = new Set();
  const visited = new Set();
  const stack = [];

  const visit = (domain) => {
    if (visiting.has(domain)) {
      const cycleStart = stack.indexOf(domain);
      issues.push(`${label} 存在循环依赖: ${[...stack.slice(cycleStart), domain].join(' -> ')}`);
      return;
    }
    if (visited.has(domain)) return;
    visiting.add(domain);
    stack.push(domain);
    for (const dependency of graph.get(domain) ?? []) visit(dependency);
    stack.pop();
    visiting.delete(domain);
    visited.add(domain);
  };

  for (const domain of graph.keys()) visit(domain);
}

function importSpecifiers(source) {
  return [...source.matchAll(/(?:from\s+|import\()\s*['"]([^'"]+)['"]/g)].map((match) => match[1]);
}

function resolveFrontendFeatureImport(filePath, specifier) {
  let targetPath;
  if (specifier.startsWith('@/v2/features/')) {
    targetPath = `${frontendRoot}/${specifier.slice('@/v2/features/'.length)}`;
  } else if (specifier.startsWith('.')) {
    targetPath = path.posix.normalize(path.posix.join(path.posix.dirname(filePath), specifier));
  } else {
    return null;
  }
  const relativePath = path.posix.relative(frontendRoot, targetPath);
  if (relativePath.startsWith('../')) return null;
  const [feature, ...entryParts] = relativePath.split('/');
  if (!expectedFeatures.includes(feature)) return null;
  return { feature, entry: entryParts.join('/') };
}

function resolveBackendDomainImport(filePath, specifier) {
  if (!specifier.startsWith('.')) return null;
  const targetPath = path.posix.normalize(path.posix.join(path.posix.dirname(filePath), specifier));
  const relativePath = path.posix.relative(backendRoot, targetPath);
  if (relativePath.startsWith('../')) return null;
  const [domain, ...entryParts] = relativePath.split('/');
  if (!expectedBackendDomains.includes(domain)) return null;
  return { domain, entry: entryParts.join('/') };
}

function isFrontendSourceFile(filePath) {
  return filePath.endsWith('.ts') || filePath.endsWith('.vue');
}

function isTestFile(filePath) {
  return /\.(?:spec|test)\.ts$/.test(filePath);
}

function checkLineBudgets() {
  const frontendFiles = recursiveFiles(frontendRoot);
  const frontendViews = frontendFiles.filter((file) => /\/V2[^/]+View\.vue$/.test(file));
  for (const filePath of frontendViews) {
    enforceLineBudget(filePath, 500);
  }
  const frontendUnits = frontendFiles.filter(
    (file) =>
      (/\/components\/[^/]+\.vue$/.test(file) || /\/use[A-Za-z0-9]+Page\.ts$/.test(file)) &&
      !frontendViews.includes(file)
  );
  for (const filePath of frontendUnits) {
    enforceLineBudget(filePath, 600, new Map());
  }

  const backendServices = recursiveFiles(backendRoot).filter((file) =>
    file.endsWith('.service.ts')
  );
  for (const filePath of backendServices) {
    enforceLineBudget(filePath, 600);
  }
  const backendUnits = recursiveFiles(backendRoot).filter(
    (file) =>
      /-(?:support|operations|query|import|input|types)\.ts$/.test(file) &&
      !file.endsWith('.spec.ts')
  );
  for (const filePath of backendUnits) {
    enforceLineBudget(filePath, 600, new Map());
  }
}

function enforceLineBudget(filePath, defaultBudget, overrides = new Map()) {
  const lineCount = countLines(read(filePath));
  const budget = overrides.get(filePath) ?? defaultBudget;
  if (lineCount > budget) {
    const label = overrides.has(filePath) ? '已登记文件不得继续增长' : '请拆分职责';
    issues.push(`${filePath}: ${lineCount} 行超过 ${budget} 行上限，${label}`);
  }
}

function recursiveFiles(projectPath) {
  if (!exists(projectPath)) return [];
  const entries = readdirSync(absolute(projectPath), { withFileTypes: true });
  return entries.flatMap((entry) => {
    const childPath = `${projectPath}/${entry.name}`;
    return entry.isDirectory() ? recursiveFiles(childPath) : [childPath];
  });
}

function requireFile(projectPath) {
  if (!exists(projectPath)) issues.push(`${projectPath}: 文件不存在`);
}

function exists(projectPath) {
  return existsSync(absolute(projectPath));
}

function read(projectPath) {
  return readFileSync(absolute(projectPath), 'utf8');
}

function countLines(source) {
  return source === '' ? 0 : source.split(/\r?\n/).length - (source.endsWith('\n') ? 1 : 0);
}

function absolute(projectPath) {
  return path.join(rootDir, projectPath);
}
