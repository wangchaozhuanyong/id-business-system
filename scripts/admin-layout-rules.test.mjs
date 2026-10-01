import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inspectLayoutComponent, inspectLayoutStyles } from './admin-layout-rules.mjs';
const page = 'apps/admin/src/v2/features/example/V2ExampleView.vue';
test('new page cannot bypass the canonical module stack', () => {
  assert.equal(
    inspectLayoutComponent(
      '<template><section class="example"><V2AsyncRegion /></section></template>',
      page
    ).issues.length,
    1
  );
  assert.deepEqual(
    inspectLayoutComponent(
      '<template><section class="v2-page-layout example"><V2AsyncRegion /></section></template>',
      page
    ).issues,
    []
  );
  assert.deepEqual(
    inspectLayoutComponent('<template><V2FinanceLedgerView /></template>', page).issues,
    []
  );
});
test('copied overview and toolbar structures are rejected', () => {
  assert.ok(
    inspectLayoutComponent(
      '<template><section><div class="example-overview__metrics"><article /></div></section></template>',
      'features/example/components/ExampleOverview.vue'
    ).issues.length
  );
  assert.ok(
    inspectLayoutComponent(
      '<template><section><input /></section></template>',
      'features/example/components/ExampleToolbar.vue'
    ).issues.length
  );
});
test('page-specific section gaps and shared-layout overrides are rejected', () => {
  assert.equal(
    inspectLayoutStyles('.example { gap: 18px; }', 'styles/example.css', ['example']).length,
    1
  );
  assert.equal(
    inspectLayoutStyles(
      '.v2-page-overview__metrics { grid-template-columns: 1fr; }',
      'styles/example.css'
    ).length,
    1
  );
  assert.deepEqual(
    inspectLayoutStyles(
      '.example { gap: var(--v2-layout-section-gap); } .business-grid { gap: 8px; }',
      'styles/example.css',
      ['example']
    ),
    []
  );
});
test('left-label widths remain configurable while vertical offsets fail', () => {
  assert.deepEqual(
    inspectLayoutStyles('.form .el-form-item__label { width: 120px; }', 'styles/example.css'),
    []
  );
  assert.equal(
    inspectLayoutStyles(
      '.form .el-form-item__label { padding-top: 4px; line-height: 24px; }',
      'styles/example.css'
    ).length,
    2
  );
});

test('list totals cannot define a second baseline or font model', () => {
  assert.equal(
    inspectLayoutStyles(
      '.v2-example-list__header .v2-section-heading__actions { align-items: baseline; font-size: 11px; }',
      'styles/example.css'
    ).length,
    2
  );
});

test('a page cannot silently redefine the global section-gap token', () => {
  assert.equal(
    inspectLayoutStyles('.example { --v2-layout-section-gap: 22px; }', 'styles/example.css').length,
    1
  );
});
