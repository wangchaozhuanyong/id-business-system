import { readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

export function loadV2TableSchemaRegistry(root) {
  function evaluate(projectPath, bindings) {
    let source = readFileSync(path.join(root, projectPath), 'utf8');
    const tree = ts.createSourceFile(projectPath, source, ts.ScriptTarget.Latest, true);
    for (const node of [...tree.statements].reverse()) {
      if (ts.isImportDeclaration(node)) source = source.slice(0, node.pos) + source.slice(node.end);
    }
    const compiled = ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
    }).outputText;
    const exports = {};
    new Function('exports', ...Object.keys(bindings), compiled)(
      exports,
      ...Object.values(bindings)
    );
    return exports;
  }
  const online = evaluate('apps/admin/src/v2/features/online-recharge/tableSchemas.ts', {
    defineV2TableSchema: (schema) => schema
  });
  return {
    ...evaluate('apps/admin/src/v2/features/tableSchemas.ts', {
      defineV2TableSchema: (schema) => schema,
      onlineTablesByFeature: online.onlineTablesByFeature
    }),
    onlineTableSchemas: online.onlineTableSchemas
  };
}
