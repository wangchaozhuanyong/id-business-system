<template>
  <el-form
    :ref="bindForm"
    :model="page.draft.form"
    :rules="page.rules"
    scroll-to-error
    label-position="left"
    label-width="110px"
    require-asterisk-position="right"
    :disabled="page.busy.value"
    @submit.prevent="page.start"
  >
    <el-form-item label="注册邮箱" prop="mailboxAliasId">
      <span>{{ page.selectedMailbox.value?.email || '请先在邮箱列表选择邮箱' }}</span>
    </el-form-item>
    <el-form-item label="代理 IP" prop="proxyId">
      <el-select
        v-model="form.proxyId"
        aria-label="注册代理"
        filterable
        remote
        :remote-method="page.searchProxyOptions"
        placeholder="搜索并选择启用代理"
      >
        <el-option
          v-for="item in page.proxyChoices(page.draft.form.proxyId)"
          :key="item.id"
          :label="item.label"
          :value="item.id"
        />
        <template #footer>
          <span>第 {{ page.optionFilters.proxyPage }} / {{ page.proxyPageCount.value }} 页</span>
          <AppButton
            size="small"
            :disabled="page.optionFilters.proxyPage <= 1"
            @click="page.changeProxyPage(page.optionFilters.proxyPage - 1)"
            >上一页</AppButton
          >
          <AppButton
            size="small"
            :disabled="page.optionFilters.proxyPage >= page.proxyPageCount.value"
            @click="page.changeProxyPage(page.optionFilters.proxyPage + 1)"
            >下一页</AppButton
          >
        </template>
      </el-select>
    </el-form-item>
    <p class="recharge-settings-note">默认带入已保存代理；本次注册使用这里选中的条目。</p>
    <el-form-item label="名字" prop="nameId">
      <el-select
        v-model="form.nameId"
        aria-label="注册名字"
        clearable
        filterable
        remote
        :remote-method="page.searchNameOptions"
        placeholder="留空自动选择启用名字"
      >
        <el-option
          v-for="item in page.nameChoices(page.draft.form.nameId)"
          :key="item.id"
          :label="item.displayName"
          :value="item.id"
        />
        <template #footer>
          <span>第 {{ page.optionFilters.namePage }} / {{ page.namePageCount.value }} 页</span>
          <AppButton
            size="small"
            :disabled="page.optionFilters.namePage <= 1"
            @click="page.changeNamePage(page.optionFilters.namePage - 1)"
            >上一页</AppButton
          >
          <AppButton
            size="small"
            :disabled="page.optionFilters.namePage >= page.namePageCount.value"
            @click="page.changeNamePage(page.optionFilters.namePage + 1)"
            >下一页</AppButton
          >
        </template>
      </el-select>
    </el-form-item>
    <el-form-item label="年龄" prop="age">
      <el-input-number
        v-model="form.age"
        :min="20"
        :max="45"
        :step="1"
        :controls="false"
        aria-label="注册年龄"
        placeholder="留空随机 20～45 岁"
      />
    </el-form-item>
    <el-form-item label="资料确认" prop="confirmIdentity">
      <el-checkbox v-model="form.confirmIdentity">确认邮箱已授权用于注册</el-checkbox>
    </el-form-item>
    <p>密码由系统生成并加密保存。遇到本人验证时暂停等待处理；本功能只检查优惠，不领取或付款。</p>
  </el-form>
</template>
<script setup lang="ts">
import AppButton from '@/components/ui/AppButton.vue';
import type { useRegistrationPage } from './useRegistrationPage';
const props = defineProps<{ page: ReturnType<typeof useRegistrationPage> }>();
const bindForm = props.page.bindForm;
const form = props.page.draft.form;
</script>
