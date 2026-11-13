import { websitePages } from '/assets/website/pages.mjs';

for (const page of websitePages) {
  window.IDDesignAPI.registerPage(page, attempt =>
    import('/assets/website/pages/' + page.script + (attempt ? '?retry=' + attempt : '')));
}
