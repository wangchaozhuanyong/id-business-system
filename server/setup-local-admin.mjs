import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { createLocalAuth, initializeLocalAdmin, localAdminEmail } from './local-auth.mjs';

const accountPath = fileURLToPath(new URL('../.runtime/local-auth.json', import.meta.url));
const { stdin, stderr } = process;

async function setup() {
  if (!stdin.isTTY || !stderr.isTTY) {
    throw new Error('请在本机终端运行此命令，并在隐藏输入提示中设置密码。');
  }
  if (createLocalAuth(accountPath)) {
    throw new Error('本机超级管理员已经初始化。');
  }
  const mutedOutput = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    }
  });
  const terminal = createInterface({ input: stdin, output: mutedOutput, terminal: true });
  const interrupt = new AbortController();
  terminal.once('SIGINT', () => interrupt.abort());
  terminal.once('close', () => interrupt.abort());

  async function ask(prompt) {
    stderr.write(prompt);
    try {
      return await terminal.question('', { signal: interrupt.signal });
    } finally {
      stderr.write('\n');
    }
  }

  try {
    stderr.write(`本机超级管理员邮箱 ${localAdminEmail}\n`);
    const password = await ask('输入新密码（至少 12 个字符，输入内容隐藏） ');
    if ((await ask('再次输入新密码 ')) !== password) throw new Error('两次密码不一致。');
    await initializeLocalAdmin(accountPath, {
      email: localAdminEmail,
      name: '本机超级管理员',
      password
    });
    stderr.write('本机超级管理员已初始化。刷新本机业务页面后即可登录。\n');
  } finally {
    terminal.close();
  }
}

try {
  await setup();
} catch (error) {
  const message =
    error.name === 'AbortError'
      ? '本机超级管理员初始化已取消。'
      : error.status === 400 || error.status === 409 || error.message.endsWith('。')
        ? error.message
        : '无法初始化本机超级管理员，请核对运行目录权限。';
  stderr.write(message + '\n');
  process.exitCode = 1;
}
