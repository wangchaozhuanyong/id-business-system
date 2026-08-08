<template>
  <V2FormDrawer
    v-model="page.creditDrawerVisible"
    title="礼品卡入账"
    size="min(960px, 96vw)"
    confirm-text="确认入账"
    :confirm-disabled-reason="page.creditDisabledReason"
    :confirm-loading="page.creditSubmitting"
    :dirty="page.creditDirty"
    @confirm="openCreditConfirmation"
  >
    <div v-if="page.selectedAccount" class="v2-topup-credit-entry">
      <section class="v2-topup-credit-entry-target v2-topup-credit-entry-target--credit">
        <div class="v2-topup-credit-target-identity">
          <span>目标 ID</span>
          <strong>{{ page.selectedAccount.appleIdMasked }}</strong>
          <small>礼品卡余额将计入该 ID，并同步写入成本流水。</small>
        </div>
        <dl class="v2-topup-credit-target-meta">
          <div>
            <dt>当前余额</dt>
            <dd>{{ page.formatDecimal(page.selectedAccount.currentBalance) }}</dd>
          </div>
          <div>
            <dt>国家</dt>
            <dd>
              <el-tag effect="plain">{{ page.selectedAccount.country.name }}</el-tag>
            </dd>
          </div>
        </dl>
      </section>

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
        <div class="v2-topup-credit-layout">
          <section class="v2-topup-credit-fieldset v2-topup-credit-card-panel">
            <header>
              <div>
                <strong>卡片资料</strong>
                <span>填写卡片身份和人民币换算依据。</span>
              </div>
              <span class="v2-topup-credit-formula">面值 × 汇率 = 卡片价值</span>
            </header>

            <div class="v2-topup-credit-grid">
              <el-form-item label="卡片名称" prop="cardNameOptionId">
                <el-select
                  v-model="page.creditForm.cardNameOptionId"
                  filterable
                  placeholder="选择卡片名称"
                >
                  <el-option
                    v-for="option in page.cardNameOptions"
                    :key="option.id"
                    :label="option.name"
                    :value="option.id"
                  />
                </el-select>
              </el-form-item>
              <el-form-item label="国家" prop="countryOptionId">
                <el-input
                  :model-value="page.selectedCountry?.name || page.selectedAccount.country.name"
                  aria-label="国家（跟随目标 ID）"
                  readonly
                />
                <small class="v2-form-help">跟随目标 ID，不可修改</small>
              </el-form-item>
            </div>

            <div v-if="!page.cardNameOptions.length" class="v2-topup-credit-option-empty">
              <el-alert
                title="暂无启用的卡片名称，请先到选项设置完成配置"
                type="error"
                show-icon
                :closable="false"
              />
              <AppButton variant="ghost" @click="page.openCardNameOptions">前往选项设置</AppButton>
            </div>

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
              <el-form-item label="卡片汇率" prop="exchangeRate">
                <el-input
                  v-model="page.creditForm.exchangeRate"
                  inputmode="decimal"
                  maxlength="19"
                  placeholder="例如 5.40000000"
                />
                <small class="v2-form-help">1 单位礼品卡面值等于多少人民币</small>
              </el-form-item>
            </div>
          </section>

          <section class="v2-topup-credit-fieldset v2-topup-credit-settlement-panel">
            <header>
              <div>
                <strong>结算与备注</strong>
                <span>核对卡商资金变化后再确认入账。</span>
              </div>
            </header>

            <el-form-item label="加卡供应商" prop="supplierOptionId">
              <el-select
                v-model="page.creditForm.supplierOptionId"
                filterable
                placeholder="选择启用的加卡供应商"
              >
                <el-option
                  v-for="option in page.topupSupplierOptions"
                  :key="option.id"
                  :label="`${option.name}${option.initialized ? '' : '（资金未初始化）'}`"
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

            <section
              class="v2-topup-credit-settlement-preview"
              aria-label="礼品卡结算预览"
              aria-live="polite"
            >
              <div class="v2-topup-credit-settlement-value">
                <span>本次卡片价值</span>
                <strong>
                  {{
                    page.creditCostPreview
                      ? `¥${page.formatDecimal(page.creditCostPreview)}`
                      : '待计算'
                  }}
                </strong>
              </div>
              <dl>
                <div>
                  <dt>卡商当前余额</dt>
                  <dd>
                    {{
                      page.selectedTopupSupplier?.initialized
                        ? `¥${page.formatDecimal(page.selectedTopupSupplier.currentBalanceCny || '0')}`
                        : '请选择供应商'
                    }}
                  </dd>
                </div>
                <div>
                  <dt>入账后余额</dt>
                  <dd :class="{ 'is-negative': page.creditWillOverdraw }">
                    {{
                      page.creditProjectedSupplierBalance !== null
                        ? `¥${page.formatDecimal(page.creditProjectedSupplierBalance)}`
                        : '待计算'
                    }}
                  </dd>
                </div>
              </dl>
            </section>

            <el-alert
              v-if="page.creditWillOverdraw"
              type="warning"
              show-icon
              :closable="false"
              title="卡商预付款余额不足；仍可入账，负数余额表示欠卡商金额"
            />

            <el-form-item label="加卡时间" prop="creditedAt">
              <el-input v-model="page.creditForm.creditedAt" type="datetime-local" />
            </el-form-item>
            <el-form-item label="备注">
              <el-input
                v-model="page.creditForm.remark"
                type="textarea"
                :rows="3"
                maxlength="2000"
                show-word-limit
                placeholder="选填，记录卡片批次或人工核对说明"
              />
            </el-form-item>
            <p class="v2-topup-credit-impact-note">
              确认后将同步更新 ID 余额、人民币成本、卡商预付款和财务流水。
            </p>
          </section>
        </div>
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
        skeleton="inline"
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
                <strong>{{ giftCard.cardName }} · {{ giftCard.codeMasked }}</strong>
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
                <dd>{{ page.formatDate(giftCard.creditedAt) }}</dd>
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
    message=""
    confirm-text="确认并入账"
    :confirm-loading="page.creditSubmitting"
    @confirm="page.submitGiftCardCredit"
  >
    <dl v-if="page.selectedAccount" class="v2-topup-credit-confirm">
      <div>
        <dt>加卡ID</dt>
        <dd>{{ page.selectedAccount.appleIdMasked }}</dd>
      </div>
      <div>
        <dt>卡号</dt>
        <dd>{{ page.normalizedCreditCode || page.creditForm.code || '—' }}</dd>
      </div>
      <div>
        <dt>国家</dt>
        <dd>{{ page.selectedCountry?.name || page.selectedAccount.country.name }}</dd>
      </div>
      <div>
        <dt>卡片汇率</dt>
        <dd>{{ page.creditForm.exchangeRate || '—' }}</dd>
      </div>
      <div>
        <dt>卡片价值</dt>
        <dd>
          {{ page.creditCostPreview ? `¥${page.formatDecimal(page.creditCostPreview)}` : '待计算' }}
        </dd>
      </div>
      <div>
        <dt>卡商余额</dt>
        <dd>
          <span>{{ page.selectedTopupSupplier?.name || '未选择卡商' }}</span>
          <strong>
            {{
              page.selectedTopupSupplier?.initialized
                ? `¥${page.formatDecimal(page.selectedTopupSupplier.currentBalanceCny || '0')}`
                : '—'
            }}
          </strong>
          <span>→</span>
          <strong :class="{ 'is-negative': page.creditWillOverdraw }">
            {{
              page.creditProjectedSupplierBalance !== null
                ? `¥${page.formatDecimal(page.creditProjectedSupplierBalance)}`
                : '—'
            }}
          </strong>
        </dd>
      </div>
    </dl>
  </V2ConfirmDialog>

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
  cardNameOptionId: [{ required: true, message: '请选择卡片名称', trigger: 'change' }],
  countryOptionId: [{ required: true, message: '目标 ID 国家不可用', trigger: 'change' }],
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
  exchangeRate: [
    {
      required: true,
      validator: (_rule, value, callback) => {
        const normalized = String(value ?? '').trim();
        callback(
          isV2UnsignedDecimal(normalized, { allowZero: false, decimalPlaces: 8 })
            ? undefined
            : new Error('卡片汇率必须是最多 8 位小数的正数')
        );
      },
      trigger: 'blur'
    }
  ],
  supplierOptionId: [{ required: true, message: '请选择加卡供应商', trigger: 'change' }],
  creditedAt: [{ required: true, message: '请选择加卡时间', trigger: 'change' }]
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
