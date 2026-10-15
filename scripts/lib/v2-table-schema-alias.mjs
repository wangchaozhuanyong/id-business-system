import { parse } from '@vue/compiler-sfc';
import ts from 'typescript';

// Resolve only const aliases whose complete branch set is statically registered.
// All branches must share their column contract; labels and schema identity may differ.
export function resolveRegisteredTableSchemaAlias(source, alias, schemas) {
  if (!/^[A-Za-z_$][\w$]*$/.test(alias)) return [];
  const { descriptor } = parse(source);
  const script = descriptor.scriptSetup?.content ?? descriptor.script?.content;
  if (!script) return [];
  const ast = ts.createSourceFile(
    'table-alias.ts',
    script,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
  const matches = [];
  for (const statement of ast.statements) {
    if (
      !ts.isVariableStatement(statement) ||
      !(statement.declarationList.flags & ts.NodeFlags.Const)
    )
      continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.name.text === alias)
        matches.push(declaration.initializer);
    }
  }
  if (matches.length !== 1 || !matches[0]) return [];
  function references(node, depth = 0) {
    if (depth > 4) return null;
    if (ts.isParenthesizedExpression(node)) return references(node.expression, depth + 1);
    if (ts.isConditionalExpression(node)) {
      const yes = references(node.whenTrue, depth + 1),
        no = references(node.whenFalse, depth + 1);
      return yes && no ? [...yes, ...no] : null;
    }
    if (!ts.isPropertyAccessExpression(node)) return null;
    const name = node.getText(ast).replace(/\s+/g, '');
    return schemas.has(name) ? [name] : null;
  }
  const resolved = references(matches[0]);
  if (!resolved) return [];
  const names = [...new Set(resolved)];
  const contract = (schema) =>
    JSON.stringify({
      role: schema.role,
      mobileMode: schema.mobileMode,
      rowKey: schema.rowKey,
      columns: schema.columns.map((column) =>
        Object.fromEntries(
          ['key', 'kind', 'widthPreset', 'pin', 'layout', 'control', 'width'].map((key) => [
            key,
            column[key] ?? null
          ])
        )
      )
    });
  const first = contract(schemas.get(names[0]));
  return names.every((name) => contract(schemas.get(name)) === first) ? names : [];
}
