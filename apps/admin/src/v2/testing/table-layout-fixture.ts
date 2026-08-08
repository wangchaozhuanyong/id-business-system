import '@/v2/styles/base.css';
import '@/v2/styles/v2.css';
import '@/v2/styles/records.css';
import { createPinia } from 'pinia';
import { createApp } from 'vue';
import V2TableActionLayoutFixture from './V2TableActionLayoutFixture.vue';

createApp(V2TableActionLayoutFixture).use(createPinia()).mount('#app');
