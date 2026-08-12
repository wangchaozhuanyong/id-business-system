import '@/v2/styles/base.css';
import '@/v2/styles/v2.css';
import '@/v2/styles/records.css';
import '@/v2/styles/branding.css';
import { createApp } from 'vue';
import { createPinia } from 'pinia';
import { applyV2Theme, type V2Theme } from '@/v2/theme';
import V2BrandingDesignFixture from './V2BrandingDesignFixture.vue';

const requestedTheme = new URLSearchParams(window.location.search).get('theme');
const theme: V2Theme = requestedTheme === 'dark' ? 'dark' : 'light';

applyV2Theme(theme);
const app = createApp(V2BrandingDesignFixture);
app.use(createPinia());
app.mount('#app');
