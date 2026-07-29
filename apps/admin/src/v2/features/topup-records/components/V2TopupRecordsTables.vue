<template>
  <V2AsyncRegion
    skeleton="table"
    :loading="activeLoading || isInitialLoading"
    :resolved="activeResolved"
    :error="activeError"
    :loading-title="activeTab === 'giftCards' ? '正在加载加卡记录' : '正在加载余额变动'"
    :refreshing-title="activeTab === 'giftCards' ? '正在更新加卡记录' : '正在更新余额变动'"
    :error-title="activeTab === 'giftCards' ? '加卡记录加载失败' : '余额变动加载失败'"
    @retry="loadActiveTab"
  >
    <section class="v2-records-list">
      <template v-if="activeTab === 'giftCards'">
        <el-table
          :aria-busy="giftCardLoading"
          scrollbar-always-on
          show-overflow-tooltip
          class="v2-records-table v2-topup-records-table"
          :data="giftCards"
          row-key="id"
          @sort-change="handleGiftCardSortChange"
        >
          <template #empty>
            <div class="v2-records-empty">
              <strong>暂无加卡记录</strong>
              <span>当前筛选条件下没有入账记录</span>
              <AppButton variant="ghost" @click="resetFilters">重置筛选</AppButton>
            </div>
          </template>

          <el-table-column label="序号" width="72" fixed="left">
            <template #default="{ $index }">{{ giftCardRowNumber($index) }}</template>
          </el-table-column>
          <el-table-column label="礼品卡号" min-width="175" fixed="left">
            <template #default="{ row }">
              <strong class="v2-topup-records-code">{{ row.codeMasked }}</strong>
            </template>
          </el-table-column>
          <el-table-column prop="faceValue" label="面值" min-width="95" sortable="custom">
            <template #default="{ row }">{{ formatDecimal(row.faceValue) }}</template>
          </el-table-column>
          <el-table-column prop="exchangeRate" label="卡片汇率" min-width="110" sortable="custom">
            <template #default="{ row }">¥{{ formatDecimal(row.exchangeRate, 8) }}</template>
          </el-table-column>
          <el-table-column label="加入 ID" min-width="190">
            <template #default="{ row }">{{ row.account.appleIdMasked }}</template>
          </el-table-column>
          <el-table-column label="国家" min-width="105">
            <template #default="{ row }">{{ row.account.country.name }}</template>
          </el-table-column>
          <el-table-column label="供应商" min-width="125">
            <template #default="{ row }">{{ row.supplier?.name || '-' }}</template>
          </el-table-column>
          <el-table-column label="加入前余额" min-width="120">
            <template #default="{ row }">
              {{ formatOptionalDecimal(row.creditedLedger?.balanceBefore) }}
            </template>
          </el-table-column>
          <el-table-column label="加入后余额" min-width="120">
            <template #default="{ row }">
              {{ formatOptionalDecimal(row.creditedLedger?.balanceAfter) }}
            </template>
          </el-table-column>
          <el-table-column
            prop="statusChangedAt"
            label="变动时间"
            min-width="165"
            sortable="custom"
          >
            <template #default="{ row }">{{ formatDate(row.statusChangedAt) }}</template>
          </el-table-column>
          <el-table-column prop="status" label="状态" min-width="105" sortable="custom">
            <template #default="{ row }">
              <el-tag :type="giftCardStatusType(row.status)" effect="plain">
                {{ giftCardStatusLabel(row.status) }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column label="操作" width="260" fixed="right">
            <template #default="{ row }">
              <div v-if="canAdjustBalance" class="v2-record-actions">
                <AppButton size="small" variant="ghost" @click="openMetadataDrawer(row)">
                  <el-icon><Edit /></el-icon>
                  修改
                </AppButton>
                <template v-if="row.status === 'credited'">
                  <AppButton
                    size="small"
                    variant="soft"
                    @click="openReversalConfirmation(row, 'redeemed')"
                  >
                    <el-icon><CircleClose /></el-icon>
                    被赎回
                  </AppButton>
                  <AppButton
                    size="small"
                    variant="danger"
                    @click="openReversalConfirmation(row, 'withdrawn')"
                  >
                    <el-icon><Back /></el-icon>
                    撤回
                  </AppButton>
                </template>
              </div>
              <span v-else>-</span>
            </template>
          </el-table-column>
        </el-table>

        <div class="v2-records-mobile-list">
          <article v-for="item in giftCards" :key="item.id" class="v2-records-mobile-item">
            <header>
              <div>
                <strong>{{ item.codeMasked }}</strong>
                <span>{{ item.account.appleIdMasked }} / {{ item.account.country.name }}</span>
              </div>
              <el-tag :type="giftCardStatusType(item.status)" effect="plain">
                {{ giftCardStatusLabel(item.status) }}
              </el-tag>
            </header>
            <dl>
              <div>
                <dt>面值</dt>
                <dd>{{ formatDecimal(item.faceValue) }}</dd>
              </div>
              <div>
                <dt>汇率</dt>
                <dd>¥{{ formatDecimal(item.exchangeRate, 8) }}</dd>
              </div>
              <div>
                <dt>供应商</dt>
                <dd>{{ item.supplier?.name || '-' }}</dd>
              </div>
              <div>
                <dt>余额变化</dt>
                <dd>
                  {{ formatOptionalDecimal(item.creditedLedger?.balanceBefore) }} →
                  {{ formatOptionalDecimal(item.creditedLedger?.balanceAfter) }}
                </dd>
              </div>
            </dl>
            <footer>
              <span>{{ formatDate(item.statusChangedAt) }}</span>
              <div v-if="canAdjustBalance" class="v2-record-actions">
                <AppButton size="small" variant="ghost" @click="openMetadataDrawer(item)">
                  修改
                </AppButton>
                <AppButton
                  v-if="item.status === 'credited'"
                  size="small"
                  variant="soft"
                  @click="openReversalConfirmation(item, 'redeemed')"
                >
                  被赎回
                </AppButton>
                <AppButton
                  v-if="item.status === 'credited'"
                  size="small"
                  variant="danger"
                  @click="openReversalConfirmation(item, 'withdrawn')"
                >
                  撤回
                </AppButton>
              </div>
            </footer>
          </article>
          <div v-if="!giftCards.length" class="v2-records-empty">
            <strong>暂无加卡记录</strong>
            <span>当前筛选条件下没有入账记录</span>
          </div>
        </div>

        <footer class="v2-records-pagination">
          <span>共 {{ giftCardTotal }} 条</span>
          <el-pagination
            v-model:current-page="giftCardPage"
            v-model:page-size="giftCardPageSize"
            v-pagination-label
            background
            :page-sizes="[10, 20, 50, 100]"
            layout="sizes, prev, pager, next"
            :total="giftCardTotal"
            @current-change="loadGiftCards"
            @size-change="handleGiftCardPageSizeChange"
          />
        </footer>
      </template>

      <template v-else>
        <el-table
          :aria-busy="ledgerLoading"
          scrollbar-always-on
          show-overflow-tooltip
          class="v2-records-table v2-topup-ledger-table"
          :data="ledgerEntries"
          row-key="id"
          @sort-change="handleLedgerSortChange"
        >
          <template #empty>
            <div class="v2-records-empty">
              <strong>暂无余额变动</strong>
              <span>当前筛选条件下没有账务流水</span>
              <AppButton variant="ghost" @click="resetFilters">重置筛选</AppButton>
            </div>
          </template>

          <el-table-column label="序号" width="72" fixed="left">
            <template #default="{ $index }">{{ ledgerRowNumber($index) }}</template>
          </el-table-column>
          <el-table-column label="变动类型" min-width="125" fixed="left">
            <template #default="{ row }">
              <el-tag :type="ledgerTypeTag(row.entryType)" effect="plain">
                {{ ledgerTypeLabel(row.entryType) }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column label="礼品卡" min-width="165">
            <template #default="{ row }">{{ row.giftCard?.codeMasked || '-' }}</template>
          </el-table-column>
          <el-table-column label="ID 账号" min-width="185">
            <template #default="{ row }">{{ row.account.appleIdMasked }}</template>
          </el-table-column>
          <el-table-column label="国家" min-width="105">
            <template #default="{ row }">{{ row.account.country.name }}</template>
          </el-table-column>
          <el-table-column prop="balanceAmount" label="余额变动" min-width="115" sortable="custom">
            <template #default="{ row }">
              <strong :class="`v2-ledger-amount--${deltaType(row.balanceDelta)}`">
                {{ formatSignedDecimal(row.balanceDelta) }}
              </strong>
            </template>
          </el-table-column>
          <el-table-column label="变动前余额" min-width="120">
            <template #default="{ row }">{{ formatDecimal(row.balanceBefore) }}</template>
          </el-table-column>
          <el-table-column label="变动后余额" min-width="120">
            <template #default="{ row }">{{ formatDecimal(row.balanceAfter) }}</template>
          </el-table-column>
          <el-table-column prop="costAmount" label="成本变动" min-width="125" sortable="custom">
            <template #default="{ row }">
              <strong :class="`v2-ledger-amount--${deltaType(row.costDelta)}`">
                {{ formatSignedCurrency(row.costDelta) }}
              </strong>
            </template>
          </el-table-column>
          <el-table-column label="变动前成本" min-width="125">
            <template #default="{ row }">¥{{ formatDecimal(row.costBefore) }}</template>
          </el-table-column>
          <el-table-column label="变动后成本" min-width="125">
            <template #default="{ row }">¥{{ formatDecimal(row.costAfter) }}</template>
          </el-table-column>
          <el-table-column label="平均成本" min-width="135">
            <template #default="{ row }"> ¥{{ formatDecimal(row.averageCostAfter, 8) }} </template>
          </el-table-column>
          <el-table-column label="关联" min-width="105">
            <template #default="{ row }">
              <el-tag v-if="row.reversalOf" type="warning" effect="plain">反向流水</el-tag>
              <el-tag v-else-if="row.reversedBy" type="info" effect="plain">已反冲</el-tag>
              <span v-else>-</span>
            </template>
          </el-table-column>
          <el-table-column label="操作人" min-width="115">
            <template #default="{ row }">
              {{ row.operator?.displayName || row.operator?.username || '系统' }}
            </template>
          </el-table-column>
          <el-table-column prop="createdAt" label="变动时间" min-width="165" sortable="custom">
            <template #default="{ row }">{{ formatDate(row.createdAt) }}</template>
          </el-table-column>
        </el-table>

        <div class="v2-records-mobile-list">
          <article v-for="item in ledgerEntries" :key="item.id" class="v2-records-mobile-item">
            <header>
              <div>
                <strong>{{ ledgerTypeLabel(item.entryType) }}</strong>
                <span>{{ item.account.appleIdMasked }} / {{ item.account.country.name }}</span>
              </div>
              <strong :class="`v2-ledger-amount--${deltaType(item.balanceDelta)}`">
                {{ formatSignedDecimal(item.balanceDelta) }}
              </strong>
            </header>
            <dl>
              <div>
                <dt>礼品卡</dt>
                <dd>{{ item.giftCard?.codeMasked || '-' }}</dd>
              </div>
              <div>
                <dt>余额快照</dt>
                <dd>
                  {{ formatDecimal(item.balanceBefore) }} → {{ formatDecimal(item.balanceAfter) }}
                </dd>
              </div>
              <div>
                <dt>成本变动</dt>
                <dd>{{ formatSignedCurrency(item.costDelta) }}</dd>
              </div>
              <div>
                <dt>平均成本</dt>
                <dd>¥{{ formatDecimal(item.averageCostAfter, 8) }}</dd>
              </div>
            </dl>
            <footer>
              <span>{{ formatDate(item.createdAt) }}</span>
              <el-tag v-if="item.reversalOf" type="warning" effect="plain">反向流水</el-tag>
              <el-tag v-else-if="item.reversedBy" type="info" effect="plain">已反冲</el-tag>
            </footer>
          </article>
          <div v-if="!ledgerEntries.length" class="v2-records-empty">
            <strong>暂无余额变动</strong>
            <span>当前筛选条件下没有账务流水</span>
          </div>
        </div>

        <footer class="v2-records-pagination">
          <span>共 {{ ledgerTotal }} 条</span>
          <el-pagination
            v-model:current-page="ledgerPage"
            v-model:page-size="ledgerPageSize"
            v-pagination-label
            background
            :page-sizes="[10, 20, 50, 100]"
            layout="sizes, prev, pager, next"
            :total="ledgerTotal"
            @current-change="loadBalanceLedger"
            @size-change="handleLedgerPageSizeChange"
          />
        </footer>
      </template>
    </section>
  </V2AsyncRegion>
</template>

<script setup lang="ts">
import { Back, CircleClose, Edit } from '@element-plus/icons-vue';
import AppButton from '@/components/ui/AppButton.vue';
import V2AsyncRegion from '@/v2/components/V2AsyncRegion.vue';
import type {
  V2BalanceLedgerEntryType,
  V2BalanceLedgerRecord,
  V2GiftCardRecord,
  V2GiftCardRecordStatus,
  V2GiftCardReversalAction
} from '../contracts';

interface SortChange {
  prop?: string;
  order?: 'ascending' | 'descending' | null;
}

defineProps<{
  activeTab: 'giftCards' | 'ledger';
  activeLoading: boolean;
  isInitialLoading: boolean;
  activeResolved: boolean;
  activeError: string;
  giftCardLoading: boolean;
  giftCards: V2GiftCardRecord[];
  giftCardTotal: number;
  ledgerLoading: boolean;
  ledgerEntries: V2BalanceLedgerRecord[];
  ledgerTotal: number;
  canAdjustBalance: boolean;
}>();

const emit = defineEmits<{
  retry: [];
  reset: [];
  giftCardSortChange: [value: SortChange];
  ledgerSortChange: [value: SortChange];
  giftCardPageChange: [];
  giftCardPageSizeChange: [];
  ledgerPageChange: [];
  ledgerPageSizeChange: [];
  editMetadata: [giftCard: V2GiftCardRecord];
  reverse: [giftCard: V2GiftCardRecord, action: V2GiftCardReversalAction];
}>();

const giftCardPage = defineModel<number>('giftCardPage', { required: true });
const giftCardPageSize = defineModel<number>('giftCardPageSize', { required: true });
const ledgerPage = defineModel<number>('ledgerPage', { required: true });
const ledgerPageSize = defineModel<number>('ledgerPageSize', { required: true });

function loadActiveTab() {
  emit('retry');
}

function resetFilters() {
  emit('reset');
}

function handleGiftCardSortChange(value: SortChange) {
  emit('giftCardSortChange', value);
}

function handleLedgerSortChange(value: SortChange) {
  emit('ledgerSortChange', value);
}

function loadGiftCards() {
  emit('giftCardPageChange');
}

function handleGiftCardPageSizeChange() {
  emit('giftCardPageSizeChange');
}

function loadBalanceLedger() {
  emit('ledgerPageChange');
}

function handleLedgerPageSizeChange() {
  emit('ledgerPageSizeChange');
}

function openMetadataDrawer(giftCard: V2GiftCardRecord) {
  emit('editMetadata', giftCard);
}

function openReversalConfirmation(giftCard: V2GiftCardRecord, action: V2GiftCardReversalAction) {
  emit('reverse', giftCard, action);
}

function giftCardRowNumber(index: number) {
  return (giftCardPage.value - 1) * giftCardPageSize.value + index + 1;
}

function ledgerRowNumber(index: number) {
  return (ledgerPage.value - 1) * ledgerPageSize.value + index + 1;
}

function giftCardStatusLabel(status: V2GiftCardRecordStatus) {
  return {
    credited: '加卡成功',
    redeemed: '被赎回',
    withdrawn: '已撤回'
  }[status];
}

function giftCardStatusType(status: V2GiftCardRecordStatus) {
  return status === 'credited' ? 'success' : status === 'redeemed' ? 'warning' : 'info';
}

function ledgerTypeLabel(entryType: V2BalanceLedgerEntryType) {
  return {
    gift_card_credit: '礼品卡入账',
    gift_card_redeemed: '被赎回扣减',
    gift_card_withdrawal: '撤回扣减',
    order_consumption: '订单扣减',
    order_consumption_reversal: '订单退款恢复',
    opening_balance: '期初余额',
    manual_adjustment: '手工修正'
  }[entryType];
}

function ledgerTypeTag(entryType: V2BalanceLedgerEntryType) {
  return entryType === 'gift_card_credit' || entryType === 'opening_balance'
    ? 'success'
    : entryType === 'gift_card_redeemed' || entryType === 'order_consumption'
      ? 'warning'
      : 'info';
}

function deltaType(value: string) {
  return Number(value) < 0 ? 'debit' : 'credit';
}

function formatSignedDecimal(value: string) {
  const number = Number(value);
  if (!Number.isFinite(number)) return value;
  const formatted = formatDecimal(String(Math.abs(number)));
  return number > 0 ? `+${formatted}` : number < 0 ? `-${formatted}` : formatted;
}

function formatSignedCurrency(value: string) {
  const number = Number(value);
  if (!Number.isFinite(number)) return `¥${value}`;
  const formatted = `¥${formatDecimal(String(Math.abs(number)))}`;
  return number > 0 ? `+${formatted}` : number < 0 ? `-${formatted}` : formatted;
}

function formatOptionalDecimal(value?: string) {
  return value === undefined ? '-' : formatDecimal(value);
}

function formatDecimal(value: string, maximumFractionDigits = 4) {
  const number = Number(value);
  return Number.isFinite(number)
    ? number.toLocaleString('zh-CN', { maximumFractionDigits })
    : value;
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).format(new Date(value));
}
</script>
