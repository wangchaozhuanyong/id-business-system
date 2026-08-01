<template>
  <div v-if="page.profile" class="v2-profile-overview">
    <section class="v2-profile-card v2-profile-card--identity">
      <div class="v2-profile-identity">
        <span class="v2-profile-identity__avatar" aria-hidden="true">
          {{ page.profile.displayName.trim().slice(0, 1) || page.profile.username.slice(0, 1) }}
        </span>
        <div>
          <span>当前登录账号</span>
          <h2>{{ page.profile.displayName }}</h2>
          <p>{{ page.profile.username }} · {{ page.profileRoleLabel(page.profile.roles) }}</p>
        </div>
      </div>
      <el-tag type="success" effect="plain">正常</el-tag>
    </section>

    <section class="v2-profile-card">
      <V2SectionHeading
        title="个人资料"
        help="联系方式只显示脱敏值；姓名、联系方式如需修改，请由管理员在员工账号中处理。"
      />
      <dl class="v2-profile-details">
        <div>
          <dt>登录账号</dt>
          <dd>{{ page.profile.username }}</dd>
        </div>
        <div>
          <dt>显示姓名</dt>
          <dd>{{ page.profile.displayName }}</dd>
        </div>
        <div>
          <dt>邮箱</dt>
          <dd>{{ page.profile.emailMasked || '未设置' }}</dd>
        </div>
        <div>
          <dt>手机号</dt>
          <dd>{{ page.profile.phoneMasked || '未设置' }}</dd>
        </div>
        <div>
          <dt>角色</dt>
          <dd>{{ page.profileRoleLabel(page.profile.roles) }}</dd>
        </div>
        <div>
          <dt>账号创建时间</dt>
          <dd>{{ page.formatProfileDate(page.profile.createdAt) }}</dd>
        </div>
        <div>
          <dt>最近登录</dt>
          <dd>{{ page.formatProfileDate(page.profile.lastLoginAt) }}</dd>
        </div>
        <div>
          <dt>最近身份验证</dt>
          <dd>{{ page.formatProfileDate(page.profile.lastAuthenticatedAt) }}</dd>
        </div>
      </dl>
    </section>

    <section class="v2-profile-card">
      <V2SectionHeading
        title="密码与登录"
        help="修改密码需要验证当前密码，成功后会退出所有登录会话。"
      />
      <div class="v2-profile-security-row">
        <div>
          <strong>{{
            page.profile.mustResetPassword ? '需要立即更换密码' : '密码状态正常'
          }}</strong>
          <span>定期更换密码，不要与其他系统共用。</span>
        </div>
        <AppButton
          :variant="page.profile.mustResetPassword ? 'primary' : 'soft'"
          @click="page.openChangePassword"
        >
          修改密码
        </AppButton>
      </div>
    </section>

    <section class="v2-profile-card">
      <V2SectionHeading
        title="多因素认证（MFA）"
        help="绑定验证器后，登录时需要额外的动态验证码。"
      />
      <div class="v2-profile-security-row">
        <div>
          <el-tag :type="page.mfaStatus?.enabled ? 'success' : 'info'" effect="plain">
            {{ page.mfaStatus?.enabled ? '已开启' : '未开启' }}
          </el-tag>
          <span v-if="page.mfaStatus?.enabled">
            剩余 {{ page.mfaStatus.recoveryCodeCount }} 个恢复码
          </span>
          <span v-else>建议绑定验证器，降低密码泄露风险。</span>
        </div>
        <div class="v2-profile-security-row__actions">
          <template v-if="page.mfaStatus?.enabled">
            <AppButton size="small" variant="soft" @click="page.regenerateRecoveryCodes">
              重生恢复码
            </AppButton>
            <AppButton size="small" variant="danger" @click="page.disableMfa">停用 MFA</AppButton>
          </template>
          <AppButton
            v-else
            variant="primary"
            :loading="page.mfaSetupLoading"
            @click="page.openMfaSetup"
          >
            绑定验证器
          </AppButton>
        </div>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import type { UnwrapNestedRefs } from 'vue';
import AppButton from '@/components/ui/AppButton.vue';
import V2SectionHeading from '@/v2/components/V2SectionHeading.vue';
import type { useProfilePage } from '../useProfilePage';

type ProfilePage = UnwrapNestedRefs<ReturnType<typeof useProfilePage>>;

defineProps<{ page: ProfilePage }>();
</script>

<style scoped>
.v2-profile-overview {
  display: grid;
  min-width: 0;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 14px;
}

.v2-profile-card {
  display: grid;
  min-width: 0;
  align-content: start;
  gap: 18px;
  padding: 18px;
  border: 1px solid var(--v2-border);
  border-radius: var(--v3-radius);
  background: var(--v2-surface);
}

.v2-profile-card--identity {
  grid-column: 1 / -1;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
}

.v2-profile-identity {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 14px;
}

.v2-profile-identity__avatar {
  display: grid;
  width: 52px;
  height: 52px;
  flex: 0 0 52px;
  place-items: center;
  border-radius: 50%;
  background: var(--v3-primary-soft);
  color: var(--v2-accent);
  font-size: 20px;
  font-weight: var(--v3-font-weight-bold);
}

.v2-profile-identity > div {
  min-width: 0;
}

.v2-profile-identity span,
.v2-profile-identity p,
.v2-profile-security-row span {
  color: var(--v2-text-soft);
  font-size: 12px;
}

.v2-profile-identity h2 {
  margin: 3px 0;
  color: var(--v2-text);
  font-size: 20px;
  line-height: var(--v3-line-height-tight);
  overflow-wrap: anywhere;
}

.v2-profile-identity p {
  margin: 0;
  overflow-wrap: anywhere;
}

.v2-profile-details {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px 22px;
  margin: 0;
}

.v2-profile-details div {
  display: grid;
  min-width: 0;
  gap: 4px;
}

.v2-profile-details dt {
  color: var(--v2-text-soft);
  font-size: 11px;
}

.v2-profile-details dd {
  min-width: 0;
  margin: 0;
  color: var(--v2-text);
  font-size: 13px;
  font-weight: var(--v3-font-weight-semibold);
  overflow-wrap: anywhere;
}

.v2-profile-security-row {
  display: flex;
  min-width: 0;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}

.v2-profile-security-row > div:first-child {
  display: flex;
  min-width: 0;
  flex-direction: column;
  align-items: flex-start;
  gap: 7px;
}

.v2-profile-security-row strong {
  color: var(--v2-text);
  font-size: 13px;
}

.v2-profile-security-row__actions {
  display: flex;
  flex: 0 0 auto;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 8px;
}

@media (max-width: 960px) {
  .v2-profile-overview {
    grid-template-columns: minmax(0, 1fr);
  }

  .v2-profile-card--identity {
    grid-column: auto;
  }
}

@media (max-width: 620px) {
  .v2-profile-card {
    padding: 15px;
  }

  .v2-profile-card--identity,
  .v2-profile-security-row {
    align-items: flex-start;
  }

  .v2-profile-security-row {
    flex-direction: column;
  }

  .v2-profile-security-row > .app-button,
  .v2-profile-security-row__actions,
  .v2-profile-security-row__actions .app-button {
    width: 100%;
  }

  .v2-profile-details {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
