<template>
  <fieldset>
    <legend>代理 IP 连接</legend>
    <el-form-item label="代理模式" prop="browserOptions.proxyMode" required>
      <el-select v-model="form.browserOptions.proxyMode" aria-label="选择代理模式">
        <el-option label="动态 IP 提取" value="dynamic" />
        <el-option label="固定代理" value="static" />
      </el-select>
    </el-form-item>
    <V2AsyncRegion
      v-if="!serverMode && catalog"
      variant="section"
      :phase="catalog.query.phase.value"
      :error="catalog.query.error.value ? getApiErrorMessage(catalog.query.error.value) : ''"
      skeleton="form"
      loading-title="正在读取代理 IP 管理"
      @retry="catalog.query.refresh"
    >
      <el-form-item label="代理 IP" prop="proxyId" required>
        <el-select
          v-model="form.proxyId"
          filterable
          aria-label="选择代理 IP"
          placeholder="选择代理 IP 管理中的启用代理"
          :disabled="catalog.query.phase.value !== 'ready'"
          no-data-text="当前模式暂无启用代理，请先在代理 IP 管理添加"
        >
          <el-option
            v-if="
              form.proxyId && !catalog.matchingItems.value.some((item) => item.id === form.proxyId)
            "
            :value="form.proxyId"
            label="原代理已失效或模式不符，请重新选择"
            disabled
          />
          <el-option
            v-for="item in catalog.matchingItems.value"
            :key="item.id"
            :value="item.id"
            :label="`${proxyCountryLabel(item.countryCode)} · ${proxyProtocolLabel(item.protocol)} · ${proxyKindLabels[item.kind]} · ${item.remark1 || item.linkMask}`"
          />
        </el-select>
      </el-form-item>
      <p class="recharge-settings-note">
        自动充值使用的代理资料，链接和账号密码统一在代理 IP 管理维护。
        <AppButton size="small" variant="ghost" @click="catalog.query.refresh"
          >刷新代理列表</AppButton
        >
      </p>
      <p v-if="form.proxyId && catalog.error.value" class="recharge-settings-error" role="alert">
        {{ catalog.error.value }}
      </p>
    </V2AsyncRegion>
    <el-form-item label="代理协议" prop="proxyType" required>
      <el-select v-model="form.proxyType" :disabled="!serverMode">
        <el-option label="HTTP" value="http" />
        <el-option label="HTTPS" value="https" />
        <el-option label="SOCKS5 代理" value="socks5" />
      </el-select>
    </el-form-item>
    <template v-if="form.browserOptions.proxyMode === 'dynamic'">
      <el-form-item
        v-if="serverMode"
        label="动态 IP 提取链接"
        prop="dynamicProxyUrl"
        :required="!stored?.dynamicProxyUrlConfigured"
      >
        <el-input
          v-model="form.dynamicProxyUrl"
          type="password"
          show-password
          autocomplete="off"
          :placeholder="
            stored?.dynamicProxyUrlConfigured
              ? '填写新链接以更换，留空保留当前链接'
              : '粘贴动态 IP 提取链接'
          "
        />
        <p class="recharge-settings-hint">
          当前来源：{{ stored?.dynamicProxyUrlMask || '尚未配置' }}
        </p>
        <p v-if="serverMode" class="recharge-settings-hint">
          服务器任务每次都会重新提取代理 IP；提取链接须为 HTTPS。
        </p>
      </el-form-item>
      <el-form-item v-if="!serverMode && !registration" label="动态代理服务商">
        <el-select v-model="form.browserOptions.dynamicProvider">
          <el-option label="通用" value="common" />
          <el-option label="Rola 代理" value="rola" />
          <el-option label="DoveIP 代理" value="doveip" />
          <el-option label="Cloudam 代理" value="cloudam" />
        </el-select>
      </el-form-item>
      <el-form-item v-if="!serverMode && !registration" label="重新提取 IP">
        <el-switch
          v-model="form.browserOptions.refreshIp"
          aria-label="打开窗口重新提取 IP"
          active-text="每次打开窗口提取"
          inactive-text="沿用已提取 IP"
        />
      </el-form-item>
      <p v-if="registration" class="recharge-settings-note">
        注册新建窗口固定重新提取 IP，按通用格式读取；继续原任务时沿用原窗口。
      </p>
    </template>
    <template v-else-if="serverMode">
      <el-form-item label="固定代理主机" prop="browserOptions.staticHost" required>
        <el-input
          v-model="form.browserOptions.staticHost"
          placeholder="填写 IP 或主机名，不含协议和端口"
          maxlength="253"
        />
      </el-form-item>
      <el-form-item label="固定代理端口" prop="browserOptions.staticPort" required>
        <el-input-number
          v-model="form.browserOptions.staticPort"
          :min="1"
          :max="65535"
          :precision="0"
          aria-label="固定代理端口"
        />
      </el-form-item>
      <el-form-item label="代理账号" prop="staticProxyUsername">
        <el-input
          v-model="form.staticProxyUsername"
          type="password"
          show-password
          autocomplete="off"
          :disabled="form.clearStaticProxyCredentials"
          placeholder="可选；更换时账号与密码一起填写"
          maxlength="256"
        />
      </el-form-item>
      <el-form-item label="代理密码" prop="staticProxyPassword">
        <el-input
          v-model="form.staticProxyPassword"
          type="password"
          show-password
          autocomplete="off"
          :disabled="form.clearStaticProxyCredentials"
          placeholder="留空保留已保存凭据"
          maxlength="256"
        />
        <p class="recharge-settings-hint">
          {{
            stored?.staticProxyCredentialsConfigured
              ? '已保存代理凭据；更换主机后请确认账号密码仍适用。'
              : '尚未保存代理凭据；无需认证时可留空。'
          }}
        </p>
      </el-form-item>
      <el-form-item v-if="stored?.staticProxyCredentialsConfigured" label="清除代理凭据">
        <el-switch
          v-model="form.clearStaticProxyCredentials"
          aria-label="清除代理凭据"
          active-text="保存后清除"
          inactive-text="保留"
        />
      </el-form-item>
    </template>
    <el-form-item v-if="!serverMode" label="IP 查询服务">
      <el-select v-model="form.browserOptions.ipCheckService">
        <el-option label="默认查询服务（ip-api）" value="ip-api" />
        <el-option label="备用查询服务（IP123）" value="ip123in" />
        <el-option label="Luminati 查询服务" value="luminati" />
      </el-select>
    </el-form-item>
  </fieldset>
</template>
<script setup lang="ts">
import AppButton from '@/components/ui/AppButton.vue';
import V2AsyncRegion from '@/v2/components/V2AsyncRegion.vue';
import { getApiErrorMessage } from '@/api/client';
import { proxyCountryLabel, proxyProtocolLabel, proxyKindLabels } from './recharge-proxy-options';
import type { useManagedBrowserProxy } from './useManagedBrowserProxy';
import type { V2RechargeBitBrowserSettings } from './contracts';
import type { BitBrowserSettingsForm } from './useRechargeBrowserSettings';
defineProps<{
  stored?: V2RechargeBitBrowserSettings;
  serverMode?: boolean;
  registration?: boolean;
  catalog?: ReturnType<typeof useManagedBrowserProxy>;
}>();
const form = defineModel<BitBrowserSettingsForm>({ required: true });
</script>
<style scoped src="./recharge-browser-settings.css"></style>
