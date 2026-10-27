import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

// Only this complete publication-control batch can reuse the reviewed source CI.
export const rechargeAutofillControls = Object.freeze([
  '.github/workflows/recharge-autofill-publication.yml',
  'scripts/ci-recharge-autofill-scope.mjs',
  'scripts/ci-recharge-autofill-scope.test.mjs',
  'scripts/ci-recharge-scope.mjs',
  'scripts/ci-recharge-check.mjs',
  'scripts/ci-recharge-check.test.mjs',
  'docs/RECHARGE_AUTOFILL_RELEASE_20261026.md',
  ...['release.py', 'publication.py', 'build.py', 'release.test.py', 'contract.json'].map(
    (suffix) => 'scripts/production-release/recharge-autofill-' + suffix
  )
]);
export function isRechargeAutofillControlsOnly(paths) {
  return (
    new Set(paths).size === paths.length &&
    rechargeAutofillControls
      .filter((p) => !p.startsWith('scripts/ci-'))
      .every((p) => paths.includes(p)) &&
    paths.every((p) => rechargeAutofillControls.includes(p))
  );
}

// Exact application batch: any additional, missing or altered source restores ordinary CI.
export const rechargeAutofillReviewedSources = Object.freeze({
  'apps/admin/src/v2/features/auto-recharge/RechargeBrowserSettings.vue':
    '0011b117164bfbbc2761cc00cb13a0e0a6bebf920c9769663c1219848331c20d',
  'apps/admin/src/v2/features/auto-recharge/RechargeSubmission.vue':
    'c0f54a161b4a042daedfd6cc51f8b95a7530bc74bc8df382d3be5d73e2088121',
  'apps/admin/src/v2/features/auto-recharge/V2AutoRechargeView.vue':
    '67766475aefb93fc35eb16a8db9c55dfe8cd17a9969b20913ac4d41c5e7bc590',
  'apps/admin/src/v2/features/auto-recharge/V2SavedPaymentCardField.vue':
    'dea299410ecad10ed025361ed15c7aa96e85f888cfbedae76a91972090029740',
  'apps/admin/src/v2/features/auto-recharge/bank-recharge-api.ts':
    '1d751b36c5460ef6c57c8e8a152edcd198655776e88f12b4699ef1859ece1ec0',
  'apps/admin/src/v2/features/auto-recharge/bitbrowser-catalog-rejection.spec.ts':
    '1ba05e9e5ee1553df5e5fe27aa74c323c619f3ffa4a8fcd3d0c40737c7f817f2',
  'apps/admin/src/v2/features/auto-recharge/bitbrowser-direct-api.ts':
    'be81d4cff308ec9489904de84bb77742e823856d29d39d827c921f26c4b16369',
  'apps/admin/src/v2/features/auto-recharge/useAutoRecharge.spec.ts':
    '32000b907ede3cb541ef2de168fb14e7f846344ca712bc52fd4b497b1a4b1b3e',
  'apps/admin/src/v2/features/auto-recharge/useAutoRecharge.ts':
    '6130cfa3661cac9463677e315008af143126d9ea43d25ce5c1f2dd67b8507e26',
  'apps/admin/src/v2/features/auto-recharge/useRechargeBrowserSettings.spec.ts':
    '1ab72722ba579148d920e23139230645a834da77004f349bda88ce028129b0b1',
  'apps/admin/src/v2/features/auto-recharge/useRechargeBrowserSettings.ts':
    '3e0407f3547aef3db49c1752bd3602c79f30bd57b4da8db76b7154d780224fae',
  'apps/admin/src/v2/features/auto-recharge/useRechargeCardCvc.spec.ts':
    '8fe054903b1c648071b7c0c81331d95c674ec85d703c065cd0fd8cd73185ed86',
  'apps/admin/src/v2/features/auto-recharge/useRechargeCardCvc.ts':
    '1a6f3ad9543f508921171d01cb49ef075fa8b69dc1919c56d113006a116c0b49',
  'apps/admin/src/v2/features/online-recharge/sections.ts':
    '513305c346d3f5bc91d30119d5ea77617ab1848a9d80a30a0c2fa13a1767e05b',
  'apps/api/src/id-business-v2/auto-recharge/recharge-settings-selection.spec.ts':
    '9113c09f2ec4e3c68094d7df7cab76de03766cda3886f70788159ad25637aa93',
  'apps/api/src/id-business-v2/auto-recharge/recharge-settings.service.ts':
    '3952a84de4a73499e676d8c064a79a4455e24e8ab79dea55e9884707fb070431',
  'apps/api/src/id-business-v2/auto-recharge/recharge-settings.spec.ts':
    '8ea54bea91a703c5b207cc0af6ec97110b3e00eeb7b6e39539ca8fd011cf626d',
  'apps/api/src/id-business-v2/online-recharge/assets.service.ts':
    '7d6090e395375aac6eeefca2ddc93ef39b86645bc7ac552f55b04ce98dd8e70a',
  'apps/api/src/id-business-v2/online-recharge/bitbrowser-card-credentials.spec.ts':
    'bbd8f1e7d2daebbb6d20bec3117a4a8b2939cc03cec8d1908299a38171a12ebd',
  'apps/api/src/id-business-v2/online-recharge/engine/README.md':
    '8229b6f4af3fe6f262246030a580e000830427615d94ab6b7530f007ee51fc7f',
  'apps/api/src/id-business-v2/online-recharge/engine/SOURCE_MANIFEST.json':
    'c6f37fbe05180282a1da8ddbb53a15e74fbef9b67ca5ce3b9d512064e50a3de6',
  'apps/api/src/id-business-v2/online-recharge/engine/credentials.cjs':
    '469e544509c6602cb2f5a27756f8ee76f8011b066a9d7d2fa8976b2d28eb193b',
  'apps/api/src/id-business-v2/online-recharge/ephemeral-credentials.service.ts':
    '7f35a03209c2151c1ed8b25f1d53ad719ce8619445de8ce3984d705895e337ee',
  'apps/api/src/id-business-v2/online-recharge/ephemeral-credentials.spec.ts':
    '42c4d7a8386de5fe995c31f63ba22828d217ef71e1ad3c4cb84c62713dc35d7f',
  'apps/api/src/id-business-v2/online-recharge/persistence/assets.repository.ts':
    '0ebebf621da783e1d1a92f343f24955388b125aedf69df3ba59de4748d7fcb89',
  'docs/AUTO_RECHARGE.md': 'da4f0c41ce16d74e283da2178a6f0d230f3384c28c790d374f1d279d732f5b0a',
  'docs/V2_TASKS.md': '0d7abd75a09c97e0e08aef03ac094db034042419a9a22100e62d08ace8f7c334'
});
export const rechargeAutofillSourcePaths = Object.freeze([
  ...Object.keys(rechargeAutofillReviewedSources),
  'scripts/ci-recharge-autofill-scope.mjs',
  'scripts/ci-recharge-autofill-scope.test.mjs',
  'scripts/ci-recharge-scope.mjs',
  'scripts/ci-recharge-check.mjs',
  'scripts/ci-recharge-check.test.mjs'
]);
const sourceDigest = (name) =>
  createHash('sha256')
    .update(readFileSync(new URL('../' + name, import.meta.url)))
    .digest('hex');
export function isRechargeAutofillSourceOnly(paths, digest = sourceDigest) {
  if (
    paths.length !== rechargeAutofillSourcePaths.length ||
    new Set(paths).size !== paths.length ||
    !rechargeAutofillSourcePaths.every((p) => paths.includes(p))
  )
    return false;
  try {
    return Object.entries(rechargeAutofillReviewedSources).every(
      ([name, hash]) => digest(name) === hash
    );
  } catch {
    return false;
  }
}
const npm = (...args) => ['npm', args];
const api = 'apps/api';
const admin = 'apps/admin';
const engine = api + '/src/id-business-v2/online-recharge/engine';
const aptTransport = `set -eu
 test -f /etc/apt/apt-mirrors.txt
 for target in /etc/apt/apt-mirrors.txt /etc/apt/apt-mirrors-security.txt; do
   if [ -f "$target" ]; then
     sed -i 's#http://azure.archive.ubuntu.com/ubuntu#https://archive.ubuntu.com/ubuntu#g' "$target"
   fi
 done
 printf 'Acquire::Retries "3";\nAcquire::http::Timeout "30";\nAcquire::https::Timeout "30";\n' > /etc/apt/apt.conf.d/99-id-business-ci-transport
`;
export function rechargeAutofillSourceCommands(part) {
  if (part === 'online-engine')
    return [
      npm('ci', '--ignore-scripts', '--no-audit', '--no-fund'),
      ['sudo', ['bash', '-c', aptTransport]],
      npm('ci', '--prefix', engine + '/upstream', '--ignore-scripts', '--no-audit', '--no-fund'),
      [
        'node',
        [engine + '/upstream/node_modules/playwright/cli.js', 'install', '--with-deps', 'chromium']
      ],
      [
        'sudo',
        [
          'apt-get',
          '-o',
          'Acquire::Retries=3',
          '-o',
          'Acquire::http::Timeout=30',
          '-o',
          'Acquire::https::Timeout=30',
          'install',
          '-y',
          '--no-install-recommends',
          'ffmpeg'
        ]
      ],
      npm('run', 'test:online-recharge:engine')
    ];
  const shared = npm('run', 'build', '--workspace', '@apple-business/shared');
  if (part === 'api')
    return [
      shared,
      npm('run', 'prisma:generate', '--workspace', api),
      npm('run', 'typecheck', '--workspace', api),
      npm(
        'run',
        'test',
        '--workspace',
        api,
        '--',
        'src/id-business-v2/auto-recharge/recharge-settings.spec.ts',
        'src/id-business-v2/auto-recharge/recharge-settings-selection.spec.ts',
        'src/id-business-v2/online-recharge/ephemeral-credentials.spec.ts',
        'src/id-business-v2/online-recharge/bitbrowser-card-credentials.spec.ts'
      ),
      npm('run', 'build', '--workspace', api)
    ];
  if (part === 'admin')
    return [
      shared,
      npm('run', 'typecheck', '--workspace', admin),
      npm(
        'run',
        'test',
        '--workspace',
        admin,
        '--',
        'bitbrowser-direct.spec.ts',
        'bitbrowser-catalog-rejection.spec.ts',
        'useRechargeCardCvc.spec.ts',
        'useAutoRecharge.spec.ts',
        'useRechargeBrowserSettings.spec.ts'
      ),
      npm('run', 'build', '--workspace', admin)
    ];
  if (part === 'guards')
    return [
      shared,
      npm(
        'exec',
        '--',
        'prettier',
        '--check',
        ...rechargeAutofillSourcePaths.filter((p) => /\.(?:ts|vue|mjs|json|md)$/.test(p))
      ),
      npm(
        'exec',
        '--',
        'eslint',
        ...rechargeAutofillSourcePaths.filter((p) => /\.(?:ts|vue|mjs|cjs)$/.test(p))
      ),
      [
        'node',
        [
          '--test',
          'scripts/ci-recharge-autofill-scope.test.mjs',
          'scripts/ci-recharge-scope.test.mjs',
          'scripts/ci-recharge-check.test.mjs',
          'scripts/ci-change-scope.test.mjs'
        ]
      ],
      ...[
        'check:admin-ui',
        'check:v2-ui-language',
        'check:v2-color-contrast',
        'check:v2-table-standard',
        'check:v2-loading-standard',
        'check:v2-module-architecture',
        'check:v2-isolation',
        'check:v2-decimal-standard',
        'check:v2-timezone-standard',
        'check:v2-prisma-runtime-boundary',
        'check:v2-concurrency-standard',
        'check:cloud-independence',
        'test:online-recharge:controls',
        'git:readiness'
      ].map((n) => npm('run', n))
    ];
  throw new Error('Unknown autofill source check part');
}
