<template>
  <section class="v2-mail-results" aria-live="polite">
    <header>
      <div>
        <span class="v2-mail-results__title-row">
          <strong>{{ title }}</strong>
          <em v-if="result.targetType">{{ queryTypeLabel }}</em>
        </span>
        <span>{{ result.email }}</span>
      </div>
      <small>{{ countLabel }}</small>
    </header>

    <div v-if="result.targetType" class="v2-mail-results__query-meta">
      <span v-if="result.remainingDays !== null && result.remainingDays !== undefined">
        查询码剩余 {{ result.remainingDays }} 天
      </span>
      <span v-if="result.targetType === 'VIRTUAL'">仅展示该虚拟邮箱最近 5 封</span>
    </div>

    <label
      v-if="result.targetType === 'PRIMARY' && virtualEmailOptions.length"
      class="v2-mail-results__filter"
    >
      <span>筛选虚拟邮箱</span>
      <el-select v-model="selectedVirtualEmailId" placeholder="全部邮箱" clearable filterable>
        <el-option
          v-for="option in virtualEmailOptions"
          :key="option.id"
          :label="option.note ? `${option.aliasEmail} · ${option.note}` : option.aliasEmail"
          :value="option.id"
        />
      </el-select>
    </label>

    <div v-if="visibleItems.length === 0" class="v2-mail-results__empty">
      <el-icon><Message /></el-icon>
      <strong>暂未查询到邮件</strong>
      <span>请确认邮箱与查询码，或稍后重新查询。</span>
    </div>

    <ol v-else class="v2-mail-results__list">
      <li v-for="(item, index) in visibleItems" :key="item.id || `${item.savedAt}-${index}`">
        <details :open="index === 0">
          <summary>
            <span>
              <strong>{{ item.subject || '无主题' }}</strong>
              <small>{{ item.from || '未知发件人' }}</small>
            </span>
            <time>{{ item.savedAt || '时间未知' }}</time>
          </summary>
          <div class="v2-mail-results__message">
            <div v-if="item.extractedCode" class="v2-mail-results__verification-code">
              <span>
                <small>验证码</small>
                <strong>{{ item.extractedCode }}</strong>
              </span>
              <AppButton size="small" variant="soft" @click="copyCode(item.extractedCode)">
                <el-icon><CopyDocument /></el-icon>
                一键复制
              </AppButton>
            </div>
            <dl>
              <div>
                <dt>发件人</dt>
                <dd>{{ item.from || '—' }}</dd>
              </div>
              <div>
                <dt>收件人</dt>
                <dd>{{ item.to || '—' }}</dd>
              </div>
              <div>
                <dt>接收时间</dt>
                <dd>{{ item.savedAt || '—' }}</dd>
              </div>
            </dl>
            <div class="v2-mail-results__body">
              <div>
                <strong>邮件正文</strong>
                <AppButton
                  variant="ghost"
                  icon-only
                  size="small"
                  title="复制邮件正文"
                  @click="copyBody(item.body)"
                >
                  <el-icon><CopyDocument /></el-icon>
                </AppButton>
              </div>
              <pre>{{ mailBodyToPlainText(item.body) || '（无正文）' }}</pre>
            </div>
          </div>
        </details>
      </li>
    </ol>
  </section>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { V2MailViewerQueryResult } from '@apple-business/shared';
import { CopyDocument, Message } from '@element-plus/icons-vue';
import AppButton from '@/components/ui/AppButton.vue';
import { ElMessage } from '@/v2/services/elementPlusMessage';
import { filterMailViewerMessages, mailBodyToPlainText } from './mail-viewer';

const props = withDefaults(defineProps<{ result: V2MailViewerQueryResult; title?: string }>(), {
  title: '查询结果'
});
const selectedVirtualEmailId = ref('');
const virtualEmailOptions = computed(() => props.result.virtualEmailsList ?? []);
const visibleItems = computed(() =>
  filterMailViewerMessages(props.result.items, selectedVirtualEmailId.value)
);
const queryTypeLabel = computed(() =>
  props.result.targetType === 'VIRTUAL' ? '买家专属' : '主管理码'
);
const countLabel = computed(() => {
  if (props.result.targetType === 'VIRTUAL') {
    return `最近 ${visibleItems.value.length} 封 · 最多 5 封`;
  }
  if (selectedVirtualEmailId.value) {
    return `${visibleItems.value.length} / ${props.result.items.length} 封邮件`;
  }
  return `${props.result.items.length} 封邮件`;
});

watch(
  () => props.result,
  () => {
    selectedVirtualEmailId.value = '';
  }
);

async function copyCode(code: string) {
  if (await copyText(code)) ElMessage.success('验证码已复制');
  else ElMessage.error('无法复制验证码，请手动选择复制');
}

async function copyBody(body: string) {
  const plainText = mailBodyToPlainText(body);
  if (!plainText) return;
  if (await copyText(plainText)) ElMessage.success('邮件正文已复制');
  else ElMessage.error('无法复制邮件正文，请手动选择复制');
}

async function copyText(value: string) {
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    const textarea = document.createElement('textarea');
    textarea.value = value;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.append(textarea);
    textarea.select();
    const copied = document.execCommand('copy');
    textarea.remove();
    return copied;
  }
}
</script>

<style scoped>
.v2-mail-results {
  display: grid;
  min-width: 0;
  gap: 10px;
}

.v2-mail-results > header {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
}

.v2-mail-results > header > div {
  display: grid;
  min-width: 0;
  gap: 2px;
}

.v2-mail-results__title-row {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 7px;
}

.v2-mail-results__title-row em {
  padding: 2px 6px;
  border: 1px solid var(--v2-border);
  border-radius: 999px;
  background: var(--v2-surface-muted);
  color: var(--v2-text-soft);
  font-size: 11px;
  font-style: normal;
  line-height: 16px;
}

.v2-mail-results > header strong {
  color: var(--v2-text);
  font-size: 15px;
}

.v2-mail-results > header span,
.v2-mail-results > header small {
  overflow-wrap: anywhere;
  color: var(--v2-text-soft);
  font-size: 12px;
}

.v2-mail-results__query-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 14px;
  color: var(--v2-text-soft);
  font-size: 12px;
}

.v2-mail-results__filter {
  display: grid;
  grid-template-columns: 104px minmax(0, 320px);
  align-items: center;
  gap: 8px;
  color: var(--v2-text);
  font-size: 13px;
}

.v2-mail-results__empty {
  display: grid;
  min-height: 148px;
  place-items: center;
  align-content: center;
  gap: 5px;
  padding: 24px;
  border: 1px dashed var(--v2-border);
  border-radius: 7px;
  color: var(--v2-text-soft);
  text-align: center;
}

.v2-mail-results__empty .el-icon {
  margin-bottom: 4px;
  font-size: 22px;
}

.v2-mail-results__empty strong {
  color: var(--v2-text);
  font-size: 14px;
}

.v2-mail-results__empty span {
  font-size: 12px;
}

.v2-mail-results__list {
  display: grid;
  min-width: 0;
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.v2-mail-results__list > li {
  overflow: hidden;
  border: 1px solid var(--v2-border);
  border-radius: 7px;
  background: var(--v2-surface);
}

.v2-mail-results__list summary {
  display: grid;
  min-height: 56px;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 12px;
  padding: 9px 12px;
  background: var(--v2-surface-muted);
  color: var(--v2-text);
  cursor: pointer;
}

.v2-mail-results__list summary > span {
  display: grid;
  min-width: 0;
  gap: 2px;
}

.v2-mail-results__list summary strong,
.v2-mail-results__list summary small {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.v2-mail-results__list summary strong {
  font-size: 13px;
}

.v2-mail-results__list summary small,
.v2-mail-results__list summary time {
  color: var(--v2-text-soft);
  font-size: 11px;
}

.v2-mail-results__message {
  display: grid;
  min-width: 0;
  gap: 14px;
  padding: 14px;
  border-top: 1px solid var(--v2-border-soft);
}

.v2-mail-results__verification-code {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 11px 12px;
  border: 1px solid color-mix(in srgb, var(--v2-primary) 28%, var(--v2-border));
  border-radius: 7px;
  background: color-mix(in srgb, var(--v2-primary) 7%, var(--v2-surface));
}

.v2-mail-results__verification-code > span {
  display: grid;
  gap: 2px;
}

.v2-mail-results__verification-code small {
  color: var(--v2-text-soft);
  font-size: 11px;
}

.v2-mail-results__verification-code strong {
  color: var(--v2-primary);
  font-family: var(--v3-font-mono);
  font-size: 19px;
  letter-spacing: 0.08em;
}

.v2-mail-results__message dl {
  display: grid;
  min-width: 0;
  gap: 5px;
  margin: 0;
}

.v2-mail-results__message dl > div {
  display: grid;
  min-width: 0;
  grid-template-columns: 88px minmax(0, 1fr);
  align-items: baseline;
  gap: 8px;
}

.v2-mail-results__message dt,
.v2-mail-results__message dd {
  margin: 0;
  overflow-wrap: anywhere;
  font-size: 12px;
  line-height: 19px;
}

.v2-mail-results__message dt {
  color: var(--v2-text-soft);
}

.v2-mail-results__message dd {
  color: var(--v2-text);
}

.v2-mail-results__body {
  display: grid;
  min-width: 0;
  gap: 7px;
}

.v2-mail-results__body > div {
  display: flex;
  min-height: 32px;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.v2-mail-results__body > div > strong {
  color: var(--v2-text);
  font-size: 13px;
}

.v2-mail-results__body pre {
  max-height: 360px;
  margin: 0;
  padding: 12px;
  overflow: auto;
  border: 1px solid var(--v2-border-soft);
  border-radius: 6px;
  background: var(--v2-surface-muted);
  color: var(--v2-text);
  font-family: var(--v3-font-mono);
  font-size: 12px;
  line-height: 20px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

@media (max-width: 560px) {
  .v2-mail-results__list summary {
    grid-template-columns: minmax(0, 1fr);
    gap: 3px;
  }

  .v2-mail-results__message dl > div {
    grid-template-columns: 76px minmax(0, 1fr);
  }

  .v2-mail-results__filter {
    grid-template-columns: minmax(0, 1fr);
  }

  .v2-mail-results__verification-code {
    align-items: stretch;
    flex-direction: column;
  }
}
</style>
