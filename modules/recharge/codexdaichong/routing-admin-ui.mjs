export const routingAdminPanel = `
<div class="panel recharge-routing-panel" id="recharge-routing-panel">
  <h2 class="panel-title">套餐支付线路</h2>
  <p>支付地区决定币种和所需出口国家。先检查标注匹配的启用代理，再检查待标注旧代理。实测匹配后才创建任务。代理池完全为空时检查服务器直连出口。</p>
  ${Object.entries({ plus: 'Plus', pro100: 'Pro 100', pro200: 'Pro 200', pro500: 'Pro 500' }).map(([key, label]) => `
  <div class="form-group"><label for="route_plan_${key}">${label} 支付地区</label>
    <select class="asset-input" id="route_plan_${key}" aria-label="${label} 支付地区"><option value="">加载中…</option></select>
  </div>`).join('')}
  <div class="embedded-control-row">
    <button type="button" class="btn btn-primary" onclick="saveRechargeRouting(this)">保存套餐地区</button>
    <button type="button" class="btn btn-secondary" onclick="loadRechargeRouting().catch(error => showMessage(error.message, 'error'))">刷新线路配置</button>
    <button type="button" class="btn btn-secondary" onclick="checkRechargeLocal(this)">检测服务器直连</button>
  </div>
  <p id="route_config_status" role="status">正在载入套餐线路配置…</p>
  <p id="route_local_status" role="status"></p>
  <p id="route_config_history"></p>
</div>`;

export const checkoutServerDiagnostic = `
<section id="checkout-server-diagnostic" class="checkout-server-diagnostic" aria-labelledby="checkout-server-title">
  <div class="checkout-server-toolbar embedded-control-row">
    <h2 class="panel-title" id="checkout-server-title">服务器直连诊断</h2>
    <p>实测充值服务器的公网出口，并与当前套餐和代理池状态核对。无需 Session，检测不会创建浏览器调试任务。</p>
    <button type="button" class="btn btn-secondary" id="checkout-server-check" onclick="checkCheckoutServer()">检测服务器直连</button>
  </div>
  <dl class="checkout-server-facts">
    <div><dt>套餐要求</dt><dd id="checkout-server-required">—</dd></div>
    <div><dt>代理池</dt><dd id="checkout-server-pool">—</dd></div>
    <div><dt>服务器出口</dt><dd id="checkout-server-exit">—</dd></div>
    <div><dt>检测时间</dt><dd id="checkout-server-checked">—</dd></div>
  </dl>
  <p class="checkout-server-result" id="checkout-server-result" role="status">尚未检测服务器出口。</p>
</section>`;
