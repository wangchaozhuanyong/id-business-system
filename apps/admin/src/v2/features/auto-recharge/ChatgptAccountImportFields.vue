<template>
  <el-form label-position="left" label-width="112px" require-asterisk-position="right">
    <V2AsyncRegion
      skeleton="inline"
      :phase="primaryQuery.phase.value"
      :error="primaryQuery.error.value ? getApiErrorMessage(primaryQuery.error.value) : ''"
      loading-title="正在加载主邮箱"
      error-title="主邮箱加载失败"
      @retry="primaryQuery.refresh"
    >
      <el-form-item label="所属主邮箱" required>
        <el-select
          v-model="primaryAccountId"
          filterable
          :disabled="!primaryQuery.data.value"
          placeholder="选择隐藏邮箱所属主邮箱"
          aria-label="导入账号所属主邮箱"
        >
          <el-option
            v-for="item in primaryQuery.data.value?.items ?? []"
            :key="item.id"
            :label="item.email"
            :value="item.id"
          />
        </el-select>
      </el-form-item>
      <p v-if="primaryQuery.data.value?.total === 0" class="bank-recharge-form-note">
        请先在邮件验证码查询中新增主邮箱。
      </p>
    </V2AsyncRegion>
    <el-form-item label="资料格式">
      <el-select v-model="format" aria-label="账号导入格式">
        <el-option label="邮箱＋2FA（无密码）" value="without_password" />
        <el-option label="邮箱＋密码＋2FA" value="with_password" />
      </el-select>
    </el-form-item>
    <el-form-item label="账号资料" required>
      <el-input
        v-model="text"
        type="textarea"
        :rows="12"
        :maxlength="256000"
        autocomplete="off"
        aria-label="粘贴 ChatGPT 账号资料"
        :placeholder="
          format === 'without_password'
            ? 'user@example.com 2FA密钥 备注'
            : 'user@example.com 密码或- 2FA密钥或- 备注'
        "
      />
    </el-form-item>
  </el-form>
  <p class="bank-recharge-form-note">
    {{
      format === 'without_password'
        ? '依次填写邮箱、2FA 密钥、备注；不需要密码。'
        : '依次填写邮箱、密码、2FA 密钥、备注；密码可留空。'
    }}
    列之间可用 Tab 或空格；Tab 支持空列，空格分隔时用 - 占位。2FA 和备注可省略，备注中的空格会合并。
    每次最多 200 行。
  </p>
</template>

<script setup lang="ts">
import { watch } from 'vue';
import V2AsyncRegion from '@/v2/components/V2AsyncRegion.vue';
import { useV2ModuleQuery } from '@/v2/composables/useV2Query';
import { getApiErrorMessage } from '@/api/client';
import { vendureMailboxApi } from './vendure-mailbox-api';
import type { ChatgptAccountImportFormat } from './chatgpt-account-import';

const text = defineModel<string>({ required: true });
const format = defineModel<ChatgptAccountImportFormat>('format', { required: true });
const primaryAccountId = defineModel<string>('primaryAccountId', { required: true });
const primaryQuery = useV2ModuleQuery({
  moduleKey: 'chatgpt-accounts',
  scope: 'auto-recharge',
  key: 'chatgpt-import-primary-accounts',
  trackRouteData: false,
  query: async ({ signal }) => {
    const items: Array<{ id: string; email: string }> = [];
    for (let page = 1; ; page++) {
      const result = await vendureMailboxApi.primaryAccounts(
        { page, pageSize: 1000, status: 'ACTIVE' },
        { signal }
      );
      items.push(...result.items.map(({ id, email }) => ({ id, email })));
      if (items.length >= result.total) return { items, total: result.total };
      if (!result.items.length) throw new Error('主邮箱列表不完整，请重试');
    }
  }
});
watch(
  primaryQuery.data,
  (data) => {
    if (!primaryAccountId.value && data?.items.length === 1)
      primaryAccountId.value = data.items[0]!.id;
  },
  { immediate: true }
);
</script>
