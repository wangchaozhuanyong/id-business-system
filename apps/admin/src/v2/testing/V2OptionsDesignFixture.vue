<template>
  <div class="v2-shell v2-options-design-fixture">
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
            <a class="v2-navigation__item" href="#exchange-rates">
              <span class="v2-navigation__item-dot" aria-hidden="true" />
              <span class="v2-navigation__item-label">汇率记录</span>
            </a>
            <a class="v2-navigation__item router-link-active" href="#options">
              <span class="v2-navigation__item-dot" aria-hidden="true" />
              <span class="v2-navigation__item-label">设置管理</span>
            </a>
          </div>
        </section>
      </nav>
    </aside>

    <div class="v2-workspace">
      <header class="v2-topbar">
        <div class="v2-topbar__identity"><h1>设置管理</h1></div>
        <div class="v2-topbar__utilities">
          <span>方案 3 · 设计验收</span>
          <el-icon><Bell /></el-icon>
          <span class="v2-options-fixture-avatar">管</span>
        </div>
      </header>

      <main class="v2-content">
        <div class="v2-content__inner">
          <p v-if="notice" class="v2-options-fixture-notice" role="status">{{ notice }}</p>
          <section class="v2-options-page">
            <div class="v2-options-page__content">
              <V2OptionsOverview :page="page" />
              <div class="v2-options-workspace">
                <V2OptionsCategoryRail :page="page" />
                <div class="v2-options-content">
                  <V2OptionsToolbar :page="page" />
                  <V2OptionsList :page="page" />
                </div>
              </div>
            </div>
          </section>
        </div>
      </main>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, markRaw, reactive, ref } from 'vue';
import type { Component, UnwrapNestedRefs } from 'vue';
import {
  ArrowDown,
  Bell,
  Box,
  CircleCheck,
  Collection,
  CreditCard,
  DataAnalysis,
  Document,
  Files,
  Location,
  PriceTag,
  Setting,
  Tickets,
  User,
  Wallet
} from '@element-plus/icons-vue';
import V2BrandLogo from '@/v2/components/V2BrandLogo.vue';
import V2OptionsCategoryRail from '@/v2/features/options/components/V2OptionsCategoryRail.vue';
import V2OptionsList from '@/v2/features/options/components/V2OptionsList.vue';
import V2OptionsOverview from '@/v2/features/options/components/V2OptionsOverview.vue';
import V2OptionsToolbar from '@/v2/features/options/components/V2OptionsToolbar.vue';
import type { useOptionsPage } from '@/v2/features/options/useOptionsPage';
import type {
  V2Option,
  V2OptionType,
  V2OptionTypeDefinition
} from '@/v2/features/options/contracts';

type OptionsPage = UnwrapNestedRefs<ReturnType<typeof useOptionsPage>>;

const navigation = [
  { title: '工作台', icon: Document, active: false },
  { title: '业务中心', icon: Collection, active: false },
  { title: '客户管理', icon: User, active: false },
  { title: '财务管理', icon: DataAnalysis, active: false },
  { title: '系统设置', icon: Setting, active: true }
];
const typeDefinitions: V2OptionTypeDefinition[] = [
  definition('id_status', 'ID状态'),
  definition('customer_source', '客户来源'),
  definition('customer_tag', '客户标签'),
  definition('country', '国家', { supportsCurrency: true }),
  definition('business_category', '业务分类'),
  definition('service', '开通业务', {
    parentType: 'business_category',
    requiresCountry: true,
    supportsBusinessAmount: true
  }),
  definition('id_supplier', 'ID供应商'),
  definition('topup_supplier', '加卡供应商'),
  definition('gift_card_name', '卡片名称'),
  definition('settlement_platform', '结算平台', { supportsFees: true }),
  definition('expense_category', '开支分类'),
  definition('income_category', '收入分类')
];
const optionTypeIcons: Record<V2OptionType, Component> = {
  id_status: markRaw(CircleCheck),
  customer_source: markRaw(User),
  customer_tag: markRaw(PriceTag),
  country: markRaw(Location),
  business_category: markRaw(Files),
  service: markRaw(Tickets),
  id_supplier: markRaw(Box),
  topup_supplier: markRaw(Wallet),
  gift_card_name: markRaw(CreditCard),
  settlement_platform: markRaw(CreditCard),
  expense_category: markRaw(Wallet),
  income_category: markRaw(Wallet)
};
const selectedTypeState = ref<V2OptionType>('service');
const renderedTypeState = ref<V2OptionType>('service');
const itemsState = ref<V2Option[]>([]);
const totalState = ref(0);
const notice = ref('');
const query = reactive({
  page: 1,
  pageSize: 10,
  keyword: '',
  status: '' as '' | 'active' | 'disabled',
  sortBy: 'sortOrder' as const,
  sortOrder: 'asc' as const
});
const selectedTypeDefinition = computed(() =>
  typeDefinitions.find((item) => item.type === selectedTypeState.value)
);
const activeTypeDefinition = computed(() =>
  typeDefinitions.find((item) => item.type === renderedTypeState.value)
);
const activeFilterCount = computed(
  () => Number(Boolean(query.keyword.trim())) + Number(Boolean(query.status))
);
const emptyState = new URLSearchParams(window.location.search).get('state') === 'empty';
const optionsByType = Object.fromEntries(
  typeDefinitions.map((item, definitionIndex) => [
    item.type,
    emptyState
      ? []
      : Array.from(
          { length: item.type === 'service' ? 23 : 6 + (definitionIndex % 5) },
          (_, index) => makeOption(item, index)
        )
  ])
) as Record<V2OptionType, V2Option[]>;

const page = reactive({
  typeDefinitions,
  optionTypeIcons,
  selectedType: selectedTypeState,
  renderedType: renderedTypeState,
  items: itemsState,
  total: totalState,
  selectedTypeDefinition,
  activeTypeDefinition,
  activeFilterCount,
  query,
  typesLoading: false,
  isInitialLoading: false,
  loading: false,
  listResolved: true,
  listError: '',
  handleTypeChange: (value: string | number | boolean | undefined) => {
    if (typeof value !== 'string') return;
    selectedTypeState.value = value as V2OptionType;
    renderedTypeState.value = value as V2OptionType;
    query.page = 1;
    query.keyword = '';
    query.status = '';
    applyFilters();
  },
  handleSearch: () => applyFilters(true),
  handleFilterChange: () => applyFilters(true),
  resetFilters: () => {
    query.page = 1;
    query.keyword = '';
    query.status = '';
    applyFilters();
  },
  handleRefresh: () => {
    notice.value = `${selectedTypeDefinition.value?.label ?? '选项'}数据已刷新。`;
    applyFilters();
  },
  handleRetry: () => applyFilters(),
  handlePageChange: () => applyFilters(),
  handlePageSizeChange: () => applyFilters(true),
  handleSortChange: () => undefined,
  openCreate: () => {
    notice.value = `预览操作：已准备新增${selectedTypeDefinition.value?.label ?? '选项'}。`;
  },
  openEdit: (item: V2Option) => {
    notice.value = `预览操作：正在编辑“${item.name}”。`;
  },
  openDelete: (item: V2Option) => {
    notice.value = `预览操作：已打开“${item.name}”删除确认。`;
  },
  getDeleteTitle: (item: V2Option) => (item.isSystem ? '系统固定选项不能删除' : '删除选项'),
  formatDecimal: (value: string) => Number(value).toFixed(2),
  formatDate: (value: string) =>
    new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    }).format(new Date(value))
}) as unknown as OptionsPage;

function definition(
  type: V2OptionType,
  label: string,
  overrides: Partial<Omit<V2OptionTypeDefinition, 'type' | 'label'>> = {}
): V2OptionTypeDefinition {
  return {
    type,
    label,
    parentType: null,
    supportsFees: false,
    supportsCurrency: false,
    requiresCountry: false,
    supportsBusinessAmount: false,
    ...overrides
  };
}

function makeOption(definitionItem: V2OptionTypeDefinition, index: number): V2Option {
  const serviceNames = ['ChatGPT Plus', 'Claude Pro', 'Midjourney', 'Canva Pro', 'Google One'];
  const genericNames: Record<Exclude<V2OptionType, 'service'>, string[]> = {
    id_status: ['正常', '冻结', '余额封控'],
    customer_source: ['微信', '淘宝', '闲鱼', '抖音'],
    customer_tag: ['公司客户', '个人客户', '大客户', '长期合作'],
    country: ['美国', '马来西亚', '新加坡', '日本'],
    business_category: ['AI 工具', '设计工具', '云存储', '影音娱乐'],
    id_supplier: ['北美资源组', '东南亚资源组', '长期合作供应商'],
    topup_supplier: ['礼品卡渠道 A', '礼品卡渠道 B', '人工采购渠道'],
    gift_card_name: ['Apple Gift Card', 'Google Play Gift Card', 'Steam Gift Card'],
    settlement_platform: ['公司开发', '微信收款', '支付宝收款', '银行转账'],
    expense_category: ['采购成本', '平台服务费', '运营支出', '其他支出'],
    income_category: ['额外服务收入', '佣金收入', '返利收入', '其他经营收入']
  };
  const type = definitionItem.type;
  const baseNames = type === 'service' ? serviceNames : genericNames[type];
  const name = `${baseNames[index % baseNames.length]}${index >= baseNames.length ? ` ${index + 1}` : ''}`;
  const date = `2026-08-${String(10 - Math.floor(index / 5)).padStart(2, '0')}T${String(
    9 + (index % 8)
  ).padStart(2, '0')}:20:00.000Z`;
  return {
    id: `${type}-${index + 1}`,
    type,
    typeLabel: definitionItem.label,
    code: `${type}-${String(index + 1).padStart(3, '0')}`,
    name,
    parentId: definitionItem.parentType ? 'business-category-ai' : null,
    parent: definitionItem.parentType
      ? { id: 'business-category-ai', type: 'business_category', name: 'AI 工具' }
      : null,
    countryOptionId: definitionItem.requiresCountry ? 'country-us' : null,
    country: definitionItem.requiresCountry
      ? { id: 'country-us', type: 'country', code: 'US', name: '美国', currencyCode: 'USD' }
      : null,
    businessAmount: definitionItem.supportsBusinessAmount ? `${20 + (index % 4) * 5}` : null,
    currencyCode:
      definitionItem.supportsCurrency || definitionItem.supportsBusinessAmount ? 'USD' : null,
    fixedFee: definitionItem.supportsFees ? `${index % 3}` : '0',
    percentageFee: definitionItem.supportsFees ? `${0.6 + (index % 4) * 0.2}` : '0',
    sortOrder: (index + 1) * 10,
    status: index % 7 === 6 ? 'disabled' : 'active',
    isSystem: type === 'id_status' && index < 2,
    remark: index % 3 === 0 ? '用于业务录入和统计筛选' : null,
    childCount: type === 'business_category' ? index % 4 : 0,
    createdAt: date,
    updatedAt: date
  };
}

function applyFilters(resetPage = false) {
  if (resetPage) query.page = 1;
  const keyword = query.keyword.trim().toLocaleLowerCase('zh-CN');
  const filtered = optionsByType[selectedTypeState.value].filter(
    (item) =>
      (!keyword ||
        item.name.toLocaleLowerCase('zh-CN').includes(keyword) ||
        item.remark?.toLocaleLowerCase('zh-CN').includes(keyword)) &&
      (!query.status || item.status === query.status)
  );
  const start = (query.page - 1) * query.pageSize;
  renderedTypeState.value = selectedTypeState.value;
  totalState.value = filtered.length;
  itemsState.value = filtered.slice(start, start + query.pageSize);
}

applyFilters();
</script>

<style scoped>
.v2-options-fixture-avatar {
  display: inline-grid;
  width: 32px;
  height: 32px;
  place-items: center;
  border-radius: 50%;
  background: var(--v2-accent-soft);
  color: var(--v2-accent);
  font-weight: 700;
}

.v2-options-fixture-notice {
  margin: 0 0 12px;
  padding: 9px 12px;
  border: 1px solid color-mix(in srgb, var(--v2-accent) 24%, var(--v2-border));
  border-radius: var(--v3-radius-sm);
  background: var(--v2-accent-soft);
  color: var(--v2-accent);
  font-size: 12px;
}
</style>
