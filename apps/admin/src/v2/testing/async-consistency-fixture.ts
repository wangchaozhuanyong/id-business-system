import '@/v2/styles/base.css';
import '@/v2/styles/v2.css';
import { createApp } from 'vue';
import { createPinia } from 'pinia';
import { applyV2Theme } from '@/v2/theme';
import V2AsyncConsistencyFixture from './V2AsyncConsistencyFixture.vue';

applyV2Theme(
  new URLSearchParams(window.location.search).get('theme') === 'dark' ? 'dark' : 'light'
);
createApp(V2AsyncConsistencyFixture).use(createPinia()).mount('#app');
