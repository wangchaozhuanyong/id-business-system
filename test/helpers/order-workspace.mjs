import assert from 'node:assert/strict';

export async function assertOrderWorkspace(page, product) {
  const form = page.locator('#main #commerce-order-form');
  await form.waitFor();
  await page.getByRole('heading', { level: 1, name: '订单提交', exact: true }).waitFor();
  const sections = form.locator(':scope > [data-commerce-section]');
  assert.deepEqual(await sections.getByRole('heading', { level: 2 }).allTextContents(),
    ['客户与账号', '付款与金额', '订阅周期']);
  for (const [index, id] of [[0, 'email'], [1, 'paidAmount'], [2, 'start'], [2, 'expiry'], [2, 'notes']]) {
    assert.equal(await sections.nth(index).locator('#commerce-' + id).count(), 1, id + ' 应在对应分组内');
  }
  const navigation = page.getByRole('navigation', { name: '订单提交业务切换' });
  assert.deepEqual(await navigation.locator('[aria-current="page"]').allTextContents(), [product]);
  const fields = await form.evaluate(node => ['start', 'expiry', 'notes'].map(id => {
    const control = node.elements['commerce-' + id];
    return { id, input: control.getBoundingClientRect().toJSON(), label: control.labels[0].getBoundingClientRect().toJSON() };
  }));
  for (const { id, input, label } of fields) {
    assert(input.width && label.width && label.bottom <= input.top + 1, id + ' 标签应在控件上方');
    assert(Math.abs(input.left - label.left) <= 1, id + ' 的标签和控件应左对齐');
    assert(input.left >= 0 && input.right <= page.viewportSize().width + 1, id + ' 应在视口内');
  }
  assert.equal(await page.locator('button[type="submit"][form="commerce-order-form"]:visible').count(), 1);
}
