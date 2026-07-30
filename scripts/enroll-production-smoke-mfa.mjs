#!/usr/bin/env node
import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';
import { chmod, lstat, open, readFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import {
  SMOKE_AUTH_ACTOR,
  SMOKE_AUTH_EMAIL,
  SMOKE_USERNAME,
  classifySupabaseCredential,
  validateReleaseEnvironment
} from './lib/cloudflare-release.mjs';
import { createTotpCode, validateTotpSecret } from './lib/totp.mjs';

const secretsPath = path.resolve('.deploy/cloudflare-free.secrets.json');
const lockPath = path.resolve('.deploy/cloudflare-free.secrets.mfa.lock');
let lockHandle;
let lockCreated = false;
try {
  lockHandle = await open(lockPath, 'wx', 0o600);
  lockCreated = true;
  await lockHandle.writeFile(`${process.pid}\n`, 'utf8');
  await lockHandle.sync();
} catch (error) {
  await lockHandle?.close().catch(() => undefined);
  if (lockCreated) {
    await unlink(lockPath).catch(() => undefined);
  }
  if (error?.code === 'EEXIST') {
    throw new Error(
      '巡检 MFA 初始化已有任务执行或遗留锁；确认没有运行中的任务后再人工移除 .deploy/cloudflare-free.secrets.mfa.lock',
      { cause: error }
    );
  }
  throw new Error('无法创建巡检 MFA 初始化锁文件', { cause: error });
}

try {
  await enrollSmokeMfa();
} finally {
  await lockHandle.close().catch(() => undefined);
  await unlink(lockPath).catch(() => undefined);
}

async function enrollSmokeMfa() {
  const secretsStat = await lstat(secretsPath);
  if (!secretsStat.isFile() || secretsStat.isSymbolicLink() || (secretsStat.mode & 0o077) !== 0) {
    throw new Error('部署凭据必须是权限为 0600 的普通文件，不能是符号链接');
  }

  const originalSecretsContent = await readFile(secretsPath, 'utf8');
  const secrets = JSON.parse(originalSecretsContent);
  if (!secrets || typeof secrets !== 'object' || Array.isArray(secrets)) {
    throw new Error('部署凭据文件必须是 JSON 对象');
  }
  const environmentErrors = validateReleaseEnvironment({
    ...secrets,
    SMOKE_TEST_MFA_TOTP_SECRET:
      secrets.SMOKE_TEST_MFA_TOTP_SECRET || 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'
  });
  if (environmentErrors.length) {
    throw new Error(`巡检 MFA 初始化目标校验失败：${environmentErrors.join('；')}`);
  }
  const username = secrets.SMOKE_TEST_USERNAME?.trim();
  const password = secrets.SMOKE_TEST_PASSWORD;
  const supabaseUrl = secrets.SUPABASE_URL?.trim().replace(/\/+$/, '');
  const publishableKey =
    secrets.SUPABASE_PUBLISHABLE_KEY?.trim() || secrets.SUPABASE_ANON_KEY?.trim();
  if (
    username !== SMOKE_USERNAME ||
    typeof password !== 'string' ||
    password.length < 20 ||
    !supabaseUrl ||
    publishableKey.length < 20 ||
    classifySupabaseCredential(publishableKey) !== 'public'
  ) {
    throw new Error('巡检账号 MFA 初始化所需的固定账号、密码和 Supabase 公开配置不完整');
  }

  const client = createClient(supabaseUrl, publishableKey, {
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
      persistSession: false
    },
    global: {
      fetch: (input, init = {}) =>
        fetch(input, {
          ...init,
          signal: AbortSignal.timeout(10_000)
        })
    }
  });

  const signIn = await client.auth.signInWithPassword({
    email: SMOKE_AUTH_EMAIL,
    password
  });
  if (
    signIn.error ||
    !signIn.data.session ||
    signIn.data.user.email?.toLowerCase() !== SMOKE_AUTH_EMAIL ||
    signIn.data.user.app_metadata?.id_business_system_actor !== SMOKE_AUTH_ACTOR
  ) {
    throw new Error('固定巡检 Supabase 用户不存在、密码不正确或专用身份标记不匹配');
  }

  const factorsResult = await client.auth.mfa.listFactors();
  if (factorsResult.error || !factorsResult.data) {
    throw new Error('无法读取固定巡检账号的 Supabase MFA 状态');
  }
  const totpFactors = factorsResult.data.all.filter((factor) => factor.factor_type === 'totp');
  if (totpFactors.length > 1) {
    throw new Error('固定巡检账号存在多个 TOTP factor，必须先人工核对，脚本不会自动删除');
  }

  let factor = totpFactors[0];
  let secret = secrets.SMOKE_TEST_MFA_TOTP_SECRET?.trim() ?? '';
  let created = false;
  if (!factor) {
    if (secret) {
      throw new Error(
        '本地已有巡检 TOTP secret，但 Supabase 不存在对应 factor；请人工核对后再移除陈旧 secret'
      );
    }
    const enrollment = await client.auth.mfa.enroll({
      factorType: 'totp',
      friendlyName: 'ID Business production release smoke'
    });
    if (
      enrollment.error ||
      !enrollment.data ||
      enrollment.data.type !== 'totp' ||
      !validateTotpSecret(enrollment.data.totp.secret)
    ) {
      throw new Error('Supabase 巡检 TOTP factor 创建失败，未写入本地 secret');
    }
    factor = { id: enrollment.data.id };
    secret = enrollment.data.totp.secret;
    await writeSecretsAtomically(
      {
        ...secrets,
        SMOKE_TEST_MFA_TOTP_SECRET: secret
      },
      originalSecretsContent
    );
    created = true;
  }

  if (!validateTotpSecret(secret)) {
    throw new Error('本地巡检 TOTP secret 缺失或格式无效；脚本不会重置已存在的 factor');
  }
  const verification = await client.auth.mfa.challengeAndVerify({
    factorId: factor.id,
    code: createTotpCode(secret)
  });
  if (verification.error || !verification.data?.access_token) {
    throw new Error(
      created
        ? 'TOTP factor 已创建且 secret 已安全写入本地，但首次校验失败；请检查系统时间后使用同一文件重试'
        : '本地 TOTP secret 无法验证现有 factor；脚本不会自动轮换或删除'
    );
  }
  assertAal2(verification.data.access_token);
  const finalFactorsResult = await client.auth.mfa.listFactors();
  const finalTotpFactors = finalFactorsResult.data?.all.filter(
    (currentFactor) => currentFactor.factor_type === 'totp'
  );
  if (
    finalFactorsResult.error ||
    finalTotpFactors?.length !== 1 ||
    finalTotpFactors[0]?.id !== factor.id ||
    finalTotpFactors[0]?.status !== 'verified'
  ) {
    throw new Error('巡检账号最终不是唯一 verified TOTP factor，已停止完成初始化');
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        created,
        secretStoredLocally: true,
        username: SMOKE_USERNAME
      },
      null,
      2
    )
  );
}

async function writeSecretsAtomically(nextSecrets, expectedCurrentContent) {
  const temporaryPath = `${secretsPath}.${process.pid}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(temporaryPath, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(nextSecrets, null, 2)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    const currentStat = await lstat(secretsPath);
    const currentContent = await readFile(secretsPath, 'utf8');
    if (
      !currentStat.isFile() ||
      currentStat.isSymbolicLink() ||
      (currentStat.mode & 0o077) !== 0 ||
      currentContent !== expectedCurrentContent
    ) {
      throw new Error('本地部署凭据在 MFA 初始化期间已变化，已停止覆盖');
    }
    await rename(temporaryPath, secretsPath);
    await chmod(secretsPath, 0o600);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
    throw new Error('巡检 TOTP secret 无法安全写入本地 0600 凭据文件', {
      cause: error
    });
  }
}

function assertAal2(accessToken) {
  try {
    const claims = JSON.parse(
      Buffer.from(accessToken.split('.')[1] ?? '', 'base64url').toString('utf8')
    );
    if (claims.aal !== 'aal2') throw new Error();
  } catch {
    throw new Error('巡检 TOTP 校验未返回 AAL2 会话');
  }
}
