<template>
  <V2FormDrawer
    retain-draft
    :model-value="open"
    title="服务器默认代理"
    size="min(700px, 96vw)"
    description="从代理 IP 管理选择默认条目，充值页自动带入国家和代理；逐笔选择决定本次实际使用。"
    confirm-text="保存默认代理"
    :confirm-loading="saving"
    :dirty="dirty"
    :confirm-disabled-reason="ready ? '' : '请先完成代理资料读取'"
    @update:model-value="setOpen"
    @confirm="save"
  >
    <V2AsyncRegion
      variant="section"
      :phase="settingsQuery.phase.value"
      :error="settingsQuery.error.value ? getApiErrorMessage(settingsQuery.error.value) : ''"
      skeleton="form"
      loading-title="正在读取默认代理"
      @retry="settingsQuery.refresh"
    >
      <V2AsyncRegion
        variant="section"
        :phase="catalogQuery.phase.value"
        :error="catalogQuery.error.value ? getApiErrorMessage(catalogQuery.error.value) : ''"
        skeleton="form"
        loading-title="正在读取代理目录"
        @retry="catalogQuery.refresh"
      >
        <el-form
          class="recharge-settings-form"
          label-position="left"
          label-width="110px"
          require-asterisk-position="right"
          :disabled="saving"
        >
          <el-form-item label="默认代理">
            <el-select
              v-model="proxyId"
              filterable
              clearable
              aria-label="选择服务器默认代理"
              placeholder="选择代理 IP 管理中的启用代理"
            >
              <el-option
                v-if="proxyId && !selected"
                :value="proxyId"
                label="原默认代理已失效，请重新选择"
                disabled
              />
              <el-option
                v-for="item in items"
                :key="item.id"
                :value="item.id"
                :label="`${proxyCountryLabel(item.countryCode)} · ${proxyProtocolLabel(item.protocol)} · ${proxyKindLabels[item.kind]} · ${item.remark1 || item.linkMask}`"
              />
            </el-select>
          </el-form-item>
        </el-form>
        <div v-if="selected" class="recharge-settings-summary">
          <strong>所选代理资料</strong>
          <p>
            {{ proxyCountryLabel(selected.countryCode) }} ·
            {{ proxyProtocolLabel(selected.protocol) }} ·
            {{ selected.connectionMode === 'extraction' ? '动态提取' : '直连代理' }} ·
            {{ selected.remark1 || proxyKindLabels[selected.kind] }}
          </p>
          <AppButton size="small" variant="ghost" @click="detailId = selected.id"
            >查看完整链接</AppButton
          >
        </div>
        <p v-else-if="proxyId" class="recharge-settings-error" role="alert">
          原默认代理已停用或删除，请重新选择或清除默认值。
        </p>
        <p v-else class="recharge-settings-note">未设置默认值时，需要在充值页手动选择代理。</p>
        <p v-if="!items.length" class="recharge-settings-note">
          暂无启用代理，请先在代理 IP 管理新增。
        </p>
        <p
          v-if="settingsQuery.data.value?.legacyConfigured && !settingsQuery.data.value?.proxyId"
          class="recharge-settings-note"
        >
          之前单独保存的代理配置已保留；服务器充值使用代理目录中的条目，请在这里选定默认代理。
        </p>
        <p class="recharge-settings-note">
          国家、协议和链接统一在代理 IP 管理维护。这里保存默认选择，完整链接可直接查看。
        </p>
        <router-link to="/v2/auto-recharge/proxies" @click.prevent="goToCatalog"
          >前往代理 IP 管理</router-link
        >
        <p v-if="error" class="recharge-settings-error" role="alert">{{ error }}</p>
      </V2AsyncRegion>
    </V2AsyncRegion>
    <V2RechargeProxyDetailDrawer v-if="detailId" :id="detailId" @close="detailId = null" />
  </V2FormDrawer>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import { getApiErrorMessage } from '@/api/client';
import AppButton from '@/components/ui/AppButton.vue';
import V2AsyncRegion from '@/v2/components/V2AsyncRegion.vue';
import V2FormDrawer from '@/v2/components/V2FormDrawer.vue';
import V2RechargeProxyDetailDrawer from './V2RechargeProxyDetailDrawer.vue';
import { proxyCountryLabel, proxyKindLabels, proxyProtocolLabel } from './recharge-proxy-options';
import type { useRechargeServerProxySettings } from './useRechargeServerProxySettings';
const props = defineProps<{ settings: ReturnType<typeof useRechargeServerProxySettings> }>();
const {
  open,
  saving,
  error,
  proxyId,
  dirty,
  settingsQuery,
  catalogQuery,
  items,
  selected,
  ready,
  setOpen,
  save
} = props.settings;
const detailId = ref<string | null>(null);
const router = useRouter();
async function goToCatalog() {
  if (saving.value) return;
  if (dirty.value) {
    error.value = '请先保存默认代理或取消修改，再前往代理 IP 管理';
    return;
  }
  setOpen(false);
  await router.push('/v2/auto-recharge/proxies');
}
</script>
<style scoped src="./recharge-browser-settings.css"></style>
