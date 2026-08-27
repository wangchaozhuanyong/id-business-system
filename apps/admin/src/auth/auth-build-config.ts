type AuthBuildEnvironment = Record<string, string | undefined>;

export function validateAuthBuildConfiguration(mode: string, env: AuthBuildEnvironment) {
  if (mode !== 'production') return;

  const authProvider = env.AUTH_PROVIDER?.trim() || 'local';
  if (authProvider !== 'local') throw new Error('AUTH_PROVIDER must be local');

  for (const [name, value] of Object.entries(env)) {
    if (name.startsWith('VITE_') && /(SERVICE_ROLE|SECRET_KEY)/.test(name) && value?.trim()) {
      throw new Error(`${name} must never be exposed to the frontend build`);
    }
  }
}
