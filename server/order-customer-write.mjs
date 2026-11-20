import { isDeepStrictEqual } from 'node:util';
import { WriteOperationError } from './write-operation.mjs';
import { hasInlineOrderCustomerContact, matchInlineOrderCustomer, orderCustomerChanges, orderCustomerCalibrateAction,
  orderCustomerCreateAction, orderPhoneKey, validOrderPhone, orderWhatsAppKey } from '../modules/orders/order-opening.mjs';

const fail = (message, status = 409) => { throw new WriteOperationError(status, message); };
const reviewRequired = () => fail('客户资料已变化或有冲突，请核对后重新提交');
const withoutEditMetadata = ({ updatedAt, updatedBy, updatedById, ...data }) => data;

export function applyInlineOrderCustomer(previous, next, action, actor, checkedAt) {
  const reviewed = next.orders.filter(row => Object.hasOwn(row, 'customerMatchReview'));
  if (!reviewed.length && action !== orderCustomerCalibrateAction) return;
  if (reviewed.length !== 1) reviewRequired();
  const [order] = reviewed;
  const priorOrders = previous?.orders || [];
  const priorCustomers = previous?.customers || [];
  if (!order.id || order.source !== '管理员手工' || !order.customerId ||
      priorOrders.some(row => row.id === order.id) || next.orders.length !== priorOrders.length + 1 ||
      !isDeepStrictEqual(next.orders.filter(row => row.id !== order.id), priorOrders))
    fail('客户资料变更须关联本次新增的一笔订单', 400);
  const { input, decision, confirmedSameName, customerVersion } = order.customerMatchReview || {};
  const lookup = matchInlineOrderCustomer(priorCustomers, input);
  if (['empty', 'invalid'].includes(lookup.kind)) fail('请核对客户姓名、联系方式和标签格式', 400);
  if (['conflict', 'inactive'].includes(lookup.kind)) reviewRequired();

  const id = order.customerId;
  const others = rows => rows.filter(row => row.id !== id);
  const proposed = next.customers.filter(row => row.id === id);
  if (proposed.length !== 1 || !isDeepStrictEqual(others(next.customers), others(priorCustomers))) reviewRequired();

  const prior = priorCustomers.find(row => row.id === id);
  const changes = orderCustomerChanges(prior, input);
  const at = new Date(checkedAt).toISOString();
  const writer = actor || { id: proposed[0].updatedById, name: proposed[0].updatedBy };
  const editMetadata = { updatedById: writer.id, updatedBy: writer.name, updatedAt: at };
  if (decision === 'new') {
    if (action !== orderCustomerCreateAction || prior || proposed[0].version !== 1 || proposed[0].active !== true)
      fail('随单建档须关联新客户', 400);
    const onlyNames = lookup.kind === 'review' && Object.keys(lookup.matches).every(key => key === 'name');
    if (lookup.kind !== 'new' && !(onlyNames && confirmedSameName === true)) reviewRequired();
    if (!changes.name) fail('请填写客户姓名', 400);
    next.customers[next.customers.indexOf(proposed[0])] = { id, ...changes, active: true, version: 1,
      createdById: writer.id, createdBy: writer.name, createdAt: at, ...editMetadata };
  } else {
    if (!['review', 'matched'].includes(lookup.kind) || !lookup.ids.includes(id) || !prior || prior.active === false ||
        customerVersion !== (prior.version ?? 0)) reviewRequired();
    if (!(changes.name || prior.name?.trim())) fail('请填写客户姓名', 400);
    if (decision === 'calibrate') {
      if (action !== orderCustomerCalibrateAction || !Object.keys(changes).length) reviewRequired();
      const expected = { ...prior, ...changes, version: customerVersion + 1 };
      if (!isDeepStrictEqual(withoutEditMetadata(proposed[0]), withoutEditMetadata(expected))) reviewRequired();
      next.customers[next.customers.indexOf(proposed[0])] = { ...expected, ...editMetadata };
    } else if (decision !== 'matched' || action !== '新增独立订单' ||
        Object.keys(changes).length || !isDeepStrictEqual(proposed[0], prior)) {
      reviewRequired();
    }
  }

  const saved = next.customers.find(row => row.id === id);
  if (!hasInlineOrderCustomerContact(saved)) fail('请至少填写一种联系方式', 400);
  for (const field of ['wechat', 'phone', 'qq', 'whatsapp', 'telegram']) {
    const snapshotField = field === 'phone' ? 'customerPhone' : field;
    if (Object.keys(orderCustomerChanges(saved, { [field]: order[snapshotField] })).length) reviewRequired();
    if (!saved[field]) continue;
    if (field === 'phone')
      order[snapshotField] = validOrderPhone(saved[field]) ? orderPhoneKey(saved[field]) : saved[field];
    else {
      const number = field === 'whatsapp' ? orderWhatsAppKey(saved[field]) : '';
      order[snapshotField] = /^\+\d+$/.test(number) ? number : saved[field];
    }
  }
  delete order.customerMatchReview;
  return order.id;
}
