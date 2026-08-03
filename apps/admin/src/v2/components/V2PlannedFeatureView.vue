<template>
  <section v-if="moduleDefinition" class="v2-module-page v2-planned-page">
    <V2PageContext
      :description="moduleDefinition.summary ?? '当前功能仍在规划中，详细范围以后续开发任务为准。'"
      aria-label="功能规划状态"
    >
      <template #meta>
        <span class="v2-planned-badge">规划中</span>
        <span>功能范围预览</span>
      </template>
      <template #status>
        <span class="v2-planned-state">尚未开放</span>
      </template>
    </V2PageContext>

    <section class="v2-planned-capabilities" aria-labelledby="v2-planned-capabilities-title">
      <V2SectionHeading
        id="v2-planned-capabilities-title"
        title="规划能力"
        help="这些区块用于确认后续功能边界，当前不会读取、修改或清理业务数据。"
      />

      <div class="v2-planned-grid">
        <article
          v-for="(section, index) in moduleDefinition.plannedSections"
          :key="section.title"
          class="v2-planned-card"
        >
          <span class="v2-planned-card__index" aria-hidden="true">
            {{ String(index + 1).padStart(2, '0') }}
          </span>
          <div>
            <strong>{{ section.title }}</strong>
            <p>{{ section.description }}</p>
          </div>
          <span class="v2-planned-card__state">待接入</span>
        </article>
      </div>
    </section>

    <aside class="v2-planned-boundary" aria-label="当前阶段边界">
      <div>
        <strong>当前阶段边界</strong>
        <p>{{ moduleDefinition.safetyNotice }}</p>
      </div>
      <span>无新增 API · 无数据库变更</span>
    </aside>
  </section>

  <V2PageState
    v-else
    state="error"
    title="规划页面配置不存在"
    message="当前路由没有对应的规划模块定义。"
  />
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useRoute } from 'vue-router';
import V2PageContext from '@/v2/components/V2PageContext.vue';
import V2PageState from '@/v2/components/V2PageState.vue';
import V2SectionHeading from '@/v2/components/V2SectionHeading.vue';
import { getV2ModuleDefinition } from '@/v2/config/modules';

const route = useRoute();
const moduleDefinition = computed(() => {
  const definition = getV2ModuleDefinition(route.meta.v2ModuleKey);
  return definition?.kind === 'planned' ? definition : undefined;
});
</script>

<style scoped>
.v2-planned-page {
  gap: 16px;
}

.v2-planned-badge {
  width: fit-content;
  padding: 3px 8px;
  border: 1px solid var(--v3-primary-border-soft);
  border-radius: 999px;
  background: var(--v2-accent-soft);
  color: var(--v3-on-primary-soft);
  font-size: 11px;
  font-weight: var(--v3-font-weight-bold);
  line-height: 18px;
}

.v2-planned-card p,
.v2-planned-boundary p {
  margin: 0;
}

.v2-planned-state {
  padding: 3px 9px;
  border: 1px solid var(--v2-border-soft);
  border-radius: 999px;
  background: var(--v2-surface-muted);
  color: var(--v2-text-soft);
  font-size: 11px;
  font-weight: var(--v3-font-weight-semibold);
  line-height: 20px;
}

.v2-planned-capabilities {
  display: grid;
  gap: 10px;
}

.v2-planned-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
}

.v2-planned-card {
  display: grid;
  min-width: 0;
  min-height: 116px;
  grid-template-columns: 36px minmax(0, 1fr) auto;
  align-items: start;
  gap: 12px;
  padding: 16px;
  border: 1px solid var(--v2-border);
  border-radius: var(--v3-radius);
  background: var(--v2-surface);
}

.v2-planned-card__index {
  display: grid;
  width: 32px;
  height: 32px;
  place-items: center;
  border-radius: 8px;
  background: var(--v2-surface-muted);
  color: var(--v2-accent);
  font-size: 11px;
  font-weight: var(--v3-font-weight-bold);
  font-variant-numeric: tabular-nums;
}

.v2-planned-card > div {
  display: grid;
  min-width: 0;
  gap: 5px;
}

.v2-planned-card strong {
  color: var(--v2-text);
  font-size: 14px;
  font-weight: var(--v3-font-weight-semibold);
}

.v2-planned-card p {
  color: var(--v2-text-soft);
  font-size: 12px;
  line-height: 1.65;
}

.v2-planned-card__state {
  padding: 2px 7px;
  border: 1px solid var(--v2-border-soft);
  border-radius: 999px;
  background: var(--v2-surface-muted);
  color: var(--v2-text-soft);
  font-size: 10px;
  line-height: 18px;
  white-space: nowrap;
}

.v2-planned-boundary {
  display: flex;
  min-width: 0;
  align-items: center;
  justify-content: space-between;
  gap: 18px;
  padding: 14px 16px;
  border: 1px solid var(--v3-warning-border-soft);
  border-radius: var(--v3-radius);
  background: var(--v3-warning-soft);
}

.v2-planned-boundary > div {
  display: grid;
  min-width: 0;
  gap: 3px;
}

.v2-planned-boundary strong {
  color: var(--v3-warning);
  font-size: 12px;
}

.v2-planned-boundary p,
.v2-planned-boundary > span {
  color: var(--v2-text-soft);
  font-size: 11px;
  line-height: 1.6;
}

.v2-planned-boundary > span {
  flex: 0 0 auto;
  white-space: nowrap;
}

@media (max-width: 900px) {
  .v2-planned-boundary {
    align-items: stretch;
    flex-direction: column;
  }

  .v2-planned-grid {
    grid-template-columns: 1fr;
  }

  .v2-planned-boundary > span {
    white-space: normal;
  }
}

@media (max-width: 560px) {
  .v2-planned-card {
    grid-template-columns: 32px minmax(0, 1fr);
  }

  .v2-planned-card__state {
    width: fit-content;
    grid-column: 2;
  }
}
</style>
