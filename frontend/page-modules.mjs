import { websitePages } from '/assets/website/pages.mjs';

for (const page of websitePages) {
  if (page.feature && !document.querySelector('meta[name="id-' + page.feature + '"][content="enabled"]')) continue;
  window.IDDesignAPI.registerPage(page, attempt =>
    import('/assets/website/pages/' + page.script + (attempt ? '?retry=' + attempt : '')));
}
