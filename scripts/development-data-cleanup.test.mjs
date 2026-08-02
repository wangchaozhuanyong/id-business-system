import assert from 'node:assert/strict';
import test from 'node:test';
import { assertLocalAcceptanceDatabase } from './lib/development-data-cleanup.mjs';

test('allows loopback API and PostgreSQL acceptance targets', () => {
  assert.doesNotThrow(() =>
    assertLocalAcceptanceDatabase(
      'http://127.0.0.1:3102/api',
      'postgresql://postgres:postgres@localhost:55432/v2802_acceptance?schema=public'
    )
  );
  assert.doesNotThrow(() =>
    assertLocalAcceptanceDatabase(
      'http://[::1]:3000/api',
      'postgresql://postgres:postgres@[::1]:5432/v2801_acceptance'
    )
  );
});

test('rejects a remote API even when the database is local', () => {
  assert.throws(
    () =>
      assertLocalAcceptanceDatabase(
        'https://production.example.com/api',
        'postgresql://postgres:postgres@127.0.0.1:5432/v2802_acceptance'
      ),
    /验收 API 必须使用/
  );
});

test('rejects a remote database even when the API is local', () => {
  assert.throws(
    () =>
      assertLocalAcceptanceDatabase(
        'http://localhost:3000/api',
        'postgresql://postgres:secret@db.production.example.com:5432/postgres'
      ),
    /禁止连接远程或生产数据库/
  );
});

test('rejects missing or malformed acceptance targets', () => {
  assert.throws(
    () => assertLocalAcceptanceDatabase('', 'postgresql://postgres@localhost/test'),
    /不能为空/
  );
  assert.throws(
    () => assertLocalAcceptanceDatabase('http://localhost:3000/api', 'not-a-url'),
    /格式不正确/
  );
});
