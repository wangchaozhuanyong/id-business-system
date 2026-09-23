<template>
  <div>
    <V2FormDrawer
      v-model="drawerOpen"
      :title="creating ? '手工录入银充订单' : '银充订单资料'"
      :description="
        creating
          ? '先记录实际代付和付款凭据，再补客户、手续费、收款与到期时间。'
          : selected?.orderNo
      "
      size="min(760px, 96vw)"
      :confirm-loading="saving"
      :dirty="dirty"
      :confirm-disabled="
        Boolean(selected && ['completed', 'refunded', 'cancelled'].includes(selected.status))
      "
      confirm-text="保存"
      @confirm="save"
    >
      <el-alert
        v-if="optionsQuery.error.value"
        type="warning"
        :closable="false"
        title="关联资料加载失败"
      >
        <AppButton size="small" variant="ghost" @click="optionsQuery.refresh">重试</AppButton>
      </el-alert>
      <el-form
        ref="formRef"
        :model="form"
        :rules="rules"
        label-position="left"
        label-width="132px"
        require-asterisk-position="right"
        autocomplete="off"
      >
        <template v-if="creating">
          <el-form-item label="ChatGPT 套餐" required
            ><el-select v-model="form.plan" aria-label="ChatGPT 套餐"
              ><el-option label="标准版（Plus）" value="plus" /><el-option
                label="专业版 5×"
                value="pro-5x" /><el-option label="专业版 20×" value="pro-20x" /></el-select
          ></el-form-item>
          <el-form-item label="代付币种" required
            ><el-select v-model="form.chargeCurrencyCode" aria-label="代付币种"
              ><el-option
                v-for="item in activeCurrencies"
                :key="item.code"
                :label="`${item.name}（${item.code}）`"
                :value="item.code" /></el-select
          ></el-form-item>
          <el-form-item label="代付金额" prop="chargeAmount" required
            ><el-input
              v-model="form.chargeAmount"
              inputmode="decimal"
              placeholder="实际银行卡付款金额"
          /></el-form-item>
          <el-form-item label="付款凭据编号" prop="manualEvidenceRef" required
            ><el-input
              v-model="form.manualEvidenceRef"
              maxlength="220"
              placeholder="银行卡流水或官网支付凭据编号"
          /></el-form-item>
          <el-form-item label="ChatGPT 账号"
            ><el-select v-model="form.accountId" clearable filterable aria-label="ChatGPT 账号"
              ><el-option
                v-for="item in accounts"
                :key="item.id"
                :label="item.emailMasked"
                :value="item.id" /></el-select
          ></el-form-item>
          <el-form-item label="客户"
            ><div class="bank-recharge-inline">
              <el-select v-model="form.customerId" clearable filterable aria-label="客户"
                ><el-option
                  v-for="item in customers"
                  :key="item.id"
                  :label="item.name"
                  :value="item.id" /></el-select
              ><AppButton size="small" variant="ghost" @click="quickCustomerOpen = true"
                >新增客户</AppButton
              >
            </div></el-form-item
          >
        </template>
        <template v-else>
          <el-form-item label="代付金额"
            ><span
              >{{ selected?.chargeAmount }} {{ selected?.chargeCurrencyCode }}</span
            ></el-form-item
          >
          <el-form-item label="付款来源"
            ><span>{{
              selected?.source === 'automatic' ? '自动充值 · 官网已核验' : '手工录入'
            }}</span></el-form-item
          >
          <el-form-item label="ChatGPT 账号"
            ><el-select
              v-model="form.accountId"
              clearable
              filterable
              aria-label="ChatGPT 账号"
              :disabled="readonly"
              ><el-option
                v-for="item in accounts"
                :key="item.id"
                :label="item.emailMasked"
                :value="item.id" /></el-select
          ></el-form-item>
          <el-form-item label="客户"
            ><div class="bank-recharge-inline">
              <el-select
                v-model="form.customerId"
                clearable
                filterable
                aria-label="客户"
                :disabled="readonly"
                ><el-option
                  v-for="item in customers"
                  :key="item.id"
                  :label="item.name"
                  :value="item.id" /></el-select
              ><AppButton
                v-if="!readonly"
                size="small"
                variant="ghost"
                @click="quickCustomerOpen = true"
                >新增客户</AppButton
              >
            </div></el-form-item
          >
          <el-form-item label="银行卡"
            ><el-select
              v-model="form.cardId"
              clearable
              filterable
              aria-label="银行卡"
              :disabled="readonly"
              ><el-option
                v-for="item in availableCards"
                :key="item.id"
                :label="`${item.label} ····${item.last4}`"
                :value="item.id" /></el-select
          ></el-form-item>
          <el-form-item label="客户手续费率"
            ><el-input v-model="form.customerFeeRate" inputmode="decimal" :disabled="readonly"
              ><template #append>%</template></el-input
            ></el-form-item
          >
          <el-form-item label="客户手续费"
            ><div class="bank-recharge-inline">
              <el-switch
                v-model="form.feeOverride"
                active-text="手动金额"
                inactive-text="按比例"
                :disabled="readonly"
              /><el-input
                v-if="form.feeOverride"
                v-model="form.customerFeeAmount"
                inputmode="decimal"
                :disabled="readonly"
              /><span v-else>{{ feePreview }} {{ selected?.chargeCurrencyCode }}</span>
            </div></el-form-item
          >
          <el-form-item label="银行手续费"
            ><div class="bank-recharge-inline">
              <el-input
                v-model="form.bankFeeAmount"
                inputmode="decimal"
                placeholder="实际扣收；没有填 0"
                :disabled="readonly"
              /><el-select
                v-model="form.bankFeeCurrencyCode"
                aria-label="银行手续费币种"
                :disabled="readonly"
                ><el-option
                  v-for="item in activeCurrencies"
                  :key="item.code"
                  :label="item.code"
                  :value="item.code"
              /></el-select></div
          ></el-form-item>
          <el-form-item label="客户实收"
            ><div class="bank-recharge-inline">
              <el-input
                v-model="form.receivedAmount"
                inputmode="decimal"
                placeholder="客户实际付款金额"
                :disabled="readonly"
              /><el-select
                v-model="form.receivedCurrencyCode"
                aria-label="客户实收币种"
                :disabled="readonly"
                ><el-option
                  v-for="item in financeCurrencies"
                  :key="item"
                  :label="item"
                  :value="item"
              /></el-select></div
          ></el-form-item>
          <el-form-item label="代付汇率"
            ><el-input
              v-model="form.chargeFxRateToCny"
              inputmode="decimal"
              placeholder="1 单位代付币种折合人民币"
              :disabled="readonly"
          /></el-form-item>
          <el-form-item
            v-if="form.bankFeeCurrencyCode !== selected?.chargeCurrencyCode"
            label="银行费汇率"
            ><el-input
              v-model="form.bankFeeFxRateToCny"
              inputmode="decimal"
              placeholder="1 单位银行手续费币种折合人民币"
              :disabled="readonly"
          /></el-form-item>
          <el-form-item v-if="form.receivedCurrencyCode !== 'CNY'" label="实收汇率"
            ><el-input
              v-model="form.receivedFxRateToCny"
              inputmode="decimal"
              placeholder="1 单位实收币种折合人民币"
              :disabled="readonly"
          /></el-form-item>
          <el-form-item label="代付资金账户"
            ><el-select
              v-model="form.fundingFinanceAccountId"
              clearable
              filterable
              aria-label="代付资金账户"
              :disabled="readonly"
              ><el-option
                v-for="item in fundingAccounts"
                :key="item.id"
                :label="item.name"
                :value="item.id" /></el-select
          ></el-form-item>
          <el-form-item label="客户收款账户"
            ><el-select
              v-model="form.receivedFinanceAccountId"
              clearable
              filterable
              aria-label="客户收款账户"
              :disabled="readonly"
              ><el-option
                v-for="item in receivedAccounts"
                :key="item.id"
                :label="item.name"
                :value="item.id" /></el-select
          ></el-form-item>
          <el-form-item label="开通时间"
            ><el-date-picker
              v-model="form.openedAt"
              type="datetime"
              value-format="YYYY-MM-DDTHH:mm"
              placeholder="选择开通时间"
              :disabled="readonly"
          /></el-form-item>
          <el-form-item label="到期时间"
            ><el-date-picker
              v-model="form.dueAt"
              type="datetime"
              value-format="YYYY-MM-DDTHH:mm"
              placeholder="选择到期时间"
              :disabled="readonly"
          /></el-form-item>
          <el-form-item label="备注"
            ><el-input
              v-model="form.remark"
              type="textarea"
              :rows="2"
              maxlength="2000"
              :disabled="readonly"
          /></el-form-item>
          <p class="bank-recharge-form-note">
            完成订单时核对收款账户、代付汇率与银行手续费，系统同时入财务日记并连接到期提醒。
          </p>
        </template>
      </el-form>
      <p v-if="saveError" class="bank-recharge-error" role="alert">{{ saveError }}</p>
    </V2FormDrawer>
    <V2QuickCustomerDrawer v-model="quickCustomerOpen" @created="customerCreated" />
    <V2FormDrawer
      v-model="currencyOpen"
      title="新增银充币种"
      description="只添加自动充值执行器支持的币种；币种精度与官网付款一致。"
      :confirm-loading="working"
      :dirty="Boolean(currencyForm.code || currencyForm.name)"
      @confirm="saveCurrency"
    >
      <el-form label-position="left" label-width="110px" require-asterisk-position="right">
        <el-form-item label="币种代码" required
          ><el-input v-model="currencyForm.code" maxlength="3" placeholder="例如 USD"
        /></el-form-item>
        <el-form-item label="币种名称" required
          ><el-input v-model="currencyForm.name" maxlength="80" placeholder="例如 美元"
        /></el-form-item>
        <el-form-item label="小数位数" required
          ><el-select v-model="currencyForm.minorUnits" aria-label="币种小数位数"
            ><el-option label="0 位" :value="0" /><el-option label="2 位" :value="2" /></el-select
        ></el-form-item>
      </el-form>
      <p v-if="saveError" class="bank-recharge-error" role="alert">{{ saveError }}</p>
    </V2FormDrawer>
    <V2FormDrawer
      v-model="cardOpen"
      title="新增银充银行卡"
      description="只保存名称和卡尾四位，不保存完整卡号。"
      :confirm-loading="working"
      :dirty="Boolean(cardForm.label || cardForm.last4)"
      @confirm="saveCard"
    >
      <el-form label-position="left" label-width="110px" require-asterisk-position="right">
        <el-form-item label="银行卡名称" required
          ><el-input v-model="cardForm.label" maxlength="80" placeholder="例如 菲律宾银充卡"
        /></el-form-item>
        <el-form-item label="卡尾四位" required
          ><el-input
            v-model="cardForm.last4"
            maxlength="4"
            inputmode="numeric"
            placeholder="仅后四位"
        /></el-form-item>
        <el-form-item label="付款币种" required
          ><el-select v-model="cardForm.currencyCode" aria-label="银行卡付款币种"
            ><el-option
              v-for="item in activeCurrencies"
              :key="item.code"
              :label="`${item.name}（${item.code}）`"
              :value="item.code" /></el-select
        ></el-form-item>
      </el-form>
      <p v-if="saveError" class="bank-recharge-error" role="alert">{{ saveError }}</p>
    </V2FormDrawer>
    <V2FormDrawer
      v-model="refundOpen"
      title="登记银充退款"
      description="仅在真实退款完成后填写。保存会冲销原财务日记。"
      :confirm-loading="working"
      :dirty="Boolean(refund.reason || refund.refundReference)"
      @confirm="confirmRefund"
    >
      <el-form label-position="left" label-width="104px" require-asterisk-position="right">
        <el-form-item label="退款原因" required
          ><el-input v-model="refund.reason" maxlength="300"
        /></el-form-item>
        <el-form-item label="退款凭据" required
          ><el-input v-model="refund.refundReference" maxlength="160"
        /></el-form-item>
      </el-form>
      <p v-if="saveError" class="bank-recharge-error" role="alert">{{ saveError }}</p>
    </V2FormDrawer>
  </div>
</template>

<script setup lang="ts">
import AppButton from '@/components/ui/AppButton.vue';
import V2FormDrawer from '@/v2/components/V2FormDrawer.vue';
import { V2QuickCustomerDrawer } from '@/v2/features/order-entry/public-api';
import type { useBankRechargeOrdersPage } from './useBankRechargeOrdersPage';

const props = defineProps<{ state: ReturnType<typeof useBankRechargeOrdersPage> }>();
const {
  drawerOpen,
  creating,
  selected,
  saving,
  dirty,
  readonly,
  save,
  formRef,
  form,
  rules,
  activeCurrencies,
  accounts,
  optionsQuery,
  customers,
  quickCustomerOpen,
  availableCards,
  feePreview,
  financeCurrencies,
  fundingAccounts,
  receivedAccounts,
  saveError,
  customerCreated,
  currencyOpen,
  currencyForm,
  working,
  saveCurrency,
  cardOpen,
  cardForm,
  saveCard,
  refundOpen,
  refund,
  confirmRefund
} = props.state;
</script>
