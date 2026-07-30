<template>
  <main class="v2-button-contrast" data-button-contrast-fixture>
    <header>
      <p>公共按钮可访问性验收</p>
      <h1>按钮变体与状态矩阵</h1>
    </header>

    <section class="v2-button-contrast__grid">
      <article
        v-for="variant in variants"
        :key="variant"
        class="v2-button-contrast__card"
        :data-variant-card="variant"
      >
        <h2>{{ variant }}</h2>
        <AppButton :variant="variant" :data-button-variant="variant" data-button-state="normal">
          正常按钮
        </AppButton>
        <AppButton
          :variant="variant"
          disabled
          :data-button-variant="variant"
          data-button-state="disabled"
        >
          禁用按钮
        </AppButton>
        <AppButton
          :variant="variant"
          loading
          :data-button-variant="variant"
          data-button-state="loading"
        >
          加载按钮
        </AppButton>
      </article>
    </section>

    <section class="v2-button-contrast__order v2-order-entry-actions" data-order-entry-scenario>
      <div>
        <span>订单状态</span>
        <strong>待处理</strong>
      </div>
      <AppButton variant="primary" disabled data-order-entry-state="disabled">
        <el-icon><CircleCheck /></el-icon>
        创建并扣减余额
      </AppButton>
      <AppButton variant="primary" data-order-entry-state="ready">
        <el-icon><CircleCheck /></el-icon>
        创建并扣减余额
      </AppButton>
      <AppButton variant="primary" loading data-order-entry-state="loading">
        创建并扣减余额
      </AppButton>
    </section>
  </main>
</template>

<script setup lang="ts">
import { CircleCheck } from '@element-plus/icons-vue';
import AppButton from '@/components/ui/AppButton.vue';

const variants = ['default', 'primary', 'soft', 'danger', 'success', 'ghost'] as const;
</script>

<style scoped>
.v2-button-contrast {
  min-height: 100dvh;
  padding: 24px;
  background: var(--v3-bg);
  color: var(--v3-text);
}

.v2-button-contrast header {
  margin: 0 auto 20px;
  max-width: 1120px;
}

.v2-button-contrast header p,
.v2-button-contrast h1,
.v2-button-contrast h2 {
  margin: 0;
}

.v2-button-contrast header p {
  color: var(--v3-text-soft);
}

.v2-button-contrast h1 {
  margin-top: 4px;
  font-size: 22px;
}

.v2-button-contrast h2 {
  font-size: 14px;
}

.v2-button-contrast__grid {
  display: grid;
  max-width: 1120px;
  margin: 0 auto;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 14px;
}

.v2-button-contrast__card,
.v2-button-contrast__order {
  display: grid;
  min-width: 0;
  align-content: start;
  gap: 12px;
  padding: 16px;
  border: 1px solid var(--v3-border);
  border-radius: var(--v3-radius);
  background: var(--v3-surface);
}

.v2-button-contrast__card .app-button {
  width: 100%;
}

.v2-button-contrast__order {
  position: static;
  bottom: auto;
  max-width: 1120px;
  margin: 14px auto 0;
  grid-template-columns: minmax(0, 1fr) repeat(3, auto);
  align-items: center;
}

@media (max-width: 720px) {
  .v2-button-contrast {
    padding: 16px;
  }

  .v2-button-contrast__grid {
    grid-template-columns: minmax(0, 1fr);
  }

  .v2-button-contrast__order {
    grid-template-columns: minmax(0, 1fr);
  }

  .v2-button-contrast__order .app-button {
    width: 100%;
  }
}
</style>
