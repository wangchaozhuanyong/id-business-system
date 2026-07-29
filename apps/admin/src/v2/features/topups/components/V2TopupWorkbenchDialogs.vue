<template>
  <V2FormDrawer
    v-model="page.creditDrawerVisible"
    title="礼品卡入账"
    size="min(560px, 94vw)"
    confirm-text="确认入账"
    :confirm-disabled="!page.canConfirmCredit"
    :confirm-loading="page.creditSubmitting"
    @confirm="page.openCreditConfirmation"
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
        title="请手工核对卡号、面值、汇率和供应商；确认后将立即写入余额与成本流水"
        type="info"
        show-icon
        :closable="false"
      />

      <section class="v2-topup-credit-entry-section v2-topup-credit-form">
        <label class="v2-topup-credit-entry-code">
          <span>礼品卡号</span>
          <el-input
            v-model="page.candidateCode"
            maxlength="64"
            autocomplete="off"
            placeholder="手工输入礼品卡号"
            @blur="page.normalizeCandidateCode"
          />
        </label>

        <div class="v2-topup-credit-grid">
          <label>
            <span>礼品卡面值</span>
            <el-input
              v-model="page.creditForm.faceValue"
              inputmode="decimal"
              maxlength="19"
              placeholder="例如 100"
            />
          </label>
          <label>
            <span>卡片汇率</span>
            <el-input
              v-model="page.creditForm.exchangeRate"
              inputmode="decimal"
              maxlength="19"
              placeholder="手工填写，例如 5.70"
            />
          </label>
        </div>
        <V2AsyncRegion
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
                <dd>¥{{ page.formatDecimal(page.usdtRateReference.merchantBuyRateToRmb, 8) }}</dd>
              </div>
              <div>
                <dt>卖出</dt>
                <dd>¥{{ page.formatDecimal(page.usdtRateReference.merchantSellRateToRmb, 8) }}</dd>
              </div>
              <div>
                <dt>中间价</dt>
                <dd>¥{{ page.formatDecimal(page.usdtRateReference.midRateToRmb, 8) }}</dd>
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

        <label>
          <span>加卡供应商</span>
          <el-select
            v-model="page.creditForm.supplierOptionId"
            filterable
            placeholder="选择启用的加卡供应商"
          >
            <el-option
              v-for="option in page.topupSupplierOptions"
              :key="option.id"
              :label="option.name"
              :value="option.id"
            />
          </el-select>
        </label>
        <el-alert
          v-if="!page.topupSupplierOptions.length"
          title="暂无启用的加卡供应商，请先到选项设置完成配置"
          type="error"
          show-icon
          :closable="false"
        />

        <label>
          <span>备注</span>
          <el-input
            v-model="page.creditForm.remark"
            type="textarea"
            :rows="3"
            maxlength="2000"
            show-word-limit
            placeholder="选填，记录采购批次或人工核对说明"
          />
        </label>

        <div class="v2-topup-credit-preview">
          <span>预计人民币成本</span>
          <strong>¥{{ page.formatDecimal(page.creditCostPreview) }}</strong>
        </div>
      </section>
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
                <dd>{{ page.formatDecimal(giftCard.exchangeRate, 8) }}</dd>
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
    :confirm-disabled="page.reversalReason.trim().length < 2"
    danger
    @confirm="page.submitGiftCardReversal"
  >
    <div class="v2-topup-reversal-confirm">
      <p class="v2-confirm-dialog__message">{{ page.reversalConfirmationMessage }}</p>
      <label>
        <span>处理原因</span>
        <el-input
          v-model="page.reversalReason"
          type="textarea"
          :rows="3"
          minlength="2"
          maxlength="500"
          show-word-limit
          placeholder="必填，记录供应商反馈或撤回依据"
        />
      </label>
    </div>
  </V2ConfirmDialog>
</template>

<script setup lang="ts">
import { RefreshLeft, WarningFilled } from '@element-plus/icons-vue';
import AppButton from '@/components/ui/AppButton.vue';
import V2AsyncRegion from '@/v2/components/V2AsyncRegion.vue';
import V2ConfirmDialog from '@/v2/components/V2ConfirmDialog.vue';
import V2FormDrawer from '@/v2/components/V2FormDrawer.vue';
import type { UnwrapNestedRefs } from 'vue';
import type { useTopupWorkbenchPage } from '../useTopupWorkbenchPage';

type TopupWorkbenchPage = UnwrapNestedRefs<ReturnType<typeof useTopupWorkbenchPage>>;

defineProps<{
  page: TopupWorkbenchPage;
}>();
</script>
