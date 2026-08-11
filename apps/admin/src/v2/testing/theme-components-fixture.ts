import '@/v2/styles/base.css';
import '@/v2/styles/v2.css';
import { createApp } from 'vue';
import { createPinia } from 'pinia';
import { applyV2Theme, type V2Theme } from '@/v2/theme';
import V2ThemeComponentsFixture from './V2ThemeComponentsFixture.vue';

const requestedTheme = new URLSearchParams(window.location.search).get('theme');
const theme: V2Theme = requestedTheme === 'dark' ? 'dark' : 'light';

applyV2Theme(theme);
createApp(V2ThemeComponentsFixture).use(createPinia()).mount('#app');
