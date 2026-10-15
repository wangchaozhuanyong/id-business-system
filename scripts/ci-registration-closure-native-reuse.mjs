import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

// Only the native PR520 receipt below can retain this failed run's completed
// parts. It never grants overall Quality success or production authority.
export const registrationNativeBinding = Object.freeze({
  repository: 'wangchaozhuanyong/id-business-system',
  pullRequest: 520,
  branch: 'codex/registration-closure-release-20261016',
  run: 38811407618,
  attempt: 1,
  base: '369c57fcb56f950c61b5fe4164a6c6d1d8102e95',
  head: '36b2a70c67c402d8d665e353a95d0ddc579e97a6',
  checkout: 'fcc841773770292c75a1ba39c5c4cb7385f9459f',
  tree: 'eaa0c88ab73409ca34fd5842828f01382e372044',
  jobs: { guards: 116685740224, api: 116685740240, admin: 116685740191, migration: 116685740232 },
  rawLogs: {
    guards: '677370f9083f5e5a2da280c1219fbcaa5a5585473965458aca5096184018f13b',
    api: '5631492e577595315443d0c75978387da3b0680bd69493ab839e5bba7cb42f80',
    admin: '8cae81c6ae4333c4478db0feb914ca9cca244b5cbcfb3a97f94f8a424892d78c',
    migration: 'b65a47df5e212bfd04e6cb4a1192599d31d7ca41d2a2c71d1e277502d2fa1d57'
  }
});

const contractPath = 'scripts/production-release/registration-closure-contract.json';
export const registrationNativeRepairPins = Object.freeze({
  'scripts/check-v2-decimal-standard.mjs':
    '02830830f190ca937e2f6ac36112f7389e4b3364a43cfd26439fe31a547f1c18',
  'scripts/check-v2-decimal-standard.test.mjs':
    'b222b4581459324ded1b10f1d5c36d7ec0c040fc9127789130e21c8c1a92e9ec',
  'scripts/check-v2-online-recharge-controls.test.mjs':
    'f9c5d3a8f56296f185b82b2caa23e8cf403d4142cf33a1b073c1094f2b27ea95',
  'scripts/production-release/registration-closure-build.py':
    '08202ad8d1828e8c36a5ea7ed6116d7803392bbffc7dedcdc52a5b35466073a2',
  'scripts/ci-registration-closure-scope.mjs':
    '1425869c9b0ce4dddf9eaef74828f47c289a7a26fab3f17f7ed7410e75fda67e',
  'scripts/ci-registration-closure-native-reuse.test.mjs':
    'b8b4d8e22a3fd05dca197413c1f579343e02aaf721e36abf2bf476c7b4064485'
});
export const registrationNativeIntegrations = Object.freeze({
  'scripts/ci-recharge-scope.mjs': {
    import:
      "import { readRegistrationNativeReuse } from './ci-registration-closure-native-reuse.mjs';\n",
    anchor:
      "  if (process.env.GITHUB_EVENT_NAME === 'pull_request') {\n    const migrationEvidence = reuseCombinedMigration(repo, event, mode, paths, currentTree);",
    addition:
      "  const registrationNativeEvidence = readRegistrationNativeReuse({\n    repo,\n    event,\n    base,\n    mode,\n    currentTree\n  });\n  if (registrationNativeEvidence) {\n    for (const part of ['admin', 'api', 'migration']) reused.add(part);\n    evidence.push(...registrationNativeEvidence.parts);\n  }\n"
  },
  'scripts/ci-recharge-check.mjs': {
    import:
      "import { readRegistrationNativeReuse } from './ci-registration-closure-native-reuse.mjs';\n",
    anchor: "const shared = () => npm('run', 'build', '--workspace', '@apple-business/shared');",
    addition:
      "// PR520 fixed native continuation starts here.\nif (\n  part === 'guards' &&\n  process.env.GITHUB_ACTIONS === 'true' &&\n  process.env.GITHUB_EVENT_NAME === 'pull_request' &&\n  process.env.GITHUB_REPOSITORY === 'wangchaozhuanyong/id-business-system' &&\n  base === '369c57fcb56f950c61b5fe4164a6c6d1d8102e95'\n) {\n  const registrationNativeEvidence = readRegistrationNativeReuse({\n    repo: process.env.GITHUB_REPOSITORY,\n    event: JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8')),\n    base,\n    mode,\n    currentTree: execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { encoding: 'utf8' }).trim()\n  });\n  if (registrationNativeEvidence) {\n    run('node', [\n      '--test',\n      'scripts/ci-registration-closure-native-reuse.test.mjs',\n      'scripts/ci-recharge-scope.test.mjs',\n      'scripts/ci-recharge-check.test.mjs',\n      'scripts/ci-recharge-checkout-scope.test.mjs',\n      'scripts/check-v2-decimal-standard.test.mjs'\n    ]);\n    run('python3', ['-B', 'scripts/production-release/registration-closure-release.test.py']);\n    const repaired = registrationNativeEvidence.changed.filter((path) => existsSync(path));\n    npm(\n      'exec',\n      '--',\n      'prettier',\n      '--check',\n      ...repaired.filter((path) => /\\.(?:mjs|json)$/.test(path))\n    );\n    npm('exec', '--', 'eslint', ...repaired.filter((path) => path.endsWith('.mjs')));\n    console.log('Authenticated PR520 guard prefix; continuing at the original failed command.');\n    const uiChecks = adminUiGuardChecks(mode, changed);\n    if (\n      changed.some(\n        (path) =>\n          path.includes('online-recharge') ||\n          /^scripts\\/check-v2-(?:table|loading|input-retention|decimal)-standard/.test(path)\n      )\n    )\n      npm('run', 'test:online-recharge:controls');\n    const architectureChecks = backendArchitectureGuardChecks(mode, changed);\n    for (const name of new Set([...uiChecks, ...architectureChecks])) npm('run', name);\n    if (!uiChecks.length && mode !== 'ci-only' && mode !== 'audit-retention') {\n      npm(\n        'run',\n        'check:v2-decimal-standard',\n        '--',\n        'apps/admin/src/v2/features/auto-recharge',\n        'apps/api/src/id-business-v2/auto-recharge',\n        'packages/shared/src/v2'\n      );\n      npm('run', 'check:v2-ui-language', '--', 'apps/admin/src/v2/features/auto-recharge');\n    }\n    console.log(\n      JSON.stringify({ prefixEvidence: registrationNativeEvidence.prefix, remainder: 'PASS' })\n    );\n    process.exit(0);\n  }\n}\n"
  }
});
const newPaths = new Set([
  'scripts/ci-registration-closure-native-reuse.mjs',
  'scripts/ci-registration-closure-native-reuse.test.mjs',
  'scripts/check-v2-decimal-standard.test.mjs'
]);
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const text = (bytes) => Buffer.from(bytes).toString('utf8');

export function validateRegistrationNativeEvidence(input, b = registrationNativeBinding) {
  const { run, jobs, checkout, logs } = input;
  if (
    run?.id !== b.run ||
    run.run_attempt !== b.attempt ||
    run.head_sha !== b.head ||
    run.event !== 'pull_request' ||
    run.path !== '.github/workflows/quality.yml' ||
    run.head_branch !== b.branch ||
    run.status !== 'completed' ||
    run.conclusion !== 'failure' ||
    run.repository?.full_name !== b.repository ||
    !run.pull_requests?.some((pr) => pr.number === b.pullRequest && pr.base?.sha === b.base) ||
    checkout?.sha !== b.checkout ||
    checkout.tree?.sha !== b.tree ||
    JSON.stringify(checkout.parents?.map((parent) => parent.sha)) !==
      JSON.stringify([b.base, b.head])
  )
    return false;
  for (const [part, id] of Object.entries(b.jobs)) {
    const selected = jobs.filter((job) => job.id === id);
    if (selected.length !== 1) return false;
    const job = selected[0],
      conclusion = part === 'guards' ? 'failure' : 'success';
    const step = (name, expected) =>
      job.steps?.filter(
        (item) => item.name === name && item.status === 'completed' && item.conclusion === expected
      ).length === 1;
    if (
      job.run_id !== b.run ||
      job.run_attempt !== b.attempt ||
      job.head_sha !== b.head ||
      job.name !== `recharge (${part})` ||
      job.status !== 'completed' ||
      job.conclusion !== conclusion ||
      !step('Checkout', 'success') ||
      !step('Install package dependencies', 'success') ||
      !step('Report reused passing check', 'skipped') ||
      !step('Check affected recharge part', conclusion) ||
      job.steps.filter((item) => item.conclusion === 'failure').length !==
        (part === 'guards' ? 1 : 0) ||
      !Buffer.isBuffer(logs[part]) ||
      logs[part].length > 16 * 1024 * 1024 ||
      sha(logs[part]) !== b.rawLogs[part]
    )
      return false;
    const lines = text(logs[part])
      .replace(/^\uFEFF/, '')
      .split('\n');
    const markers = lines
      .map((line, index) => (line.includes('git log -1 --format=%H') ? index : -1))
      .filter((index) => index >= 0);
    if (markers.length !== 1 || !lines[markers[0] + 1]?.trimEnd().endsWith(b.checkout))
      return false;
  }
  const guard = text(logs.guards);
  return (
    guard.includes('Ran 584 tests in 211.625s') &&
    guard.includes('ℹ tests 13') &&
    guard.includes('ℹ pass 11') &&
    guard.includes('ℹ fail 2') &&
    guard.includes('ReferenceError: useAuthStore is not defined') &&
    guard.includes('bank-recharge-registration-mirror.service.ts:419') &&
    guard.includes('Error: Command failed: npm run test:online-recharge:controls') &&
    guard.includes('scripts/ci-recharge-check.mjs:799:5')
  );
}

export function validateRegistrationNativeRepair({ changed, before, after, modes }) {
  const pins = registrationNativeRepairPins;
  const allowed = new Set([
    ...Object.keys(pins),
    ...newPaths,
    contractPath,
    'scripts/ci-recharge-scope.mjs',
    'scripts/ci-recharge-check.mjs'
  ]);
  if (
    !changed.length ||
    new Set(changed).size !== changed.length ||
    changed.some(
      (path) =>
        !allowed.has(path) ||
        modes[path]?.after !== '100644' ||
        (modes[path].before !== '100644' && !(newPaths.has(path) && modes[path].before === null))
    )
  )
    return false;
  for (const [path, digest] of Object.entries(pins))
    if (!changed.includes(path) || sha(after(path)) !== digest) return false;
  for (const [path, patch] of Object.entries(registrationNativeIntegrations)) {
    const source = text(before(path));
    if (
      !changed.includes(path) ||
      source.split(patch.anchor).length !== 2 ||
      text(after(path)) !==
        patch.import + source.replace(patch.anchor, patch.addition + patch.anchor)
    )
      return false;
  }
  try {
    const old = JSON.parse(text(before(contractPath))),
      current = JSON.parse(text(after(contractPath)));
    const additions = [
      'scripts/check-v2-decimal-standard.mjs',
      'scripts/check-v2-decimal-standard.test.mjs'
    ];
    if (
      !changed.includes(contractPath) ||
      additions.some(
        (path) =>
          Object.hasOwn(old.validationSources, path) ||
          current.validationSources[path] !== sha(after(path))
      )
    )
      return false;
    for (const path of additions) delete current.validationSources[path];
    if (JSON.stringify(current) !== JSON.stringify(old)) return false;
  } catch {
    return false;
  }
  return (
    changed.includes('scripts/ci-registration-closure-native-reuse.mjs') &&
    changed.includes('scripts/ci-registration-closure-native-reuse.test.mjs')
  );
}

export function readRegistrationNativeReuse({ repo, event, base, mode, currentTree }) {
  const b = registrationNativeBinding,
    pr = event?.pull_request;
  if (
    process.env.GITHUB_ACTIONS !== 'true' ||
    process.env.GITHUB_EVENT_NAME !== 'pull_request' ||
    repo !== b.repository ||
    pr?.number !== b.pullRequest ||
    pr.head?.ref !== b.branch
  )
    return undefined;
  if (
    base !== b.base ||
    pr.base?.sha !== b.base ||
    pr.head.repo?.full_name !== repo ||
    pr.base.repo?.full_name !== repo ||
    mode !== 'recharge'
  )
    throw new Error('PR520 native continuation scope changed');
  const command = (file, args, binary = false) =>
    execFileSync(file, args, {
      encoding: binary ? undefined : 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      stdio: ['pipe', 'pipe', 'pipe']
    });
  const git = (...args) => command('git', args).trim();
  const bytes = (revision, path) => command('git', ['show', revision + ':' + path], true);
  const gh = (suffix) => JSON.parse(command('gh', ['api', `repos/${repo}/${suffix}`]));
  if (
    !/^[a-f0-9]{40}$/.test(pr.head.sha || '') ||
    git('rev-parse', pr.head.sha + '^{tree}') !== currentTree ||
    git('rev-parse', b.head + '^{tree}') !== b.tree
  )
    throw new Error('PR520 native source tree changed');
  const changed = git('diff', '--name-only', b.tree, currentTree).split('\n').filter(Boolean);
  const modes = Object.fromEntries(
    changed.map((path) => [
      path,
      {
        before: git('ls-tree', b.tree, '--', path).split(' ')[0] || null,
        after: git('ls-tree', currentTree, '--', path).split(' ')[0] || null
      }
    ])
  );
  if (
    !validateRegistrationNativeRepair({
      changed,
      modes,
      before: (path) => bytes(b.tree, path),
      after: (path) => bytes(currentTree, path)
    })
  )
    throw new Error('PR520 native inputs changed outside the exact control repair');
  const run = gh(`actions/runs/${b.run}`),
    { jobs } = gh(`actions/runs/${b.run}/attempts/${b.attempt}/jobs?per_page=100`);
  const checkout = gh('git/commits/' + b.checkout);
  const logs = Object.fromEntries(
    Object.entries(b.jobs).map(([part, job]) => [
      part,
      command(
        'gh',
        ['api', '--allow-escape-sequences', `repos/${repo}/actions/jobs/${job}/logs`],
        true
      )
    ])
  );
  if (!validateRegistrationNativeEvidence({ run, jobs, checkout, logs }))
    throw new Error('PR520 original native evidence unavailable');
  const inputSha256 = sha(command('git', ['ls-tree', '-r', b.tree], true));
  const receipt = (part) => ({
    part,
    run: b.run,
    attempt: b.attempt,
    job: b.jobs[part],
    checkout: b.checkout,
    tree: b.tree,
    rawLogSha256: b.rawLogs[part],
    inputSha256
  });
  return {
    changed,
    parts: ['admin', 'api', 'migration'].map(receipt),
    prefix: {
      ...receipt('guards'),
      overallRunConclusion: 'failure',
      continueAt: 'npm run test:online-recharge:controls',
      prefixOnly: true
    }
  };
}
