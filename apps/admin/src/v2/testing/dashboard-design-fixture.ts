import '@/v2/styles/base.css';
import '@/v2/styles/v2.css';
import '@/v2/styles/records.css';
import '@/v2/styles/dashboard.css';
import { createApp } from 'vue';
import { createPinia } from 'pinia';
import V2DashboardDesignFixture from './V2DashboardDesignFixture.vue';

const app = createApp(V2DashboardDesignFixture);
app.use(createPinia());
app.mount('#app');
