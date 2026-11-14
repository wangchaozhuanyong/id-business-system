(() => {
  'use strict';
  const $ = id => document.getElementById('authorization-' + id);
  const form = $('form');
  const refresh = $('refresh');
  const submit = form.querySelector('button');
  const session = $('session');
  const agreement = $('confirm');
  const account = $('account');
  const help = document.querySelector('.partner-authorization-heading details');
  const match = /^#([a-f0-9-]{36})\.([A-Za-z0-9_-]{43})$/.exec(location.hash);
  const labels = {
    awaiting_authorization: '请核对合作方和套餐，填写目标账号的授权资料。',
    queued: '已受理，等待执行。',
    running: '正在处理充值。',
    succeeded: '充值已开通。',
    failed: '本次充值未完成，请联系合作方查询。',
    awaiting_review: '结果待核对，请查询原请求，避免重复提交。',
    expired: '授权已过期，请回原网站重新发起。'
  };
  const plans = { plus: 'Plus', pro_5x: 'Pro 100', pro_20x: 'Pro 200' };
  let submitting = false;
  let busy = false;
  let uncertain = false;
  function showAccount() {
    let email;
    try { email = JSON.parse(session.value)?.user?.email; } catch {}
    const valid = typeof email === 'string' && email.length <= 254 && email.includes('@');
    account.textContent = valid ? '目标账号 ' + email.replace(/^(.).*(@.*)$/, '$1***$2') : '';
    account.hidden = !valid;
    agreement.checked = false;
    agreement.disabled = !valid;
  }
  async function read(sendSession = false) {
    if (!match || busy) return;
    busy = true;
    submit.disabled = refresh.disabled = true;
    $('error').hidden = true;
    const [, id, ticket] = match;
    try {
      if (sendSession) submitting = true;
      const response = await fetch('/recharge/authorize/request', {
        method: 'POST', cache: 'no-store', credentials: 'omit', signal: AbortSignal.timeout(20_000),
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, ticket, ...(sendSession && { session: session.value }) })
      });
      const result = await response.json();
      if (!response.ok) {
        if (response.status >= 500) throw new Error('暂时无法确认结果，请查询原请求。');
        if (response.status === 410 || response.status === 404) {
          form.hidden = refresh.hidden = true;
          session.value = '';
        } else if (response.status === 409) {
          form.hidden = true;
          refresh.hidden = false;
          session.value = '';
          showAccount();
        }
        $('error').textContent = result.error;
        $('error').hidden = false;
        return;
      }
      uncertain = false;
      $('details').hidden = false;
      $('partner').textContent = result.partner || '—';
      $('plan').textContent = plans[result.plan] || '—';
      $('reference').textContent = result.id;
      $('status').textContent = labels[result.status] || labels.awaiting_review;
      form.hidden = result.status !== 'awaiting_authorization';
      refresh.hidden = !['queued', 'running', 'awaiting_review'].includes(result.status);
      if (form.hidden) {
        session.value = '';
        showAccount();
      }
    } catch (error) {
      if (submitting) {
        uncertain = true;
        session.value = '';
        showAccount();
        form.hidden = true;
      }
      refresh.hidden = false;
      $('error').textContent = uncertain ? '无法确认提交结果，请查询原请求。' : '暂时无法读取，请重试查询。';
      $('error').hidden = false;
    } finally {
      submitting = busy = false;
      submit.disabled = refresh.disabled = false;
    }
  }
  form.addEventListener('submit', event => {
    event.preventDefault();
    if (!uncertain && agreement.checked && form.reportValidity()) void read(true);
  });
  session.addEventListener('input', showAccount);
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && help.open) {
      help.open = false;
      help.querySelector('summary').focus();
    }
  });
  document.addEventListener('click', event => {
    if (help.open && !help.contains(event.target)) help.open = false;
  });
  refresh.addEventListener('click', () => void read());
  window.addEventListener('pagehide', () => {
    session.value = '';
    showAccount();
  });
  const dark = matchMedia('(prefers-color-scheme: dark)');
  const setTheme = () => { document.documentElement.dataset.theme = dark.matches ? 'dark' : 'light'; };
  dark.addEventListener('change', setTheme);
  setTheme();
  showAccount();
  if (match) void read();
  else $('status').textContent = '授权链接无效，请回原网站重新发起。';
})();
