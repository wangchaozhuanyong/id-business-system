import { createSSRApp, nextTick, reactive, ref, type Ref } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { V2MailProvider } from '@apple-business/shared';

const mocks = vi.hoisted(() => ({
  api: {
    createManagedMailbox: vi.fn(),
    createManagedMailboxBatch: vi.fn(),
    startMicrosoftMailboxAuthorization: vi.fn(),
    getMicrosoftMailboxAuthorizationStatus: vi.fn()
  },
  message: { success: vi.fn(), warning: vi.fn(), error: vi.fn() },
  refresh: vi.fn()
}));
vi.mock('element-plus/es/components/message-box/style/css.mjs', () => ({}));
vi.mock('element-plus/es/components/message-box/index.mjs', () => ({
  ElMessageBox: { confirm: vi.fn() }
}));
vi.mock('@/components/ui/AppButton.vue', () => ({ default: {} }));
vi.mock('@/components/ui/FeatureHelp.vue', () => ({ default: {} }));
vi.mock('@/v2/components/V2AsyncRegion.vue', () => ({ default: {} }));
vi.mock('@/v2/components/V2Table.vue', () => ({ default: {} }));
vi.mock('@/v2/components/V2TableActionColumn.vue', () => ({ default: {} }));
vi.mock('@/v2/components/V2TableColumn.vue', () => ({ default: {} }));
vi.mock('@/v2/api/workspace', () => ({ idBusinessV2WorkspaceApi: mocks.api }));
vi.mock('@/v2/services/elementPlusMessage', () => ({ ElMessage: mocks.message }));
vi.mock('@/v2/composables/useV2DrawerNavigation', () => ({ useV2DrawerNavigation: vi.fn() }));
vi.mock('@/v2/composables/useV2Query', () => ({
  createV2QueryKey: vi.fn(() => 'test-query'),
  useV2ModuleQuery: () => ({ data: ref(), error: ref(), refresh: mocks.refresh })
}));
vi.mock('@/v2/composables/useV2SessionDraft', () => ({
  useV2FormDraft: (_key: string, initial: () => object) => ({
    form: reactive(initial()),
    open: vi.fn(),
    beginSave: () => vi.fn()
  })
}));

import Panel from './V2ManagedMailboxPanel.vue';
import Batch from './V2ManagedMailboxBatchDrawer.vue';

type PanelState = {
  form: { email: string; provider: V2MailProvider; appPassword: string; label: string };
  formRef: Ref<{ validate: () => Promise<void> }>;
  submitMailbox: () => Promise<void>;
};
type BatchState = {
  provider: Ref<V2MailProvider>;
  batchText: Ref<string>;
  submit: () => Promise<void>;
  result: Ref<{ succeeded: number; failed: number } | null>;
};

// Run the actual SFC setup and submit handlers in a Vue instance, without a website or database.
async function withSetup<T>(component: unknown, props: object, check: (state: T) => Promise<void>) {
  let failure: unknown;
  const app = createSSRApp({
    async setup() {
      const state = (component as { setup: (props: object, context: object) => T }).setup(props, {
        expose: vi.fn(),
        emit: vi.fn(),
        slots: {},
        attrs: {}
      });
      // Keep the Vue instance alive while exercising its real watchers and handlers.
      try {
        await check(state);
      } catch (error) {
        failure = error;
      }
      return () => null;
    }
  });
  await renderToString(app);
  if (failure) throw failure;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.api.startMicrosoftMailboxAuthorization.mockResolvedValue({
    authorizationId: 'synthetic-authorization',
    authorizationUrl: 'https://login.microsoftonline.com/synthetic',
    expiresAt: new Date(Date.now() + 60_000).toISOString()
  });
  mocks.api.getMicrosoftMailboxAuthorizationStatus.mockResolvedValue({ status: 'succeeded' });
  vi.stubGlobal('window', {
    open: vi.fn(() => ({
      closed: false,
      opener: null,
      location: { assign: vi.fn() },
      close: vi.fn()
    }))
  });
});
afterEach(() => vi.unstubAllGlobals());

describe('mailbox provider routing', () => {
  it('routes an Outlook Apple Account address through Microsoft without sending its app password', async () => {
    await withSetup<PanelState>(Panel, {}, async (state) => {
      state.form.provider = 'icloud';
      state.form.appPassword = 'synthetic-password-must-not-be-sent';
      state.form.label = 'Apple Account';
      state.form.email = '  ExampleUser8609@Outlook.COM  ';
      await nextTick();
      expect(state.form.provider).toBe('microsoft');
      state.formRef.value = {
        validate: vi.fn(async () => {
          expect(state.form.email).toBe('ExampleUser8609@Outlook.COM');
        })
      };
      await state.submitMailbox();
      expect(mocks.api.startMicrosoftMailboxAuthorization).toHaveBeenCalledExactlyOnceWith({
        email: 'ExampleUser8609@Outlook.COM',
        label: 'Apple Account',
        mailboxId: undefined
      });
      expect(mocks.api.createManagedMailbox).not.toHaveBeenCalled();
      expect(JSON.stringify(mocks.api.startMicrosoftMailboxAuthorization.mock.calls)).not.toContain(
        'synthetic-password'
      );
    });
  });

  it('rechecks the service before validation if the user manually selected iCloud after entering Outlook', async () => {
    await withSetup<PanelState>(Panel, {}, async (state) => {
      state.form.email = 'sample@outlook.com';
      state.form.provider = 'icloud';
      state.formRef.value = {
        validate: vi.fn(async () => {
          expect(state.form.provider).toBe('microsoft');
          if (state.form.provider !== 'microsoft')
            throw new Error('Password field is still required');
        })
      };
      await state.submitMailbox();
      expect(mocks.api.startMicrosoftMailboxAuthorization).toHaveBeenCalledOnce();
      expect(mocks.api.createManagedMailbox).not.toHaveBeenCalled();
    });
  });

  it('retains the address and remark when Microsoft authorization fails', async () => {
    mocks.api.getMicrosoftMailboxAuthorizationStatus.mockResolvedValue({ status: 'failed' });
    await withSetup<PanelState>(Panel, {}, async (state) => {
      state.form.email = 'sample@outlook.com';
      state.form.label = 'Keep my draft';
      state.formRef.value = { validate: vi.fn().mockResolvedValue(undefined) };
      await state.submitMailbox();
      expect(state.form.email).toBe('sample@outlook.com');
      expect(state.form.label).toBe('Keep my draft');
      expect(mocks.api.createManagedMailbox).not.toHaveBeenCalled();
      expect(mocks.message.success).not.toHaveBeenCalled();
    });
  });

  it.each([
    ['member@gmail.com', 'gmail'],
    ['member@icloud.com', 'icloud']
  ] as const)('preserves the existing password flow for %s', async (email, provider) => {
    mocks.api.createManagedMailbox.mockResolvedValue({
      mailbox: { id: 'synthetic-mailbox' },
      buyerCredential: 'synthetic-query-code'
    });
    await withSetup<PanelState>(Panel, {}, async (state) => {
      state.form.email = email;
      state.form.appPassword = 'synthetic-app-password';
      state.formRef.value = { validate: vi.fn().mockResolvedValue(undefined) };
      await state.submitMailbox();
      expect(mocks.api.createManagedMailbox).toHaveBeenCalledExactlyOnceWith({
        email,
        provider,
        appPassword: 'synthetic-app-password',
        label: undefined
      });
      expect(mocks.api.startMicrosoftMailboxAuthorization).not.toHaveBeenCalled();
    });
  });

  it('keeps the explicit Microsoft choice for a company domain without guessing its host', async () => {
    await withSetup<PanelState>(Panel, {}, async (state) => {
      state.form.provider = 'microsoft';
      state.form.email = 'team@company.example';
      state.formRef.value = { validate: vi.fn().mockResolvedValue(undefined) };
      await state.submitMailbox();
      expect(mocks.api.startMicrosoftMailboxAuthorization).toHaveBeenCalledExactlyOnceWith({
        email: 'team@company.example',
        label: undefined,
        mailboxId: undefined
      });
      expect(mocks.api.createManagedMailbox).not.toHaveBeenCalled();
    });
  });

  it('routes a bare Outlook batch through individual Microsoft authorization', async () => {
    await withSetup<BatchState>(Batch, { modelValue: true }, async (state) => {
      state.provider.value = 'icloud';
      state.batchText.value = 'ExampleUser8609@outlook.com\nsecond@hotmail.com';
      await nextTick();
      expect(state.provider.value).toBe('microsoft');
      await state.submit();
      expect(mocks.api.startMicrosoftMailboxAuthorization).toHaveBeenCalledTimes(2);
      expect(mocks.api.createManagedMailboxBatch).not.toHaveBeenCalled();
      expect(state.result.value).toMatchObject({ succeeded: 2, failed: 0 });
    });
  });

  it('does not silently reinterpret a password column as a Microsoft remark', async () => {
    await withSetup<BatchState>(Batch, { modelValue: true }, async (state) => {
      state.provider.value = 'icloud';
      const source = 'sample@outlook.com----synthetic-private-password----remark';
      state.batchText.value = source;
      await state.submit();
      expect(state.batchText.value).toBe(source);
      expect(mocks.api.startMicrosoftMailboxAuthorization).not.toHaveBeenCalled();
      expect(mocks.api.createManagedMailboxBatch).not.toHaveBeenCalled();
      expect(JSON.stringify(mocks.message.warning.mock.calls)).not.toContain(
        'synthetic-private-password'
      );
      expect(mocks.message.warning).toHaveBeenCalledOnce();
    });
  });

  it('keeps mixed-service batches intact without sending either to the wrong service', async () => {
    await withSetup<BatchState>(Batch, { modelValue: true }, async (state) => {
      state.provider.value = 'microsoft';
      const source = 'sample@outlook.com\nsecond@icloud.com';
      state.batchText.value = source;
      await state.submit();
      expect(state.batchText.value).toBe(source);
      expect(mocks.api.startMicrosoftMailboxAuthorization).not.toHaveBeenCalled();
      expect(mocks.api.createManagedMailboxBatch).not.toHaveBeenCalled();
      expect(mocks.message.warning).toHaveBeenCalledOnce();
    });
  });
});
