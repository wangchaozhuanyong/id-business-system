import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createV2SearchCommit,
  registerV2SearchInput,
  resetV2SearchInputs
} from './useV2AutoSearch';

afterEach(() => vi.useRealTimers());
describe('统一自动搜索', () => {
  it('连续输入只提交最后一次，回车取消后续重复查询', () => {
    vi.useFakeTimers();
    const commit = vi.fn();
    const pending = createV2SearchCommit(commit);
    pending.schedule();
    vi.advanceTimersByTime(200);
    pending.schedule();
    vi.advanceTimersByTime(299);
    expect(commit).not.toHaveBeenCalled();
    pending.flush();
    vi.advanceTimersByTime(1000);
    expect(commit).toHaveBeenCalledTimes(1);
  });
  it('重置或卸载取消待提交查询，不影响其他列表', () => {
    vi.useFakeTimers();
    const commit = vi.fn();
    const pending = createV2SearchCommit(commit);
    const other = vi.fn();
    const unregister = registerV2SearchInput('accounts:keyword', pending.cancel);
    const unregisterOther = registerV2SearchInput('customers:keyword', other);
    pending.schedule();
    resetV2SearchInputs('accounts:');
    vi.runAllTimers();
    expect(commit).not.toHaveBeenCalled();
    expect(other).not.toHaveBeenCalled();
    unregister();
    unregisterOther();
  });
});
