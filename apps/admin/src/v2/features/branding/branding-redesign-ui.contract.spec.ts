import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import view from './V2BrandingSettingsView.vue?raw';
import overview from './components/V2BrandingOverview.vue?raw';
import preview from './components/V2BrandingPreview.vue?raw';
import api from '../../api/branding.ts?raw';
import manifest from './manifest.ts?raw';
import fixture from '../../testing/V2BrandingDesignFixture.vue?raw';

const brandingStyles = readFileSync(
  fileURLToPath(new URL('../../styles/branding.css', import.meta.url)),
  'utf8'
);

describe('branding scheme 3 redesign contract', () => {
  it('composes a status overview and aligned editor-preview workspace', () => {
    expect(view).toContain('<V2BrandingOverview');
    expect(view).toContain('class="v2-branding-workspace"');
    expect(view).toContain('<V2BrandingPreview :form="form"');
    expect(view).toContain('class="v2-branding-editor__section"');
    expect(view).toContain('require-asterisk-position="right"');
    expect(view).toContain('label-position="left"');
    expect(view).toContain('@/v2/styles/branding.css');
    expect(view).toContain('class="v2-branding-editor__status"');
  });

  it('preserves all eight branding fields, validation and live preview behavior', () => {
    for (const field of [
      'appName',
      'logoText',
      'logoUrl',
      'appSubtitle',
      'loginHeroTitle',
      'loginNote',
      'footerText',
      'documentTitleSuffix'
    ]) {
      expect(view).toContain(`prop="${field}"`);
    }
    expect(view).toContain('validateV2Form(formRef.value)');
    expect(view).toContain('splitV2BrandingHeroTitle(form.loginHeroTitle)');
    expect(view).toContain('Object.assign(form, V2_BRANDING_DEFAULTS)');
    expect(preview).toContain('form.documentTitleSuffix');
    expect(preview).toContain('v-for="(line, index) in heroLines"');
  });

  it('keeps the existing admin-only API and persistence boundary', () => {
    expect(manifest).toContain("requiredRoles: ['admin']");
    expect(api).toContain("http.get('/id-business-v2/branding', { signal: options.signal })");
    expect(api).toContain("http.patch('/id-business-v2/branding', input)");
    expect(overview).toContain("$emit('save')");
    expect(overview).toContain("$emit('reset-defaults')");
  });

  it('provides an interactive fixture without production requests', () => {
    expect(fixture).toContain('<V2BrandingOverview');
    expect(fixture).toContain('<V2BrandingPreview');
    expect(fixture).toContain('Object.assign(savedForm, form)');
    expect(fixture).toContain('已恢复默认内容，尚未保存。');
    expect(fixture).not.toContain('http.');
  });

  it('keeps the login preview synchronized with the active light or dark theme', () => {
    expect(preview).toContain('data-theme-branding-preview');
    expect(brandingStyles).toContain('background-color: var(--v3-login-bg)');
    expect(brandingStyles).toContain('color: var(--v3-login-text)');
    expect(brandingStyles).toContain('background: var(--v3-login-surface-soft)');
    expect(brandingStyles).not.toContain('background: #0d1b2a');
  });
});
