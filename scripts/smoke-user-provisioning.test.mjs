import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SMOKE_AUTH_ACTOR,
  SMOKE_AUTH_EMAIL,
  SMOKE_DISPLAY_NAME,
  SMOKE_ROLE_CODE,
  SMOKE_ROLE_DESCRIPTION,
  SMOKE_ROLE_NAME,
  SMOKE_USERNAME,
  RELEASE_SUPABASE_PROJECT_REF
} from './lib/cloudflare-release.mjs';
import {
  assertDedicatedSmokeBusinessUsers,
  assertDedicatedSmokeIdentity,
  assertDedicatedSmokeRole,
  assertDedicatedSupabaseAuthUser,
  assertSmokeProvisioningEnvironment
} from './lib/smoke-user-provisioning.mjs';

const dedicatedBusinessUser = {
  id: '11111111-1111-4111-8111-111111111111',
  username: SMOKE_USERNAME,
  displayName: SMOKE_DISPLAY_NAME,
  email: null,
  userRoles: [{ role: { code: SMOKE_ROLE_CODE } }]
};
const dedicatedRole = {
  code: SMOKE_ROLE_CODE,
  name: SMOKE_ROLE_NAME,
  description: SMOKE_ROLE_DESCRIPTION,
  userRoles: [{ user: { username: SMOKE_USERNAME } }]
};
const dedicatedAuthUser = {
  id: '22222222-2222-4222-8222-222222222222',
  email: SMOKE_AUTH_EMAIL,
  app_metadata: {
    id_business_system_actor: SMOKE_AUTH_ACTOR
  }
};

test('accepts only the fixed smoke username and server-side Supabase configuration', () => {
  const result = assertSmokeProvisioningEnvironment({
    AUTH_PROVIDER: 'supabase',
    SMOKE_TEST_USERNAME: SMOKE_USERNAME,
    SMOKE_TEST_PASSWORD: 'not-logged-by-test-value',
    DATABASE_URL: `postgresql://postgres.${RELEASE_SUPABASE_PROJECT_REF}:password@aws-0-us-west-1.pooler.supabase.com:5432/postgres?schema=public`,
    SUPABASE_URL: `https://${RELEASE_SUPABASE_PROJECT_REF}.supabase.co/`,
    SUPABASE_SECRET_KEY: `sb_secret_${'s'.repeat(24)}`
  });

  assert.equal(result.authProvider, 'supabase');
  assert.equal(result.supabaseUrl, `https://${RELEASE_SUPABASE_PROJECT_REF}.supabase.co`);
  assert.throws(
    () =>
      assertSmokeProvisioningEnvironment({
        AUTH_PROVIDER: 'local',
        SMOKE_TEST_USERNAME: 'employee',
        SMOKE_TEST_PASSWORD: 'not-logged-by-test-value'
      }),
    /必须固定/
  );
  assert.throws(
    () =>
      assertSmokeProvisioningEnvironment({
        AUTH_PROVIDER: 'local',
        SMOKE_TEST_USERNAME: SMOKE_USERNAME,
        SMOKE_TEST_PASSWORD: 'short'
      }),
    /至少包含 20/
  );
  assert.throws(
    () =>
      assertSmokeProvisioningEnvironment({
        AUTH_PROVIDER: 'supabase',
        SMOKE_TEST_USERNAME: SMOKE_USERNAME,
        SMOKE_TEST_PASSWORD: 'not-logged-by-test-value',
        DATABASE_URL: `postgresql://postgres.${RELEASE_SUPABASE_PROJECT_REF}:password@aws-0-us-west-1.pooler.supabase.com:5432/postgres`,
        SUPABASE_URL: `http://${RELEASE_SUPABASE_PROJECT_REF}.supabase.co/`,
        SUPABASE_SECRET_KEY: `sb_secret_${'s'.repeat(24)}`
      }),
    /HTTPS 项目根地址/
  );
  assert.throws(
    () =>
      assertSmokeProvisioningEnvironment({
        AUTH_PROVIDER: 'supabase',
        SMOKE_TEST_USERNAME: SMOKE_USERNAME,
        SMOKE_TEST_PASSWORD: 'not-logged-by-test-value',
        DATABASE_URL: `postgresql://postgres.${RELEASE_SUPABASE_PROJECT_REF}:password@aws-0-us-west-1.pooler.supabase.com:5432/postgres`,
        SUPABASE_URL: `https://${RELEASE_SUPABASE_PROJECT_REF}.supabase.co/`,
        SUPABASE_SECRET_KEY: 'short'
      }),
    /服务端管理配置/
  );
  assert.throws(
    () =>
      assertSmokeProvisioningEnvironment({
        AUTH_PROVIDER: 'supabase',
        SMOKE_TEST_USERNAME: SMOKE_USERNAME,
        SMOKE_TEST_PASSWORD: 'not-logged-by-test-value',
        DATABASE_URL:
          'postgresql://postgres.abcdefghijklmnopqrst:password@aws-0-us-west-1.pooler.supabase.com:5432/postgres',
        SUPABASE_URL: 'https://abcdefghijklmnopqrst.supabase.co/',
        SUPABASE_SECRET_KEY: `sb_secret_${'s'.repeat(24)}`
      }),
    /固定的生产 Supabase/
  );
});

test('accepts the legacy dedicated business user but rejects employee collisions and extra roles', () => {
  assert.equal(assertDedicatedSmokeBusinessUsers([dedicatedBusinessUser]), dedicatedBusinessUser);
  assert.throws(
    () =>
      assertDedicatedSmokeBusinessUsers([
        {
          ...dedicatedBusinessUser,
          displayName: '真实员工'
        }
      ]),
    /非专用业务用户/
  );
  assert.throws(
    () =>
      assertDedicatedSmokeBusinessUsers([
        {
          ...dedicatedBusinessUser,
          userRoles: [...dedicatedBusinessUser.userRoles, { role: { code: 'administrator' } }]
        }
      ]),
    /非专用业务用户/
  );
});

test('rejects a reused role code when it belongs to a non-smoke user', () => {
  assert.doesNotThrow(() => assertDedicatedSmokeRole(dedicatedRole));
  assert.throws(
    () =>
      assertDedicatedSmokeRole({
        ...dedicatedRole,
        userRoles: [{ user: { username: 'employee' } }]
      }),
    /非专用角色/
  );
});

test('requires exact V2AuthIdentity and protected Supabase app metadata ownership', () => {
  const identity = {
    userId: dedicatedBusinessUser.id,
    authUserId: dedicatedAuthUser.id,
    usernameNormalized: SMOKE_USERNAME,
    authEmail: SMOKE_AUTH_EMAIL
  };
  assert.doesNotThrow(() =>
    assertDedicatedSmokeIdentity(identity, {
      userId: dedicatedBusinessUser.id,
      authUserId: dedicatedAuthUser.id
    })
  );
  assert.doesNotThrow(() => assertDedicatedSupabaseAuthUser(dedicatedAuthUser));

  assert.throws(
    () =>
      assertDedicatedSmokeIdentity(
        {
          ...identity,
          userId: '33333333-3333-4333-8333-333333333333'
        },
        {
          userId: dedicatedBusinessUser.id,
          authUserId: dedicatedAuthUser.id
        }
      ),
    /绑定到其他账号/
  );
  assert.throws(
    () =>
      assertDedicatedSupabaseAuthUser({
        ...dedicatedAuthUser,
        app_metadata: {}
      }),
    /非专用 Supabase Auth 用户/
  );
});
