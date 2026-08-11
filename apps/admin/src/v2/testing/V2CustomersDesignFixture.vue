<template>
  <div class="v2-shell v2-customers-design-fixture">
    <aside class="v2-sidebar">
      <div class="v2-brand">
        <V2BrandLogo class="v2-brand__mark" logo-text="ID" />
        <div class="v2-brand__copy">
          <strong>ID 业务管理系统</strong>
          <span>业务管理工作台</span>
        </div>
      </div>

      <nav class="v2-navigation" aria-label="设计验收导航">
        <section
          v-for="section in navigation"
          :key="section.title"
          class="v2-navigation__section"
          :class="{ 'is-open': section.active, 'is-active': section.active }"
        >
          <button class="v2-navigation__parent" type="button">
            <el-icon class="v2-navigation__parent-icon"><component :is="section.icon" /></el-icon>
            <span class="v2-navigation__parent-label">{{ section.title }}</span>
            <el-icon class="v2-navigation__chevron"><ArrowDown /></el-icon>
          </button>
          <div v-if="section.active" class="v2-navigation__children">
            <a class="v2-navigation__item router-link-active" href="#customers">
              <span class="v2-navigation__item-dot" aria-hidden="true" />
              <span class="v2-navigation__item-label">客户记录</span>
            </a>
          </div>
        </section>
      </nav>
    </aside>

    <div class="v2-workspace">
      <header class="v2-topbar">
        <div class="v2-topbar__identity"><h1>客户记录</h1></div>
        <div class="v2-topbar__utilities">
          <span>方案 3 · 设计验收</span>
          <el-icon><Bell /></el-icon>
          <span class="v2-customers-fixture-avatar">管</span>
        </div>
      </header>

      <main class="v2-content">
        <div class="v2-content__inner">
          <p v-if="notice" class="v2-customers-fixture-notice" role="status">{{ notice }}</p>
          <section class="v2-records-page">
            <V2CustomersOverview :page="page" />
            <V2CustomersToolbar :page="page" />
            <V2CustomersList :page="page" />
          </section>
        </div>
      </main>
    </div>
  </div>
</template>

<script setup lang="ts">
import { reactive, ref } from 'vue';
import type { UnwrapNestedRefs } from 'vue';
import {
  ArrowDown,
  Bell,
  Collection,
  DataAnalysis,
  Document,
  Setting,
  User
} from '@element-plus/icons-vue';
import V2BrandLogo from '@/v2/components/V2BrandLogo.vue';
import V2CustomersList from '@/v2/features/customers/components/V2CustomersList.vue';
import V2CustomersOverview from '@/v2/features/customers/components/V2CustomersOverview.vue';
import V2CustomersToolbar from '@/v2/features/customers/components/V2CustomersToolbar.vue';
import type { useCustomersPage } from '@/v2/features/customers/useCustomersPage';
import type { V2Customer } from '@/v2/types/records';
import type { V2OptionSelector, V2OptionType } from '@/v2/types/options';

type CustomersPage = UnwrapNestedRefs<ReturnType<typeof useCustomersPage>>;

const navigation = [
  { title: '订单管理', icon: Document, active: false },
  { title: 'ID 资源', icon: Collection, active: false },
  { title: '客户管理', icon: User, active: true },
  { title: '财务管理', icon: DataAnalysis, active: false },
  { title: '数据报表', icon: DataAnalysis, active: false },
  { title: '系统设置', icon: Setting, active: false }
];

function option(
  id: string,
  type: V2OptionType,
  name: string,
  parent: V2OptionSelector['parent'] = null
): V2OptionSelector {
  return {
    id,
    type,
    code: id,
    name,
    parentId: parent?.id ?? null,
    parent,
    countryOptionId: null,
    country: null,
    businessAmount: null,
    currencyCode: null
  };
}

const sourceOptions = [
  option('source-referral', 'customer_source', '老客户转介绍'),
  option('source-search', 'customer_source', '搜索咨询'),
  option('source-channel', 'customer_source', '渠道合作')
];
const tagOptions = [
  option('tag-priority', 'customer_tag', '重点客户'),
  option('tag-renewal', 'customer_tag', '续费稳定'),
  option('tag-new', 'customer_tag', '新客户')
];
const serviceParent = { id: 'category-ai', name: 'AI 工具' };
const serviceOptions = [
  option('service-chatgpt', 'service', 'ChatGPT Plus', serviceParent),
  option('service-claude', 'service', 'Claude Pro', serviceParent),
  option('service-midjourney', 'service', 'Midjourney', serviceParent)
];
const customerNames = ['王明', '林晓雯', '陈先生', '周欣怡', '郑文杰', '黄女士', '刘昊', '赵若彤'];

function makeCustomer(index: number): V2Customer {
  const source = sourceOptions[index % sourceOptions.length];
  const tag = tagOptions[index % tagOptions.length];
  const service = serviceOptions[index % serviceOptions.length];
  const hasPhone = index % 4 !== 3;
  const hasWhatsapp = index % 3 === 0;
  const disabled = index % 7 === 6;
  const day = String(10 - Math.floor(index / 5)).padStart(2, '0');
  return {
    id: `customer-${index + 1}`,
    name: `${customerNames[index % customerNames.length]}${index > 7 ? ` ${index + 1}` : ''}`,
    maskedPhone: hasPhone ? `138****${String(2600 + index).slice(-4)}` : null,
    phoneTail: hasPhone ? String(2600 + index).slice(-4) : null,
    hasPhone,
    wechat: index % 5 === 4 ? null : `wx_customer_${String(index + 1).padStart(2, '0')}`,
    qq: index % 4 === 2 ? null : `${728455300 + index}`,
    maskedWhatsapp: hasWhatsapp ? `+60 1*-*** ${String(1200 + index).slice(-4)}` : null,
    whatsappTail: hasWhatsapp ? String(1200 + index).slice(-4) : null,
    hasWhatsapp,
    sourceOptionId: source.id,
    source: { id: source.id, code: source.code, name: source.name },
    tagOptionIds: [tag.id],
    tags: [{ id: tag.id, code: tag.code, name: tag.name }],
    serviceOptionIds: [service.id],
    services: [
      {
        id: service.id,
        code: service.code,
        name: service.name,
        parent: service.parent,
        firstOpenedAt: `2026-07-${day}T08:20:00.000Z`,
        lastOpenedAt: `2026-08-${day}T12:30:00.000Z`,
        activationCount: (index % 4) + 1
      }
    ],
    recordStatus: disabled ? 'disabled' : 'active',
    remark: index % 6 === 0 ? '优先安排续费提醒' : null,
    createdBy: { id: 'admin-1', username: 'admin', displayName: '管理员' },
    createdAt: `2026-07-${day}T08:20:00.000Z`,
    updatedAt: `2026-08-${day}T16:05:00.000Z`
  };
}

const emptyState = new URLSearchParams(window.location.search).get('state') === 'empty';
const allCustomers: V2Customer[] = emptyState
  ? []
  : Array.from({ length: 23 }, (_, index) => makeCustomer(index));
const notice = ref('');

const page = reactive({
  items: [] as V2Customer[],
  total: 0,
  loading: false,
  listError: '',
  hasLoadedOnce: true,
  isInitialLoading: false,
  sourceOptions,
  tagOptions,
  serviceOptions,
  canCreate: true,
  canUpdate: true,
  canDelete: true,
  canRevealContact: true,
  activeFilterCount: 0,
  query: {
    page: 1,
    pageSize: 10,
    keyword: '',
    sourceOptionId: '',
    tagOptionId: '',
    serviceOptionId: '',
    recordStatus: '',
    sortBy: 'updatedAt',
    sortOrder: 'desc'
  },
  loadCustomers: () => {
    notice.value = '客户资料已刷新，列表框架保持稳定。';
    applyFilters();
  },
  openCreate: () => {
    notice.value = '预览操作：已打开新增客户抽屉。';
  },
  handleSearch: () => applyFilters(true),
  handleFilterChange: () => applyFilters(true),
  resetFilters: () => {
    Object.assign(page.query, {
      page: 1,
      keyword: '',
      sourceOptionId: '',
      tagOptionId: '',
      serviceOptionId: '',
      recordStatus: ''
    });
    applyFilters();
  },
  handlePageChange: () => applyFilters(),
  handlePageSizeChange: () => applyFilters(true),
  handleSortChange: () => undefined,
  selectorLabel: (item: V2OptionSelector) =>
    item.parent ? `${item.parent.name} / ${item.name}` : item.name,
  optionNames: (items: Array<{ name: string }>) => items.map((item) => item.name).join('、'),
  formatDate: (value: string) =>
    new Intl.DateTimeFormat('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    }).format(new Date(value)),
  openRevealPhone: (item: V2Customer) => {
    notice.value = `预览操作：已申请查看 ${item.name} 的完整手机号。`;
  },
  openRevealWhatsapp: (item: V2Customer) => {
    notice.value = `预览操作：已申请查看 ${item.name} 的完整 WhatsApp。`;
  },
  openEdit: (item: V2Customer) => {
    notice.value = `预览操作：正在编辑 ${item.name}。`;
  },
  toggleStatus: (item: V2Customer) => {
    item.recordStatus = item.recordStatus === 'active' ? 'disabled' : 'active';
    notice.value = `${item.name} 已切换为${item.recordStatus === 'active' ? '启用' : '停用'}。`;
    applyFilters();
  },
  openDelete: (item: V2Customer) => {
    notice.value = `预览操作：正在核对 ${item.name} 的软删除确认。`;
  }
}) as unknown as CustomersPage;

function applyFilters(resetPage = false) {
  if (resetPage) page.query.page = 1;
  const keyword = page.query.keyword.trim().toLowerCase();
  const filtered = allCustomers.filter((customer) => {
    const matchesKeyword =
      !keyword ||
      [customer.name, customer.maskedPhone, customer.wechat, customer.qq, customer.maskedWhatsapp]
        .filter(Boolean)
        .some((value) => value?.toLowerCase().includes(keyword));
    return (
      matchesKeyword &&
      (!page.query.sourceOptionId || customer.sourceOptionId === page.query.sourceOptionId) &&
      (!page.query.tagOptionId || customer.tagOptionIds.includes(page.query.tagOptionId)) &&
      (!page.query.serviceOptionId ||
        customer.serviceOptionIds.includes(page.query.serviceOptionId)) &&
      (!page.query.recordStatus || customer.recordStatus === page.query.recordStatus)
    );
  });
  page.activeFilterCount = [
    keyword,
    page.query.sourceOptionId,
    page.query.tagOptionId,
    page.query.serviceOptionId,
    page.query.recordStatus
  ].filter(Boolean).length;
  page.total = filtered.length;
  const start = (page.query.page - 1) * page.query.pageSize;
  page.items = filtered.slice(start, start + page.query.pageSize);
}

applyFilters();
</script>

<style scoped>
.v2-customers-fixture-avatar {
  display: inline-grid;
  width: 34px;
  height: 34px;
  place-items: center;
  border-radius: 50%;
  background: var(--v2-accent-soft);
  color: var(--v2-accent);
  font-size: 13px;
  font-weight: 700;
}

.v2-customers-fixture-notice {
  margin: 0 0 12px;
  padding: 9px 12px;
  border: 1px solid var(--v3-success-border-soft);
  border-radius: var(--v3-radius-sm);
  background: var(--v3-success-soft);
  color: var(--v2-text);
  font-size: 12px;
}
</style>
