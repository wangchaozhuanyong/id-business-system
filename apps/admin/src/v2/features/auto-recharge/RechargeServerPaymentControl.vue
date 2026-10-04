<template>
  <section class="recharge-server-control">
    <p v-if="job.result.manual_payment_confirmation" class="recharge-note">
      本任务已开启付款前人工确认；官网报价后暂停，由本人确认本次单次付款，最多等待 5 分钟。
    </p>
    <template v-if="confirmation.eligible.value">
      <p class="recharge-note">请核对上方官方报价、币种和付款上限，再确认本次付款。</p>
      <AppButton
        variant="primary"
        :disabled="!confirmation.confirmationEnabled.value"
        :loading="confirmation.busy.value"
        @click="confirmation.confirm"
      >
        确认当前报价并付款一次
      </AppButton>
    </template>
    <p v-if="confirmation.message.value" class="recharge-note" role="status">
      {{ confirmation.message.value }}
    </p>
    <template v-if="handoff.eligible.value">
      <p class="recharge-note">
        官网要求本人验证，请操作当前任务的原付款验证窗口，最多等待 5 分钟。
      </p>
      <div class="recharge-actions">
        <AppButton
          variant="primary"
          :disabled="!allowed || confirmation.busy.value"
          @click="handoff.show"
          >打开原付款验证窗口</AppButton
        >
        <AppButton variant="ghost" :disabled="!allowed" @click="$emit('refresh')"
          >我已完成验证，核对原单</AppButton
        >
      </div>
    </template>
    <p
      v-if="!allowed && (confirmation.eligible.value || handoff.eligible.value)"
      class="recharge-note"
      role="status"
    >
      请先确认管理员会话，再操作本次任务。
    </p>
    <p v-if="handoff.message.value && !handoff.open.value" class="recharge-note" role="status">
      {{ handoff.message.value }}
    </p>
    <V2FormDrawer
      :model-value="handoff.open.value"
      title="原付款验证窗口"
      size="min(760px, 96vw)"
      description="这里只显示原窗口的官方验证区域，请本人完成官网或银行验证。"
      confirm-text="我已完成验证，核对原单"
      :confirm-disabled="handoff.busy.value"
      :retain-draft="false"
      @update:model-value="closeDrawer"
      @confirm="recheck"
    >
      <p class="recharge-note">
        系统最多提交一次付款；核对原单只刷新状态，不会新建订单或重新付款。临时画面与输入关闭即清除。
      </p>
      <V2AsyncRegion
        :phase="handoff.query.phase.value"
        :error="handoff.queryError.value"
        :empty="!handoff.frame.value"
        variant="section"
        skeleton="form"
        loading-title="正在读取原验证画面"
        refreshing-title="正在刷新原验证画面"
        empty-title="原验证画面已结束"
        empty-message="请关闭窗口并核对原单状态。"
        @retry="handoff.refreshFrame"
      >
        <template v-if="handoff.frame.value">
          <p class="recharge-note">
            {{
              handoff.frame.value.kind === 'bank' ? '银行验证' : '官网本人验证'
            }}：点击画面中的控件，或使用下方按键和临时输入。
          </p>
          <img
            class="recharge-handoff-frame"
            :src="handoff.frame.value.image"
            :width="handoff.frame.value.width"
            :height="handoff.frame.value.height"
            alt="当前原付款窗口的官方验证区域"
            tabindex="0"
            :aria-disabled="!handoff.canOperate.value"
            @click="clickFrame"
            @keydown="pressKey"
          />
          <div class="recharge-actions">
            <AppButton
              v-for="key in keys"
              :key="key.value"
              variant="ghost"
              :disabled="!handoff.canOperate.value"
              @click="handoff.send({ type: 'key', key: key.value })"
              >{{ key.label }}</AppButton
            >
            <AppButton
              variant="ghost"
              :disabled="!handoff.canOperate.value"
              @click="handoff.send({ type: 'scroll', deltaY: -300 })"
              >向上滚动</AppButton
            >
            <AppButton
              variant="ghost"
              :disabled="!handoff.canOperate.value"
              @click="handoff.send({ type: 'scroll', deltaY: 300 })"
              >向下滚动</AppButton
            >
          </div>
          <el-form label-position="left" require-asterisk-position="right">
            <el-form-item label="临时验证输入">
              <el-input
                v-model="handoff.verificationInput.value"
                type="password"
                show-password
                autocomplete="off"
                :maxlength="64"
                :disabled="!handoff.canOperate.value"
                aria-label="临时验证输入"
              />
            </el-form-item>
          </el-form>
          <div class="recharge-actions">
            <AppButton
              variant="primary"
              :disabled="!handoff.canOperate.value"
              @click="handoff.send({ type: 'text', text: handoff.verificationInput.value })"
              >发送临时输入</AppButton
            >
            <AppButton
              variant="ghost"
              :disabled="handoff.busy.value || handoff.query.phase.value === 'refreshing'"
              allow-when-stale
              @click="handoff.refreshFrame"
              >刷新验证画面</AppButton
            >
          </div>
        </template>
      </V2AsyncRegion>
      <p v-if="handoff.busy.value" class="recharge-note" role="status">
        正在执行本次操作，请稍候。
      </p>
      <p v-if="handoff.message.value" class="recharge-note" role="status">
        {{ handoff.message.value }}
      </p>
    </V2FormDrawer>
  </section>
</template>

<script setup lang="ts">
import { computed, toRef } from 'vue';
import AppButton from '@/components/ui/AppButton.vue';
import V2FormDrawer from '@/v2/components/V2FormDrawer.vue';
import V2AsyncRegion from '@/v2/components/V2AsyncRegion.vue';
import { useAuthStore } from '@/stores/auth';
import type { V2RechargeJob } from './contracts';
import { handoffCoordinates, type RechargeHandoffAction } from './recharge-handoff';
import { useRechargeHandoff } from './useRechargeHandoff';
import { useRechargeServerConfirmation } from './useRechargeServerConfirmation';

const props = defineProps<{ job: V2RechargeJob }>();
const emit = defineEmits<{ refresh: [] }>();
const auth = useAuthStore();
const allowed = computed(() => auth.writesAllowed && auth.user?.roles.includes('admin') === true);
const job = toRef(props, 'job');
const handoff = useRechargeHandoff(job, allowed);
const confirmation = useRechargeServerConfirmation(job, allowed, () => emit('refresh'));
const keys: { value: Extract<RechargeHandoffAction, { type: 'key' }>['key']; label: string }[] = [
  { value: 'Tab', label: '下一个控件' },
  { value: 'Enter', label: '确认键' },
  { value: 'Space', label: '空格键' },
  { value: 'Backspace', label: '退格键' }
];
function closeDrawer(value: boolean) {
  if (!value) handoff.close();
}
function recheck() {
  handoff.close();
  emit('refresh');
}
function clickFrame(event: MouseEvent) {
  if (!handoff.frame.value || !handoff.canOperate.value) return;
  const image = event.currentTarget as HTMLImageElement;
  const point = handoffCoordinates(
    handoff.frame.value,
    image.getBoundingClientRect(),
    event.clientX,
    event.clientY
  );
  if (point) void handoff.send({ type: 'click', ...point });
}
function pressKey(event: KeyboardEvent) {
  if (!handoff.canOperate.value) return;
  const key = event.key === ' ' ? 'Space' : event.key;
  if (
    ![
      'Tab',
      'Enter',
      'Space',
      'Backspace',
      'ArrowUp',
      'ArrowDown',
      'ArrowLeft',
      'ArrowRight'
    ].includes(key)
  )
    return;
  event.preventDefault();
  void handoff.send({
    type: 'key',
    key: key as Extract<RechargeHandoffAction, { type: 'key' }>['key']
  });
}
</script>
<style scoped>
.recharge-server-control {
  min-width: 0;
}
.recharge-handoff-frame {
  display: block;
  max-width: 100%;
  width: 100%;
  height: auto;
}
.recharge-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-block: 12px;
}
</style>
