import { writeFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
import vue from '@vitejs/plugin-vue';
import AutoImport from 'unplugin-auto-import/vite';
import Components from 'unplugin-vue-components/vite';
import { ElementPlusResolver } from 'unplugin-vue-components/resolvers';
import { defineConfig, loadEnv } from 'vite';

const workspaceRoot = fileURLToPath(new URL('../..', import.meta.url));
const htmlEntry = fileURLToPath(new URL('./index.html', import.meta.url));
const pagesHeaders = fileURLToPath(new URL('./dist/_headers', import.meta.url));

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, workspaceRoot, '');
  const apiProxyTarget =
    process.env.VITE_DEV_API_PROXY_TARGET ||
    env.VITE_DEV_API_PROXY_TARGET ||
    'http://localhost:3000';
  const buildId = String(`v2-${Date.now().toString(36)}`)
    .replace(/[^a-zA-Z0-9._-]/g, '')
    .slice(0, 96);
  const v2TableResolver = {
    type: 'component' as const,
    resolve(name: string) {
      if (name !== 'ElTable') return;
      return {
        name: 'default',
        from: '@/v2/components/V2ElTable.vue',
        sideEffects: 'element-plus/es/components/table/style/css'
      };
    }
  };

  return {
    define: {
      __V2_BUILD_ID__: JSON.stringify(buildId)
    },
    plugins: [
      {
        name: 'v2-history-entry',
        transformIndexHtml(html) {
          return html.replace(
            '<head>',
            `<head>\n    <meta name="v2-build-id" content="${buildId}" />`
          );
        },
        closeBundle() {
          writeFileSync(
            pagesHeaders,
            [
              '/index.html',
              '  Cache-Control: no-store, max-age=0',
              '',
              '/assets/*',
              '  Cache-Control: public, max-age=31536000, immutable',
              '',
              '/*',
              '  X-Content-Type-Options: nosniff',
              '  Referrer-Policy: strict-origin-when-cross-origin',
              '  X-Frame-Options: DENY',
              ''
            ].join('\n'),
            'utf8'
          );
        }
      },
      AutoImport({
        dts: false,
        imports: ['vue', 'vue-router', 'pinia'],
        resolvers: [ElementPlusResolver({ importStyle: 'css' })]
      }),
      Components({
        dts: false,
        resolvers: [
          v2TableResolver,
          ElementPlusResolver({
            exclude: /^ElTable$/,
            importStyle: 'css'
          })
        ]
      }),
      vue()
    ],
    resolve: {
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url))
      }
    },
    server: {
      port: 5374,
      strictPort: true,
      proxy: {
        '/api': {
          target: apiProxyTarget,
          changeOrigin: true
        }
      }
    },
    preview: {
      proxy: {
        '/api': {
          target: apiProxyTarget,
          changeOrigin: true
        }
      }
    },
    build: {
      outDir: 'dist',
      emptyOutDir: true,
      rollupOptions: {
        input: htmlEntry
      }
    }
  };
});
