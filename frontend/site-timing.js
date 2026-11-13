(() => {
  'use strict';
  if (document.querySelector('meta[name="id-site-observations"]')?.content !== 'enabled') return;
  const pattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
  const outcome = (error, response) => {
    const status = error?.status ?? response?.status;
    return status >= 500 ? 'failed' : status >= 400 ? 'blocked' : status ? 'failed' : 'connection';
  };

  function start(activity) {
    const began = performance.now();
    let finished = false, requestId, received;
    return {
      response(response) {
        received = response;
        const id = response.headers?.get?.('X-ID-Diagnostic');
        requestId = pattern.test(id || '') ? id : undefined;
      },
      finish(error, response) {
        if (finished) return null;
        finished = true;
        const elapsed = Math.min(120_000, Math.max(0, Math.round(performance.now() - began)));
        const id = requestId || window.crypto?.randomUUID?.();
        if (!id || (activity === 'login' && !requestId)) return null;
        const result = error ? outcome(error, response || received) : 'ok';
        void window.fetch('/api/local/site-management/timing', {
          method: 'POST', keepalive: true, cache: 'no-store', credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id, activity, result, elapsed })
        }).catch(() => {});
        return result === 'ok' ? null : id;
      }
    };
  }

  function show(box, id) {
    if (!pattern.test(id || '') || !box?.isConnected) return;
    const line = document.createElement('span');
    line.className = 'site-diagnostic-reference';
    const number = document.createElement('span');
    const value = document.createElement('span');
    value.textContent = id;
    number.append('诊断编号 ', value);
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'button compact';
    copy.textContent = '复制编号';
    copy.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(id);
        copy.textContent = '已复制';
      } catch {
        copy.textContent = '请手动复制';
        const range = document.createRange();
        range.selectNodeContents(value);
        getSelection()?.removeAllRanges();
        getSelection()?.addRange(range);
      }
    });
    line.append(number, copy);
    box.append(line);
  }

  window.IDSiteTiming = Object.freeze({ start, show });
})();
