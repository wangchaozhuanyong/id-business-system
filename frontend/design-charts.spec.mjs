import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
const context = { window: {} };
vm.runInNewContext(await readFile(new URL('./design-charts.js', import.meta.url), 'utf8'), context);
const charts = context.window.IDCharts;
const series = [{ key: 'value', label: '数量', tone: 'blue' }];

test('缺失值不当作零，零值仍有可访问的精确数据', () => {
  assert.match(charts.bars({ title: '空数据', rows: [{ label: '甲', value: null }], series }), /暂无可绘制数据/);
  const zero = charts.bars({ title: '零', rows: [{ label: '甲', value: 0 }], series });
  assert.match(zero, /<td>0<\/td>/);
  assert.doesNotMatch(zero, /NaN|Infinity/);
  assert.match(charts.comparison('库存', [{ label: '可用', value: null }]), /待核验/);
});

test('负数、极大值与长小数保持原始数值，坐标始终有效', () => {
  const source = [{ label: '亏损', value: '-123.456789' }, { label: '盈利', value: '1000000000.01' }];
  const before = JSON.stringify(source);
  const html = charts.bars({ title: '测试', rows: source, series });
  assert.equal(JSON.stringify(source), before);
  assert.match(html, /<td>-123\.456789<\/td>/);
  assert.match(html, /<td>1000000000\.01<\/td>/);
  assert.doesNotMatch(html, /NaN|Infinity|height="-/);
});

test('图表文本转义并拒绝任意颜色属性，键盘与文本数据入口共存', () => {
  const html = charts.bars({ title: '<img src=x>', rows: [{ label: '"><script>x</script>', value: 4 }],
    series: [{ key: 'value', label: '<script>', tone: '"><svg onload=x>' }] });
  assert.doesNotMatch(html, /<script>|<img|onload=/);
  assert.match(html, /tabindex="0"/);
  assert.match(html, /查看图表数据/);
  assert.match(html, /data-tone="blue"/);
});

// Inline style attributes are rejected by the application's strict CSP.
test('库存对比用独立 SVG 条形，不依赖内联样式或互斥分类假设', () => {
  const html = charts.comparison('库存', [{ label: '可用', value: 8, tone: 'teal' }, { label: '已领用', value: 2, tone: 'blue' }]);
  assert.match(html, /width="100"/);
  assert.match(html, /width="25"/);
  assert.doesNotMatch(html, /style=|%/);
});
