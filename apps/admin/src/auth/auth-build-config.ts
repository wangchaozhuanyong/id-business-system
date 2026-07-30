type AuthBuildEnvironment = Record<string, string | undefined>;

export function validateAuthBuildConfiguration(mode: string, env: AuthBuildEnvironment) {
  if (mode !== 'production') return;

  const authProvider = env.AUTH_PROVIDER?.trim() || 'local';
  if (authProvider !== 'local' && authProvider !== 'supabase') {
    throw new Error('AUTH_PROVIDER must be local or supabase');
  }

  const backendUrl = normalizeUrl(env.SUPABASE_URL);
  const frontendUrl = normalizeUrl(env.VITE_SUPABASE_URL);
  const frontendKey = firstValue(env.VITE_SUPABASE_ANON_KEY, env.VITE_SUPABASE_PUBLISHABLE_KEY);
  const serviceKey = firstValue(env.SUPABASE_SERVICE_ROLE_KEY, env.SUPABASE_SECRET_KEY);
  const hasAnyFrontendConfig = Boolean(frontendUrl || frontendKey);
  const hasCompleteFrontendConfig = Boolean(frontendUrl && frontendKey);

  for (const [name, value] of Object.entries(env)) {
    if (name.startsWith('VITE_') && /(SERVICE_ROLE|SECRET_KEY)/.test(name) && value?.trim()) {
      throw new Error(`${name} must never be exposed to the frontend build`);
    }
  }

  if (authProvider === 'local') {
    if (hasAnyFrontendConfig) {
      throw new Error(
        'AUTH_PROVIDER=local cannot be built with Supabase frontend authentication enabled'
      );
    }
    return;
  }

  if (!backendUrl || !hasCompleteFrontendConfig) {
    throw new Error(
      'AUTH_PROVIDER=supabase requires matching backend and frontend Supabase configuration'
    );
  }
  if (backendUrl !== frontendUrl) {
    throw new Error('Backend and frontend Supabase URLs must target the same project');
  }
  if (serviceKey && serviceKey === frontendKey) {
    throw new Error('Supabase service credentials must never be used as a frontend key');
  }
}

function firstValue(...values: Array<string | undefined>) {
  return values.map((value) => value?.trim()).find(Boolean) ?? '';
}

function normalizeUrl(value: string | undefined) {
  return value?.trim().replace(/\/$/, '') ?? '';
}
