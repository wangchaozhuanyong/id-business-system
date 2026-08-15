/* global document, localStorage, location, sessionStorage, window */

(() => {
  try {
    const storedTheme = localStorage.getItem('id-business-v2-theme');
    const theme = storedTheme === 'light' || storedTheme === 'dark' ? storedTheme : 'light';
    document.documentElement.dataset.v2Theme = theme;
    document.documentElement.style.colorScheme = theme;
  } catch {
    document.documentElement.dataset.v2Theme = 'light';
    document.documentElement.style.colorScheme = 'light';
  }

  window.__V2_APP_MOUNTED__ = false;
  window.addEventListener('vite:preloadError', (event) => {
    if (window.__V2_APP_MOUNTED__) return;
    event.preventDefault();

    const buildId =
      document.querySelector('meta[name="v2-build-id"]')?.getAttribute('content') ||
      'unknown-build';
    let alreadyReloaded;
    try {
      const storageKey = 'apple-business:v2-preload-reload-build';
      alreadyReloaded = sessionStorage.getItem(storageKey) === buildId;
      if (!alreadyReloaded) sessionStorage.setItem(storageKey, buildId);
    } catch {
      alreadyReloaded = true;
    }

    if (!alreadyReloaded) {
      location.reload();
      return;
    }

    const status = document.querySelector('.v2-boot__status');
    const retry = document.querySelector('.v2-boot__retry');
    if (status) {
      status.textContent = '页面资源仍未加载成功，请检查网络后重试。';
      status.hidden = false;
    }
    if (retry) retry.hidden = false;
  });

  window.addEventListener('DOMContentLoaded', () => {
    document.querySelector('.v2-boot__retry')?.addEventListener('click', () => location.reload());
  });
  window.setTimeout(() => {
    if (window.__V2_APP_MOUNTED__) return;
    const retry = document.querySelector('.v2-boot__retry');
    if (retry) retry.hidden = false;
  }, 12000);
})();
