import { websitePages } from '/assets/website/pages.mjs';

const api = window.IDDesignAPI;
function cardPoolLoading() {
  if (api.state.actor?.role === 'super') return api.modules.operations.cardPool.render(true);
}

for (const page of websitePages) {
  if (page.feature && !document.querySelector('meta[name="id-' + page.feature + '"][content="enabled"]')) continue;
  api.registerPage(page, attempt =>
    import('/assets/website/pages/' + page.script + (attempt ? '?retry=' + attempt : '')),
    page.route === 'staff/finance/cards' ? cardPoolLoading : undefined);
}
