<template>
  <V2FormDrawer
    v-model="page.policyDrawerVisible"
    title="编辑管理员 MFA 策略"
    eyebrow="登录安全"
    description="设置 MFA 总开关、管理员强制范围与验证器签发方"
    confirm-text="保存策略"
    :confirm-loading="page.policySaving"
    :dirty="page.policyDirty"
    @confirm="page.submitPolicy(policyFormRef)"
  >
    <el-alert
      v-if="page.policyMutationError"
      class="v2-security-dialogs__alert"
      type="error"
      :title="page.policyMutationError"
      show-icon
      :closable="false"
    />
    <el-form
      ref="policyFormRef"
      class="v2-horizontal-form"
      :model="page.policyForm"
      :rules="page.policyRules"
      label-position="left"
      label-width="126px"
      require-asterisk-position="right"
      status-icon
      scroll-to-error
    >
      <V2PanelSection heading-id="security-mfa-policy" title="策略范围" step="01">
        <el-form-item label="启用 MFA 策略">
          <el-switch
            :model-value="page.policyForm.enabled"
            active-text="启用"
            inactive-text="停用"
            @update:model-value="page.setPolicyEnabled"
          />
        </el-form-item>
        <el-form-item label="管理员强制 MFA">
          <el-switch
            v-model="page.policyForm.requiredForAdmins"
            :disabled="!page.policyForm.enabled"
            active-text="强制"
            inactive-text="不强制"
          />
        </el-form-item>
        <el-form-item label="签发方" prop="issuer" required>
          <el-input v-model="page.policyForm.issuer" maxlength="80" show-word-limit />
        </el-form-item>
        <el-alert
          class="v2-security-dialogs__inline-alert"
          type="warning"
          title="开启管理员强制 MFA 前，后端会检查所有启用管理员均已绑定；否则拒绝保存。"
          show-icon
          :closable="false"
        />
      </V2PanelSection>
    </el-form>
  </V2FormDrawer>

  <V2FormDrawer
    v-model="page.mfaSetupVisible"
    title="绑定当前账号 MFA"
    eyebrow="账号保护"
    description="先录入绑定凭据，再使用当前动态验证码完成校验"
    confirm-text="验证并绑定"
    :confirm-loading="page.mfaEnabling"
    :dirty="true"
    @confirm="page.enableMyMfa(mfaCodeFormRef)"
  >
    <el-alert
      v-if="page.mfaMutationError"
      class="v2-security-dialogs__alert"
      type="error"
      :title="page.mfaMutationError"
      show-icon
      :closable="false"
    />
    <el-alert
      class="v2-security-dialogs__alert"
      type="info"
      title="在验证器应用中手动录入签发方、账号和密钥，再输入当前 6 位动态验证码。"
      show-icon
      :closable="false"
    />
    <el-form
      ref="mfaCodeFormRef"
      class="v2-horizontal-form"
      :model="page.mfaCodeForm"
      :rules="page.mfaCodeRules"
      label-position="left"
      label-width="104px"
      require-asterisk-position="right"
      status-icon
      scroll-to-error
    >
      <V2PanelSection heading-id="security-mfa-credential" title="绑定凭据" step="01">
        <el-form-item label="绑定密钥">
          <el-input :model-value="page.mfaSetup?.secret || ''" readonly />
        </el-form-item>
        <el-form-item label="配置链接">
          <el-input
            :model-value="page.mfaSetup?.otpauthUrl || ''"
            type="textarea"
            :rows="3"
            readonly
            resize="none"
          />
        </el-form-item>
      </V2PanelSection>
      <V2PanelSection heading-id="security-mfa-verification" title="动态验证" step="02">
        <el-form-item label="动态验证码" prop="code" required>
          <el-input
            v-model="page.mfaCodeForm.code"
            inputmode="numeric"
            autocomplete="one-time-code"
            maxlength="6"
            placeholder="6 位数字"
          />
        </el-form-item>
      </V2PanelSection>
    </el-form>
  </V2FormDrawer>

  <V2FormDrawer
    v-model="page.whitelistDrawerVisible"
    :title="page.editingWhitelist ? '编辑 IP 白名单' : '新增 IP 白名单'"
    eyebrow="网络访问控制"
    description="限制管理端或 API 的可信网络范围，避免误锁当前访问地址"
    :confirm-text="page.editingWhitelist ? '保存修改' : '确认新增'"
    :confirm-loading="page.whitelistSaving"
    :dirty="page.whitelistDirty"
    @confirm="page.submitWhitelist(whitelistFormRef)"
  >
    <el-alert
      v-if="page.whitelistMutationError"
      class="v2-security-dialogs__alert"
      type="error"
      :title="page.whitelistMutationError"
      show-icon
      :closable="false"
    />
    <el-form
      ref="whitelistFormRef"
      class="v2-horizontal-form"
      :model="page.whitelistForm"
      :rules="page.whitelistRules"
      label-position="left"
      label-width="104px"
      require-asterisk-position="right"
      status-icon
      scroll-to-error
    >
      <V2PanelSection heading-id="security-whitelist-rule" title="网络范围" step="01">
        <el-form-item label="IP 或 CIDR" prop="ipOrCidr" required>
          <el-input
            v-model="page.whitelistForm.ipOrCidr"
            maxlength="64"
            placeholder="例如 203.0.113.8 或 10.0.0.0/24"
          />
        </el-form-item>
        <el-form-item label="应用范围" prop="scope" required>
          <el-select v-model="page.whitelistForm.scope">
            <el-option label="管理端" value="admin" />
            <el-option label="API" value="api" />
          </el-select>
        </el-form-item>
        <el-form-item label="启用状态">
          <el-switch v-model="page.whitelistForm.enabled" active-text="启用" inactive-text="停用" />
        </el-form-item>
      </V2PanelSection>
      <V2PanelSection heading-id="security-whitelist-evidence" title="规则说明" step="02">
        <el-form-item label="说明" prop="remark">
          <el-input
            v-model="page.whitelistForm.remark"
            type="textarea"
            :rows="3"
            maxlength="200"
            show-word-limit
          />
        </el-form-item>
        <el-alert
          class="v2-security-dialogs__inline-alert"
          type="warning"
          title="保存启用规则前，后端会确认当前请求 IP 仍在最终白名单中；无法确认时拒绝保存。"
          show-icon
          :closable="false"
        />
      </V2PanelSection>
    </el-form>
  </V2FormDrawer>

  <el-dialog
    :model-value="page.recoveryCodesVisible"
    title="立即保存 MFA 恢复码"
    width="min(520px, 94vw)"
    :close-on-click-modal="false"
    :close-on-press-escape="false"
    :show-close="false"
    @closed="page.closeRecoveryCodes"
  >
    <el-alert
      class="v2-security-dialogs__alert"
      type="warning"
      title="恢复码只显示这一次。请离线保存，每个恢复码只能使用一次。"
      show-icon
      :closable="false"
    />
    <ol class="v2-security-dialogs__codes" aria-label="MFA 恢复码">
      <li v-for="code in page.recoveryCodes" :key="code">{{ code }}</li>
    </ol>
    <template #footer>
      <AppButton variant="primary" @click="page.closeRecoveryCodes">我已安全保存</AppButton>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { ref, type UnwrapNestedRefs } from 'vue';
import type { FormInstance } from 'element-plus';
import AppButton from '@/components/ui/AppButton.vue';
import V2FormDrawer from '@/v2/components/V2FormDrawer.vue';
import V2PanelSection from '@/v2/components/V2PanelSection.vue';
import type { useSecurityPage } from '../useSecurityPage';

type SecurityPage = UnwrapNestedRefs<ReturnType<typeof useSecurityPage>>;

defineProps<{ page: SecurityPage }>();

const policyFormRef = ref<FormInstance>();
const mfaCodeFormRef = ref<FormInstance>();
const whitelistFormRef = ref<FormInstance>();
</script>

<style scoped>
.v2-security-dialogs__alert {
  margin-bottom: 18px;
}

.v2-security-dialogs__inline-alert {
  margin-top: 8px;
}

.v2-security-dialogs__codes {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px 24px;
  margin: 0;
  padding: 8px 8px 8px 32px;
  font-family: var(--el-font-family);
  font-variant-numeric: tabular-nums;
}

.v2-security-dialogs__codes li {
  overflow-wrap: anywhere;
}

@media (max-width: 520px) {
  .v2-security-dialogs__codes {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
