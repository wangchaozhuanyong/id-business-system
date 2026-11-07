export function lifecycleFixture(type = 'claude') {
  const account = { id: 'account-a', type, email: 'owned@example.test', source: '自己注册',
    version: 1, inventoryState: 'used', used: true, health: 'normal', status: '正常',
    registered: '2026-01-01 12:00', password: 'SYNTHETIC',
    usageLinks: [{ kind: 'order-sale', orderId: 'order-a', label: '原交付', time: '2026-09-01 12:00' }], inventoryHistory: [] };
  const order = { id: 'order-a', orderNo: 'QA-1', product: type === 'gpt' ? 'GPT' : 'Claude Pro',
    plan: type === 'gpt' ? 'Plus' : 'Pro', businessType: '成品交付', accountId: account.id,
    accountSource: '库存', email: account.email, customerId: 'customer-a',
    start: '2026-09-01T12:00', expiry: '2026-10-01T12:00', createdAt: '2026-09-01T12:00',
    payment: '银行卡', paymentId: '7141', paidAmount: '20.0000', paidCurrency: 'USD', paidConfirmed: true,
    kyc: 'KYC 认证', verifier: '历史认证人', verifierPhone: '000000', tenantId: 'tenant-a',
    financialEvidence: [{ kind: 'payment', amount: '20.0000' }], refunds: [], bankReturns: [], corrections: [], version: 1 };
  return { inventory: { accounts: [account], mailboxes: [], batches: [], returnRecords: [], registrationRecords: [], importRecords: [] },
    commerce: { customers: [{ id: 'customer-a', name: '客户 A', active: true }, { id: 'customer-b', name: '客户 B', active: true }],
      tenants: [{ id: 'tenant-a', name: '原认证租户' }], orders: [order], logs: [], operating: [], rentBatches: [] } };
}
