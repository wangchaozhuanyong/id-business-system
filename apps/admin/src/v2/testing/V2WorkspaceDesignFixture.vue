<template>
  <div class="v2-shell v2-workspace-fixture" data-workspace-fixture>
    <aside class="v2-sidebar">
      <div class="v2-brand">
        <span class="v2-brand__mark">ID</span>
        <div class="v2-brand__copy">
          <strong>ID 业务管理</strong>
          <span>运营工作台</span>
        </div>
      </div>
      <nav class="v2-navigation" aria-label="验收导航">
        <section class="v2-navigation__section is-open">
          <button class="v2-navigation__parent" type="button">
            <el-icon class="v2-navigation__parent-icon"><Monitor /></el-icon>
            <span class="v2-navigation__parent-label">工作台</span>
          </button>
          <div class="v2-navigation__children">
            <a class="v2-navigation__item router-link-active" href="#workspace">
              <span class="v2-navigation__item-dot" aria-hidden="true" />
              <span class="v2-navigation__item-label">订单录入</span>
            </a>
            <a class="v2-navigation__item" href="#accounts">
              <span class="v2-navigation__item-dot" aria-hidden="true" />
              <span class="v2-navigation__item-label">ID 管理</span>
            </a>
          </div>
        </section>
        <section class="v2-navigation__section">
          <button class="v2-navigation__parent" type="button">
            <el-icon class="v2-navigation__parent-icon"><DataAnalysis /></el-icon>
            <span class="v2-navigation__parent-label">业务中心</span>
          </button>
        </section>
      </nav>
      <V2WorkspaceLauncher :sidebar-collapsed="false" />
    </aside>

    <div class="v2-workspace">
      <header class="v2-topbar">
        <div class="v2-topbar__identity"><h1>订单录入</h1></div>
      </header>
      <main class="v2-content">
        <div class="v2-content__inner">
          <section class="v2-workspace-fixture__overview">
            <span>当前业务</span>
            <h2>订单录入工作台</h2>
            <p>个人工作区固定在侧栏左下角，不挤压主业务内容。</p>
          </section>
          <section class="v2-workspace-fixture__content">
            <div>
              <strong>业务与对象</strong>
              <span>美国 · Apple ID · 账号开通</span>
            </div>
            <div>
              <strong>客户与结算</strong>
              <span>测试客户 · 人民币结算</span>
            </div>
          </section>
        </div>
      </main>
    </div>
  </div>
</template>

<script setup lang="ts">
import { DataAnalysis, Monitor } from '@element-plus/icons-vue';
import V2WorkspaceLauncher from '@/v2/components/workspace/V2WorkspaceLauncher.vue';
</script>

<style scoped>
.v2-workspace-fixture__overview {
  padding: 28px 0 24px;
  border-bottom: 1px solid var(--v2-border);
}

.v2-workspace-fixture__overview > span {
  color: var(--v2-accent);
  font-size: 12px;
  font-weight: var(--v3-font-weight-semibold);
}

.v2-workspace-fixture__overview h2 {
  margin: 6px 0 4px;
  color: var(--v2-text);
  font-size: 24px;
  line-height: 32px;
}

.v2-workspace-fixture__overview p {
  margin: 0;
  color: var(--v2-text-soft);
  font-size: 14px;
}

.v2-workspace-fixture__content {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 1px;
  margin-top: 24px;
  overflow: hidden;
  border: 1px solid var(--v2-border);
  border-radius: 7px;
  background: var(--v2-border);
}

.v2-workspace-fixture__content > div {
  display: grid;
  min-width: 0;
  gap: 6px;
  padding: 20px;
  background: var(--v2-surface);
}

.v2-workspace-fixture__content strong {
  color: var(--v2-text);
  font-size: 15px;
}

.v2-workspace-fixture__content span {
  color: var(--v2-text-soft);
  font-size: 13px;
}

@media (max-width: 720px) {
  .v2-workspace-fixture__content {
    grid-template-columns: 1fr;
  }
}
</style>
