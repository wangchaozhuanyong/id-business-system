import assert from 'node:assert/strict';
import { readFile, readdir, stat } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { retailAccess } from '../server/access-roles.mjs';
import { websitePages } from '../modules/website/pages.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));

async function sources(directory) {
  const entries = await readdir(resolve(root, directory), { withFileTypes: true });
  const groups = await Promise.all(entries.filter(entry => entry.name !== 'vendor').map(entry => {
    const path = directory + '/' + entry.name;
    return entry.isDirectory() ? sources(path) : [path];
  }));
  return groups.flat().filter(path => /\.(?:mjs|ts)$/.test(path) && !/\.test\./.test(path));
}

test('back-end and shared business rules cannot depend on browser entry points', async () => {
  const files = (await Promise.all(['server', 'modules'].map(sources))).flat();
  for (const file of files) {
    const path = resolve(root, file);
    const content = await readFile(path, 'utf8');
    const modules = content.matchAll(/\b(?:from\s+|import\s*(?:\(\s*)?)['"](\.{1,2}\/[^'"\n]+)['"]/g);
    for (const [, dependency] of modules) {
      const target = relative(root, resolve(path, '..', dependency));
      assert(!target.startsWith('frontend/'), file + ' imports ' + target);
      if (file.startsWith('modules/') && file !== 'modules/recharge/codexdaichong/demo-site.mjs')
        assert(!target.startsWith('server/'), file + ' imports ' + target);
    }
  }
});

test('declared pages have unique routes and resources and share server permissions', async () => {
  for (const key of ['id', 'route', 'resource']) {
    const values = websitePages.map(page => page[key]);
    assert.equal(new Set(values).size, values.length, 'duplicate page ' + key);
    assert(values.every(value => typeof value === 'string' && value.length));
  }
  const clientSource = await readFile(resolve(root, 'frontend/local-data.js'), 'utf8');
  for (const page of websitePages) {
    assert.match(page.script, /^[a-z][a-z0-9-]+\.mjs$/);
    assert((await stat(resolve(root, 'frontend', page.script))).isFile());
    assert(clientSource.includes("'" + page.scope + "'"), 'missing data scope for ' + page.route);
    for (const role of ['super', 'admin', 'supervisor', 'finance', 'registrar', 'employee']) {
      const path = '/api/local/' + page.resource;
      for (const method of ['GET', 'POST', 'DELETE']) {
        assert.equal(retailAccess({ role }, path, method), page.roles.includes(role) && page.methods.includes(method),
          method + ' by ' + role + ' at ' + page.route);
      }
    }
  }
});
