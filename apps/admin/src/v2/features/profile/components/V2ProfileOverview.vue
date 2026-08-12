<template>
  <div v-if="page.profile" class="v2-profile-overview">
    <section class="v2-profile-hero" aria-label="当前账户总览">
      <div class="v2-profile-hero__identity">
        <span class="v2-profile-hero__avatar" aria-hidden="true">
          {{ page.profile.displayName.trim().slice(0, 1) || page.profile.username.slice(0, 1) }}
        </span>
        <div>
          <span>我的账户</span>
          <h2>{{ page.profile.displayName }}</h2>
          <p>{{ page.profile.username }} · {{ page.profileRoleLabel(page.profile.roles) }}</p>
        </div>
      </div>

      <div class="v2-profile-hero__metrics" aria-label="当前账户安全指标">
        <article>
          <span>账号状态</span>
          <strong class="is-text">正常</strong>
          <small>当前可登录</small>
        </article>
        <article>
          <span>MFA</span>
          <strong class="is-text">{{ page.mfaStatus?.enabled ? '已开启' : '未开启' }}</strong>
          <small>{{ page.mfaStatus?.recoveryCodeCount ?? 0 }} 个恢复码</small>
        </article>
        <article>
          <span>在线设备</span>
          <strong>{{ activeSessionCount }}</strong>
          <small>当前页有效会话</small>
        </article>
        <article>
          <span>密码状态</span>
          <strong class="is-text">{{ page.profile.mustResetPassword ? '待修改' : '正常' }}</strong>
          <small>改密会退出会话</small>
        </article>
      </div>

      <div class="v2-profile-hero__actions">
        <AppButton variant="ghost" :disabled="page.loading" @click="page.refresh">
          <el-icon><Refresh /></el-icon>
          刷新
        </AppButton>
        <AppButton variant="primary" @click="page.openChangePassword">修改密码</AppButton>
      </div>
    </section>

    <div class="v2-profile-workspace">
      <section class="v2-profile-panel">
        <V2SectionHeading
          title="个人资料"
          help="联系方式只显示脱敏值；如需修改，请由管理员在员工账户中处理。"
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

      <section class="v2-profile-panel">
        <V2SectionHeading
          title="MFA 与登录保护"
          help="绑定验证器后，登录时需要额外的动态验证码。"
        />
        <div class="v2-profile-protection">
          <div>
            <span>多因素认证</span>
            <strong>{{ page.mfaStatus?.enabled ? '已开启' : '未开启' }}</strong>
            <small v-if="page.mfaStatus?.enabled">
              剩余 {{ page.mfaStatus.recoveryCodeCount }} 个恢复码
            </small>
            <small v-else>建议绑定验证器，降低密码泄露风险。</small>
          </div>
          <div class="v2-profile-protection__actions">
            <template v-if="page.mfaStatus?.enabled">
              <AppButton size="small" variant="soft" @click="page.regenerateRecoveryCodes">
                重新生成恢复码
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
        <div class="v2-profile-protection">
          <div>
            <span>登录密码</span>
            <strong>{{
              page.profile.mustResetPassword ? '需要立即更换密码' : '密码状态正常'
            }}</strong>
            <small>修改成功后会退出当前账号的全部登录会话。</small>
          </div>
          <AppButton
            :variant="page.profile.mustResetPassword ? 'primary' : 'soft'"
            @click="page.openChangePassword"
          >
            修改密码
          </AppButton>
        </div>
      </section>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, type UnwrapNestedRefs } from 'vue';
import { Refresh } from '@element-plus/icons-vue';
import AppButton from '@/components/ui/AppButton.vue';
import V2SectionHeading from '@/v2/components/V2SectionHeading.vue';
import type { useProfilePage } from '../useProfilePage';

type ProfilePage = UnwrapNestedRefs<ReturnType<typeof useProfilePage>>;

const props = defineProps<{ page: ProfilePage }>();
const activeSessionCount = computed(
  () => props.page.sessions.filter((item) => !item.revokedAt).length
);
</script>
