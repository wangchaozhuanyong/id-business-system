<template>
  <V2FormDrawer
    v-model="page.inflowDrawerVisible"
    :title="page.editingInflow ? '更正收入记录' : '收入记账'"
    eyebrow="资金流入"
    description="区分经营收入、股东投入和借入资金，并保留账户、汇率与更正审计链路"
    :confirm-text="page.editingInflow ? '冲销并重记' : '确认入账'"
    :confirm-loading="page.inflowSubmitting"
    :dirty="page.inflowDirty"
    @confirm="page.submitInflow"
  >
    <el-alert
      v-if="page.editingInflow"
      title="系统不会修改原始流水；确认后会冲销原流水，并按下方正确内容重新记账。"
      type="warning"
      :closable="false"
      show-icon
    />
    <el-alert
      v-if="page.inflowForm.nature === 'operating_income'"
      title="这里只记录订单之外的经营收入；填写收款流水号时，系统会校验其是否与订单收款冲突。"
      type="info"
      :closable="false"
      show-icon
    />
    <el-form
      class="v2-horizontal-form"
      label-position="left"
      label-width="126px"
      require-asterisk-position="right"
    >
      <V2PanelSection heading-id="finance-inflow-identity" title="收入与收款" step="01">
        <el-form-item label="资金性质" required>
          <el-select v-model="page.inflowForm.nature">
            <el-option label="经营收入" value="operating_income" />
            <el-option label="股东投入" value="capital_contribution" />
            <el-option label="借入资金" value="borrowed_funds" />
          </el-select>
        </el-form-item>
        <el-form-item
          v-if="page.inflowForm.nature === 'operating_income'"
          label="收入分类"
          required
        >
          <el-select v-model="page.inflowForm.categoryOptionId">
            <el-option
              v-for="item in page.incomeCategories"
              :key="item.id"
              :label="item.name"
              :value="item.id"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="收款账户" required>
          <el-select v-model="page.inflowForm.financeAccountId">
            <el-option
              v-for="item in page.accounts.filter((account) => account.status === 'active')"
              :key="item.id"
              :label="`${item.name} · ${item.currency} · ${formatOriginal(item.currentBalance, item.currency)}`"
              :value="item.id"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="入账金额" required>
          <el-input v-model="page.inflowForm.amount" inputmode="decimal">
            <template #prepend>{{ page.selectedInflowAccount?.currency || '币种' }}</template>
          </el-input>
        </el-form-item>
        <el-form-item label="发生时间" required>
          <el-input v-model="page.inflowForm.occurredAt" type="datetime-local" />
        </el-form-item>
      </V2PanelSection>
      <V2PanelSection
        v-if="page.selectedInflowAccount && page.selectedInflowAccount.currency !== 'CNY'"
        heading-id="finance-inflow-rate"
        title="汇率证据"
        step="02"
      >
        <el-form-item label="人工汇率">
          <el-input
            v-model="page.inflowForm.fxRateToCny"
            inputmode="decimal"
            placeholder="留空则锁定有效采集汇率"
          />
        </el-form-item>
        <el-form-item label="人工汇率原因">
          <el-input
            v-model="page.inflowForm.manualRateReason"
            type="textarea"
            :rows="3"
            maxlength="500"
          />
        </el-form-item>
      </V2PanelSection>
      <V2PanelSection
        heading-id="finance-inflow-evidence"
        title="业务与更正依据"
        :step="page.selectedInflowAccount?.currency === 'CNY' ? '02' : '03'"
      >
        <el-form-item :label="payerLabel" :required="page.inflowForm.nature !== 'operating_income'">
          <el-input v-model="page.inflowForm.payer" maxlength="200" />
        </el-form-item>
        <el-form-item label="收款流水号">
          <el-input
            v-model="page.inflowForm.externalReference"
            maxlength="200"
            placeholder="选填，填写银行、钱包或结算平台流水号"
          />
        </el-form-item>
        <el-form-item label="收款凭证">
          <div class="v2-finance-receipt-field">
            <input
              :key="page.inflowReceiptInputKey"
              class="v2-finance-receipt-field__input"
              type="file"
              accept="application/pdf,image/jpeg,image/png,image/webp"
              aria-describedby="finance-inflow-receipt-help"
              @change="page.selectInflowReceipt"
            />
            <div v-if="page.inflowReceiptFile" class="v2-finance-receipt-field__selection">
              <span>
                待上传：{{ page.inflowReceiptFile.name }} ·
                {{ formatReceiptSize(page.inflowReceiptFile.size) }}
              </span>
              <AppButton size="small" variant="ghost" @click="page.clearSelectedInflowReceipt">
                移除文件
              </AppButton>
            </div>
            <div
              v-else-if="page.editingInflow?.receiptAttachment"
              class="v2-finance-receipt-field__selection"
            >
              <span>
                当前凭证：{{ page.editingInflow.receiptAttachment.originalName }} ·
                {{ formatReceiptSize(Number(page.editingInflow.receiptAttachment.sizeBytes)) }}
              </span>
              <AppButton
                size="small"
                variant="ghost"
                :loading="page.receiptDownloadingId === page.editingInflow.id"
                @click="page.viewInflowReceipt(page.editingInflow)"
              >
                查看凭证
              </AppButton>
            </div>
            <p id="finance-inflow-receipt-help" class="v2-finance-receipt-field__help">
              选填；支持 PDF、JPG、PNG、WebP，最大 5 MB，文件随账务流水加密保存。
            </p>
          </div>
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="page.inflowForm.remark" type="textarea" :rows="3" maxlength="2000" />
        </el-form-item>
        <el-form-item v-if="page.editingInflow" label="更正原因" required>
          <el-input
            v-model="page.inflowCorrectionReason"
            type="textarea"
            :rows="3"
            maxlength="500"
          />
        </el-form-item>
      </V2PanelSection>
    </el-form>
  </V2FormDrawer>
</template>

<script setup lang="ts">
import { computed, type UnwrapNestedRefs } from 'vue';
import AppButton from '@/components/ui/AppButton.vue';
import V2FormDrawer from '@/v2/components/V2FormDrawer.vue';
import V2PanelSection from '@/v2/components/V2PanelSection.vue';
import { formatOriginal } from '../financeLedgerPresentation';
import type { useFinanceLedgerPage } from '../useFinanceLedgerPage';

const { page } = defineProps<{
  page: UnwrapNestedRefs<ReturnType<typeof useFinanceLedgerPage>>;
}>();

const payerLabel = computed(() =>
  page.inflowForm.nature === 'capital_contribution'
    ? '出资人'
    : page.inflowForm.nature === 'borrowed_funds'
      ? '出借人'
      : '付款方'
);

function formatReceiptSize(size: number) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}
</script>
