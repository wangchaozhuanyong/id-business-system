# V2 页面统一加载规范

本规范适用于所有当前及未来的路由业务页面，禁止使用 `v-loading`、`el-skeleton` 或整页遮罩。

## 1. 加载状态矩阵

| 场景                       | 标准行为                                                                   |
| -------------------------- | -------------------------------------------------------------------------- |
| HTML 启动阶段              | 只显示路由中性的极简品牌占位；不得伪造工作区侧边栏、导航或业务表格。       |
| 会话确认                   | Vue 应用先挂载，再由 Boot Gate 核验会话；未确认时不渲染敏感业务内容。      |
| 冷启动认证 503             | 进入中性“登录服务暂时不可用”边界，不挂载业务外壳、权限导航或缓存业务页。   |
| 已验证会话认证 503         | 保留当前外壳和最后成功内容，显示只读降级条；阻止写操作和新的受保护导航。   |
| 会话自动恢复               | 原路由保持不变，统一失效已保留查询并后台刷新；恢复前不得重放写请求。       |
| 首次路由加载               | 会话门保持同一中性画面；真实布局就绪后一次进入工作区骨架，不允许空白帧。   |
| 路由资源加载               | 保留 V2 外壳和当前页面，只显示顶部路由进度；禁止白屏、整页卸载和交叉动画。 |
| 路由资源失败               | 已有页面时只显示一个布局内错误；保留当前页面，由用户决定是否重试。         |
| 路由意图预取               | 只预取目标路由代码；短暂掠过可取消，不提前请求业务数据或改变当前页面。     |
| 首次数据加载               | 没有成功快照时，使用与真实内容结构一致的共享骨架。                         |
| 缓存命中                   | 立即显示缓存数据，不显示骨架、遮罩或按钮闪烁。                             |
| 同参数刷新                 | 保留最后成功内容；超过 120ms 后只显示区域顶部细进度线。                    |
| 筛选、分页、排序、页签切换 | 保留最后成功快照并标记为只读；新参数成功后原子替换，区域尺寸不得跳动。     |
| 首次加载失败               | 显示统一错误状态、错误原因和重新加载按钮。                                 |
| 已有数据刷新失败           | 保留原内容，在区域顶部显示错误和重试；禁止清空列表。                       |
| 空数据                     | 只有请求成功后才能显示空状态，不能把加载中或失败误报为空。                 |
| 权限不足                   | 使用统一 forbidden 状态，不渲染无权限业务操作。                            |
| 写操作                     | 只在当前按钮、行、抽屉或弹窗显示 loading，并阻止重复提交。                 |

## 2. 强制实现方式

- 入口必须静态导入 Vue、Pinia、App 和 Router；安装运行时错误处理、Pinia 和 Router 后立即
  `mount`，不得等待鉴权、`router.isReady()` 或 Element Plus 组件合集。
- `SessionCoordinator` 是会话和凭据的唯一真相源，`useAuthStore()` 只做响应式投影。状态固定为
  `cold | anonymous | validating | ready | refreshing | degraded | blocked`，一切转换必须通过合法转换图；
  不得在 App、页面或另一个 store 中维护平行会话状态。
- 持久化只允许一条 `apple_business_auth_v2`原子记录，同时包含 `credentialId`、`token`、
  `tokenRevision`、`userCache` 和 `updatedAt`。旧 token/user 键只允许一次迁移，不得再分开写入。
- 会话验证必须 singleflight，且每个响应在提交前同时匹配 `credentialId + tokenRevision`。登出、
  身份切换或凭据被其他标签页替换后，迟到的 200/401/403 均不得改写新身份。
- `/auth/me` 使用 8 秒超时和 200/800ms 带抖动的有界重试，只重试网络错误、502、503、504。
  30 秒内连续失败三个完整周期后开启 15/30/60 秒熔断；人工重试只允许一个 half-open 探针。
- 认证例外只能由精确 endpoint registry 声明。`/auth/change-password` 允许密码重置阻断期使用，
  `/auth/logout` 允许在 degraded/blocked 期使用；禁止用 URL 子串或错误文案猜测。
- 路由守卫和会话恢复路由由 Router + SessionCoordinator 独占；App 只计算 Boot Gate 展示状态。
  已验证 degraded 期的新受保护导航必须显式重定向回 `from`，不得 `return false`。
- API 失败必须是结构化 `ApiError`；Vue Router 导航失败必须检查其 resolve 结果。全局运行时边界不得按
  “Navigation aborted”、动态 import 或组件文案做正则分类。
- `booting`、`session-checking` 和首次 `route-loading` 只能复用同一中性会话门结构和文案；不得在
  真实布局挂载前临时伪造深色侧边栏、顶部栏或工作区。身份和目标路由确认后，必须一次进入真实布局及
  对应内容骨架。
- 本地用户快照只能辅助非敏感启动外壳，不能在服务端会话确认前渲染权限导航或业务数据。退出、
  会话过期和身份变化必须终止旧身份请求、清空 V2 查询缓存，并通过重建路由树清除组件内草稿。
- Element Plus 组件和样式必须通过 `unplugin-vue-components`、`unplugin-auto-import` 与
  `ElementPlusResolver` 按需引入，禁止 `element-plus/dist/index.css` 和完整工作区组件预加载。
- `vite:preloadError` 必须区分首次启动和已有稳定路由：首次失败按 `buildId` 在当前
  `sessionStorage` 最多自动刷新一次；再次失败进入可恢复状态。已有稳定路由时全局恢复器不得拦截
  Promise：真实导航错误交给 Vue Router 显示唯一布局内错误，推测预取错误由预取调用方静默吸收。
  错误出现前必须保留当前页面；用户明确重试后允许重载目标地址，以绕过浏览器 ES 模块映射缓存的
  失败动态导入。
- 路由预取必须以真实用户意图触发：鼠标悬停使用可取消的短延迟，键盘聚焦可预取，pointerdown
  确认导航时立即复用同一加载 Promise；pointerleave/blur 必须取消尚未开始的任务。标签页不可见、
  离线、`saveData`、`slow-2g` 或 `2g` 时禁止推测预取，但不得阻止用户实际导航。预取只加载哈希
  路由代码，不读取业务 API、不持久化数据、不显示导航进度。
- 性能观测必须把一次导航拆为 `v2:route-start`、`v2:route-code-ready` 和
  `v2:route-data-ready`。`afterEach` 只能上报代码就绪；当前路由的唯一
  `useV2ModuleQuery` 在内存缓存可用或真实网络请求成功后上报数据就绪，并标明
  `memory-cache | network`。首次数据失败上报 `v2:route-data-error`，迟到的旧路由响应不得结束
  当前导航指标。
- 每个 V2 路由页面必须使用 `V2AsyncRegion`；主列表使用 `page`，抽屉、页签子列表和独立数据块使用
  `section`。
- 显式声明 `status: 'planned'`、且不读取任何远程数据的规划占位页，不使用
  `V2AsyncRegion` 或 `useV2ModuleQuery`，也不得伪造加载、空数据或成功结果；开始接入真实数据时必须
  先移除规划状态并完整遵守本规范。
- 每个 `V2AsyncRegion` 必须显式声明 `skeleton`。共享内容形状固定为：列表与分页使用 `table`，
  订单录入及复杂编辑使用 `form`，汇率概览使用 `metrics`，选项工作区使用 `settings`，抽屉详情使用
  `detail`，候选项与卡片列表使用 `cards`，单行引用数据使用 `inline`。页面不得复制或改造私有骨架。
- 每个 V2 模块必须在 `V2ModuleDefinition.freshnessPolicy` 声明
  `event-driven | event-with-deadline`。所有真实远程数据页面必须
  使用 `useV2ModuleQuery({ moduleKey, scope, key, query })`；禁止继续使用仅缓存完成标记的
  `useV2ModuleRefresh({ moduleKey, scope, load })`。
- `resolved` 表示该区域至少成功返回过一次，不能用 `items.length` 判断；成功空列表也属于
  resolved。
- `useV2ModuleQuery` 必须向区域透传受控 `phase`。统一阶段为
  `disabled | idle | initial-loading | ready | refreshing | transitioning | initial-error |
refresh-error`；业务组件不得重新组合多个布尔值猜测主查询状态。
- 查询状态必须同时记录 `requestedKey` 与 `displayedKey`。二者不同时属于参数过渡：旧快照继续展示但
  必须只读，分页器展示旧快照的页码和每页条数；只有新 key 成功后才能一起提交内容、总数和分页状态。
- 查询 key 必须由已规范化的分页、搜索、筛选和排序参数生成；同身份、同 scope、同 key 的并发读取
  必须复用一个请求，不同 key 不允许通过固定请求通道互相取消。
- 远程请求开始前不得清空已提交的列表、表格列或详情。筛选、排序和分页的新 key 尚无数据时，
  必须保留最后一次成功内容；新 key 成功后原子替换，失败时继续保留旧内容并显示可重试错误。
- 时间过去不等于缓存失效。`event-driven` 查询在没有 scope 版本变化时永久保持 clean；
  `event-with-deadline` 只允许在服务端返回的 `revalidateAt` 到达时失效。clean 缓存回访不得读取
  业务列表；dirty 的活跃查询保留旧内容并立即后台刷新，dirty 的非活跃查询只在进入页面时刷新。
- 数据库写入必须在业务事务内原子递增 `id_business_v2_scope_versions`；事务成功提交后，由 Node API
  通过受 JWT 保护的 `/api/realtime/events` SSE 通道广播精确 scope/version。事件不得包含订单、账号、
  手机号、卡号或其他业务行字段；没有浏览器订阅时不得额外读取版本表。
- SSE 正常连接时禁止固定读取版本接口或业务列表；服务端只允许发送不查询业务数据的连接心跳。
  实时连接断开后才允许每 15 秒读取 `/api/id-business-v2/change-versions` 补偿漏事件；重连、恢复联网、
  长时间隐藏后恢复时必须立即核对一次版本，SSE 恢复后停止降级轮询。
- 写命令必须显式声明实际变更的主 scope，禁止省略 scope 或默认递增全部数据域；衍生页面由
  `V2_SCOPE_DEPENDENCIES` 在客户端精确展开。应用首次读取版本只建立本地基线，不得把服务端已有版本
  误判为 35 个 scope 同时变更；仅后续差异才能标记相关查询为 dirty。
- 实时发布只允许使用写命令声明并已提交的 scope；禁止业务表级触发器或客户端自行扩大 scope，避免
  同一事务重复递增和过度刷新。推送失败不得回滚已经提交的业务事务，客户端通过版本快照完成补偿。
- 缓存 key 必须包含登录身份代际；失效必须中止旧读取并阻止旧响应回写，100ms 内合并同 scope
  事件。同 scope、同 key 的并发读取复用 Promise。最多保留 200 个非活跃查询条目，缓存仅在内存，
  退出登录或切换身份时清空并断开实时频道。
- 组件创建时必须同步读取同身份、同 scope、同 key 的已有缓存，回访不得先渲染一次骨架。服务端
  数据与界面草稿必须分离：只有订单录入通过显式路由声明使用 KeepAlive；普通列表、筛选、分页、
  页签、抽屉和弹窗随页面卸载，不得依赖全页面 KeepAlive。
- 读取请求的主反馈由 `V2AsyncRegion` 独占：首次请求显示内容形状骨架；已有内容的请求超过 120ms
  后只显示不遮挡内容的顶部进度线。手工刷新按钮请求期间只禁用，不得再显示 loading；搜索、筛选、
  分页、页签和自动轮询也不得额外显示全局“后台更新中”、旋转图标、浮动卡片或第二个区域指示器。
- 加载区域必须具有 `aria-busy`；状态文案通过 live region 或 `role="status"` 提供；动态动画必须
  支持 `prefers-reduced-motion`。
- 权限不仅控制组件可见性，也必须通过查询 `enabled` 阻止请求。权限未确认或无权访问时不得创建读取
  请求、命中旧身份敏感快照或短暂展示受保护内容。
- 抽屉详情等非模块主查询必须使用可中止、只允许最后一次请求提交的请求代次。切换实体时先清除上一
  实体详情；同一实体重试可保留旧详情。关闭抽屉、卸载页面或切换实体后，迟到响应不得回写。

## 3. 禁止写法

- 在 `app.mount()` 前等待 `initializeSession()`、`ensureSessionReady()`、`router.isReady()` 或
  组件集合预加载。
- 在 App 中 watch 会话、自行 push/replace 恢复路由，或在 `router.isReady().finally(...)` 中泄漏拒绝。
- 保留旧 `auth/session.ts`、Window 自定义 session event、分开 token/user 键或第二个会话 Promise/generation。
- 在 degraded/cold/blocked 状态绕过中央写门禁，或在恢复时自动重放之前失败的 POST。
- 在 `index.html` 中复制后台侧边栏、导航、顶部栏、表格或业务数据骨架。
- 在首次 `route-loading` 中短暂切换成另一套工作区占位，导致侧边栏、顶部栏或页面重心闪跳。
- 入口安装全量 Element Plus 插件或预加载完整工作区组件集合。
- 同一路由资源错误同时显示布局错误和 V2App 全屏错误，或在已有稳定页面时自动刷新。
- 空闲时、启动后或按固定列表批量预取全部 V2 路由；短暂掠过后不取消，或在省流量/2G 下推测预取。
- 路由预取时提前请求业务 API、写入浏览器持久化存储、显示路由进度或把失败误报成当前页面错误。
- 在 Router `afterEach` 中记录含糊的 `route-ready` 并把它解释成业务数据已经返回。
- V2 路由页面直接使用 `v-loading`、`el-skeleton`、`ElLoading`。
- 直接拼装 `<V2PageState state="loading">`，遗漏 `V2AsyncRegion.skeleton`，或复制页面专用
  skeleton、mask、overlay。
- 同一读取请求同时显示按钮 loading、全局更新文案与区域进度，或恢复右上角浮动刷新卡片、旋转
  指示器和内容蒙层。
- 在 `onActivated` 中绕过统一查询状态机无条件调用页面加载函数。
- 因固定 15/30/60 秒 TTL 或导航切换重新读取 clean 业务列表；用完整列表轮询代替 scope 版本校验。
- 对全部 V2 路由统一套用 KeepAlive，或把服务端响应、敏感数据、订单草稿写入浏览器持久化存储。
- 请求开始时执行 `items = []`、销毁表格 `key` 或用空白占位替换已有内容。
- 缓存命中仍显示 loading，或把刷新失败、权限失败显示成“暂无数据”。
- 为绕过检查添加无说明例外。确需例外时必须先建立清理任务并写明期限。

## 4. 新页面示例

```vue
<V2AsyncRegion
  skeleton="table"
  :phase="ordersQuery.phase"
  :previous-data="ordersQuery.isParameterTransition"
  :error="loadError"
  loading-title="正在加载订单"
  refreshing-title="正在更新订单"
  error-title="订单加载失败"
  @retry="loadOrders"
>
  <OrderList :items="items" />
</V2AsyncRegion>

<AppButton title="刷新订单" :disabled="ordersQuery.isRefreshing" @click="loadOrders">
  刷新
</AppButton>
```

```ts
const ordersQuery = useV2ModuleQuery({
  moduleKey: 'orders',
  scope: 'orders',
  key: () => createV2QueryKey(normalizeOrdersQuery(query)),
  query: ({ signal }) => ordersApi.list(normalizeOrdersQuery(query), { signal })
});

const items = computed(() => ordersQuery.data.value?.items ?? []);
const displayedPage = computed(() => ordersQuery.data.value?.page ?? query.page);
const displayedPageSize = computed(() => ordersQuery.data.value?.pageSize ?? query.pageSize);
```

新增或修改 V2 页面后必须运行：

```bash
npm run typecheck --workspace @apple-business/admin
npm run lint --workspace @apple-business/admin
npm run build --workspace @apple-business/admin
npm run check:v2-loading-standard
npm run acceptance:v2-navigation-performance
npm run acceptance:v2-realtime
```

`acceptance:v2-navigation-performance` 需要本地 API 和测试账号；缺少运行条件时必须明确记录未执行，
不能把静态检查或本地 mock 当成真实登录通过。

变化同步由 `changeSync.spec.ts` 验证 scope/version 精度、BigInt 比较和首次基线行为；
线上巡检只执行只读版本接口，不修改业务行。
