import '@/v2/styles/base.css';
import { createApp } from 'vue';
import { createPinia } from 'pinia';
import { applyV2Theme, type V2Theme } from '@/v2/theme';
import V2ThemeComponentsFixture from './V2ThemeComponentsFixture.vue';

const requestedTheme = new URLSearchParams(window.location.search).get('theme');
const theme: V2Theme = requestedTheme === 'dark' ? 'dark' : 'light';

async function mountFixture() {
  // 独立模式验证基础皮肤，不让后台布局样式掩盖全局规则缺失。
  if (!new URLSearchParams(window.location.search).has('standalone')) {
    await import('@/v2/styles/v2.css');
  }
  applyV2Theme(theme);
  createApp(V2ThemeComponentsFixture).use(createPinia()).mount('#app');
}

void mountFixture();
