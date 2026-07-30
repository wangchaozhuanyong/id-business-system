export function shouldEnableV2RealtimeChanges(
  configuredValue: string | undefined,
  supabaseConfigured: boolean
) {
  return configuredValue === 'true' && supabaseConfigured;
}
