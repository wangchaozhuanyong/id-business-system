<template>
  <main class="v2-public-mailbox">
    <header class="v2-public-mailbox__header">
      <a href="/mailbox" aria-label="邮件查询首页">
        <span>邮</span>
        <strong>邮件查询</strong>
      </a>
      <div>
        <el-icon><Lock /></el-icon>
        <span>安全连接</span>
      </div>
    </header>

    <section class="v2-public-mailbox__workspace" aria-labelledby="public-mailbox-title">
      <header>
        <span>谷歌邮箱 · 苹果邮箱</span>
        <h1 id="public-mailbox-title">查询邮箱消息</h1>
        <p>输入卖家提供的邮箱查询凭据。</p>
      </header>
      <V2MailQueryPanel />
    </section>

    <footer>
      <el-icon><CircleCheck /></el-icon>
      <span>查询码只用于本次校验，页面不会在浏览器中保存。</span>
    </footer>
  </main>
</template>

<script setup lang="ts">
import '@/v2/styles/v2.css';
import { CircleCheck, Lock } from '@element-plus/icons-vue';
import V2MailQueryPanel from '@/v2/components/workspace/V2MailQueryPanel.vue';
</script>

<style scoped>
.v2-public-mailbox {
  display: grid;
  min-height: 100dvh;
  grid-template-rows: auto 1fr auto;
  background: var(--v2-canvas);
  color: var(--v2-text);
}

.v2-public-mailbox__header {
  display: flex;
  width: min(960px, calc(100% - 40px));
  min-height: 68px;
  align-items: center;
  justify-content: space-between;
  gap: 20px;
  margin: 0 auto;
  border-bottom: 1px solid var(--v2-border);
}

.v2-public-mailbox__header > a {
  display: flex;
  align-items: center;
  gap: 10px;
  color: var(--v2-text);
  text-decoration: none;
}

.v2-public-mailbox__header > a > span {
  display: grid;
  width: 32px;
  height: 32px;
  place-items: center;
  border-radius: 6px;
  background: var(--v2-accent);
  color: var(--v3-on-primary-solid);
  font-size: 12px;
  font-weight: var(--v3-font-weight-semibold);
}

.v2-public-mailbox__header > a > strong {
  font-size: 15px;
  letter-spacing: 0;
}

.v2-public-mailbox__header > div {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--v2-text-soft);
  font-size: 12px;
}

.v2-public-mailbox__workspace {
  align-self: start;
  width: min(760px, calc(100% - 40px));
  margin: clamp(40px, 8vh, 88px) auto 40px;
  padding: 28px;
  border: 1px solid var(--v2-border);
  border-radius: 8px;
  background: var(--v2-surface);
  box-shadow: var(--v3-shadow-sm);
}

.v2-public-mailbox__workspace > header {
  display: grid;
  gap: 5px;
  margin-bottom: 26px;
  padding-bottom: 20px;
  border-bottom: 1px solid var(--v2-border-soft);
}

.v2-public-mailbox__workspace > header > span {
  color: var(--v2-accent);
  font-size: 12px;
  font-weight: var(--v3-font-weight-semibold);
}

.v2-public-mailbox__workspace h1 {
  margin: 0;
  font-size: 24px;
  line-height: 32px;
  letter-spacing: 0;
}

.v2-public-mailbox__workspace p {
  margin: 0;
  color: var(--v2-text-soft);
  font-size: 13px;
  line-height: 21px;
}

.v2-public-mailbox > footer {
  display: flex;
  min-height: 58px;
  align-items: center;
  justify-content: center;
  gap: 7px;
  padding: 16px 20px;
  color: var(--v2-text-soft);
  font-size: 12px;
  text-align: center;
}

@media (max-width: 560px) {
  .v2-public-mailbox__header,
  .v2-public-mailbox__workspace {
    width: calc(100% - 28px);
  }

  .v2-public-mailbox__workspace {
    margin-top: 24px;
    padding: 20px 16px;
  }

  .v2-public-mailbox__workspace h1 {
    font-size: 21px;
    line-height: 29px;
  }

  .v2-public-mailbox__header > div > span {
    display: none;
  }
}
</style>
