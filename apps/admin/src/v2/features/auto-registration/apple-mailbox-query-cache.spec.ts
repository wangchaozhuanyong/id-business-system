import { createRenderer, h } from 'vue';
import { ElPagination } from 'element-plus/es/components/pagination/index.mjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearV2QueryCache } from '@/v2/composables/useV2Query';
import { clearV2SessionDrafts } from '@/v2/composables/useV2SessionDraft';
import { useAppleMailboxes } from './useAppleMailboxes';
import type { AppleMailboxListQuery, AppleMailboxRow } from './contracts';

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  mark: vi.fn(),
  start: vi.fn(),
  task: vi.fn(),
  cancel: vi.fn(),
  recover: vi.fn()
}));
vi.mock('@/stores/auth', () => ({
  useAuthStore: () => ({ writesAllowed: true, user: { roles: ['admin'] } })
}));
vi.mock('@/auth/sessionCoordinator', async () => {
  const { ref } = await import('vue');
  return { sessionCoordinator: { identityEpoch: ref(0), subscribeIdentityChange: () => () => {} } };
});
vi.mock('./api', () => ({
  autoRegistrationApi: {
    appleMailboxes: mocks.list,
    markAppleMailboxes: mocks.mark,
    startAppleMailbox: mocks.start,
    appleMailboxTask: mocks.task,
    cancelAppleMailboxTask: mocks.cancel,
    recoverAppleMailbox: mocks.recover
  }
}));

type TestNode = { children: TestNode[]; parent: TestNode | null; props: Record<string, unknown> };
const node = (): TestNode => ({ children: [], parent: null, props: {} });
const renderer = createRenderer<TestNode, TestNode>({
  patchProp: (element, key, _previous, value) => {
    element.props[key] = value;
  },
  insert(child, parent) {
    child.parent = parent;
    parent.children.push(child);
  },
  remove(child) {
    if (child.parent)
      child.parent.children = child.parent.children.filter((item) => item !== child);
  },
  createElement: node,
  createText: node,
  createComment: node,
  setText: () => undefined,
  setElementText: () => undefined,
  parentNode: (child) => child.parent,
  nextSibling: () => null
});

let rows: AppleMailboxRow[] = [];
const apps: Array<{ unmount: () => void }> = [];
const roots = new Map<ReturnType<typeof useAppleMailboxes>, TestNode>();
function mountPage(withPagination = false) {
  let page!: ReturnType<typeof useAppleMailboxes>;
  const app = renderer.createApp({
    setup() {
      page = useAppleMailboxes();
      return () =>
        withPagination
          ? h(ElPagination, {
              currentPage: page.displayedPage.value,
              pageSize: page.displayedPageSize.value,
              total: page.query.data.value?.total ?? 0,
              disabled: page.paginationBusy.value,
              layout: 'prev, pager, next',
              onCurrentChange: page.changePage
            })
          : h('div');
    }
  });
  const root = node();
  app.mount(root);
  roots.set(page, root);
  apps.push(app);
  return page;
}
function paginationNext(page: ReturnType<typeof useAppleMailboxes>) {
  function find(element: TestNode): TestNode | undefined {
    if (String(element.props.class).split(/\s+/).includes('btn-next')) return element;
    return element.children.map(find).find(Boolean);
  }
  const next = find(roots.get(page)!);
  expect(next).toBeDefined();
  expect(next!.props.disabled).toBe(false);
  (next!.props.onClick as () => void)();
}
function row(index: number): AppleMailboxRow {
  return {
    aliasId: `alias-${index}`,
    email: `hidden-${index}@example.invalid`,
    primaryEmail: 'primary@example.invalid',
    mailboxStatus: 'ACTIVE',
    authorizationValid: true,
    primaryAvailable: true,
    registrationStatus: 'unregistered',
    registrationIp: null,
    registrationIpSource: null,
    note: null,
    source: 'manual',
    updatedAt: null,
    revision: 3,
    taskUuid: null,
    taskStatus: null,
    canRegister: true,
    blockedReason: null
  };
}
async function cacheFirstAndLastPage(page: ReturnType<typeof useAppleMailboxes>) {
  await vi.waitFor(() => expect(page.query.data.value?.total).toBe(26));
  expect(page.query.data.value?.page).toBe(1);
  page.changePage(2);
  await vi.waitFor(() => expect(page.query.data.value?.page).toBe(2));
  expect(page.items.value).toHaveLength(6);
}
async function returnToFirstPage(page: ReturnType<typeof useAppleMailboxes>) {
  // Element Plus 在总数变化后将页码回到 1；这里只模拟其既有事件，查询和缓存保持真实实现。
  page.changePage(1);
  await vi.waitFor(() => {
    expect(page.query.data.value?.page).toBe(1);
    expect(page.query.data.value?.total).toBe(0);
    expect(page.items.value).toEqual([]);
  });
  expect(mocks.list.mock.calls.filter(([query]) => query.page === 1)).toHaveLength(2);
}

beforeEach(() => {
  vi.clearAllMocks();
  clearV2QueryCache();
  clearV2SessionDrafts();
  rows = Array.from({ length: 26 }, (_, index) => row(index + 1));
  mocks.list.mockImplementation(async (query: AppleMailboxListQuery) => ({
    items: rows.slice((query.page - 1) * query.pageSize, query.page * query.pageSize),
    total: rows.length,
    page: query.page,
    pageSize: query.pageSize
  }));
  mocks.mark.mockImplementation(async () => {
    rows = [];
    return { updated: 1 };
  });
  mocks.recover.mockImplementation(async () => {
    rows = [];
    return {};
  });
});
afterEach(() => {
  apps.splice(0).forEach((app) => app.unmount());
  clearV2QueryCache();
  clearV2SessionDrafts();
  roots.clear();
});

describe('苹果隐藏邮箱真实分页缓存失效', () => {
  it('真实分页在空末页缓存失效后，首页恢复数据仍能点击下一页', async () => {
    const page = mountPage(true);
    await vi.waitFor(() => expect(page.query.data.value?.total).toBe(26));
    paginationNext(page);
    await vi.waitFor(() => expect(page.query.data.value?.page).toBe(2));
    rows = [];
    await page.refreshMailboxes();
    await vi.waitFor(() => expect(page.query.data.value?.page).toBe(1));
    rows = Array.from({ length: 26 }, (_, index) => row(index + 1));
    await page.refreshMailboxes();
    expect(page.query.data.value?.total).toBe(26);
    paginationNext(page);
    await vi.waitFor(() => {
      expect(page.filters.page).toBe(2);
      expect(page.query.data.value?.page).toBe(2);
      expect(page.query.data.value?.total).toBe(26);
      expect(page.items.value).toHaveLength(6);
    });
  });
  it('真实分页忽略旧空缓存钳制后，新读取仍为空时只按稳定结果回到首页', async () => {
    const page = mountPage(true);
    await vi.waitFor(() => expect(page.query.data.value?.total).toBe(26));
    paginationNext(page);
    await vi.waitFor(() => expect(page.query.data.value?.page).toBe(2));
    rows = [];
    await page.refreshMailboxes();
    await vi.waitFor(() => expect(page.query.data.value?.page).toBe(1));
    rows = Array.from({ length: 26 }, (_, index) => row(index + 1));
    await page.refreshMailboxes();
    rows = [];
    paginationNext(page);
    await vi.waitFor(() => {
      expect(page.filters.page).toBe(1);
      expect(page.query.data.value?.page).toBe(1);
      expect(page.query.data.value?.total).toBe(0);
      expect(page.query.phase.value).toBe('ready');
    });
  });
  it('末页刷新成空后返回第一页立即重新读取，不复用此前 26 条缓存', async () => {
    const page = mountPage();
    await cacheFirstAndLastPage(page);
    rows = [];
    await page.refreshMailboxes();
    await vi.waitFor(() => expect(page.query.data.value?.total).toBe(0));
    await returnToFirstPage(page);
  });
  it('标记成功后跨页缓存同样失效，不恢复筛选前旧记录', async () => {
    const page = mountPage();
    await cacheFirstAndLastPage(page);
    page.openMark([page.items.value[0]!]);
    page.markDraft.form.registrationStatus = 'registered';
    await page.saveMark();
    expect(mocks.mark).toHaveBeenCalledOnce();
    await returnToFirstPage(page);
  });
  it('保存后记录移入已缓存首页时显示最新状态与 IP，不回填旧记录', async () => {
    const page = mountPage();
    await cacheFirstAndLastPage(page);
    const target = page.items.value[0]!;
    mocks.mark.mockImplementationOnce(async () => {
      rows = [
        {
          ...target,
          revision: 4,
          registrationStatus: 'registered',
          registrationIp: '203.0.113.10',
          registrationIpSource: 'manual'
        },
        ...rows.filter((item) => item.aliasId !== target.aliasId)
      ];
      return { updated: 1 };
    });
    page.openMark([target]);
    page.markDraft.form.registrationStatus = 'registered';
    page.markDraft.form.registrationIp = '203.0.113.10';
    await page.saveMark();
    page.changePage(1);
    await vi.waitFor(() =>
      expect(page.items.value[0]).toMatchObject({
        aliasId: target.aliasId,
        revision: 4,
        registrationStatus: 'registered',
        registrationIp: '203.0.113.10'
      })
    );
    expect(mocks.list.mock.calls.filter(([query]) => query.page === 1)).toHaveLength(2);
  });
  it('任务完成后失效所有分页，返回缓存首页仍获取完成后的邮箱结果', async () => {
    const page = mountPage();
    await cacheFirstAndLastPage(page);
    let status = 'running';
    mocks.task.mockImplementation(async () => ({
      taskUuid: 'task-cache-proof',
      status,
      logs: [],
      resultKind: status === 'completed' ? 'new_registration' : null,
      record: {
        revision: 4,
        registrationStatus: 'registered',
        registrationIp: null,
        registrationIpSource: null,
        source: 'automatic',
        note: null,
        markedAt: null,
        operatorId: null,
        activeTaskUuid: null,
        lastTaskUuid: 'task-cache-proof',
        lastResultKind: null,
        taskStatus: status
      }
    }));
    page.taskUuid.value = 'task-cache-proof';
    await vi.waitFor(() => expect(page.taskQuery.data.value?.status).toBe('running'));
    rows = [];
    status = 'completed';
    await page.taskQuery.refresh();
    await vi.waitFor(() => expect(page.query.data.value?.total).toBe(0));
    await returnToFirstPage(page);
  });
  it('解除中断占用成功后返回其他已缓存分页重新取当前结果', async () => {
    const page = mountPage();
    await cacheFirstAndLastPage(page);
    await page.recover({ ...page.items.value[0]!, taskStatus: 'interrupted' });
    expect(mocks.recover).toHaveBeenCalledOnce();
    await returnToFirstPage(page);
  });
  it('刷新失败仍保留末页内容并可重试，其他分页仍需重新确认', async () => {
    const page = mountPage();
    await cacheFirstAndLastPage(page);
    mocks.list.mockRejectedValueOnce(new Error('暂时无法读取邮箱'));
    await page.refreshMailboxes();
    expect(page.items.value).toHaveLength(6);
    expect(page.query.phase.value).toBe('refresh-error');
    rows = [];
    await page.refreshMailboxes();
    await returnToFirstPage(page);
  });
});
