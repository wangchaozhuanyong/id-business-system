#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const rootDir = process.cwd();
const v2Root = 'apps/api/src/id-business-v2';
const showDetails = process.argv.includes('--details');
const failures = [];
const legacyDecimalPolicyPath = `${v2Root}/decimal-policy.ts`;
const inventories = {
  directPrismaClient: new Set(),
  prismaRuntimeImport: new Set(),
  prismaNamespaceType: new Set(),
  decimalRuntime: new Set(),
  sqlRuntime: new Set(),
  prismaInstanceof: new Set(),
  directTransaction: new Set(),
  directModelAccess: new Set(),
  rawSql: new Set(),
  postgresUuidParameters: new Set(),
  joinedRowLocks: new Set(),
  mysqlOnlyNullSafeOperator: new Set(),
  legacyDecimal: new Set(),
  rowMapperOutsidePersistence: new Set()
};

if (existsSync(path.join(rootDir, legacyDecimalPolicyPath))) {
  failures.push(`${legacyDecimalPolicyPath}: 旧 Prisma Decimal policy 必须删除`);
}

for (const relativePath of listSourceFiles(v2Root)) {
  if (/\.(?:spec|test)\.ts$/.test(relativePath)) continue;

  const sourceText = readFileSync(path.join(rootDir, relativePath), 'utf8');
  const sourceFile = ts.createSourceFile(
    relativePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
  const persistencePath = isPersistencePath(relativePath);
  const transactionInfrastructure = isTransactionInfrastructure(relativePath);

  const mysqlOnlyNullSafeOperatorIndex = sourceText.indexOf('<=>');
  if (mysqlOnlyNullSafeOperatorIndex >= 0) {
    inventories.mysqlOnlyNullSafeOperator.add(relativePath);
    const { line, character } = sourceFile.getLineAndCharacterOfPosition(
      mysqlOnlyNullSafeOperatorIndex
    );
    failures.push(
      `${relativePath}:${line + 1}:${character + 1} 共享运行时 SQL 禁止使用 MySQL 专用 <=> 运算符`
    );
  }

  visit(sourceFile, (node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      inspectImport({
        node,
        moduleName: node.moduleSpecifier.text,
        relativePath,
        sourceFile,
        persistencePath,
        transactionInfrastructure
      });
      return;
    }

    if (ts.isPropertyAccessExpression(node)) {
      const property = node.name.text;
      const expressionText = node.expression.getText(sourceFile);

      if (!persistencePath && !transactionInfrastructure && property === 'prisma') {
        record(
          inventories.directPrismaClient,
          relativePath,
          sourceFile,
          node.name,
          '业务层禁止直接持有 Prisma Client'
        );
      }

      if (property === '$transaction') {
        inventories.directTransaction.add(relativePath);
        if (!persistencePath && !transactionInfrastructure) {
          fail(relativePath, sourceFile, node.name, '业务层禁止直接开启 $transaction');
        }
      }

      if (!persistencePath && isPrismaDelegateProperty(property, expressionText)) {
        record(
          inventories.directModelAccess,
          relativePath,
          sourceFile,
          node.name,
          'Prisma 模型访问只能位于 persistence adapter'
        );
      }

      if (isRawSqlProperty(property)) {
        inventories.rawSql.add(relativePath);
        if (!persistencePath) {
          fail(relativePath, sourceFile, node.name, 'raw SQL 只能位于 persistence adapter');
        }
      }

      if (
        (expressionText === 'Prisma' || expressionText === 'PrismaNamespace') &&
        property === 'Decimal'
      ) {
        inventories.decimalRuntime.add(relativePath);
        if (!persistencePath) {
          fail(relativePath, sourceFile, node.name, '业务层禁止依赖 Prisma.Decimal runtime');
        }
      }

      if (
        (expressionText === 'Prisma' || expressionText === 'PrismaNamespace') &&
        (property === 'sql' || property === 'join')
      ) {
        inventories.sqlRuntime.add(relativePath);
        if (!persistencePath) {
          fail(
            relativePath,
            sourceFile,
            node.name,
            'Prisma SQL runtime 只能位于 persistence adapter'
          );
        }
      }
    }

    if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression)) {
      const property = node.argumentExpression.text;
      if (property === '$transaction') {
        inventories.directTransaction.add(relativePath);
        if (!persistencePath && !transactionInfrastructure) {
          fail(
            relativePath,
            sourceFile,
            node.argumentExpression,
            '业务层禁止直接开启 $transaction'
          );
        }
      }
      if (
        !persistencePath &&
        isPrismaDelegateProperty(property, node.expression.getText(sourceFile))
      ) {
        record(
          inventories.directModelAccess,
          relativePath,
          sourceFile,
          node.argumentExpression,
          'Prisma 模型访问只能位于 persistence adapter'
        );
      }
      if (isRawSqlProperty(property)) {
        inventories.rawSql.add(relativePath);
        if (!persistencePath) {
          fail(
            relativePath,
            sourceFile,
            node.argumentExpression,
            'raw SQL 只能位于 persistence adapter'
          );
        }
      }
    }

    if (persistencePath && ts.isTaggedTemplateExpression(node)) {
      inspectPostgresRawSqlTemplate({ node, relativePath, sourceFile });
    }

    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword
    ) {
      const rightText = node.right.getText(sourceFile);
      if (/PrismaClient(?:Known|Unknown)RequestError/.test(rightText)) {
        inventories.prismaInstanceof.add(relativePath);
        fail(
          relativePath,
          sourceFile,
          node.right,
          '禁止用 instanceof 识别 Prisma 错误；统一使用结构化错误分类器'
        );
      }
    }

    if (ts.isIdentifier(node) && isLegacyDecimalIdentifier(node.text)) {
      inventories.legacyDecimal.add(relativePath);
      fail(relativePath, sourceFile, node, `禁止使用旧 Decimal 帮助符号 ${node.text}`);
    }

    if (
      !persistencePath &&
      !relativePath.startsWith(`${v2Root}/runtime/`) &&
      ts.isIdentifier(node) &&
      isRowMapperIdentifier(node.text)
    ) {
      inventories.rowMapperOutsidePersistence.add(relativePath);
      fail(relativePath, sourceFile, node, `row mapper ${node.text} 只能位于 persistence adapter`);
    }
  });
}

if (failures.length > 0) {
  console.error(`V2 Prisma runtime 边界检查失败（${failures.length} 项）：`);
  for (const failure of [...new Set(failures)].sort()) console.error(`- ${failure}`);
  if (showDetails) printInventories();
  process.exit(1);
}

console.log(
  `V2 Prisma runtime 边界检查通过：业务层 Prisma Client 0，Prisma runtime import 0，Decimal runtime 0，SQL runtime 0，Prisma instanceof 0，直接事务 0，直接模型访问 0，raw SQL 0，未转型 UUID 参数 0，未限定 JOIN 行锁 0，MySQL 专用空值运算符 0，旧 Decimal helper 0，persistence 外 row mapper 0。`
);

if (showDetails) printInventories();

function inspectImport({
  node,
  moduleName,
  relativePath,
  sourceFile,
  persistencePath,
  transactionInfrastructure
}) {
  if (moduleName.includes('@prisma/client/runtime')) {
    inventories.prismaRuntimeImport.add(relativePath);
    fail(relativePath, sourceFile, node, '禁止导入 Prisma runtime implementation');
  }

  if (moduleName.endsWith('/prisma.service') || moduleName.endsWith('/prisma.service.ts')) {
    inventories.directPrismaClient.add(relativePath);
    if (!persistencePath && !transactionInfrastructure) {
      fail(
        relativePath,
        sourceFile,
        node,
        'PrismaService 只能由 persistence adapter 或事务内核使用'
      );
    }
  }

  if (moduleName === '@prisma/client') {
    for (const binding of prismaNamespaceBindings(node.importClause)) {
      inventories.prismaNamespaceType.add(relativePath);
      if (!persistencePath && !relativePath.startsWith(`${v2Root}/runtime/`)) {
        fail(
          relativePath,
          sourceFile,
          binding,
          '业务层禁止依赖 Prisma namespace 类型；查询结构必须封装在 persistence adapter'
        );
      }
    }
    for (const binding of valueImportBindings(node.importClause)) {
      inventories.prismaRuntimeImport.add(relativePath);
      if (!persistencePath && !transactionInfrastructure) {
        fail(
          relativePath,
          sourceFile,
          binding.node,
          `业务层禁止运行时导入 @prisma/client 的 ${binding.name}`
        );
      }
    }
  }

  if (moduleName.endsWith('/decimal-policy') || moduleName === './decimal-policy') {
    inventories.legacyDecimal.add(relativePath);
    fail(relativePath, sourceFile, node, '旧 decimal-policy 已禁止；改用 Amount4/Rate8 与共享常量');
  }
}

function inspectPostgresRawSqlTemplate({ node, relativePath, sourceFile }) {
  const tagText = node.tag.getText(sourceFile);
  if (tagText !== 'Prisma.sql' && !/\.\$(?:query|execute)Raw(?:Unsafe)?$/.test(tagText)) {
    return;
  }

  const template = node.template;
  if (!ts.isTemplateExpression(template)) return;

  const fragments = [
    template.head.text,
    ...template.templateSpans.map((span) => span.literal.text)
  ];
  const sqlText = fragments.join(' ? ');

  for (const [index, span] of template.templateSpans.entries()) {
    const parameterName = getSqlParameterName(span.expression);
    if (!parameterName || !/(?:^id$|Id$)/.test(parameterName)) continue;

    const previousFragment = fragments[index] ?? '';
    const nextFragment = fragments[index + 1] ?? '';
    const usesUuidCast =
      /^\s*::\s*uuid\b/i.test(nextFragment) ||
      (/\bCAST\s*\(\s*$/i.test(previousFragment) && /^\s+AS\s+uuid\s*\)/i.test(nextFragment));

    if (!usesUuidCast) {
      inventories.postgresUuidParameters.add(relativePath);
      fail(
        relativePath,
        sourceFile,
        span.expression,
        `PostgreSQL 原生 SQL 的 UUID 参数 ${parameterName} 必须显式转换为 ::uuid`
      );
    }
  }

  if (
    /\bJOIN\b/i.test(sqlText) &&
    /\bFOR\s+UPDATE\b/i.test(sqlText) &&
    !/\bFOR\s+UPDATE\s+OF\s+[A-Za-z_][A-Za-z0-9_]*/i.test(sqlText)
  ) {
    inventories.joinedRowLocks.add(relativePath);
    fail(
      relativePath,
      sourceFile,
      node,
      '包含 JOIN 的 PostgreSQL FOR UPDATE 必须使用 OF <主表别名> 限定锁目标'
    );
  }
}

function getSqlParameterName(expression) {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isNonNullExpression(current)
  ) {
    current = current.expression;
  }

  if (ts.isIdentifier(current)) return current.text;
  if (ts.isPropertyAccessExpression(current)) return current.name.text;
  return null;
}

function valueImportBindings(importClause) {
  if (!importClause || importClause.isTypeOnly) return [];
  const bindings = [];

  if (importClause.name) {
    bindings.push({ name: importClause.name.text, node: importClause.name });
  }

  const namedBindings = importClause.namedBindings;
  if (namedBindings && ts.isNamespaceImport(namedBindings)) {
    bindings.push({ name: namedBindings.name.text, node: namedBindings.name });
  }
  if (namedBindings && ts.isNamedImports(namedBindings)) {
    for (const element of namedBindings.elements) {
      if (!element.isTypeOnly) {
        bindings.push({ name: element.name.text, node: element.name });
      }
    }
  }
  return bindings;
}

function prismaNamespaceBindings(importClause) {
  const namedBindings = importClause?.namedBindings;
  if (!namedBindings) return [];
  if (ts.isNamespaceImport(namedBindings)) {
    return namedBindings.name.text === 'Prisma' ? [namedBindings.name] : [];
  }
  return namedBindings.elements
    .filter((element) => element.name.text === 'Prisma' || element.propertyName?.text === 'Prisma')
    .map((element) => element.name);
}

function visit(node, visitor) {
  visitor(node);
  ts.forEachChild(node, (child) => visit(child, visitor));
}

function record(inventory, relativePath, sourceFile, node, message) {
  inventory.add(relativePath);
  fail(relativePath, sourceFile, node, message);
}

function fail(relativePath, sourceFile, node, message) {
  const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  failures.push(`${relativePath}:${line + 1}:${character + 1} ${message}`);
}

function listSourceFiles(relativeRoot) {
  const absoluteRoot = path.join(rootDir, relativeRoot);
  return readdirSync(absoluteRoot, { withFileTypes: true }).flatMap((entry) => {
    const relativePath = path.posix.join(relativeRoot.replaceAll('\\', '/'), entry.name);
    if (entry.isDirectory()) return listSourceFiles(relativePath);
    return entry.name.endsWith('.ts') ? [relativePath] : [];
  });
}

function isPersistencePath(relativePath) {
  const basename = path.basename(relativePath);
  return (
    relativePath.split(/[\\/]/).includes('persistence') ||
    basename.endsWith('.repository.ts') ||
    basename.endsWith('-persistence.service.ts')
  );
}

function isTransactionInfrastructure(relativePath) {
  return relativePath === `${v2Root}/runtime/id-business-v2-command-transaction.service.ts`;
}

function isRawSqlProperty(property) {
  return /^\$(?:query|execute)Raw(?:Unsafe)?$/.test(property);
}

function isPrismaDelegateProperty(property, expressionText) {
  if (/^idBusinessV2[A-Z]/.test(property)) return true;
  return property === 'auditLog' && /^(?:tx|client|prisma|this\.prisma)$/.test(expressionText);
}

function isLegacyDecimalIdentifier(identifier) {
  return [
    'toV2Decimal',
    'toV2DecimalString',
    'roundV2Decimal',
    'V2_DECIMAL_ROUNDING_MODE'
  ].includes(identifier);
}

function isRowMapperIdentifier(identifier) {
  return ['mapAmount4', 'mapOptionalAmount4', 'mapRate8', 'mapOptionalRate8'].includes(identifier);
}

function printInventories() {
  for (const [label, files] of Object.entries(inventories)) {
    console.log(`\n${label} (${files.size})`);
    for (const file of [...files].sort()) console.log(`- ${file}`);
  }
}
