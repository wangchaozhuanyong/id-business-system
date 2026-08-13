<template>
  <V2FormDrawer
    v-model="page.mfaSetupVisible"
    title="绑定当前账号 MFA"
    eyebrow="账号保护"
    description="先录入绑定凭据，再使用当前动态验证码完成校验"
    confirm-text="验证并绑定"
    :confirm-loading="page.mfaEnabling"
    :dirty="true"
    @confirm="page.enableMfa(mfaCodeFormRef)"
  >
    <el-alert
      v-if="page.mfaMutationError"
      class="v2-profile-dialogs__alert"
      type="error"
      :title="page.mfaMutationError"
      show-icon
      :closable="false"
    />
    <el-alert
      class="v2-profile-dialogs__alert"
      type="info"
      title="在验证器应用中录入下方密钥或配置链接，再输入当前 6 位动态验证码。"
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
      <V2PanelSection heading-id="profile-mfa-credential" title="绑定凭据" step="01">
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
      <V2PanelSection heading-id="profile-mfa-verification" title="动态验证" step="02">
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
      class="v2-profile-dialogs__alert"
      type="warning"
      title="恢复码只显示这一次。请离线保存，每个恢复码只能使用一次。"
      show-icon
      :closable="false"
    />
    <ol class="v2-profile-dialogs__codes" aria-label="MFA 恢复码">
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
import type { useProfilePage } from '../useProfilePage';

type ProfilePage = UnwrapNestedRefs<ReturnType<typeof useProfilePage>>;

defineProps<{ page: ProfilePage }>();

const mfaCodeFormRef = ref<FormInstance>();
</script>

<style scoped>
.v2-profile-dialogs__alert {
  margin-bottom: 18px;
}

.v2-profile-dialogs__codes {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px 24px;
  margin: 0;
  padding: 8px 8px 8px 32px;
  font-family: var(--el-font-family);
  font-variant-numeric: tabular-nums;
}

.v2-profile-dialogs__codes li {
  overflow-wrap: anywhere;
}

@media (max-width: 520px) {
  .v2-profile-dialogs__codes {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
