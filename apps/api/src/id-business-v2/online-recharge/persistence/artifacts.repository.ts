import { BadRequestException, Injectable, NotFoundException, StreamableFile } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { constants } from 'node:fs';
import { mkdir, open, realpath, writeFile } from 'node:fs/promises';
import { resolve, join, sep, dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { Prisma } from '@prisma/client';
import type { OnlineRechargeWorkerRpc } from '../contracts';
import { OnlineRechargeWorkerRepository } from './worker.repository';
import { OnlineRechargeRepository } from './online-recharge.repository';
import { id, object, text, safeBootstrapDiagnostics } from '../validation';
import type { AuthenticatedUser } from '../../../auth/auth.types';

// This existing diagnostic upload accepts enums/counts only, never field values or DOM.
function validFormDiagnostics(value: unknown): boolean {
  type RecordValue = Record<string, unknown>;
  const record = (v: unknown): v is RecordValue =>
    !!v && typeof v === 'object' && !Array.isArray(v);
  const count = (v: unknown, max = 10000) =>
    Number.isInteger(v) && Number(v) >= 0 && Number(v) <= max;
  const oneOf = (v: unknown, values: readonly string[]) =>
    typeof v === 'string' && values.includes(v);
  const readPhases = [
    'frame_scan',
    'candidate_handles',
    'candidate_eligibility',
    'value',
    'control_read'
  ];
  const errors = ['timeout', 'detached', 'context_destroyed', 'closed', 'aborted', 'read_failed'];
  if (!record(value) || Object.keys(value).some((key) => !['inspection', 'steps'].includes(key)))
    return false;
  if (!Array.isArray(value.steps) || value.steps.length > 32) return false;
  const stepEnums: Record<string, string[]> = {
    field: [
      'number',
      'expiry',
      'month',
      'year',
      'cvc',
      'country',
      'line1',
      'city',
      'postal',
      'name',
      'state'
    ],
    phase: ['locate', 'precheck', 'input', 'readback'],
    state: ['pending', 'completed', 'failed'],
    frameKind: ['main', 'embedded'],
    tag: ['input', 'select', 'textarea', 'other'],
    role: ['combobox'],
    locatorKind: [
      'id',
      'data-elements-stable-field-name',
      'data-testid',
      'autocomplete',
      'name',
      'label',
      'placeholder'
    ],
    method: ['fill', 'select_option', 'combobox'],
    readPhase: readPhases,
    errorClass: errors
  };
  if (
    value.steps.some(
      (step) =>
        !record(step) ||
        !['field', 'phase', 'state'].every((key) => key in step) ||
        Object.entries(step).some(([key, v]) =>
          Object.hasOwn(stepEnums, key)
            ? !oneOf(v, stepEnums[key])
            : ['durationMs', 'frameId', 'candidateCount', 'eligibleCount'].includes(key)
              ? !count(v, key === 'durationMs' ? 600000 : 10000)
              : ['inShadowRoot', 'readOnly', 'visible', 'matched'].includes(key)
                ? typeof v !== 'boolean'
                : true
        )
    )
  )
    return false;
  if (value.inspection === undefined) return true;
  if (!record(value.inspection)) return false;
  const visibility = [
    'zero_geometry',
    'hidden',
    'inert',
    'aria_hidden',
    'display_none',
    'visibility_hidden',
    'opacity_zero',
    'content_visibility_hidden',
    'modal_background'
  ];
  const groups: Record<string, string[]> = {
    frameSkipCounts: visibility,
    controlCounts: ['scanned', 'eligible', 'locatable', 'recognized'],
    controlRejectCounts: [
      ...visibility,
      'aria_disabled',
      'disabled',
      'readonly',
      'excluded_type',
      'no_locator'
    ],
    interactionRejectCounts: [
      'occluded',
      'outside_viewport',
      'unsupported_transform',
      'unsupported_geometry',
      'control_ineligible',
      'frame_ineligible',
      'scroll_unavailable',
      'page_changed'
    ]
  };
  const interactionReasons = ['none', ...groups.interactionRejectCounts];
  const validInteraction = (row: unknown): boolean => {
    if (
      !record(row) ||
      !oneOf(row.field, stepEnums.field) ||
      !oneOf(row.initialReason, interactionReasons)
    )
      return false;
    const enums: Record<string, string[]> = {
      field: stepEnums.field,
      initialReason: interactionReasons,
      afterScrollReason: interactionReasons,
      tag: ['input', 'select', 'textarea', 'button', 'other'],
      role: ['combobox', 'other'],
      type: ['text', 'tel', 'number', 'password', 'select-one', 'select-multiple', 'other'],
      frameKind: ['main', 'embedded'],
      recovery: ['requested', 'ready', 'read_incomplete', 'blocked']
    };
    return Object.entries(row).every(([key, v]) => {
      if (Object.hasOwn(enums, key)) return oneOf(v, enums[key]);
      if (key === 'frameId') return count(v);
      if (['inShadowRoot', 'frameChanged'].includes(key)) return typeof v === 'boolean';
      if (key === 'scroll')
        return (
          record(v) &&
          Object.keys(v).every((k) => ['state', 'durationMs', 'errorClass'].includes(k)) &&
          oneOf(v.state, ['completed', 'failed']) &&
          count(v.durationMs, 600000) &&
          (v.errorClass === undefined ||
            oneOf(v.errorClass, [
              'scroll_timeout',
              'node_detached',
              'frame_changed',
              'context_destroyed',
              'other'
            ]))
        );
      if (key === 'blocker')
        return (
          record(v) &&
          Object.keys(v).length === 3 &&
          oneOf(v.tag, ['div', 'span', 'input', 'select', 'button', 'iframe', 'dialog', 'other']) &&
          oneOf(v.role, ['dialog', 'combobox', 'listbox', 'option', 'other']) &&
          typeof v.containsTarget === 'boolean'
        );
      if (key === 'pointChecks')
        return (
          Array.isArray(v) &&
          v.length <= 8 &&
          v.every(
            (point) =>
              record(point) &&
              Object.keys(point).every((k) =>
                ['scope', 'depth', 'reason', 'geometry'].includes(k)
              ) &&
              oneOf(point.scope, ['control', 'frame_owner']) &&
              count(point.depth, 32) &&
              oneOf(point.reason, interactionReasons) &&
              (point.geometry === undefined ||
                (record(point.geometry) &&
                  Object.entries(point.geometry).every(
                    ([k, n]) =>
                      [
                        'left',
                        'top',
                        'width',
                        'height',
                        'viewportWidth',
                        'viewportHeight',
                        'x',
                        'y'
                      ].includes(k) &&
                      typeof n === 'number' &&
                      Number.isInteger(n) &&
                      Math.abs(n) <= 1000000
                  )))
          )
        );
      return false;
    });
  };
  return Object.entries(value.inspection).every(([key, v]) => {
    if (key === 'interactionChecks')
      return Array.isArray(v) && v.length <= 8 && v.every(validInteraction);
    if (['complete', 'contentLoadFailed', 'timedOut', 'pageClosed', 'aborted'].includes(key))
      return typeof v === 'boolean';
    if (['framesChecked', 'framesSkipped', 'framesFailed'].includes(key)) return count(v);
    if (key === 'readAttempts') return v === 1 || v === 2;
    if (key === 'readPhase') return oneOf(v, readPhases);
    if (key === 'readFailures')
      return (
        Array.isArray(v) &&
        v.length <= 32 &&
        v.every(
          (row) =>
            record(row) &&
            Object.keys(row).length === 3 &&
            oneOf(row.phase, ['frame_scan', 'frame_owner', 'load_state', 'control_snapshot']) &&
            oneOf(row.reason, errors) &&
            count(row.count) &&
            Number(row.count) > 0
        )
      );
    return (
      Object.hasOwn(groups, key) &&
      record(v) &&
      Object.entries(v).every(([name, n]) => groups[key].includes(name) && count(n))
    );
  });
}

function validEvidenceUploads(value: unknown): boolean {
  const reasons = [
    'timeout',
    'network_error',
    'http_error',
    'response_invalid',
    'lease_lost',
    'operation_rejected',
    'file_unavailable',
    'path_rejected',
    'file_rejected',
    'deadline_exhausted',
    'unknown'
  ];
  return (
    Array.isArray(value) &&
    value.length <= 32 &&
    value.every((entry) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
      const row = entry as Record<string, unknown>;
      return (
        typeof row.kind === 'string' &&
        ['screenshot', 'video', 'diagnostic', 'batch'].includes(row.kind) &&
        typeof row.outcome === 'string' &&
        ['uploaded', 'failed', 'skipped'].includes(row.outcome) &&
        (row.outcome === 'uploaded' ||
          (typeof row.reason === 'string' && reasons.includes(row.reason))) &&
        Object.entries(row).every(([key, v]) => {
          if (['kind', 'outcome'].includes(key)) return typeof v === 'string';
          if (key === 'reason') return typeof v === 'string' && reasons.includes(v);
          if (key === 'durationMs')
            return Number.isInteger(v) && Number(v) >= 0 && Number(v) <= 600000;
          if (key === 'httpStatus')
            return Number.isInteger(v) && Number(v) >= 100 && Number(v) <= 599;
          if (key === 'remainingFiles')
            return Number.isInteger(v) && Number(v) >= 1 && Number(v) <= 40;
          return false;
        })
      );
    })
  );
}

@Injectable()
export class OnlineRechargeArtifactsRepository {
  constructor(
    private readonly repository: OnlineRechargeRepository,
    private readonly workers: OnlineRechargeWorkerRepository,
    private readonly config: ConfigService
  ) {}
  private async root() {
    const projectRoot = resolve(__dirname, '../../../../../..');
    const directory = resolve(
      this.config.get<string>('ONLINE_RECHARGE_ARTIFACT_DIR') ||
        join(projectRoot, '.runtime/online-recharge/artifacts')
    );
    if (!directory.startsWith(projectRoot + sep))
      throw new BadRequestException('运行资料目录必须属于当前项目');
    const canonicalProject = await realpath(projectRoot);
    let ancestor = directory;
    while (true) {
      try {
        const canonical = await realpath(ancestor);
        if (canonical !== canonicalProject && !canonical.startsWith(canonicalProject + sep))
          throw new BadRequestException('运行资料目录链接不能越过当前项目');
        break;
      } catch (error) {
        if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT')
          throw error;
        const parent = dirname(ancestor);
        if (parent === ancestor) throw new BadRequestException('运行资料目录不可用');
        ancestor = parent;
      }
    }
    return directory;
  }
  async upload(rpc: OnlineRechargeWorkerRpc) {
    const input = rpc.args ?? {};
    if (
      input.redacted !== true ||
      !['screenshot', 'video', 'diagnostic'].includes(String(input.kind))
    )
      throw new BadRequestException('仅允许已脱敏的截图和录像');
    const mimeType = text(input.mimeType, '文件类型', 80);
    const extension = {
      'image/png': '.png',
      'image/jpeg': '.jpg',
      'video/mp4': '.mp4',
      'video/webm': '.webm',
      'application/json': '.json'
    }[mimeType];
    if (
      !extension ||
      (input.kind === 'screenshot') !== mimeType.startsWith('image/') ||
      (input.kind === 'diagnostic') !== (mimeType === 'application/json')
    )
      throw new BadRequestException('运行资料类型无效');
    if (typeof input.dataBase64 !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(input.dataBase64))
      throw new BadRequestException('文件内容格式无效');
    const maxBytes =
      input.kind === 'diagnostic'
        ? 32768
        : input.kind === 'screenshot'
          ? 10 * 1024 * 1024
          : 100 * 1024 * 1024;
    if (input.dataBase64.length > Math.ceil((maxBytes * 4) / 3) + 4)
      throw new BadRequestException('运行资料超过大小限制');
    const bytes = Buffer.from(input.dataBase64, 'base64');
    if (!bytes.length || bytes.length > maxBytes)
      throw new BadRequestException('运行资料为空或过大');
    if (input.kind === 'diagnostic') {
      let report: Record<string, unknown>;
      try {
        report = JSON.parse(bytes.toString('utf8'));
      } catch {
        throw new BadRequestException('诊断文件格式无效');
      }
      const fields = [
        'format',
        'startedAt',
        'endedAt',
        'lastStage',
        'outcome',
        'failureClass',
        'failureCode',
        'missing',
        'timeline',
        'cardVerified',
        'billingVerified',
        'buttonReady',
        'submitted',
        'httpStatus',
        'executorTerminated',
        'sourceManifestSha256',
        'formDiagnostics',
        'bootstrapDiagnostics',
        'evidenceUploads'
      ];
      const stages = [
        'input',
        'proxy',
        'login',
        'preflight',
        'checkout_create',
        'checkout_open',
        'card_readiness',
        'card_fill',
        'billing_fill',
        'button_ready',
        'cleanup'
      ];
      const classes = [
        'NONE',
        'INPUT_MISSING',
        'PROXY_UNAVAILABLE',
        'BROWSER_PROFILE_UNAVAILABLE',
        'LOGIN_READ_FAILED',
        'NETWORK_READ_FAILED',
        'LOGIN_UNCONFIRMED',
        'CHECKOUT_REJECTED',
        'CHECKOUT_CREATION_UNKNOWN',
        'PAYMENT_COMPONENT_NOT_LOADED',
        'CARD_NOT_READY',
        'BILLING_FILL_FAILED',
        'BUTTON_NOT_READY',
        'READ_INCOMPLETE',
        'CHALLENGE_BLOCKED',
        'EXECUTOR_INTERRUPTED',
        'OTHER'
      ];
      const codes = [
        'UNKNOWN',
        ...classes,
        'PROXY_CONNECTION_FAILED',
        'PROFILE_IDENTITY_MISSING',
        'PROFILE_PROXY_INVALID',
        'PROFILE_BUSY',
        'PROFILE_EXIT_CHANGED',
        'PROFILE_BINDING_INVALID',
        'PROFILE_DIRECTORY_INVALID',
        'PROFILE_LAUNCH_FAILED',
        'PROFILE_CLEANUP_FAILED',
        'PENDING_CREDENTIALS',
        'CHECKOUT_FORM_DATA_MISSING',
        'CHECKOUT_AUTH_READ_FAILED',
        'SESSION_INVALID',
        'SESSION_NOT_CONFIRMED',
        'SESSION_API_UNCONFIRMED',
        'SESSION_VERIFICATION_BLOCKED',
        'SESSION_BOOTSTRAP_FAILED',
        'ACCOUNT_MISMATCH',
        'NETWORK_TIMEOUT',
        'NETWORK_UNAVAILABLE',
        'UPSTREAM_INVALID_RESPONSE',
        'UPSTREAM_BLOCKED',
        'UPSTREAM_FORBIDDEN',
        'CHECKOUT_CREATION_REJECTED',
        'CHECKOUT_OPEN_FAILED',
        'CHECKOUT_CARD_NOT_READY',
        'CHECKOUT_CONTROL_READ_FAILED',
        'CHECKOUT_CONTROL_BLOCKED',
        'CHECKOUT_CONTENT_LOAD_FAILED',
        'CHECKOUT_FORM_TIMEOUT',
        'CHECKOUT_PAGE_CLOSED',
        'EXECUTION_FAILED'
      ];
      const timestamp = (value: unknown) =>
        typeof value === 'string' &&
        /^\d{4}-\d{2}-\d{2}T/.test(value) &&
        Number.isFinite(Date.parse(value));
      if (
        !report ||
        Object.keys(report).some((key) => !fields.includes(key)) ||
        (report.bootstrapDiagnostics !== undefined &&
          !isDeepStrictEqual(
            safeBootstrapDiagnostics(report.bootstrapDiagnostics),
            report.bootstrapDiagnostics
          )) ||
        report.format !== 'unpaid-validation-v1' ||
        !['ready_before_payment', 'failed_with_class', 'challenge_blocked'].includes(
          String(report.outcome)
        ) ||
        !classes.includes(String(report.failureClass)) ||
        (report.failureCode !== undefined && !codes.includes(String(report.failureCode))) ||
        (report.missing !== undefined &&
          (!Array.isArray(report.missing) ||
            report.missing.length > 9 ||
            report.missing.some(
              (key) =>
                ![
                  'number',
                  'expiry',
                  'cvc',
                  'country',
                  'line1',
                  'city',
                  'postal',
                  'name',
                  'state'
                ].includes(String(key))
            ))) ||
        (report.formDiagnostics !== undefined && !validFormDiagnostics(report.formDiagnostics)) ||
        (report.evidenceUploads !== undefined && !validEvidenceUploads(report.evidenceUploads)) ||
        !stages.includes(String(report.lastStage)) ||
        !timestamp(report.startedAt) ||
        !timestamp(report.endedAt) ||
        report.submitted !== false ||
        (report.sourceManifestSha256 !== undefined &&
          !/^[0-9a-f]{64}$/.test(String(report.sourceManifestSha256))) ||
        ['cardVerified', 'billingVerified', 'buttonReady', 'executorTerminated'].some(
          (key) => typeof report[key] !== 'boolean'
        ) ||
        (report.httpStatus !== undefined &&
          (!Number.isInteger(report.httpStatus) ||
            Number(report.httpStatus) < 100 ||
            Number(report.httpStatus) > 599)) ||
        !Array.isArray(report.timeline) ||
        report.timeline.length > 32 ||
        report.timeline.some(
          (item) =>
            !item ||
            Object.keys(item).some(
              (key) => !['stage', 'startedAt', 'endedAt', 'state'].includes(key)
            ) ||
            !stages.includes(item.stage) ||
            (item.state !== undefined && !['completed', 'failed'].includes(item.state)) ||
            !timestamp(item.startedAt) ||
            !timestamp(item.endedAt)
        )
      )
        throw new BadRequestException('诊断文件字段无效');
    }
    const artifactId = randomUUID(),
      filename = artifactId + extension;
    const metadata = {
      id: artifactId,
      name: text(input.name ?? filename, '文件名', 200),
      kind: String(input.kind),
      mimeType,
      filename,
      size: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      downloadPath: `/id-business-v2/online-recharge/admin/artifacts/${artifactId}`
    };
    return this.workers.withLease(rpc, async (tx, row) => {
      if (
        input.kind === 'diagnostic' &&
        (row.operation !== 'debug' || object(row.payload).validationMode !== 'ready_before_payment')
      )
        throw new BadRequestException('诊断文件仅支持不付款验收任务');
      await mkdir(await this.root(), { recursive: true });
      await writeFile(join(await this.root(), filename), bytes, { flag: 'wx', mode: 0o600 });
      await tx.onlineRechargeEvent.create({
        data: {
          id: artifactId,
          taskId: row.id,
          stage: 'artifact',
          message:
            input.kind === 'diagnostic'
              ? '已保存不付款诊断'
              : input.kind === 'video'
                ? '已保存执行录像'
                : '已保存执行截图',
          metadata: metadata as Prisma.InputJsonValue
        }
      });
      return metadata;
    });
  }
  async list(taskId: string) {
    const rows = await this.repository.read((db) =>
      db.onlineRechargeEvent.findMany({
        where: { taskId, stage: 'artifact' },
        orderBy: { createdAt: 'asc' }
      })
    );
    return {
      files: rows.map((row) => {
        const item = object(row.metadata);
        return {
          id: row.id,
          name: item.name,
          kind: item.kind,
          sha256: item.sha256,
          downloadPath: item.downloadPath
        };
      })
    };
  }
  async download(artifactId: string, operator: AuthenticatedUser) {
    const row = await this.repository.read((db) =>
      db.onlineRechargeEvent.findFirst({ where: { id: id(artifactId), stage: 'artifact' } })
    );
    if (!row) throw new NotFoundException('运行资料不存在');
    const metadata = object(row.metadata),
      filename = text(metadata.filename, '文件', 60);
    if (!/^[0-9a-f-]{36}\.(png|jpg|mp4|webm|json)$/.test(filename))
      throw new NotFoundException('运行资料无效');
    const file = await open(
      join(await this.root(), filename),
      constants.O_RDONLY | constants.O_NOFOLLOW
    );
    try {
      await this.repository.transaction(`artifact:${artifactId}`, (tx) =>
        this.repository.log(tx, 'artifacts.download', operator, artifactId, { taskId: row.taskId })
      );
      return new StreamableFile(file.createReadStream(), {
        type: String(metadata.mimeType),
        disposition: `attachment; filename="${filename}"`
      });
    } catch (error) {
      await file.close();
      throw error;
    }
  }
}
