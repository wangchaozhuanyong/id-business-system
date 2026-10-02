<template>
  <main class="async-fixture" data-async-fixture>
    <h1>刷新、加载与交互规则</h1>
    <p>本地合成资料，所有请求与操作均在当前页面模拟。</p>
    <section class="fixture-controls">
      <label class="v2-filter-field">
        <span>响应方式</span>
        <select v-model="mode" data-response-mode>
          <option value="fast">快速成功</option>
          <option value="slow">慢速成功</option>
          <option value="failure">读取失败</option>
          <option value="ignore-abort">取消后迟到</option>
        </select>
      </label>
      <AppButton data-query-toggle @click="visible = !visible">{{
        visible ? '离开区域' : '返回区域'
      }}</AppButton>
      <AppButton data-cache-clear @click="clearV2QueryCache">清理验收缓存</AppButton>
      <AppButton data-scope-invalidate @click="invalidateV2Queries('orders')"
        >标记资料变化</AppButton
      >
      <output data-request-count>读取次数：{{ requests }}</output>
      <output data-abort-count>取消次数：{{ aborts }}</output>
    </section>

    <V2QueryConsistencyProbe v-if="visible" :read="read" />

    <section class="legacy-sample">
      <h2>兼容加载区域</h2>
      <div class="fixture-controls">
        <AppButton data-legacy-first-failure @click="setLegacyFailure(false)"
          >首次读取失败</AppButton
        >
        <AppButton data-legacy-refresh-failure @click="setLegacyFailure(true)"
          >已有资料失败</AppButton
        >
        <AppButton
          data-legacy-forbidden
          @click="
            legacy.forbidden = !legacy.forbidden;
            legacy.loading = true;
          "
          >切换禁止状态</AppButton
        >
      </div>
      <V2AsyncRegion
        skeleton="cards"
        :loading="legacy.loading"
        :resolved="legacy.resolved"
        :error="legacy.error"
        :forbidden="legacy.forbidden"
        loading-title="正在读取兼容资料"
        data-legacy-region
        @retry="retryLegacy"
      >
        <p data-legacy-content>上次成功资料</p>
        <template #error-action>
          <AppButton data-legacy-retry allow-when-stale @click="retryLegacy">重新读取</AppButton>
        </template>
      </V2AsyncRegion>
      <output data-legacy-requests>兼容读取次数：{{ legacy.requests }}</output>
    </section>
  </main>
</template>

<script setup lang="ts">
import { reactive, ref } from 'vue';
import AppButton from '@/components/ui/AppButton.vue';
import V2AsyncRegion from '@/v2/components/V2AsyncRegion.vue';
import {
  clearV2QueryCache,
  invalidateV2Queries,
  type V2QueryContext
} from '@/v2/composables/useV2Query';
import V2QueryConsistencyProbe from './V2QueryConsistencyProbe.vue';

type ResponseMode = 'fast' | 'slow' | 'failure' | 'ignore-abort';
const requestedMode = new URLSearchParams(window.location.search).get('mode');
const mode = ref<ResponseMode>(
  requestedMode === 'slow' || requestedMode === 'failure' || requestedMode === 'ignore-abort'
    ? requestedMode
    : 'fast'
);
const visible = ref(true);
const requests = ref(0);
const aborts = ref(0);
const legacy = reactive({
  loading: false,
  resolved: true,
  error: '',
  forbidden: false,
  requests: 0
});

function read({ signal, page }: V2QueryContext & { page: number }) {
  const request = ++requests.value;
  const responseMode = mode.value;
  return new Promise<{ label: string }>((resolve, reject) => {
    const timer = setTimeout(
      () => {
        if (responseMode === 'failure') reject(new Error('验收读取失败，请重试。'));
        else resolve({ label: `第 ${page} 页 · 第 ${request} 次读取` });
      },
      responseMode === 'fast' ? 40 : responseMode === 'ignore-abort' ? 800 : 500
    );
    signal.addEventListener(
      'abort',
      () => {
        aborts.value += 1;
        if (responseMode !== 'ignore-abort') {
          clearTimeout(timer);
          reject(new DOMException('验收请求已取消', 'AbortError'));
        }
      },
      { once: true }
    );
  });
}

function setLegacyFailure(resolved: boolean) {
  legacy.loading = false;
  legacy.resolved = resolved;
  legacy.error = '验收读取失败，请重试。';
  legacy.forbidden = false;
}

function retryLegacy() {
  legacy.loading = true;
  legacy.requests += 1;
  setTimeout(() => {
    legacy.loading = false;
    legacy.resolved = true;
    legacy.error = '';
  }, 500);
}
</script>

<style scoped>
.async-fixture {
  display: grid;
  max-width: 1100px;
  margin: 0 auto;
  padding: 24px;
  gap: 18px;
}

.async-fixture h1,
.async-fixture p {
  margin: 0;
}

.fixture-controls {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
}

.legacy-sample {
  display: grid;
  gap: 16px;
  padding-top: 20px;
  border-top: 1px solid var(--v2-border);
}

select {
  min-height: 36px;
  border: 1px solid var(--v2-border);
  border-radius: var(--v3-radius-control);
  background: var(--v2-surface);
  color: var(--v2-text);
}
</style>
