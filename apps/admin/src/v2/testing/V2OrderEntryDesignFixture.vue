<template>
  <div class="v2-shell v2-order-entry-design-fixture">
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
            <el-icon class="v2-navigation__parent-icon">
              <component :is="section.icon" />
            </el-icon>
            <span class="v2-navigation__parent-label">{{ section.title }}</span>
            <el-icon class="v2-navigation__chevron"><ArrowDown /></el-icon>
          </button>
          <div v-if="section.active" class="v2-navigation__children">
            <a class="v2-navigation__item router-link-active" href="#order-entry">
              <span class="v2-navigation__item-dot" aria-hidden="true" />
              <span class="v2-navigation__item-label">订单录入</span>
            </a>
            <a class="v2-navigation__item" href="#orders">
              <span class="v2-navigation__item-dot" aria-hidden="true" />
              <span class="v2-navigation__item-label">订单列表</span>
            </a>
          </div>
        </section>
      </nav>
    </aside>

    <div class="v2-workspace">
      <header class="v2-topbar">
        <div class="v2-topbar__identity">
          <h1>订单录入</h1>
        </div>
        <div class="v2-topbar__utilities">
          <span>方案 3 · 设计验收</span>
          <el-icon><Bell /></el-icon>
          <span class="v2-order-entry-fixture-avatar">管</span>
        </div>
      </header>

      <main class="v2-content">
        <div class="v2-content__inner">
          <section class="v2-order-entry-page">
            <section class="v2-order-entry-workspace">
              <el-form
                class="v2-horizontal-form v2-order-entry-form"
                label-position="left"
                label-width="112px"
                require-asterisk-position="right"
              >
                <V2SectionHeading
                  class="v2-order-entry-section-header"
                  title="订单资料"
                  help="字段按业务顺序集中展示，订单号由系统自动生成。"
                />

                <div class="v2-order-entry-groups">
                  <section class="v2-order-entry-field-group">
                    <V2SectionHeading
                      as="div"
                      level="h3"
                      class="v2-order-entry-group-title"
                      :step="1"
                      compact
                      title="业务与对象"
                    />
                    <div class="v2-order-entry-group-columns">
                      <div class="v2-order-entry-form-column">
                        <el-form-item label="国家" required>
                          <el-select v-model="form.country" aria-label="国家">
                            <el-option label="美国" value="美国" />
                          </el-select>
                        </el-form-item>
                        <el-form-item label="业务名称" required>
                          <el-select v-model="form.service" aria-label="业务名称">
                            <el-option label="plus-20us / 20 USD" value="plus-20us / 20 USD" />
                          </el-select>
                        </el-form-item>
                        <el-form-item label="客户" required>
                          <div class="v2-order-entry-customer-control">
                            <el-select v-model="form.customer" aria-label="客户">
                              <el-option label="王朝" value="王朝" />
                            </el-select>
                            <AppButton variant="ghost">新增客户</AppButton>
                          </div>
                        </el-form-item>
                      </div>
                      <div class="v2-order-entry-form-column">
                        <el-form-item label="业务分类" required>
                          <el-select v-model="form.category" aria-label="业务分类">
                            <el-option label="ChatGPT" value="ChatGPT" />
                          </el-select>
                        </el-form-item>
                        <el-form-item label="使用 ID" required>
                          <el-select v-model="selectedId" aria-label="使用 ID">
                            <el-option
                              v-for="candidate in candidates"
                              :key="candidate.id"
                              :label="`${candidate.appleIdMasked} / 余额 ${candidate.currentBalance}`"
                              :value="candidate.id"
                            />
                          </el-select>
                        </el-form-item>
                        <el-form-item label="ID 选择方式">
                          <el-radio-group
                            v-model="selectionMode"
                            class="v2-order-entry-selection-mode"
                          >
                            <el-radio value="auto">自动匹配</el-radio>
                            <el-radio value="manual">手动选择</el-radio>
                          </el-radio-group>
                        </el-form-item>
                      </div>
                    </div>
                  </section>

                  <section class="v2-order-entry-field-group">
                    <V2SectionHeading
                      as="div"
                      level="h3"
                      class="v2-order-entry-group-title"
                      :step="2"
                      compact
                      title="客户与结算"
                    />
                    <div class="v2-order-entry-group-columns">
                      <div class="v2-order-entry-form-column">
                        <el-form-item label="结算平台" required>
                          <el-select v-model="form.platform" aria-label="结算平台">
                            <el-option label="公司开发" value="公司开发" />
                          </el-select>
                        </el-form-item>
                        <el-form-item label="平台订单号">
                          <el-input v-model="form.platformOrderNo" placeholder="选填" />
                        </el-form-item>
                        <el-form-item label="客户业务账号">
                          <el-input v-model="form.customerAccount" />
                        </el-form-item>
                        <el-form-item label="目标/反算利率">
                          <el-input v-model="form.profitRate" placeholder="填写售卖价格后自动反算">
                            <template #append>%</template>
                          </el-input>
                        </el-form-item>
                      </div>
                      <div class="v2-order-entry-form-column">
                        <el-form-item label="收款币种" required>
                          <el-select v-model="form.currency" aria-label="收款币种">
                            <el-option label="人民币 CNY" value="CNY" />
                          </el-select>
                        </el-form-item>
                        <el-form-item label="售卖价格" required>
                          <el-input v-model="form.sellingPrice" inputmode="decimal" />
                        </el-form-item>
                        <el-form-item label="折算人民币">
                          <div class="v2-order-entry-readonly">
                            <strong>¥220</strong><span>自动折算</span>
                          </div>
                        </el-form-item>
                        <el-form-item label="推荐价格">
                          <div class="v2-order-entry-recommendation">
                            <div><strong>¥220</strong><small>当前为实收反算</small></div>
                            <AppButton variant="soft">采用</AppButton>
                          </div>
                        </el-form-item>
                      </div>
                    </div>
                  </section>

                  <section class="v2-order-entry-field-group">
                    <V2SectionHeading
                      as="div"
                      level="h3"
                      class="v2-order-entry-group-title"
                      :step="3"
                      compact
                      title="周期与备注"
                    />
                    <div class="v2-order-entry-group-columns v2-order-entry-period-columns">
                      <div class="v2-order-entry-form-column">
                        <el-form-item label="消耗余额（USD）" required>
                          <el-input v-model="form.balance" inputmode="decimal" />
                        </el-form-item>
                        <el-form-item label="开通时间" required>
                          <el-date-picker v-model="form.openedAt" type="datetime" />
                        </el-form-item>
                        <el-form-item label="到期时间" required>
                          <el-date-picker v-model="form.dueAt" type="datetime" />
                        </el-form-item>
                      </div>
                      <div class="v2-order-entry-form-column">
                        <el-form-item label="ID 购买成本">
                          <div class="v2-order-entry-readonly">
                            <strong>¥0</strong><span>无需填写</span>
                          </div>
                        </el-form-item>
                        <el-form-item label="平台手续费">
                          <div class="v2-order-entry-readonly">
                            <strong>¥20</strong><span>服务端复核</span>
                          </div>
                        </el-form-item>
                        <el-form-item label="备注" class="v2-order-entry-remark-item">
                          <el-input
                            v-model="form.remark"
                            type="textarea"
                            :autosize="{ minRows: 1, maxRows: 3 }"
                            placeholder="选填"
                          />
                        </el-form-item>
                      </div>
                    </div>
                  </section>
                </div>
              </el-form>

              <V2OrderEntryCandidates
                v-model:account-id="selectedId"
                v-model:account-disposition="accountDisposition"
                :id-selection-mode="selectionMode"
                :can-match="true"
                :matching-loading="false"
                matching-phase="ready"
                :matching-parameter-transition="false"
                :matching-result="matchingResult"
                :candidate-items="candidates"
                matching-error=""
                matching-empty-message=""
                :format-decimal="formatDecimal"
              />

              <V2OrderEntryLiveSummary
                :selected-candidate="selectedCandidate"
                selected-country-name="美国"
                account-purchase-cost-preview="0"
                platform-fee-preview="20"
                estimated-balance-cost-preview="116"
                total-cost-preview="136"
                estimated-profit-preview="84"
                estimated-profit-rate-preview="42"
                :format-decimal="formatDecimal"
              />

              <V2OrderEntrySubmitBar
                :submitting="submitted"
                disabled-reason=""
                :selected-id="selectedCandidate?.appleIdMasked ?? ''"
                :selected-balance="selectedCandidate?.currentBalance ?? '0'"
                selected-currency="USD"
                estimated-profit="84"
                estimated-profit-rate="42"
                :format-decimal="formatDecimal"
                @submit="previewSubmit"
              />
            </section>
          </section>
        </div>
      </main>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, reactive, ref } from 'vue';
import {
  ArrowDown,
  Bell,
  Collection,
  DataAnalysis,
  Document,
  Setting,
  User
} from '@element-plus/icons-vue';
import AppButton from '@/components/ui/AppButton.vue';
import V2BrandLogo from '@/v2/components/V2BrandLogo.vue';
import V2SectionHeading from '@/v2/components/V2SectionHeading.vue';
import V2OrderEntryCandidates from '@/v2/features/order-entry/components/V2OrderEntryCandidates.vue';
import V2OrderEntryLiveSummary from '@/v2/features/order-entry/components/V2OrderEntryLiveSummary.vue';
import V2OrderEntrySubmitBar from '@/v2/features/order-entry/components/V2OrderEntrySubmitBar.vue';
import type { V2OrderCandidate, V2OrderMatchingResult } from '@/v2/types/orders';

const navigation = [
  { title: '订单管理', icon: Document, active: true },
  { title: 'ID 资源', icon: Collection, active: false },
  { title: '客户管理', icon: User, active: false },
  { title: '财务管理', icon: DataAnalysis, active: false },
  { title: '数据报表', icon: DataAnalysis, active: false },
  { title: '系统设置', icon: Setting, active: false }
];

const candidateSeed = [
  ['85********@qq.com', '324.2', '5.8', '正常'],
  ['77********@163.com', '182.7', '4.2', '正常'],
  ['92********@gmail.com', '68.5', '6.1', '正常'],
  ['60********@qq.com', '15.3', '3.9', '正常'],
  ['31********@outlook.com', '402.8', '5.5', '正常'],
  ['18********@icloud.com', '210.0', '5.2', '正常'],
  ['59********@foxmail.com', '95.0', '5.0', '正常'],
  ['44********@qq.com', '143.6', '4.7', '正常'],
  ['67********@gmail.com', '88.4', '5.4', '正常'],
  ['25********@icloud.com', '270.1', '4.9', '正常'],
  ['36********@outlook.com', '155.5', '5.1', '正常'],
  ['49********@163.com', '199.8', '4.8', '正常'],
  ['73********@qq.com', '122.6', '5.3', '正常']
] as const;

const candidates: V2OrderCandidate[] = candidateSeed.map((item, index) => ({
  id: `candidate-${index + 1}`,
  appleIdMasked: item[0],
  country: { id: 'country-us', code: 'US', name: '美国' },
  status: { id: 'status-normal', code: 'normal', name: item[3] },
  currentBalance: item[1],
  balanceCostAmount: '116',
  estimatedBalanceCostAmount: '116',
  averageCost: item[2],
  purchaseCost: '0',
  balanceAfterMatch: String(Math.max(0, Number(item[1]) - 20).toFixed(1)),
  updatedAt: '2026-08-09T08:40:00.000Z'
}));

const matchingResult: V2OrderMatchingResult = {
  criteria: {
    service: { id: 'service-plus', code: 'plus-20us', name: 'plus-20us' },
    category: { id: 'category-chatgpt', code: 'chatgpt', name: 'ChatGPT' },
    country: { id: 'country-us', code: 'US', name: '美国' },
    requiredBalance: '20',
    requiredStatusCode: 'normal',
    evaluatedAt: '2026-08-09T08:40:00.000Z'
  },
  counts: {
    activeInCountry: 20,
    normalStatus: 18,
    sufficientBalance: 15,
    available: 13
  },
  selectedCandidateId: candidates[0]?.id ?? null,
  items: candidates,
  revalidateAt: '2026-08-09T08:41:00.000Z'
};

const form = reactive({
  category: 'ChatGPT',
  service: 'plus-20us / 20 USD',
  customer: '王朝',
  country: '美国',
  platform: '公司开发',
  platformOrderNo: '',
  customerAccount: '728455343@qq.com',
  profitRate: '42',
  currency: 'CNY',
  sellingPrice: '220',
  balance: '20',
  openedAt: new Date('2026-08-09T08:40:00'),
  dueAt: new Date('2026-09-06T08:40:00'),
  remark: ''
});

const selectionMode = ref<'auto' | 'manual'>('auto');
const selectedId = ref(candidates[0]?.id ?? '');
const accountDisposition = ref<'retained' | 'sold'>('retained');
const submitted = ref(false);
const selectedCandidate = computed(
  () => candidates.find((candidate) => candidate.id === selectedId.value) ?? null
);

function formatDecimal(value: string) {
  const numeric = Number(value);
  return Number.isFinite(numeric)
    ? numeric.toLocaleString('zh-CN', { maximumFractionDigits: 2 })
    : value;
}

function previewSubmit() {
  submitted.value = true;
  window.setTimeout(() => {
    submitted.value = false;
  }, 500);
}
</script>

<style scoped>
.v2-order-entry-fixture-avatar {
  display: grid;
  width: 34px;
  height: 34px;
  place-items: center;
  border-radius: 50%;
  background: #dbe7f5;
  color: #17304c;
  font-weight: 700;
}

@media (max-width: 900px) {
  .v2-order-entry-design-fixture .v2-sidebar {
    display: none;
  }
}
</style>
