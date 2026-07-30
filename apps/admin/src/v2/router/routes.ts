import { reactive, readonly } from 'vue';
import type { Component } from 'vue';
import type { RouteRecordRaw } from 'vue-router';
import { markV2RoutePrefetch, type V2RoutePrefetchIntent } from '@/runtime/performance';
import { v2ModuleDefinitions } from '@/v2/config/modules';
import type { V2ViewLoader } from '@/v2/features/feature';

export type V2RouteLoadState = 'idle' | 'pending' | 'ready' | 'error';

type V2RouteModule = { default: Component };
type V2RouteLoader = V2ViewLoader;

interface V2RouteLoaderRecord {
  loader: V2RouteLoader;
  state: V2RouteLoadState;
  promise?: Promise<V2RouteModule>;
}

const routeLoaderRecords = new Map<string, V2RouteLoaderRecord>();
const layoutLoader = createTrackedLoader('layout', () => import('@/v2/layouts/V2AdminLayout.vue'));

const mutableV2RouteNavigationState = reactive({
  path: '',
  stablePath: '',
  state: 'idle' as V2RouteLoadState,
  error: null as unknown
});
export const v2RouteNavigationState = readonly(mutableV2RouteNavigationState);

function createTrackedLoader(key: string, importer: V2RouteLoader): V2RouteLoader {
  const record: V2RouteLoaderRecord = {
    loader: async () => {
      if (record.promise) return record.promise;
      record.state = 'pending';
      record.promise = importer()
        .then((module) => {
          record.state = 'ready';
          return module;
        })
        .catch((error) => {
          record.state = 'error';
          record.promise = undefined;
          throw error;
        });
      return record.promise;
    },
    state: 'idle'
  };
  routeLoaderRecords.set(key, record);
  return record.loader;
}

const moduleLoaders = new Map<string, V2RouteLoader>(
  v2ModuleDefinitions.map((module) => [
    module.key,
    createTrackedLoader(module.key, module.loadView)
  ])
);

function getModuleView(key: string): V2RouteLoader {
  const loader = moduleLoaders.get(key);
  if (loader) return loader;
  throw new Error(`未配置的 V2 业务页面：${key}`);
}

function getModuleKeyByPath(path: string) {
  const normalizedPath = path.split(/[?#]/, 1)[0].replace(/\/+$/, '') || '/';
  return v2ModuleDefinitions.find((module) => module.route === normalizedPath)?.key;
}

export async function prefetchV2Route(path: string, intent: V2RoutePrefetchIntent = 'hover') {
  const moduleKey = getModuleKeyByPath(path);
  if (!moduleKey) return;
  markV2RoutePrefetch(path, intent, 'start');
  try {
    await Promise.all([layoutLoader(), getModuleView(moduleKey)()]);
    markV2RoutePrefetch(path, intent, 'ready');
  } catch (error) {
    markV2RoutePrefetch(path, intent, 'error');
    throw error;
  }
}

export function isV2RouteReady(path: string) {
  const moduleKey = getModuleKeyByPath(path);
  if (!moduleKey) return false;
  return (
    routeLoaderRecords.get('layout')?.state === 'ready' &&
    routeLoaderRecords.get(moduleKey)?.state === 'ready'
  );
}

export function setV2RouteNavigationState(
  path: string,
  state: V2RouteLoadState,
  error: unknown = null
) {
  mutableV2RouteNavigationState.path = path;
  mutableV2RouteNavigationState.state = state;
  mutableV2RouteNavigationState.error = error;
  if (state === 'ready') {
    mutableV2RouteNavigationState.stablePath = path;
  }
}

export const v2Routes: RouteRecordRaw[] = [
  {
    path: '/v2',
    component: layoutLoader,
    meta: {
      title: 'ID 业务管理系统',
      group: 'V2',
      status: 'ready'
    },
    children: [
      {
        path: '',
        redirect: '/v2/workbench/renewals'
      },
      ...v2ModuleDefinitions.map(
        (module): RouteRecordRaw => ({
          path: module.route.replace(/^\/v2\//, ''),
          name: `v2-${module.key}`,
          component: getModuleView(module.key),
          meta: {
            title: module.title,
            group: module.group,
            status: module.status ?? 'ready',
            permission: 'permission' in module ? module.permission : undefined,
            requiredRoles: 'requiredRoles' in module ? module.requiredRoles : undefined,
            v2ModuleKey: module.key,
            keepAlive: 'keepAlive' in module && module.keepAlive === true
          }
        })
      )
    ]
  }
];
