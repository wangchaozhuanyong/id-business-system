import '@/v2/styles/base.css';
import '@/v2/styles/v2.css';
import '@/v2/styles/records.css';
import '@/v2/styles/system-monitoring.css';
import { createApp } from 'vue';
import { createPinia } from 'pinia';
import V2SystemMonitoringDesignFixture from './V2SystemMonitoringDesignFixture.vue';

const app = createApp(V2SystemMonitoringDesignFixture);
app.use(createPinia());
app.mount('#app');
