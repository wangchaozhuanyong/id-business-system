import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FormInstance } from 'element-plus';
import { ElMessage } from '@/v2/services/elementPlusMessage';
import { validateV2Form } from './formValidation';

vi.mock('@/v2/services/elementPlusMessage', () => ({
  ElMessage: {
    warning: vi.fn()
  }
}));

beforeEach(() => {
  vi.clearAllMocks();
});

function createInvalidForm() {
  const focus = vi.fn();
  const scrollToField = vi.fn();
  const form = {
    fields: [],
    validate: vi.fn(async (callback) => {
      callback?.(false, {
        countryId: [{ message: '请选择国家', field: 'countryId' }],
        customerId: [{ message: '请选择客户', field: 'customerId' }]
      });
      return false;
    }),
    scrollToField,
    getField: vi.fn(() => ({
      $el: {
        querySelector: () => ({ focus })
      }
    }))
  } as unknown as FormInstance;

  return { form, focus, scrollToField };
}

describe('validateV2Form', () => {
  it('reports every invalid field and focuses the first one', async () => {
    const { form, focus, scrollToField } = createInvalidForm();

    await expect(validateV2Form(form)).resolves.toBe(false);

    expect(scrollToField).toHaveBeenCalledWith('countryId');
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(ElMessage.warning).toHaveBeenCalledWith(
      '表单有 2 项需要处理，已定位到第一项：请选择国家'
    );
  });

  it('returns true without warning when the form is valid', async () => {
    const form = {
      fields: [],
      validate: vi.fn(async () => true),
      scrollToField: vi.fn(),
      getField: vi.fn()
    } as unknown as FormInstance;

    await expect(validateV2Form(form)).resolves.toBe(true);
    expect(ElMessage.warning).not.toHaveBeenCalled();
  });

  it('fails closed when no form instance is available', async () => {
    await expect(validateV2Form(undefined)).resolves.toBe(false);
  });

  it('prevents concurrent validation of the same form', async () => {
    let release: ((value: boolean) => void) | undefined;
    const form = {
      fields: [],
      validate: vi.fn(
        () =>
          new Promise<boolean>((resolve) => {
            release = resolve;
          })
      ),
      scrollToField: vi.fn(),
      getField: vi.fn()
    } as unknown as FormInstance;

    const first = validateV2Form(form);
    await expect(validateV2Form(form)).resolves.toBe(false);
    release?.(true);
    await expect(first).resolves.toBe(true);
    expect(form.validate).toHaveBeenCalledTimes(1);
  });
});
