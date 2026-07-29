import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { build } from 'esbuild';

const rootDir = process.cwd();
const functionNameArgument = process.argv.find((argument) =>
  argument.startsWith('--function-name=')
);
const functionName = functionNameArgument?.slice('--function-name='.length) || 'v2-api';
if (!/^v2-api(?:-perf)?$/.test(functionName)) {
  throw new Error('function name must be v2-api or v2-api-perf');
}
const sourceFunctionDir = path.join(rootDir, 'supabase/functions/v2-api');
const functionDir = path.join(rootDir, `supabase/functions/${functionName}`);
const generatedClientDir = path.join(rootDir, 'apps/api/src/generated/prisma-supabase-edge');
const compiledBootstrapPath = path.join(
  rootDir,
  'apps/api/dist-cloudflare/cloudflare-v2-bootstrap.js'
);
const bundlePath = path.join(functionDir, 'bundle.mjs');
const wasmFileName = 'query_compiler_bg.wasm';
const compilerFileName = 'query_compiler_bg.js';

await mkdir(functionDir, { recursive: true });
if (functionDir !== sourceFunctionDir) {
  await copyFile(path.join(sourceFunctionDir, 'deno.json'), path.join(functionDir, 'deno.json'));
}
await rm(bundlePath, { force: true });
await rm(path.join(functionDir, wasmFileName), { force: true });
await rm(path.join(functionDir, compilerFileName), { force: true });

await build({
  entryPoints: [path.join(sourceFunctionDir, 'index.ts')],
  outfile: bundlePath,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'es2022',
  sourcemap: false,
  minify: true,
  legalComments: 'none',
  define: {
    __V2_FUNCTION_NAME__: JSON.stringify(functionName)
  },
  banner: {
    js: [
      "import { createRequire as __createRequire } from 'node:module';",
      "import { fileURLToPath as __fileURLToPath } from 'node:url';",
      "import { dirname as __pathDirname } from 'node:path';",
      "import { Buffer } from 'node:buffer';",
      "import __process from 'node:process';",
      'const require = __createRequire(import.meta.url);',
      'const __filename = __fileURLToPath(import.meta.url);',
      'const __dirname = __pathDirname(__filename);',
      'globalThis.global ??= globalThis;',
      'globalThis.Buffer ??= Buffer;',
      "Object.defineProperty(__process, 'env', { value: { ...Deno.env.toObject() }, configurable: true, enumerable: true, writable: true });",
      'globalThis.process = __process;',
      "if (typeof globalThis.process.pid !== 'number') Object.defineProperty(globalThis.process, 'pid', { value: 1 });"
    ].join(' ')
  },
  external: ['pg-native'],
  plugins: [
    {
      name: 'compiled-nest-bootstrap',
      setup(esbuild) {
        esbuild.onResolve({ filter: /^@v2-bootstrap$/ }, () => ({
          path: compiledBootstrapPath
        }));
      }
    },
    {
      name: 'nest-optional-packages',
      setup(esbuild) {
        esbuild.onResolve(
          {
            filter:
              /^(class-transformer|class-validator|@nestjs\/microservices(?:\/microservices-module)?|@nestjs\/websockets\/socket-module)$/
          },
          (args) => ({
            path: args.path,
            namespace: 'nest-optional'
          })
        );
        esbuild.onLoad({ filter: /.*/, namespace: 'nest-optional' }, () => ({
          contents: 'module.exports = {};',
          loader: 'js'
        }));
      }
    },
    {
      name: 'cloudflare-prisma-alias',
      setup(esbuild) {
        esbuild.onResolve({ filter: /^@cloudflare-prisma\// }, (args) => ({
          path: `${path.join(
            generatedClientDir,
            args.path.replace(/^@cloudflare-prisma\//, '')
          )}.ts`
        }));
      }
    }
  ]
});

// Supabase CLI scans quoted relative imports before executing the bundle. Nest's
// dependency error text contains a documentation-only "./some.service" import,
// which the scanner otherwise mistakes for a real file.
const bundle = await readFile(bundlePath, 'utf8');
await writeFile(bundlePath, bundle.replaceAll('./some.service', 'some.service'));

console.log(`Supabase ${functionName} bundle generated.`);
