<template>
  <V2FormDrawer
    v-model="page.creditDrawerVisible"
    title="礼品卡入账"
    size="min(560px, 94vw)"
    confirm-text="确认入账"
    :confirm-disabled-reason="page.creditDisabledReason"
    :confirm-loading="page.creditSubmitting"
    @confirm="openCreditConfirmation"
  >
    <div v-if="page.selectedAccount" class="v2-topup-credit-entry">
      <section class="v2-topup-credit-entry-target">
        <div>
          <span>目标 ID</span>
          <strong>{{ page.selectedAccount.appleIdMasked }}</strong>
        </div>
        <div>
          <span>当前余额</span>
          <strong>{{ page.formatDecimal(page.selectedAccount.currentBalance) }}</strong>
        </div>
        <el-tag effect="plain">{{ page.selectedAccount.country.name }}</el-tag>
      </section>

      <el-alert
        title="请核对卡号、面值、实际付款、资金来源和供应商；确认后将立即写入余额与成本流水"
        type="info"
        show-icon
        :closable="false"
      />

      <el-form
        ref="creditFormRef"
        class="v2-horizontal-form v2-topup-credit-entry-section v2-topup-credit-form"
        :model="page.creditForm"
        :rules="creditRules"
        label-position="left"
        label-width="108px"
        require-asterisk-position="right"
        status-icon
        scroll-to-error
        :scroll-into-view-options="{ block: 'center', behavior: 'smooth' }"
      >
        <el-form-item label="礼品卡号" prop="code" class="v2-topup-credit-entry-code">
          <el-input
            v-model="page.creditForm.code"
            maxlength="64"
            autocomplete="off"
            placeholder="手工输入礼品卡号"
            @blur="page.normalizeCandidateCode"
          />
        </el-form-item>

        <div class="v2-topup-credit-grid">
          <el-form-item label="礼品卡面值" prop="faceValue">
            <el-input
              v-model="page.creditForm.faceValue"
              inputmode="decimal"
              maxlength="19"
              placeholder="例如 100"
            />
          </el-form-item>
          <el-form-item label="付款币种" prop="purchaseCurrency">
            <el-select
              v-model="page.creditForm.purchaseCurrency"
              @change="page.handlePurchaseCurrencyChange"
            >
              <el-option label="人民币 CNY" value="CNY" />
              <el-option label="马币 MYR" value="MYR" />
              <el-option label="USDT" value="USDT" />
            </el-select>
          </el-form-item>
          <el-form-item label="实际付款" prop="purchaseOriginalAmount">
            <el-input
              v-model="page.creditForm.purchaseOriginalAmount"
              inputmode="decimal"
              maxlength="19"
              :placeholder="`实际支付的 ${page.creditForm.purchaseCurrency} 金额`"
            />
          </el-form-item>
          <el-form-item label="付款时间" prop="paidAt">
            <el-input v-model="page.creditForm.paidAt" type="datetime-local" />
          </el-form-item>
        </div>
        <V2AsyncRegion
          v-if="page.creditForm.purchaseCurrency === 'USDT'"
          class="v2-topup-exchange-source"
          variant="section"
          skeleton="inline"
          :loading="page.exchangeRateLoading"
          :resolved="page.exchangeRateResolved"
          loading-title="正在读取当前 USDT 汇率"
          refreshing-title="正在更新当前 USDT 汇率"
        >
          <section
            v-if="page.usdtRateReference"
            class="v2-topup-usdt-reference"
            aria-label="当前 USDT 参考汇率"
          >
            <header>
              <div>
                <strong>{{
                  page.usdtRateReference.stale ? '最近一次 USDT 汇率' : '当前 USDT 汇率'
                }}</strong>
                <span>
                  CNY / USDT · 更新于
                  {{ page.formatDate(page.usdtRateReference.averagedAt) }}
                </span>
              </div>
              <el-tag
                :type="page.usdtRateReference.stale ? 'warning' : 'success'"
                effect="plain"
                size="small"
              >
                {{ page.usdtRateReference.stale ? '已过期' : '仅供参考' }}
              </el-tag>
            </header>
            <dl>
              <div>
                <dt>买入</dt>
                <dd>¥{{ page.formatDecimal(page.usdtRateReference.merchantBuyRateToRmb) }}</dd>
              </div>
              <div>
                <dt>卖出</dt>
                <dd>¥{{ page.formatDecimal(page.usdtRateReference.merchantSellRateToRmb) }}</dd>
              </div>
              <div>
                <dt>中间价</dt>
                <dd>¥{{ page.formatDecimal(page.usdtRateReference.midRateToRmb) }}</dd>
              </div>
            </dl>
          </section>
          <el-alert
            v-else-if="page.exchangeRateMessage"
            type="warning"
            :title="page.exchangeRateMessage"
            show-icon
            :closable="false"
          />
        </V2AsyncRegion>

        <el-form-item label="加卡供应商" prop="supplierOptionId">
          <el-select
            v-model="page.creditForm.supplierOptionId"
            filterable
            placeholder="选择启用的加卡供应商"
            @change="page.handleSupplierChange"
          >
            <el-option
              v-for="option in page.topupSupplierOptions"
              :key="option.id"
              :label="option.name"
              :value="option.id"
            />
          </el-select>
        </el-form-item>
        <el-alert
          v-if="!page.topupSupplierOptions.length"
          title="暂无启用的加卡供应商，请先到选项设置完成配置"
          type="error"
          show-icon
          :closable="false"
        />

        <el-form-item label="付款来源" prop="purchaseSourceId">
          <el-select
            v-model="page.creditForm.purchaseSourceId"
            filterable
            placeholder="选择资金账户或该供应商预存钱包"
          >
            <el-option
              v-for="source in page.purchaseSourceOptions"
              :key="source.value"
              :label="source.label"
              :value="source.value"
            />
          </el-select>
        </el-form-item>

        <div v-if="page.creditForm.purchaseCurrency !== 'CNY'" class="v2-topup-credit-grid">
          <el-form-item label="手工汇率" prop="purchaseFxRateToCny">
            <el-input
              v-model="page.creditForm.purchaseFxRateToCny"
              inputmode="decimal"
              placeholder="留空则保存时自动采集"
            />
          </el-form-item>
          <el-form-item
            v-if="page.creditForm.purchaseFxRateToCny"
            label="汇率原因"
            prop="purchaseManualRateReason"
          >
            <el-input
              v-model="page.creditForm.purchaseManualRateReason"
              maxlength="200"
              placeholder="说明手工汇率来源"
            />
          </el-form-item>
        </div>

        <el-form-item label="备注">
          <el-input
            v-model="page.creditForm.remark"
            type="textarea"
            :rows="3"
            maxlength="2000"
            show-word-limit
            placeholder="选填，记录采购批次或人工核对说明"
          />
        </el-form-item>

        <div class="v2-topup-credit-preview">
          <span>本次人民币成本</span>
          <strong>
            {{
              page.creditCostPreview
                ? `¥${page.formatDecimal(page.creditCostPreview)}`
                : '保存时按交易汇率计算'
            }}
          </strong>
          <span>系统单位成本</span>
          <strong>
            {{
              page.creditUnitCostPreview
                ? page.formatDecimal(page.creditUnitCostPreview)
                : '保存后生成'
            }}
          </strong>
          <template v-if="page.selectedPurchaseSource?.kind === 'wallet'">
            <span>供应商钱包余额</span>
            <strong>
              {{ page.formatDecimal(page.selectedPurchaseSource.currentBalance) }}
              {{ page.creditForm.purchaseCurrency }}
            </strong>
            <span>扣款后钱包余额</span>
            <strong :class="{ 'is-negative': page.creditWillOverdraw }">
              {{ page.formatDecimal(page.creditProjectedSupplierBalance || '0') }}
              {{ page.creditForm.purchaseCurrency }}
            </strong>
          </template>
        </div>
        <el-alert
          v-if="page.creditWillOverdraw"
          type="error"
          show-icon
          :closable="false"
          title="供应商钱包余额不足，系统将拒绝入账，不允许静默透支"
        />
      </el-form>
    </div>
  </V2FormDrawer>

  <el-drawer
    v-model="page.reversalDrawerVisible"
    title="可处理礼品卡"
    size="min(620px, 94vw)"
    destroy-on-close
  >
    <div v-if="page.reversalAccount" class="v2-topup-reversal">
      <section class="v2-topup-credit-entry-target">
        <div>
          <span>目标 ID</span>
          <strong>{{ page.reversalAccount.appleIdMasked }}</strong>
        </div>
        <div>
          <span>当前余额</span>
          <strong>{{ page.formatDecimal(page.reversalAccount.currentBalance) }}</strong>
        </div>
        <el-tag effect="plain">{{ page.reversalAccount.country.name }}</el-tag>
      </section>

      <el-alert
        v-if="page.reversalLimited"
        title="当前只显示最近 100 笔可处理礼品卡"
        type="warning"
        show-icon
        :closable="false"
      />

      <V2AsyncRegion
        variant="section"
        skeleton="cards"
        :loading="page.reversalLoading"
        :resolved="page.reversalResolved"
        :empty="page.reversalResolved && !page.reversibleGiftCards.length"
        :error="page.reversalError"
        loading-title="正在加载可处理礼品卡"
        refreshing-title="正在更新可处理礼品卡"
        empty-title="暂无可处理礼品卡"
        empty-message="当前没有可执行被赎回或撤回的礼品卡。"
        error-title="可处理礼品卡加载失败"
        @retry="page.loadReversibleGiftCards"
      >
        <div class="v2-topup-reversal-list">
          <article
            v-for="giftCard in page.reversibleGiftCards"
            :key="giftCard.id"
            class="v2-topup-reversal-item"
          >
            <header>
              <div>
                <strong>{{ giftCard.codeMasked }}</strong>
                <span>{{ giftCard.supplier?.name ?? '未记录供应商' }}</span>
              </div>
              <el-tag type="success" effect="plain">已入账</el-tag>
            </header>

            <dl>
              <div>
                <dt>礼品卡面值</dt>
                <dd>{{ page.formatDecimal(giftCard.faceValue) }}</dd>
              </div>
              <div>
                <dt>原入账成本</dt>
                <dd>¥{{ page.formatDecimal(giftCard.costAmount) }}</dd>
              </div>
              <div>
                <dt>卡片汇率</dt>
                <dd>{{ page.formatDecimal(giftCard.exchangeRate) }}</dd>
              </div>
              <div>
                <dt>入账时间</dt>
                <dd>
                  {{ page.formatDate(giftCard.creditedLedger?.createdAt ?? giftCard.createdAt) }}
                </dd>
              </div>
            </dl>

            <div v-if="page.canAdjustBalance" class="v2-topup-reversal-actions">
              <AppButton
                size="small"
                variant="danger"
                :disabled="page.reversalSubmitting"
                @click="page.openReversalConfirmation(giftCard, 'redeemed')"
              >
                <el-icon><WarningFilled /></el-icon>
                标记被赎回
              </AppButton>
              <AppButton
                size="small"
                variant="ghost"
                :disabled="page.reversalSubmitting"
                @click="page.openReversalConfirmation(giftCard, 'withdrawn')"
              >
                <el-icon><RefreshLeft /></el-icon>
                撤回
              </AppButton>
            </div>
            <el-tag v-else type="info" effect="plain">仅查看，无余额修正权限</el-tag>
          </article>
        </div>
      </V2AsyncRegion>
    </div>
  </el-drawer>

  <V2ConfirmDialog
    v-model="page.creditConfirmationVisible"
    title="确认礼品卡入账"
    :message="page.creditConfirmationMessage"
    confirm-text="确认并入账"
    :confirm-loading="page.creditSubmitting"
    @confirm="page.submitGiftCardCredit"
  />

  <V2ConfirmDialog
    v-model="page.reversalConfirmationVisible"
    :title="page.reversalDialogTitle"
    :message="page.reversalConfirmationMessage"
    :confirm-text="page.reversalConfirmText"
    :confirm-loading="page.reversalSubmitting"
    danger
    @confirm="submitGiftCardReversal"
  >
    <div class="v2-topup-reversal-confirm">
      <p class="v2-confirm-dialog__message">{{ page.reversalConfirmationMessage }}</p>
      <el-form
        ref="reversalFormRef"
        class="v2-horizontal-form"
        :model="page.reversalForm"
        :rules="reversalRules"
        label-position="left"
        label-width="88px"
        require-asterisk-position="right"
        scroll-to-error
      >
        <el-form-item label="处理原因" prop="reason">
          <el-input
            v-model="page.reversalForm.reason"
            type="textarea"
            :rows="3"
            minlength="2"
            maxlength="500"
            show-word-limit
            placeholder="必填，记录供应商反馈或撤回依据"
          />
        </el-form-item>
      </el-form>
    </div>
  </V2ConfirmDialog>
</template>

<script setup lang="ts">
import { RefreshLeft, WarningFilled } from '@element-plus/icons-vue';
import { ref } from 'vue';
import type { FormInstance, FormRules } from 'element-plus';
import AppButton from '@/components/ui/AppButton.vue';
import V2AsyncRegion from '@/v2/components/V2AsyncRegion.vue';
import V2ConfirmDialog from '@/v2/components/V2ConfirmDialog.vue';
import V2FormDrawer from '@/v2/components/V2FormDrawer.vue';
import { V2_DECIMAL_PLACES, isV2UnsignedDecimal } from '@/v2/utils/decimal';
import { validateV2Form } from '@/v2/utils/formValidation';
import { getGiftCardCodeError } from '../gift-card-credit-form';
import type { UnwrapNestedRefs } from 'vue';
import type { useTopupWorkbenchPage } from '../useTopupWorkbenchPage';

type TopupWorkbenchPage = UnwrapNestedRefs<ReturnType<typeof useTopupWorkbenchPage>>;

const props = defineProps<{
  page: TopupWorkbenchPage;
}>();

const creditFormRef = ref<FormInstance>();
const reversalFormRef = ref<FormInstance>();

const creditRules: FormRules = {
  code: [
    {
      required: true,
      validator: (_rule, value, callback) => {
        const message = getGiftCardCodeError(String(value ?? ''));
        callback(message ? new Error(message) : undefined);
      },
      trigger: 'blur'
    }
  ],
  faceValue: [positiveDecimalRule('礼品卡面值')],
  purchaseCurrency: [{ required: true, message: '请选择付款币种', trigger: 'change' }],
  purchaseOriginalAmount: [positiveDecimalRule('实际付款金额')],
  purchaseSourceId: [{ required: true, message: '请选择付款来源', trigger: 'change' }],
  paidAt: [{ required: true, message: '请选择付款时间', trigger: 'change' }],
  purchaseFxRateToCny: [
    {
      validator: (_rule, value, callback) => {
        const normalized = String(value ?? '').trim();
        callback(
          !normalized || isV2UnsignedDecimal(normalized, { allowZero: false, decimalPlaces: 8 })
            ? undefined
            : new Error('汇率必须是最多 8 位小数的正数')
        );
      },
      trigger: 'blur'
    }
  ],
  purchaseManualRateReason: [
    {
      validator: (_rule, value, callback) =>
        callback(
          props.page.creditForm.purchaseFxRateToCny && !String(value ?? '').trim()
            ? new Error('手工填写汇率时必须说明来源')
            : undefined
        ),
      trigger: 'blur'
    }
  ],
  supplierOptionId: [{ required: true, message: '请选择加卡供应商', trigger: 'change' }]
};

const reversalRules: FormRules = {
  reason: [
    {
      required: true,
      validator: (_rule, value, callback) => {
        callback(
          String(value ?? '').trim().length >= 2
            ? undefined
            : new Error('处理原因至少填写 2 个字符')
        );
      },
      trigger: 'blur'
    }
  ]
};

function positiveDecimalRule(label: string) {
  return {
    required: true,
    validator: (_rule: unknown, value: unknown, callback: (error?: Error) => void) => {
      callback(
        isV2UnsignedDecimal(String(value ?? ''), { allowZero: false })
          ? undefined
          : new Error(`${label}必须是最多 ${V2_DECIMAL_PLACES} 位小数的正数`)
      );
    },
    trigger: 'blur'
  };
}

async function openCreditConfirmation() {
  props.page.normalizeCandidateCode();
  if (await validateV2Form(creditFormRef.value)) {
    props.page.openCreditConfirmation();
  }
}

async function submitGiftCardReversal() {
  if (await validateV2Form(reversalFormRef.value)) {
    await props.page.submitGiftCardReversal();
  }
}
</script>
