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

          <V2TableColumn kind="index" width-preset="index" label="序号" fixed="left">
            <template #default="{ $index }">{{ giftCardRowNumber($index) }}</template>
          </V2TableColumn>
          <V2TableColumn kind="identifier" width-preset="identifier" label="礼品卡号" fixed="left">
            <template #default="{ row }">
              <strong class="v2-topup-records-code">{{ row.code }}</strong>
            </template>
          </V2TableColumn>
          <V2TableColumn kind="text" width-preset="standard" label="卡片名称">
            <template #default="{ row }">{{ row.cardName.name }}</template>
          </V2TableColumn>
          <V2TableColumn
            kind="numeric"
            width-preset="compact"
            prop="faceValue"
            label="面值"
            sortable="custom"
          >
            <template #default="{ row }">
              {{ formatDecimal(row.faceValue) }} {{ row.country.currencyCode || '' }}
            </template>
          </V2TableColumn>
          <V2TableColumn
            kind="numeric"
            width-preset="compact"
            prop="exchangeRate"
            label="卡片汇率"
            sortable="custom"
          >
            <template #default="{ row }">¥{{ formatDecimal(row.exchangeRate) }}</template>
          </V2TableColumn>
          <V2TableColumn
            kind="numeric"
            width-preset="standard"
            prop="costAmount"
            label="卡片价值（人民币）"
            sortable="custom"
          >
            <template #default="{ row }">¥{{ formatDecimal(row.costAmount) }}</template>
          </V2TableColumn>
          <V2TableColumn kind="identifier" width-preset="identifier" label="加入 ID">
            <template #default="{ row }">
              {{ row.account.appleIdMasked }}
              <el-tag
                v-if="row.account.lossStatus === 'reported'"
                type="danger"
                effect="plain"
                size="small"
              >
                已报损
              </el-tag>
            </template>
          </V2TableColumn>
          <V2TableColumn kind="text" label="国家" width-preset="compact">
            <template #default="{ row }">{{ row.country.name }}</template>
          </V2TableColumn>
          <V2TableColumn kind="text" label="供应商" width-preset="standard">
            <template #default="{ row }">{{ row.supplier?.name || '—' }}</template>
          </V2TableColumn>
          <V2TableColumn kind="numeric" width-preset="standard" label="ID 加卡前余额">
            <template #default="{ row }">
              {{ formatOptionalDecimal(row.creditedLedger?.balanceBefore) }}
            </template>
          </V2TableColumn>
          <V2TableColumn kind="numeric" width-preset="standard" label="ID 加卡后余额">
            <template #default="{ row }">
              {{ formatOptionalDecimal(row.creditedLedger?.balanceAfter) }}
            </template>
          </V2TableColumn>
          <V2TableColumn kind="numeric" label="供应商扣款前余额" width-preset="wide">
            <template #default="{ row }">
              {{
                row.supplierFunding
                  ? `¥${formatDecimal(row.supplierFunding.balanceBeforeCny)}`
                  : '—（切账前）'
              }}
            </template>
          </V2TableColumn>
          <V2TableColumn kind="numeric" label="供应商扣款后余额" width-preset="wide">
            <template #default="{ row }">
              {{
                row.supplierFunding
                  ? `¥${formatDecimal(row.supplierFunding.balanceAfterCny)}`
                  : '—（切账前）'
              }}
            </template>
          </V2TableColumn>
          <V2TableColumn kind="text" label="操作人" width-preset="standard">
            <template #default="{ row }">
              {{ row.createdBy?.displayName || row.createdBy?.username || '系统' }}
            </template>
          </V2TableColumn>
          <V2TableColumn
            kind="text"
            width-preset="wide"
            prop="remark"
            label="备注"
            show-overflow-tooltip
          >
            <template #default="{ row }">{{ row.remark || '—' }}</template>
          </V2TableColumn>
          <V2TableColumn
            kind="date"
            width-preset="dateTime"
            prop="creditedAt"
            label="加卡时间"
            sortable="custom"
          >
            <template #default="{ row }">{{ formatDate(row.creditedAt) }}</template>
          </V2TableColumn>
          <V2TableColumn
            kind="status"
            width-preset="compact"
            prop="status"
            label="状态"
            sortable="custom"
          >
            <template #default="{ row }">
              <el-tag :type="giftCardStatusType(row.status)" effect="plain">
                {{ giftCardStatusLabel(row.status) }}
              </el-tag>
            </template>
          </V2TableColumn>
          <V2TableActionColumn layout="triple">
            <template #default="{ row }">
              <template
                v-if="
                  row.account.lossStatus === 'active' && (canAdjustBalance || canReassignSupplier)
                "
              >
                <AppButton
                  v-if="canAdjustBalance"
                  size="small"
                  variant="ghost"
                  @click="openMetadataDrawer(row)"
                >
                  <el-icon><Edit /></el-icon>
                  备注
                </AppButton>
                <AppButton
                  v-if="canReassignSupplier"
                  size="small"
                  variant="soft"
                  @click="openSupplierReassignment(row)"
                >
                  更正供应商
                </AppButton>
                <el-dropdown
                  v-if="canAdjustBalance && row.status === 'credited'"
                  trigger="click"
                  @command="handleFinancialCommand(row, $event)"
                >
                  <AppButton size="small" variant="ghost">更多操作</AppButton>
                  <template #dropdown>
                    <el-dropdown-menu>
                      <el-dropdown-item command="redeemed">
                        <el-icon><CircleClose /></el-icon>
                        标记被赎回
                      </el-dropdown-item>
                      <el-dropdown-item command="withdrawn" divided>
                        <el-icon><Back /></el-icon>
                        撤回并返还供应商
                      </el-dropdown-item>
                    </el-dropdown-menu>
                  </template>
                </el-dropdown>
              </template>
              <span v-else>—</span>
            </template>
          </V2TableActionColumn>
        </el-table>

        <div class="v2-records-mobile-list">
          <article v-for="item in giftCards" :key="item.id" class="v2-records-mobile-item">
            <header>
              <div>
                <strong>{{ item.cardName.name }} · {{ item.code }}</strong>
                <span>{{ item.account.appleIdMasked }} / {{ item.country.name }}</span>
              </div>
              <el-tag :type="giftCardStatusType(item.status)" effect="plain">
                {{ giftCardStatusLabel(item.status) }}
              </el-tag>
            </header>
            <dl>
              <div>
                <dt>面值</dt>
                <dd>{{ formatDecimal(item.faceValue) }} {{ item.country.currencyCode || '' }}</dd>
              </div>
              <div>
                <dt>汇率</dt>
                <dd>¥{{ formatDecimal(item.exchangeRate) }}</dd>
              </div>
              <div>
                <dt>卡片价值（人民币）</dt>
                <dd>¥{{ formatDecimal(item.costAmount) }}</dd>
              </div>
              <div>
                <dt>备注</dt>
                <dd>{{ item.remark || '—' }}</dd>
              </div>
              <div>
                <dt>供应商</dt>
                <dd>{{ item.supplier?.name || '—' }}</dd>
              </div>
              <div>
                <dt>余额变化</dt>
                <dd>
                  {{ formatOptionalDecimal(item.creditedLedger?.balanceBefore) }} →
                  {{ formatOptionalDecimal(item.creditedLedger?.balanceAfter) }}
                </dd>
              </div>
              <div>
                <dt>供应商余额</dt>
                <dd>
                  {{
                    item.supplierFunding
                      ? `¥${formatDecimal(item.supplierFunding.balanceBeforeCny)} → ¥${formatDecimal(
                          item.supplierFunding.balanceAfterCny
                        )}`
                      : '—（切账前）'
                  }}
                </dd>
              </div>
            </dl>
            <footer>
              <span>{{ formatDate(item.creditedAt) }}</span>
              <div
                v-if="
                  item.account.lossStatus === 'active' && (canAdjustBalance || canReassignSupplier)
                "
                class="v2-record-actions"
              >
                <AppButton
                  v-if="canAdjustBalance"
                  size="small"
                  variant="ghost"
                  @click="openMetadataDrawer(item)"
                >
                  备注
                </AppButton>
                <AppButton
                  v-if="canReassignSupplier"
                  size="small"
                  variant="soft"
                  @click="openSupplierReassignment(item)"
                >
                  更正供应商
                </AppButton>
                <AppButton
                  v-if="canAdjustBalance && item.status === 'credited'"
                  size="small"
                  variant="soft"
                  @click="openReversalConfirmation(item, 'redeemed')"
                >
                  被赎回
                </AppButton>
                <AppButton
                  v-if="canAdjustBalance && item.status === 'credited'"
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

          <V2TableColumn kind="index" width-preset="index" label="序号" fixed="left">
            <template #default="{ $index }">{{ ledgerRowNumber($index) }}</template>
          </V2TableColumn>
          <V2TableColumn
            kind="text"
            label="变动类型"
            width-preset="standard"
            width-mode="fixed"
            fixed="left"
          >
            <template #default="{ row }">
              <el-tag :type="ledgerTypeTag(row.entryType)" effect="plain">
                {{ ledgerTypeLabel(row.entryType) }}
              </el-tag>
            </template>
          </V2TableColumn>
          <V2TableColumn kind="identifier" width-preset="identifier" label="礼品卡">
            <template #default="{ row }">{{ row.giftCard?.code || '—' }}</template>
          </V2TableColumn>
          <V2TableColumn kind="identifier" width-preset="identifier" label="ID 账号">
            <template #default="{ row }">{{ row.account.appleIdMasked }}</template>
          </V2TableColumn>
          <V2TableColumn kind="text" label="国家" width-preset="compact">
            <template #default="{ row }">{{ row.account.country.name }}</template>
          </V2TableColumn>
          <V2TableColumn
            kind="numeric"
            width-preset="standard"
            prop="balanceAmount"
            label="余额变动"
            sortable="custom"
          >
            <template #default="{ row }">
              <strong :class="`v2-ledger-amount--${deltaType(row.balanceDelta)}`">
                {{ formatSignedDecimal(row.balanceDelta) }}
              </strong>
            </template>
          </V2TableColumn>
          <V2TableColumn kind="numeric" width-preset="standard" label="变动前余额">
            <template #default="{ row }">{{ formatDecimal(row.balanceBefore) }}</template>
          </V2TableColumn>
          <V2TableColumn kind="numeric" width-preset="standard" label="变动后余额">
            <template #default="{ row }">{{ formatDecimal(row.balanceAfter) }}</template>
          </V2TableColumn>
          <V2TableColumn
            kind="numeric"
            width-preset="standard"
            prop="costAmount"
            label="成本变动"
            sortable="custom"
          >
            <template #default="{ row }">
              <strong :class="`v2-ledger-amount--${deltaType(row.costDelta)}`">
                {{ formatSignedCurrency(row.costDelta) }}
              </strong>
            </template>
          </V2TableColumn>
          <V2TableColumn kind="numeric" width-preset="standard" label="变动前成本">
            <template #default="{ row }">¥{{ formatDecimal(row.costBefore) }}</template>
          </V2TableColumn>
          <V2TableColumn kind="numeric" width-preset="standard" label="变动后成本">
            <template #default="{ row }">¥{{ formatDecimal(row.costAfter) }}</template>
          </V2TableColumn>
          <V2TableColumn kind="numeric" width-preset="standard" label="平均成本">
            <template #default="{ row }"> ¥{{ formatDecimal(row.averageCostAfter) }} </template>
          </V2TableColumn>
          <V2TableColumn kind="text" label="关联" width-preset="compact">
            <template #default="{ row }">
              <el-tag v-if="row.reversalOf" type="warning" effect="plain">反向流水</el-tag>
              <el-tag v-else-if="row.reversedBy" type="info" effect="plain">已反冲</el-tag>
              <span v-else>—</span>
            </template>
          </V2TableColumn>
          <V2TableColumn kind="text" label="操作人" width-preset="standard">
            <template #default="{ row }">
              {{ row.operator?.displayName || row.operator?.username || '系统' }}
            </template>
          </V2TableColumn>
          <V2TableColumn
            kind="date"
            width-preset="dateTime"
            prop="createdAt"
            label="变动时间"
            sortable="custom"
          >
            <template #default="{ row }">{{ formatDate(row.createdAt) }}</template>
          </V2TableColumn>
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
                <dd>{{ item.giftCard?.code || '—' }}</dd>
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
                <dd>¥{{ formatDecimal(item.averageCostAfter) }}</dd>
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
import V2TableColumn from '@/v2/components/V2TableColumn.vue';
import { Back, CircleClose, Edit } from '@element-plus/icons-vue';
import AppButton from '@/components/ui/AppButton.vue';
import V2AsyncRegion from '@/v2/components/V2AsyncRegion.vue';
import V2TableActionColumn from '@/v2/components/V2TableActionColumn.vue';
import {
  deltaType,
  formatDate,
  formatDecimal,
  formatOptionalDecimal,
  formatSignedCurrency,
  formatSignedDecimal,
  giftCardStatusLabel,
  giftCardStatusType,
  ledgerTypeLabel,
  ledgerTypeTag
} from '../topup-records-format';
import type {
  V2BalanceLedgerRecord,
  V2GiftCardRecord,
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
  canReassignSupplier: boolean;
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
  reassignSupplier: [giftCard: V2GiftCardRecord];
  reverse: [giftCard: V2GiftCardRecord, action: V2GiftCardReversalAction];
}>();

const giftCardPage = defineModel<number>('giftCardPage', { required: true });
const giftCardPageSize = defineModel<number>('giftCardPageSize', { required: true });
const ledgerPage = defineModel<number>('ledgerPage', { required: true });
const ledgerPageSize = defineModel<number>('ledgerPageSize', { required: true });
const loadActiveTab = () => emit('retry');
const resetFilters = () => emit('reset');
const handleGiftCardSortChange = (value: SortChange) => emit('giftCardSortChange', value);
const handleLedgerSortChange = (value: SortChange) => emit('ledgerSortChange', value);
const loadGiftCards = () => emit('giftCardPageChange');
const handleGiftCardPageSizeChange = () => emit('giftCardPageSizeChange');
const loadBalanceLedger = () => emit('ledgerPageChange');
const handleLedgerPageSizeChange = () => emit('ledgerPageSizeChange');
function openMetadataDrawer(giftCard: V2GiftCardRecord) {
  emit('editMetadata', giftCard);
}
function openSupplierReassignment(giftCard: V2GiftCardRecord) {
  emit('reassignSupplier', giftCard);
}
function openReversalConfirmation(giftCard: V2GiftCardRecord, action: V2GiftCardReversalAction) {
  emit('reverse', giftCard, action);
}
function handleFinancialCommand(giftCard: V2GiftCardRecord, command: unknown) {
  if (command === 'redeemed' || command === 'withdrawn') {
    openReversalConfirmation(giftCard, command);
  }
}
function giftCardRowNumber(index: number) {
  return (giftCardPage.value - 1) * giftCardPageSize.value + index + 1;
}
function ledgerRowNumber(index: number) {
  return (ledgerPage.value - 1) * ledgerPageSize.value + index + 1;
}
</script>
