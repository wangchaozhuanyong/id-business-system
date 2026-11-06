/* Shared state for the signed-in account's toolbox. */
(() => {
  'use strict';

  const api = window.IDLocalData;
  if (!api) return;

  let document = null;
  let defaultShortcuts = [];
  let error = '';
  let reading;
  let saving = false;

  function accept(result) {
    if (document && result.version < document.version) return;
    const { shortcuts, phrases } = result.data;
    document = {
      version: result.version,
      data: {
        shortcuts:
          result.version === 0 && !shortcuts.length ? structuredClone(defaultShortcuts) : shortcuts,
        phrases
      }
    };
  }

  function load({ refresh = false } = {}) {
    if (reading) return reading;
    if (document && !refresh) return Promise.resolve();
    error = '';
    reading = api
      .load('toolbox')
      .then(accept)
      .catch((failure) => {
        error = failure.message || '无法读取个人工具与话术，请重试。';
        throw failure;
      })
      .finally(() => {
        reading = undefined;
      });
    return reading;
  }

  function conflict() {
    return Object.assign(new Error('个人资料已在其他窗口更新，请核对最新内容后再保存。'), {
      status: 409
    });
  }

  async function save(kind, expectedVersion, change, action) {
    if (!document) throw new Error('请先读取个人工具与话术。');
    if (saving) throw new Error('个人资料正在保存，请稍候。');
    if (expectedVersion !== document.version) throw conflict();
    const next = structuredClone(document.data);
    change(next[kind]);
    saving = true;
    try {
      accept(await api.save('toolbox', expectedVersion, next, { action }));
    } catch (failure) {
      if (failure.status !== 409) throw failure;
      await load({ refresh: true }).catch(() => {});
      throw conflict();
    } finally {
      saving = false;
    }
  }

  window.IDLocalToolbox = Object.freeze({
    setDefaultShortcuts: (rows) => {
      defaultShortcuts = structuredClone(rows);
    },
    current: () => document,
    error: () => error,
    load,
    save
  });
})();
