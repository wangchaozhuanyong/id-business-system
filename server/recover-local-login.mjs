import { realpath } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { parseArgs } from 'node:util';
import { recoverLocalLogin } from './local-auth.mjs';

try {
  const { values } = parseArgs({ options: {
    accounts: { type: 'string' }, action: { type: 'string' }, employee: { type: 'string' }, confirm: { type: 'string' }
  } });
  if (!values.accounts || !isAbsolute(values.accounts) || await realpath(values.accounts) !== values.accounts)
    throw new Error('请提供员工资料文件的绝对真实路径');
  const result = recoverLocalLogin(values.accounts, { action: values.action, employeeId: values.employee, confirmation: values.confirm });
  console.log(JSON.stringify(result));
} catch (error) {
  console.error(error.status ? error.message : '未完成登录恢复，请核对运行账号、资料路径和权限');
  process.exitCode = 1;
}
