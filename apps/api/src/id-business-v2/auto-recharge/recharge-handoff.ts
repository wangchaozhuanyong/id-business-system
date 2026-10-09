import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  ServiceUnavailableException
} from '@nestjs/common';
import type {
  V2RechargeHandoffCommand,
  V2RechargeHandoffFrame,
  V2RechargeQuote
} from '@apple-business/shared';
import type { AuthenticatedUser } from '../../auth/auth.types';
import type {
  V2CommandTransactionManager,
  V2TransactionalAuditService
} from '../runtime/public-api';
import type { RechargeRepository } from './persistence/recharge.repository';
import { assertFinalQuote, object, uuidPattern } from './recharge-validation';
import { isRechargeWorkerConfigured } from './recharge-worker-client';

const keys = [
  'Tab',
  'Enter',
  'Space',
  'Backspace',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight'
];
const isUuid = (value: unknown): value is string =>
  typeof value === 'string' && uuidPattern.test(value);
const integer = (value: unknown, low: number, high: number) =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= low && value <= high;
const canonicalTime = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString() === value;

export function validateHandoffCommand(value: unknown): V2RechargeHandoffCommand {
  const input = object(value);
  const fields: Record<string, string[]> = {
    click: ['x', 'y'],
    key: ['key'],
    text: ['text'],
    scroll: ['deltaY']
  };
  const extra = fields[String(input.type)];
  if (
    !extra ||
    Object.keys(input).length !== 5 + extra.length ||
    Object.keys(input).some(
      (key) => !['commandId', 'sessionId', 'frameId', 'revision', 'type', ...extra].includes(key)
    ) ||
    !isUuid(input.commandId) ||
    !isUuid(input.sessionId) ||
    !isUuid(input.frameId) ||
    !integer(input.revision, 1, 1000000) ||
    (input.type === 'click' && (!integer(input.x, 0, 2047) || !integer(input.y, 0, 2047))) ||
    (input.type === 'key' && !keys.includes(String(input.key))) ||
    (input.type === 'text' &&
      (typeof input.text !== 'string' ||
        input.text.length < 1 ||
        input.text.length > 64 ||
        [...input.text].some(
          (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
        ))) ||
    (input.type === 'scroll' && (!integer(input.deltaY, -600, 600) || input.deltaY === 0))
  )
    throw new BadRequestException('验证操作无效，请刷新原验证窗口');
  return input as unknown as V2RechargeHandoffCommand;
}

export function assertHandoffJob(
  job: { ownerId: string; action: string; state: string; leaseUntil: Date; result: unknown },
  ownerId: string
) {
  if (job.ownerId !== ownerId) throw new ForbiddenException('无权操作此任务');
  const result = object(job.result);
  if (
    job.action !== 'server' ||
    job.state !== 'awaiting_human_verification' ||
    job.leaseUntil.getTime() <= Date.now() ||
    result.handoff_available !== true ||
    result.account_matched !== true ||
    !isUuid(result.handoff_session_id) ||
    !integer(result.handoff_generation, 1, 10) ||
    !['hcaptcha', 'bank'].includes(String(result.handoff_kind)) ||
    !canonicalTime(result.handoff_expires_at) ||
    Date.parse(result.handoff_expires_at) <= Date.now() ||
    result.recheck_only === true
  )
    throw new ConflictException('原验证窗口已结束，只能刷新或核对原单');
  return result;
}

export function validateHandoffFrame(value: unknown): V2RechargeHandoffFrame {
  const input = object(value);
  if (
    Object.keys(input).length !== 8 ||
    !isUuid(input.sessionId) ||
    !isUuid(input.frameId) ||
    !integer(input.revision, 1, 1000000) ||
    !['hcaptcha', 'bank'].includes(String(input.kind)) ||
    !integer(input.width, 1, 2048) ||
    !integer(input.height, 1, 2048) ||
    !canonicalTime(input.expiresAt) ||
    Date.parse(input.expiresAt) <= Date.now() ||
    Date.parse(input.expiresAt) > Date.now() + 301000 ||
    typeof input.image !== 'string' ||
    input.image.length > 1400000 ||
    !/^data:image\/jpeg;base64,\/9j\/[A-Za-z0-9+/]+={0,2}$/.test(input.image)
  )
    throw new ServiceUnavailableException('原验证画面暂不可用，请刷新');
  return {
    sessionId: input.sessionId,
    frameId: input.frameId,
    revision: input.revision as number,
    kind: input.kind as 'hcaptcha' | 'bank',
    image: input.image,
    width: input.width as number,
    height: input.height as number,
    expiresAt: input.expiresAt
  };
}

/** 验证操作无重发、无通用任务收据回退；画面和输入均不进入日志或持久记录。 */
export async function requestHandoffWorker(
  id: string,
  command?: V2RechargeHandoffCommand
): Promise<unknown> {
  if (!uuidPattern.test(id)) throw new BadRequestException('任务编号无效');
  if (!isRechargeWorkerConfigured()) throw new ServiceUnavailableException('服务器执行器尚未配置');
  const base = process.env.AUTO_RECHARGE_WORKER_URL ?? 'http://auto-recharge:8051';
  try {
    const response = await fetch(`${base}/jobs/${id}/handoff`, {
      method: command ? 'POST' : 'GET',
      redirect: 'error',
      cache: 'no-store',
      headers: {
        'Content-Type': 'application/json',
        'X-Recharge-Worker': process.env.AUTO_RECHARGE_WORKER_TOKEN!
      },
      ...(command ? { body: JSON.stringify(command) } : {}),
      signal: AbortSignal.timeout(8000)
    });
    if (!response.ok) throw new Error('handoff_unavailable');
    const raw = await response.text();
    if (Buffer.byteLength(raw) > 1500000) throw new Error('handoff_response_too_large');
    const value: unknown = JSON.parse(raw);
    if (!command) return validateHandoffFrame(value);
    const receipt = object(value);
    if (
      Object.keys(receipt).length !== 2 ||
      receipt.commandId !== command.commandId ||
      receipt.accepted !== true
    )
      throw new Error('handoff_receipt_mismatch');
    return { commandId: command.commandId, accepted: true as const };
  } catch {
    throw new ServiceUnavailableException(
      command
        ? '验证操作接收结果待核验，请刷新画面；不要重复提交该操作'
        : '原验证画面暂不可用，请刷新或核对原单'
    );
  }
}

interface HandoffDependencies {
  repository: RechargeRepository;
  transactions: V2CommandTransactionManager;
  audit: V2TransactionalAuditService;
}

export async function readRechargeHandoff(
  id: string,
  operator: AuthenticatedUser,
  deps: Pick<HandoffDependencies, 'repository'>
) {
  if (!uuidPattern.test(id)) throw new BadRequestException('任务编号无效');
  assertHandoffJob(await deps.repository.owned(id, operator.id), operator.id);
  const frame = await requestHandoffWorker(id);
  // 读取期间结束、取消或租约到期的旧画面不能再交给客户端操作。
  const result = assertHandoffJob(await deps.repository.owned(id, operator.id), operator.id);
  if (
    object(frame).sessionId !== result.handoff_session_id ||
    object(frame).kind !== result.handoff_kind ||
    object(frame).expiresAt !== result.handoff_expires_at
  )
    throw new ConflictException('原验证窗口已变化，请刷新');
  return frame;
}

export async function submitRechargeHandoff(
  id: string,
  input: unknown,
  operator: AuthenticatedUser,
  deps: HandoffDependencies
) {
  if (!uuidPattern.test(id)) throw new BadRequestException('任务编号无效');
  const command = validateHandoffCommand(input);
  await deps.transactions.execute(
    async (tx) => {
      await deps.repository.lock(tx);
      const job = await deps.repository.active(tx, id);
      const result = assertHandoffJob(job, operator.id);
      if (command.sessionId !== result.handoff_session_id)
        throw new ConflictException('原验证会话已变化，请刷新画面');
      await deps.audit.append(tx, {
        userId: operator.id,
        module: 'id_business_v2',
        action: 'id_business_v2.auto_recharge.handoff',
        objectType: 'recharge_job',
        objectId: id,
        afterData: {
          commandId: command.commandId,
          typeLabel: {
            click: '点击验证区域',
            key: '按验证键',
            text: '输入验证资料',
            scroll: '滚动验证区域'
          }[command.type]
        },
        remark: '本人操作原单验证区域，输入内容不记录'
      });
    },
    {
      changedScopes: ['auto-recharge'],
      requestId: command.commandId,
      operator,
      retryMode: 'none'
    }
  );
  return requestHandoffWorker(id, command);
}

export function serverHandoffProgressState(
  job: { state: string; leaseUntil: Date; nonceHash: string | null; result: unknown },
  report: Record<string, unknown>
) {
  const previous = object(job.result);
  if (report.handoff_available === true) {
    if (!isUuid(report.handoff_session_id) || !integer(report.handoff_generation, 1, 10))
      throw new ConflictException('人工验证会话无效');
    if (
      integer(previous.handoff_generation, 1, 10) &&
      (Number(report.handoff_generation) < Number(previous.handoff_generation) ||
        (report.handoff_generation === previous.handoff_generation &&
          (report.handoff_session_id !== previous.handoff_session_id ||
            report.handoff_kind !== previous.handoff_kind ||
            report.handoff_expires_at !== previous.handoff_expires_at ||
            previous.handoff_available === false)) ||
        (Number(report.handoff_generation) > Number(previous.handoff_generation) &&
          report.handoff_session_id === previous.handoff_session_id))
    )
      throw new ConflictException('旧验证窗口不能恢复操作');
    if (
      job.state === 'unknown' ||
      !['hcaptcha', 'bank'].includes(String(report.handoff_kind)) ||
      !canonicalTime(report.handoff_expires_at) ||
      Date.parse(report.handoff_expires_at) <= Date.now() ||
      Date.parse(report.handoff_expires_at) >
        Math.min(job.leaseUntil.getTime(), Date.now() + 301000)
    )
      throw new ConflictException('人工验证窗口已失效');
    if (
      canonicalTime(previous.handoff_expires_at) &&
      Date.parse(report.handoff_expires_at) > Date.parse(previous.handoff_expires_at)
    )
      throw new ConflictException('人工验证不能延长原等待时间');
    return 'awaiting_human_verification';
  } else if (report.handoff_available === false) {
    if (
      report.handoff_session_id !== previous.handoff_session_id ||
      report.handoff_generation !== previous.handoff_generation ||
      report.handoff_kind !== previous.handoff_kind ||
      report.handoff_expires_at !== previous.handoff_expires_at
    )
      throw new ConflictException('旧验证窗口不能结束当前验证');
    if (job.state !== 'awaiting_human_verification') return job.state;
    return previous.manual_confirmation_accepted === true ||
      previous.payment_attempted === true ||
      Number(previous.confirmation_requests_sent ?? 0) > 0
      ? 'confirming'
      : job.nonceHash
        ? 'awaiting_confirmation'
        : 'running';
  }
  return job.state;
}

export function serverQuoteConfirmationState(result: unknown, report: Record<string, unknown>) {
  void result;
  if (report.status !== 'awaiting_confirmation')
    throw new ConflictException('执行器未进入人工确认等待，已停止付款');
  return 'awaiting_confirmation';
}

export function assertManualServerConfirmationAllowed(
  job: { action: string; plan: string; leaseUntil: Date },
  result: Record<string, unknown>
) {
  if (job.action !== 'server') return;
  if (job.leaseUntil.getTime() <= Date.now())
    throw new ConflictException('执行窗口已结束，请核对原单');
  if (
    result.manual_confirmation_accepted === true ||
    result.payment_attempted === true ||
    Number(result.confirmation_requests_sent ?? 0) > 0 ||
    result.recheck_only === true
  )
    throw new ConflictException('本次确认已提交，禁止重复付款');
  const quote = object(result.quote) as unknown as V2RechargeQuote;
  assertFinalQuote(quote, job.plan, result.quote_authority, result);
  if (
    result.account_matched !== true ||
    quote.today?.currency !== result.locked_currency ||
    !quote.today ||
    quote.today.amount_minor <= 0
  )
    throw new ConflictException('官网身份或报价已变化，请核对原单');
}
