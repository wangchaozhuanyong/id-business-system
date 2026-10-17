export function rejectRetiredRegistrationExecution() {
  throw new Error('Automatic registration has been removed; registration execution is disabled');
}

// Historical release classifiers are retained as evidence, but cannot run the retired feature.
export function rejectRetiredRegistrationCommand(file, args = []) {
  const executable = args[1] === '--' ? args[2] : args[1];
  if (file === 'npm' && args[0] === 'exec' && ['prettier', 'eslint'].includes(executable)) return;
  const retired = [
    /(?:^|\/)auto-registration(?:\/|$)/u,
    /^auto-registration:(?:setup|local)$/u,
    /(?:^|\/)scripts\/(?:setup-auto-registration|start-auto-registration-local|acceptance-v2-registration-[^/]+)\.mjs$/u,
    /(?:^|\/)scripts\/production-release\/registration-[^/]+\.(?:py|mjs)$/u,
    /(?:^|\/)bank-recharge-registration-mirror\.service(?:\.spec)?\.ts$/u
  ];
  if ([file, ...args].some((value) => retired.some((pattern) => pattern.test(String(value)))))
    rejectRetiredRegistrationExecution();
}
