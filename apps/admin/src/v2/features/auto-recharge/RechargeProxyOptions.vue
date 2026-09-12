<template>
  <fieldset>
    <legend>代理 IP 连接</legend>
    <el-form-item label="代理模式" prop="browserOptions.proxyMode" required>
      <el-select v-model="form.browserOptions.proxyMode" aria-label="选择代理模式">
        <el-option label="动态 IP 提取" value="dynamic" />
        <el-option label="固定代理" value="static" />
      </el-select>
    </el-form-item>
    <el-form-item label="代理协议" prop="proxyType" required>
      <el-select v-model="form.proxyType">
        <el-option label="HTTP" value="http" />
        <el-option label="HTTPS" value="https" />
        <el-option label="SOCKS5 代理" value="socks5" />
      </el-select>
    </el-form-item>
    <template v-if="form.browserOptions.proxyMode === 'dynamic'">
      <el-form-item
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
      </el-form-item>
      <el-form-item label="动态代理服务商">
        <el-select v-model="form.browserOptions.dynamicProvider">
          <el-option label="通用" value="common" />
          <el-option label="Rola 代理" value="rola" />
          <el-option label="DoveIP 代理" value="doveip" />
          <el-option label="Cloudam 代理" value="cloudam" />
        </el-select>
      </el-form-item>
      <el-form-item label="重新提取 IP">
        <el-switch
          v-model="form.browserOptions.refreshIp"
          aria-label="打开窗口重新提取 IP"
          active-text="每次打开窗口提取"
          inactive-text="沿用已提取 IP"
        />
      </el-form-item>
    </template>
    <template v-else>
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
    <el-form-item label="IP 查询服务">
      <el-select v-model="form.browserOptions.ipCheckService">
        <el-option label="默认查询服务（ip-api）" value="ip-api" />
        <el-option label="备用查询服务（IP123）" value="ip123in" />
        <el-option label="Luminati 查询服务" value="luminati" />
      </el-select>
    </el-form-item>
  </fieldset>
</template>
<script setup lang="ts">
import type { V2RechargeBitBrowserSettings } from './contracts';
import type { BitBrowserSettingsForm } from './useRechargeBrowserSettings';
defineProps<{ stored?: V2RechargeBitBrowserSettings }>();
const form = defineModel<BitBrowserSettingsForm>({ required: true });
</script>
<style scoped src="./recharge-browser-settings.css"></style>
