export interface V2OperatorAccount {
  username?: string | null;
}

export function operatorUsername(
  operator?: V2OperatorAccount | null,
  fallback: 'system' | 'dash' = 'dash'
) {
  return operator?.username || (fallback === 'system' ? '系统' : '—');
}
