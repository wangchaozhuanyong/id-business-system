export const routingAdminPanel = `
<div class="panel recharge-routing-panel" id="recharge-routing-panel">
  <h2 class="panel-title">套餐支付线路</h2>
  <p>支付地区决定币种和所需出口国家。启动前实测代理出口，只使用国家匹配的线路。代理池完全为空时才检查服务器直连出口；国家不匹配或检测失败就停止。运行中的任务沿用已选线路，充值步骤、换卡和美国账单地址保持原逻辑。</p>
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
