import '@/v2/styles/base.css';
import { createApp, h } from 'vue';
import { createPinia } from 'pinia';
import { createMemoryHistory, createRouter } from 'vue-router';
import { useAuthStore } from '@/stores/auth';
import V2ChangePasswordView from '@/v2/views/V2ChangePasswordView.vue';

const router = createRouter({
  history: createMemoryHistory(),
  routes: [
    {
      path: '/',
      component: V2ChangePasswordView
    },
    {
      path: '/login',
      component: {
        render: () => h('div', '登录页')
      }
    }
  ]
});
const pinia = createPinia();
const app = createApp(V2ChangePasswordView);

app.use(pinia);
app.use(router);

const authStore = useAuthStore(pinia);
authStore.$patch({
  token: 'fixture-token',
  user: {
    id: '33333333-3333-4333-8333-333333333333',
    username: 'fixture-user',
    displayName: '验收用户',
    roles: ['admin'],
    permissions: [],
    mustResetPassword: true
  },
  sessionStatus: 'ready'
});

await router.push('/');
await router.isReady();
app.mount('#app');
