import { afterEach, describe, expect, it, vi } from 'vitest';
import { OnlineRechargeHumanVerification } from './human-verification.service';
import type { AuthenticatedUser } from '../../auth/auth.types';
import { requireTaskLease } from './persistence/worker.repository';

const taskId = '11111111-1111-4111-8111-111111111111';
const owner: AuthenticatedUser = {
  id: 'operator-one',
  username: 'synthetic',
  displayName: '合成管理员',
  roles: ['admin'],
  permissions: []
};
const services: OnlineRechargeHumanVerification[] = [];
afterEach(() => {
  services.splice(0).forEach((item) => item.onModuleDestroy());
  vi.useRealTimers();
});
function fixture() {
  const row = {
    id: taskId,
    status: 'running',
    operation: 'recharge',
    provider: 'self',
    paymentStarted: false,
    confirmedPaid: false,
    providerOrderId: null,
    providerTaskId: null,
    leaseOwner: 'worker',
    leaseId: 'lease',
    leaseVersion: 1,
    leaseExpiresAt: new Date(Date.now() + 90000)
  };
  const scope = { taskId, workerId: 'worker', leaseId: 'lease', leaseVersion: 1 };
  const tx = {
    onlineRechargeTask: { findUnique: vi.fn(async () => row), update: vi.fn(async () => row) }
  };
  const repository = {
    transaction: vi.fn(async (_key, work) => work(tx)),
    read: vi.fn(async (work) => work(tx)),
    log: vi.fn<(...args: unknown[]) => Promise<void>>(async () => {})
  };
  const workers = {
    withLease: vi.fn(async (rpc, work) => {
      requireTaskLease(row as never, rpc);
      return work(tx, row);
    })
  };
  const service = new OnlineRechargeHumanVerification(workers as never, repository as never);
  services.push(service);
  const worker = (method: string, args: Record<string, unknown> = {}, overrides: object = {}) =>
    service.worker({ ...scope, method, args, ...overrides });
  return {
    row,
    scope,
    repository,
    service,
    worker,
    open: () => worker('humanVerificationOpen', { deadline: Date.now() + 10000 }),
    admin: (action = 'view', args: object = {}, operator = owner) =>
      service.admin(taskId, { action, ...args }, operator)
  };
}
function screen() {
  // Synthetic PNG header; the relay validates dimensions without decoding or persisting pixels.
  const png = Buffer.alloc(24);
  Buffer.from('89504e470d0a1a0a', 'hex').copy(png);
  png.writeUInt32BE(100, 16);
  png.writeUInt32BE(80, 20);
  return {
    frameId: '22222222-2222-4222-8222-222222222222',
    image: png.toString('base64'),
    width: 100,
    height: 80
  };
}
describe('人工验证临时交互通道', () => {
  it('画面轮询只读校验租约，不发布业务变更或开启写事务', async () => {
    const f = fixture(),
      opened = await f.open();
    await f.worker('humanVerificationPoll', opened);
    await f.admin();
    expect(f.repository.read).toHaveBeenCalledTimes(2);
    expect(f.repository.transaction).not.toHaveBeenCalled();
    f.row.leaseExpiresAt = new Date(Date.now() - 1);
    await expect(f.worker('humanVerificationPoll', opened)).rejects.toThrow('租约失效');
  });
  it('审计事务提交失败时，不发布接管权限或点击指令', async () => {
    const f = fixture(),
      opened = await f.open(),
      image = screen();
    await f.worker('humanVerificationPoll', { ...opened, screen: image });
    const failCommit = () =>
      f.repository.transaction.mockImplementationOnce(async (_key, work) => {
        await work({ onlineRechargeTask: { findUnique: async () => f.row } });
        throw new Error('synthetic-commit-failed');
      });
    failCommit();
    await expect(f.admin('claim', opened)).rejects.toThrow('synthetic-commit-failed');
    expect(await f.admin()).toMatchObject({ owned: false });
    await f.admin('claim', opened);
    failCommit();
    await expect(
      f.admin('click', { ...opened, frameId: image.frameId, x: 1, y: 2 })
    ).rejects.toThrow('synthetic-commit-failed');
    expect(await f.worker('humanVerificationPoll', opened)).toMatchObject({ command: null });
  });
  it('画面只交给已接管的管理用户，点击只下发一次待确认序号', async () => {
    const f = fixture(),
      opened = await f.open(),
      image = screen();
    await f.worker('humanVerificationPoll', { ...opened, screen: image });
    expect(await f.admin()).not.toHaveProperty('screen');
    expect(await f.admin('claim', opened)).toMatchObject({ owned: true, screen: image });
    await f.admin('click', { ...opened, frameId: image.frameId, x: 10, y: 20 });
    const result = await f.worker('humanVerificationPoll', opened);
    expect(result).toMatchObject({ command: { kind: 'click', sequence: 1 } });
    await expect(f.admin('continue', opened)).rejects.toThrow('尚未确认');
    expect(await f.worker('humanVerificationPoll', { ...opened, ack: 1 })).toMatchObject({
      command: null
    });
    expect(f.repository.log.mock.calls.map((call) => call[1])).toContain(
      'human_verification.click'
    );
  });
  it.each(['succeeded', 'failed', 'awaiting_review', 'queued'])(
    '不能接续 %s 任务',
    async (status) => {
      const f = fixture();
      f.row.status = status;
      await expect(f.open()).rejects.toThrow('租约失效');
    }
  );
  it.each(['paymentStarted', 'confirmedPaid'])('存在 %s 事实时不提供接管', async (key) => {
    const f = fixture();
    Object.assign(f.row, { [key]: true });
    await expect(f.open()).rejects.toThrow('付款前');
  });
  it('拒绝新租约和旧代际，并且管理员不能抢占其他人的接管', async () => {
    const f = fixture(),
      opened = await f.open();
    await f.admin('claim', opened);
    await expect(f.admin('claim', opened, { ...owner, id: 'operator-two' })).rejects.toThrow(
      '其他管理员'
    );
    await expect(f.admin('click', { generation: 'old' })).rejects.toThrow('已变化');
    await expect(f.worker('humanVerificationPoll', opened, { leaseId: 'other' })).rejects.toThrow(
      '租约失效'
    );
    f.row.leaseId = 'other';
    await expect(f.admin()).rejects.toThrow('租约失效');
  });
  it('只读身份、未接管身份无法发送操作', async () => {
    const f = fixture(),
      opened = await f.open();
    await expect(
      f.admin('claim', opened, {
        ...owner,
        roles: [],
        permissions: ['id_business_v2.online_recharge.read']
      })
    ).rejects.toThrow('没有管理');
    await expect(f.admin('continue', opened)).rejects.toThrow('先接管');
  });
  it.each([
    [-1, 0],
    [100, 0],
    [0, 80],
    [Infinity, 2]
  ])('组件外坐标 %s,%s 被拒绝', async (x, y) => {
    const f = fixture(),
      opened = await f.open(),
      image = screen();
    await f.worker('humanVerificationPoll', { ...opened, screen: image });
    await f.admin('claim', opened);
    await expect(f.admin('click', { ...opened, frameId: image.frameId, x, y })).rejects.toThrow(
      '已过期'
    );
  });
  it('取消立即撤销待执行点击及画面，不允许迟到授权或重复打开', async () => {
    const f = fixture(),
      opened = await f.open(),
      image = screen();
    await f.worker('humanVerificationPoll', { ...opened, screen: image });
    await f.admin('claim', opened);
    await f.admin('click', { ...opened, frameId: image.frameId, x: 1, y: 2 });
    await f.admin('cancel', opened);
    expect(await f.worker('humanVerificationAuthorize', { ...opened, sequence: 1 })).toEqual({
      stopped: true
    });
    expect(await f.admin()).toEqual({ available: false });
    await expect(f.open()).rejects.toThrow('已经使用过');
  });
  it('遵守原期限，接管后断线超过15秒也停止', async () => {
    vi.useFakeTimers();
    const f = fixture(),
      opened = await f.worker('humanVerificationOpen', { deadline: Date.now() + 60000 });
    await f.admin('claim', opened);
    vi.advanceTimersByTime(16000);
    expect(await f.worker('humanVerificationPoll', opened)).toEqual({ stopped: true });
    const g = fixture(),
      next = await g.open();
    vi.advanceTimersByTime(10001);
    expect(await g.worker('humanVerificationPoll', next)).toEqual({ stopped: true });
  });
  it('不接受异常图片、任意命令或延长人工期限', async () => {
    const f = fixture();
    await expect(
      f.worker('humanVerificationOpen', { deadline: Date.now() + 130000 })
    ).rejects.toThrow('期限');
    const opened = await f.open();
    await expect(
      f.worker('humanVerificationPoll', { ...opened, screen: { ...screen(), width: 120 } })
    ).rejects.toThrow('尺寸');
    await expect(f.admin('navigate', opened)).rejects.toThrow('不支持');
  });
});
