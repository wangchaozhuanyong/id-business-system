import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveRegisteredTableSchemaAlias } from './lib/v2-table-schema-alias.mjs';
const make = (label = '订单') => ({
  role: 'primary',
  mobileMode: 'scroll',
  rowKey: { kind: 'path', value: 'id' },
  columns: [
    { key: 'orderNo', label, kind: 'identifier', widthPreset: 'wide', pin: 'start' },
    { key: 'actions', kind: 'actions', pin: 'end', layout: 'triple' }
  ]
});
const schemas = () =>
  new Map([
    ['v2TableSchemas.orders.bit', make()],
    ['v2TableSchemas.orders.online', make('线上订单')]
  ]);
const sfc = (expression, kind = 'const') =>
  `<script setup lang="ts">${kind} schema = ${expression};</script><template><div /></template>`;
test('registered homogeneous const branches preserve both real schema consumers', () => {
  assert.deepEqual(
    resolveRegisteredTableSchemaAlias(
      sfc("channel === 'online' ? v2TableSchemas.orders.online : v2TableSchemas.orders.bit"),
      'schema',
      schemas()
    ),
    ['v2TableSchemas.orders.online', 'v2TableSchemas.orders.bit']
  );
});
test('unknown or copied schema branches cannot bypass registration', () => {
  for (const value of [
    'otherSchema',
    '{ columns: [] }',
    'v2TableSchemas.orders.missing',
    'getSchema()'
  ]) {
    assert.deepEqual(
      resolveRegisteredTableSchemaAlias(
        sfc(`flag ? v2TableSchemas.orders.bit : ${value}`),
        'schema',
        schemas()
      ),
      []
    );
  }
});
test('mutable aliases and arbitrary expressions are rejected', () => {
  assert.deepEqual(
    resolveRegisteredTableSchemaAlias(sfc('v2TableSchemas.orders.bit', 'let'), 'schema', schemas()),
    []
  );
  assert.deepEqual(
    resolveRegisteredTableSchemaAlias(sfc('v2TableSchemas.orders.bit'), 'schema.value', schemas()),
    []
  );
  assert.deepEqual(
    resolveRegisteredTableSchemaAlias(
      sfc('computed(() => v2TableSchemas.orders.bit)'),
      'schema',
      schemas()
    ),
    []
  );
});
test('different semantic keys, kinds, widths, actions or row keys cannot share a template', () => {
  for (const change of [
    (s) => {
      s.columns[0].key = 'other';
    },
    (s) => {
      s.columns[0].kind = 'numeric';
    },
    (s) => {
      s.columns[0].widthPreset = 'compact';
    },
    (s) => {
      s.columns[1].layout = 'single';
    },
    (s) => {
      s.rowKey.value = 'otherId';
    },
    (s) => {
      s.columns.pop();
    }
  ]) {
    const registry = schemas();
    change(registry.get('v2TableSchemas.orders.online'));
    assert.deepEqual(
      resolveRegisteredTableSchemaAlias(
        sfc('flag ? v2TableSchemas.orders.online : v2TableSchemas.orders.bit'),
        'schema',
        registry
      ),
      []
    );
  }
});
