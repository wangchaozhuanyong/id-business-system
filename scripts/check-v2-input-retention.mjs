#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { parse } from '@vue/compiler-sfc';

const root = fileURLToPath(new URL('..', import.meta.url));
function walk(dir) {
  return readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((item) => {
    const file = `${dir}/${item.name}`;
    return item.isDirectory()
      ? walk(file)
      : /\.(vue|ts)$/.test(file) && !/\.spec\.ts$/.test(file)
        ? [file]
        : [];
  });
}
const files = [...walk('apps/admin/src/v2/features'), ...walk('apps/admin/src/v2/components')];
const sources = files.map((file) => {
  const source = readFileSync(path.join(root, file), 'utf8');
  const descriptor = file.endsWith('.vue') ? parse(source).descriptor : null;
  return {
    file,
    source,
    script: descriptor
      ? descriptor.scriptSetup?.content || descriptor.script?.content || ''
      : source,
    template: descriptor?.template?.content || ''
  };
});
const modelNames = new Set();
for (const { template } of sources) {
  for (const match of template.matchAll(/v-model(?::[\w-]+)?(?:\.[\w-]+)*="([^"]+)"/g)) {
    const tokens = match[1].match(/[A-Za-z_$][\w$]*/g) || [];
    const name = tokens[0] === 'page' ? tokens[1] : tokens[0];
    // Dialog visibility, selected remote objects and acknowledgement checkboxes are transient UI state.
    if (
      name &&
      !/(?:Visible|Open|Loading|Selected|Selection|Confirmed|Checklist|Dialog|Drawer)$/.test(name)
    )
      modelNames.add(name);
  }
}
// These fields are single-use access/authorization inputs or remote response baselines, never drafts.
const transient = new Set([
  'open',
  'visible',
  'loginCode',
  'authorizeSinglePayment',
  'relayAutoRefresh',
  'mfaCodeForm',
  'revealForm',
  'confirmed',
  'confirmChecked',
  'historyChecklist',
  'lossConfirmed',
  'reportAccountLoss',
  'reversalConfirmed',
  'confirmedCustomerRefund',
  'showSecret',
  'showSecrets',
  'detailTabs',
  'selectedId',
  'selectedModule',
  'tableRef',
  'uploadRef',
  'formRef',
  'draftKeys',
  'totpCode',
  'cvv'
]);
const issues = [];
let registered = 0;
for (const { file, script } of sources) {
  const tree = ts.createSourceFile(file, script, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  function visit(node) {
    if (
      ts.isCallExpression(node) &&
      ['useV2SessionDraft', 'useV2FormDraft'].includes(node.expression.getText(tree))
    )
      registered += 1;
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      ts.isCallExpression(node.initializer)
    ) {
      const name = node.name.text;
      const factory = node.initializer.expression.getText(tree);
      if (
        file.includes('/features/') &&
        modelNames.has(name) &&
        !transient.has(name) &&
        /^(ref|reactive|shallowRef)$/.test(factory)
      ) {
        // The order-entry route is the only permitted KeepAlive draft owner.
        if (file.includes('/order-entry/') && !file.endsWith('/useOrderEntryOptionsQuery.ts'))
          return;
        // These reactive wrappers unwrap controller/query results rather than declare input state.
        if (factory === 'reactive' && !ts.isObjectLiteralExpression(node.initializer.arguments[0]))
          return;
        if (name === 'options' && file.endsWith('/V2OrderEditDrawer.vue')) return;
        // Correction text already uses a per-record session Map, with a watcher writing each edit.
        if (
          name === 'correctionReason' &&
          script.includes('correctionReasons.set(selected.value.id, reason)') &&
          script.includes('useV2SessionDraft(')
        )
          return;
        // Inputs nested in an already registered session factory are owned by that shared draft.
        let parent = node.parent;
        let registeredOwner = false;
        while (parent) {
          if (
            ts.isCallExpression(parent) &&
            parent.expression.getText(tree) === 'useV2SessionDraft'
          )
            registeredOwner = true;
          parent = parent.parent;
        }
        if (!registeredOwner)
          issues.push(
            `${file}: ${name} 使用 ${factory} 管理用户输入，需登记会话草稿或明确临时授权边界`
          );
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
}
const shared = readFileSync(
  path.join(root, 'apps/admin/src/v2/composables/useV2SessionDraft.ts'),
  'utf8'
);
assert.ok(shared.includes('subscribeIdentityChange(clearV2SessionDrafts)'), '身份变化必须清理草稿');
assert.ok(shared.includes('function beginSave()'), '保存必须捕获提交快照');
assert.ok(!/localStorage|sessionStorage/.test(shared), '草稿不得落盘');
for (const name of ['V2FormDrawer', 'V2ConfirmDialog']) {
  assert.match(
    readFileSync(path.join(root, `apps/admin/src/v2/components/${name}.vue`), 'utf8'),
    /retainDraft: true/,
    `${name} 必须默认保留输入`
  );
}
if (issues.length) {
  console.error(issues.join('\n'));
  process.exitCode = 1;
} else
  console.log(
    JSON.stringify({
      ok: true,
      scannedFiles: sources.length,
      inputNames: modelNames.size,
      draftRegistrations: registered,
      storage: 'session-memory',
      issues: 0
    })
  );
