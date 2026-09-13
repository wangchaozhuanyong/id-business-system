<template>
  <V2FormDrawer
    :model-value="settingsOpen"
    title="代理 IP 与窗口设置"
    description="保存后用于后续新建窗口；正在执行的窗口保持原配置。"
    size="min(860px, 96vw)"
    confirm-text="保存设置"
    :confirm-loading="settingsSaving"
    :confirm-disabled-reason="
      !settingsQuery.data.value
        ? '请先完成设置读取'
        : !catalogReady
          ? '请先读取比特浏览器分组与标签'
          : ''
    "
    :dirty="settingsDirty"
    @update:model-value="setSettingsOpen"
    @confirm="submit"
  >
    <V2AsyncRegion
      variant="section"
      :phase="settingsQuery.phase.value"
      :error="settingsQuery.error.value ? getApiErrorMessage(settingsQuery.error.value) : ''"
      skeleton="form"
      loading-title="正在读取代理与窗口设置"
      @retry="settingsQuery.refresh"
    >
      <div v-if="stored" class="recharge-settings-summary">
        <strong>当前代理 IP 与窗口配置</strong>
        <p>{{ summary.proxy }}</p>
        <p>分组：{{ stored.groupName }} · {{ summary.languages }}</p>
      </div>
      <p v-if="settingsError" class="recharge-settings-error" role="alert">{{ settingsError }}</p>
      <el-form
        ref="formRef"
        class="recharge-settings-form"
        :model="settingsForm"
        :rules="rules"
        label-position="left"
        label-width="148px"
        require-asterisk-position="right"
        scroll-to-error
        :disabled="settingsSaving"
      >
        <RechargeProxyOptions v-model="settingsForm" :stored="stored" />
        <fieldset>
          <legend>慢加载与重试</legend>
          <el-form-item label="每轮等待时间" prop="browserOptions.sessionWaitMinutes" required>
            <el-input-number
              v-model="settingsForm.browserOptions.sessionWaitMinutes"
              aria-label="每轮等待时间"
              :min="1"
              :max="10"
              :precision="0"
            />
            <span class="recharge-settings-hint">分钟；页面加载和账号核对共用这段时间。</span>
          </el-form-item>
          <el-form-item label="最多重建次数" prop="browserOptions.sessionRetryLimit" required>
            <el-input-number
              v-model="settingsForm.browserOptions.sessionRetryLimit"
              aria-label="最多重建次数"
              :min="0"
              :max="2"
              :precision="0"
            />
            <span class="recharge-settings-hint">次；0 表示不重建，2 表示最多尝试 3 个窗口。</span>
          </el-form-item>
          <p class="recharge-settings-note">
            加载超时会关闭并删除本次失败窗口后重试。验证码需要手动处理；进入建单或付款后不会自动重建。
          </p>
        </fieldset>
        <fieldset>
          <legend>窗口资料</legend>
          <div class="recharge-settings-connection recharge-settings-catalog-actions">
            <el-button
              :disabled="
                catalogQuery.phase.value === 'initial-loading' ||
                catalogQuery.phase.value === 'refreshing'
              "
              @click="refreshCatalog"
              >刷新分组与标签</el-button
            >
            <span class="recharge-settings-note">读取当前电脑上比特浏览器里的现有选项</span>
          </div>
          <V2AsyncRegion
            variant="section"
            :phase="catalogQuery.phase.value"
            :previous-data="catalogQuery.isParameterTransition.value"
            :error="catalogQuery.error.value ? getApiErrorMessage(catalogQuery.error.value) : ''"
            skeleton="form"
            loading-title="正在读取比特浏览器分组与标签"
            @retry="refreshCatalog"
          >
            <el-form-item label="窗口分组" prop="groupName" required>
              <el-select
                v-model="settingsForm.groupName"
                aria-label="选择窗口分组"
                filterable
                :disabled="!catalogReady"
                placeholder="选择比特浏览器中的分组"
                no-data-text="暂无分组，请先在比特浏览器添加后刷新"
              >
                <el-option
                  v-for="item in groupOptions"
                  :key="item.id"
                  :value="item.name"
                  :label="item.disabled ? `${item.name}（同名，请先在比特浏览器区分）` : item.name"
                  :disabled="item.disabled"
                />
              </el-select>
            </el-form-item>
            <el-form-item label="窗口标签" prop="tagName" required>
              <el-select
                v-model="settingsForm.tagName"
                aria-label="选择窗口标签"
                filterable
                :disabled="!catalogReady"
                placeholder="选择比特浏览器中的标签"
                no-data-text="暂无标签，请先在比特浏览器添加后刷新"
              >
                <el-option
                  v-for="item in tagOptions"
                  :key="item.id"
                  :value="item.name"
                  :label="item.disabled ? `${item.name}（同名，请先在比特浏览器区分）` : item.name"
                  :disabled="item.disabled"
                />
              </el-select>
            </el-form-item>
            <p
              v-if="catalogReady && (!groupOptions.length || !tagOptions.length)"
              class="recharge-settings-note"
              role="status"
            >
              比特浏览器中暂无可选分组或标签，请添加后刷新。
            </p>
          </V2AsyncRegion>
          <p class="recharge-settings-note">
            窗口名称在充值页面逐笔填写；新窗口加入所选分组并绑定所选标签，备注同步使用标签名称。
          </p>
        </fieldset>
        <fieldset>
          <legend>本机连接</legend>
          <el-form-item label="本机连接器地址" prop="connectorUrl" required>
            <el-input v-model="settingsForm.connectorUrl" />
          </el-form-item>
          <el-form-item label="比特接口地址" prop="localApiUrl" required>
            <el-input v-model="settingsForm.localApiUrl" />
          </el-form-item>
          <el-form-item
            label="比特接口密钥"
            prop="localApiToken"
            :required="!stored?.localApiTokenConfigured"
          >
            <el-input
              v-model="settingsForm.localApiToken"
              type="password"
              show-password
              autocomplete="off"
              :placeholder="
                stored?.localApiTokenConfigured
                  ? '已保存，留空保留；填写新值以替换'
                  : '填写比特浏览器系统设置中的密钥'
              "
            />
          </el-form-item>
          <el-form-item
            label="本机连接密钥"
            prop="connectorToken"
            :required="!stored?.connectorTokenConfigured"
          >
            <el-input
              v-model="settingsForm.connectorToken"
              type="password"
              show-password
              autocomplete="off"
              :placeholder="
                stored?.connectorTokenConfigured
                  ? '已保存，留空保留；填写新值以替换'
                  : '填写本机连接器的连接密钥'
              "
            />
          </el-form-item>
          <div class="recharge-settings-connection">
            <el-button :loading="connectorStatus === 'checking'" @click="testConnector"
              >检测完整连接</el-button
            >
            <span :role="connectorStatus === 'offline' ? 'alert' : 'status'">{{
              connectorMessage
            }}</span>
          </div>
        </fieldset>
        <RechargeWindowOptions v-model="settingsForm.browserOptions" />
      </el-form>
    </V2AsyncRegion>
  </V2FormDrawer>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import RechargeProxyOptions from './RechargeProxyOptions.vue';
import RechargeWindowOptions from './RechargeWindowOptions.vue';
import { browserOptionRules } from './recharge-browser-rules';
import { browserSettingsSummary } from './recharge-browser-presentation';
import type { FormInstance, FormRules } from 'element-plus';
import { getApiErrorMessage } from '@/api/client';
import { validateV2Form } from '@/v2/utils/formValidation';
import V2FormDrawer from '@/v2/components/V2FormDrawer.vue';
import V2AsyncRegion from '@/v2/components/V2AsyncRegion.vue';
import type { useRechargeBrowserSettings } from './useRechargeBrowserSettings';
const props = defineProps<{ settings: ReturnType<typeof useRechargeBrowserSettings> }>();
const {
  settingsOpen,
  settingsSaving,
  settingsDirty,
  settingsError,
  settingsForm,
  settingsQuery,
  connectorStatus,
  connectorMessage,
  setSettingsOpen,
  testConnector,
  saveSettings,
  catalogQuery,
  groupOptions,
  tagOptions,
  catalogReady,
  refreshCatalog
} = props.settings;
const stored = computed(() => settingsQuery.data.value);
const summary = computed(() => browserSettingsSummary(stored.value));
const formRef = ref<FormInstance>();
const rules = computed<FormRules>(() => ({
  ...browserOptionRules(settingsForm.value),
  connectorUrl: [{ required: true, message: '请填写本机连接器地址', trigger: 'blur' }],
  localApiUrl: [{ required: true, message: '请填写比特接口地址', trigger: 'blur' }],
  groupName: [
    {
      trigger: 'change',
      validator: (_rule, value, callback) =>
        callback(
          groupOptions.value.some((item) => !item.disabled && item.name === value)
            ? undefined
            : new Error('请选择有效且名称唯一的窗口分组')
        )
    }
  ],
  tagName: [
    {
      trigger: 'change',
      validator: (_rule, value, callback) =>
        callback(
          tagOptions.value.some((item) => !item.disabled && item.name === value)
            ? undefined
            : new Error('请选择有效且名称唯一的窗口标签')
        )
    }
  ],
  proxyType: [{ required: true, message: '请选择代理协议', trigger: 'change' }],
  localApiToken: [
    {
      required: !stored.value?.localApiTokenConfigured,
      min: 16,
      max: 1000,
      message: '请填写 16 至 1000 位比特接口密钥',
      trigger: 'blur'
    }
  ],
  connectorToken: [
    {
      required: !stored.value?.connectorTokenConfigured,
      min: 16,
      max: 1000,
      message: '请填写 16 至 1000 位本机连接密钥',
      trigger: 'blur'
    }
  ],
  dynamicProxyUrl: [
    {
      required:
        settingsForm.value.browserOptions.proxyMode === 'dynamic' &&
        !stored.value?.dynamicProxyUrlConfigured,
      type: 'url',
      max: 2000,
      message: '请填写有效的动态 IP 提取链接',
      trigger: 'blur'
    }
  ]
}));
async function submit() {
  if (await validateV2Form(formRef.value)) await saveSettings();
}
</script>

<style scoped src="./recharge-browser-settings.css"></style>
