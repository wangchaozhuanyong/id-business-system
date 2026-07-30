import { nextTick } from 'vue';
import type { FormInstance } from 'element-plus';
import { ElMessage } from '@/v2/services/elementPlusMessage';

type V2ValidationError = {
  message?: string;
};

type V2InvalidFields = Record<string, V2ValidationError[]>;

const validatingForms = new WeakSet<FormInstance>();
const focusableControlSelector = [
  'input:not([disabled]):not([type="hidden"])',
  'textarea:not([disabled])',
  'button:not([disabled])',
  '[role="combobox"]:not([aria-disabled="true"])',
  '[tabindex]:not([tabindex="-1"])'
].join(',');

export interface V2FormValidationFailure {
  fieldCount: number;
  firstField?: string;
  firstMessage?: string;
}

export async function validateV2Form(form: FormInstance | undefined): Promise<boolean> {
  if (!form || validatingForms.has(form)) return false;

  validatingForms.add(form);
  let invalidFields: V2InvalidFields | undefined;

  try {
    const valid = await form
      .validate((isValid, fields) => {
        if (!isValid) invalidFields = fields as V2InvalidFields | undefined;
      })
      .catch((error: unknown) => {
        if (isValidationFailure(error)) {
          invalidFields = error.fields;
        }
        return false;
      });

    if (valid) return true;

    const failure = resolveValidationFailure(form, invalidFields);
    if (failure.firstField) {
      form.scrollToField(failure.firstField);
    }

    await nextTick();
    focusFirstInvalidControl(form, failure.firstField);

    const firstMessage = failure.firstMessage ? `：${failure.firstMessage}` : '';
    ElMessage.warning(
      `表单有 ${Math.max(1, failure.fieldCount)} 项需要处理，已定位到第一项${firstMessage}`
    );
    return false;
  } finally {
    validatingForms.delete(form);
  }
}

function resolveValidationFailure(
  form: FormInstance,
  invalidFields?: V2InvalidFields
): V2FormValidationFailure {
  const invalidEntries = Object.entries(invalidFields ?? {});
  if (invalidEntries.length) {
    const [firstField, errors] = invalidEntries[0];
    return {
      fieldCount: invalidEntries.length,
      firstField,
      firstMessage: errors?.find((error) => error.message)?.message
    };
  }

  const invalidFormFields = form.fields.filter((field) => field.validateState === 'error');
  return {
    fieldCount: invalidFormFields.length,
    firstField: invalidFormFields[0]?.propString,
    firstMessage: invalidFormFields[0]?.validateMessage
  };
}

function focusFirstInvalidControl(form: FormInstance, firstField?: string) {
  if (!firstField) return;
  const field = form.getField(firstField);
  const control = field?.$el?.querySelector<HTMLElement>(focusableControlSelector);
  control?.focus({ preventScroll: true });
}

function isValidationFailure(error: unknown): error is { fields: V2InvalidFields } {
  return Boolean(
    error &&
    typeof error === 'object' &&
    'fields' in error &&
    typeof (error as { fields?: unknown }).fields === 'object'
  );
}
