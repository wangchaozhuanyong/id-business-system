// Closed, value-free diagnostic attachment contract. No browser or engine runtime import.
type Check = (value: unknown) => boolean;
type Row = Record<string, unknown>;
const record = (v: unknown): v is Row => !!v && typeof v === 'object' && !Array.isArray(v);
const integer =
  (max = 10000, min = 0): Check =>
  (v) =>
    Number.isInteger(v) && Number(v) >= min && Number(v) <= max;
const oneOf =
  (items: readonly unknown[]): Check =>
  (v) =>
    items.includes(v);
const bool: Check = (v) => typeof v === 'boolean';
const list =
  (check: Check, max: number): Check =>
  (v) =>
    Array.isArray(v) && v.length <= max && v.every(check);
const closed =
  (shape: Record<string, Check>, required: string[] = []): Check =>
  (v) =>
    record(v) &&
    required.every((key) => Object.hasOwn(v, key)) &&
    Object.entries(v).every(([key, item]) => Object.hasOwn(shape, key) && shape[key](item));
const count = integer(),
  elapsed = integer(3600000),
  status = integer(599, 100);
const ERRORS = ['timeout', 'detached', 'context_destroyed', 'closed', 'aborted', 'read_failed'];
const READ_OPERATIONS = [
  'frame_element',
  'owner_visibility',
  'load_error_count',
  'load_error_visibility',
  'control_snapshot',
  'candidate_handles',
  'candidate_eligibility',
  'control_read',
  'node_connected',
  'value',
  'candidate_scroll',
  'unknown'
];
const FIELDS = [
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
];
export const DIAGNOSTIC_OMISSIONS = [
  'events',
  'critical_events',
  'pending_requests',
  'failure_classes',
  'control_details',
  'exclusion_rows',
  'await_steps',
  'form_steps'
];
export const validReadFailure: Check = closed(
  {
    phase: oneOf(['frame_scan', 'frame_owner', 'load_state', 'control_snapshot', 'control_read']),
    reason: oneOf(ERRORS),
    count: integer(10000, 1),
    probe: oneOf(['load_precheck', 'control_scan', 'field_input']),
    readOperation: oneOf(READ_OPERATIONS),
    frameKind: oneOf(['main', 'embedded', 'unknown']),
    frameId: integer(10000, 1),
    attempt: oneOf([1, 2]),
    enumerationIndex: integer(10000, 1),
    frameCount: integer(10000, 1)
  },
  ['phase', 'reason', 'count']
);
export const validReadAttemptSummary: Check = closed(
  {
    attempt: oneOf([1, 2]),
    frameCount: count,
    framesChecked: count,
    framesSkipped: count,
    framesFailed: count,
    complete: bool,
    durationMs: integer(600000)
  },
  [
    'attempt',
    'frameCount',
    'framesChecked',
    'framesSkipped',
    'framesFailed',
    'complete',
    'durationMs'
  ]
);
const EVENTS = [
  'request',
  'response',
  'request_finished',
  'request_failed',
  'script_error',
  'console_error',
  'csp',
  'frame_attached',
  'frame_navigated',
  'frame_detached',
  'route_abort',
  'page_closed'
];
const ENDPOINTS = [
  'stripe_script',
  'stripe_frame',
  'stripe_elements',
  'stripe_init',
  'stripe_confirm',
  'stripe_other',
  'chatgpt_checkout',
  'chatgpt_auth',
  'chatgpt_script',
  'chatgpt_other',
  'openai_checkout',
  'verification',
  'other'
];
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'OTHER'];
const CODES = [
  'DNS_FAILED',
  'PROXY_AUTH_FAILED',
  'PROXY_TUNNEL_FAILED',
  'TLS_FAILED',
  'CONNECTION_RESET',
  'CONNECTION_CLOSED',
  'CONNECTION_REFUSED',
  'TIMEOUT',
  'BLOCKED_BY_CLIENT',
  'BLOCKED_BY_CSP',
  'ABORTED',
  'NETWORK_FAILED',
  'JS_TYPE_ERROR',
  'JS_SYNTAX_ERROR',
  'JS_REFERENCE_ERROR',
  'SCRIPT_LOAD_FAILED',
  'SDK_INITIALIZATION_FAILED',
  'STRIPE_KEY_INVALID',
  'STRIPE_CLIENT_SECRET_INVALID',
  'CORS_BLOCKED',
  'SCRIPT_ERROR'
];
const DIRECTIVES = [
  'script-src',
  'script-src-elem',
  'frame-src',
  'connect-src',
  'default-src',
  'style-src',
  'other'
];
const RULES = [
  'SESSION_GOOGLE_LOGIN',
  'SESSION_MICROSOFT_LOGIN',
  'SESSION_OFFICIAL_LOGIN',
  'RELOAD_CDP',
  'RELOAD_CDP_FAILURE',
  'RELOAD_FRAME',
  'RECOVERY_READONLY'
];
const RESOURCES = [
  'document',
  'stylesheet',
  'image',
  'media',
  'font',
  'script',
  'texttrack',
  'xhr',
  'fetch',
  'eventsource',
  'websocket',
  'manifest',
  'other',
  'unknown'
];
const ROUTES = [
  'auth_session',
  'auth_csrf',
  'checkout_page',
  'checkout_create',
  'stripe_elements',
  'stripe_init',
  'stripe_confirm',
  'other'
];
const SOURCES = ['our_route_abort', 'network_or_proxy', 'unknown_abort', 'network_other'];
const ABORT_STATES = ['requested', 'completed', 'failed'];
const FAILURE_CODES = [
  'ERR_FAILED',
  'ERR_ABORTED',
  'ERR_BLOCKED_BY_CLIENT',
  'ERR_BLOCKED_BY_CSP',
  'ERR_NAME_NOT_RESOLVED',
  'ERR_PROXY_AUTH_REQUESTED',
  'ERR_TUNNEL_CONNECTION_FAILED',
  'ERR_PROXY_CONNECTION_FAILED',
  'ERR_CERT_AUTHORITY_INVALID',
  'ERR_CONNECTION_RESET',
  'ERR_CONNECTION_CLOSED',
  'ERR_CONNECTION_REFUSED',
  'ERR_CONNECTION_ABORTED',
  'ERR_TIMED_OUT',
  'NS_BINDING_ABORTED',
  'NS_ERROR_NET_RESET',
  'NS_ERROR_UNKNOWN_HOST',
  'OTHER'
];
const OPEN_CODES = [
  'CHECKOUT_CARD_NOT_READY',
  'CHECKOUT_FORM_NOT_READY',
  'CHECKOUT_PLAN_PREPARING',
  'CHECKOUT_CONTROL_AMBIGUOUS',
  'CHECKOUT_CONTROL_READ_FAILED',
  'CHECKOUT_CONTROL_BLOCKED',
  'CHECKOUT_PAGE_CLOSED',
  'CHECKOUT_FORM_ABORTED',
  'CHECKOUT_FORM_TIMEOUT',
  'CHECKOUT_FORM_DATA_MISSING',
  'CHECKOUT_CONTENT_LOAD_FAILED',
  'CHECKOUT_RELOAD_TIMEOUT',
  'CHECKOUT_RELOAD_PAYMENT_STARTED',
  'CHECKOUT_RELOAD_ALREADY_ATTEMPTED',
  'CHECKOUT_RELOAD_NOT_REQUIRED',
  'CHECKOUT_RELOAD_ORIGINAL_CHANGED',
  'CHECKOUT_RELOAD_STATE_UNAVAILABLE',
  'CHECKOUT_RELOAD_FAILED',
  'CHECKOUT_RELOAD_PAGE_CLOSED',
  'CHECKOUT_RELOAD_GUARD_UNAVAILABLE',
  'CHECKOUT_RELOAD_FRAME_WRITE_UNPROVEN',
  'CHECKOUT_AUTH_READ_FAILED'
];
const BLOCKED_REQUEST_OPERATIONS = [
  'READ_REQUEST',
  'CHECKOUT_CREATE',
  'STRIPE_INIT_SAME_CHECKOUT',
  'STRIPE_INIT_OTHER_CHECKOUT',
  'STRIPE_INIT_NATIVE_UNBOUND',
  'STRIPE_OTHER_WRITE',
  'OTHER_WRITE',
  'OTHER_REQUEST'
];
const BLOCKED_REQUEST_REASONS = [
  'NON_INITIALIZATION_OPERATION',
  'ORIGINAL_CHECKOUT_MISMATCH',
  'NATIVE_CHECKOUT_UNBOUND',
  'UNKNOWN_PARAMETER',
  'DUPLICATE_PARAMETER',
  'INVALID_PARAMETER_VALUE',
  'BODY_UNAVAILABLE',
  'BODY_TOO_LARGE',
  'INVALID_REQUEST',
  'GUARD_UNAVAILABLE',
  'GUARD_REJECTED',
  'LEASE_LOST',
  'PAYMENT_ALREADY_STARTED',
  'ORIGINAL_CHECKOUT_CHANGED',
  'FRAME_GUARD_UNPROVEN',
  'DIAGNOSTIC_LIMIT'
];
const RELOAD_CODES = [
  'LEASE_LOST',
  'CHECKOUT_RELOAD_READONLY',
  'CHECKOUT_RELOAD_READY',
  'CHECKOUT_RELOAD_NOT_ATTEMPTED',
  'CHECKOUT_RELOAD_TIMEOUT',
  'CHECKOUT_RELOAD_PAYMENT_STARTED',
  'CHECKOUT_RELOAD_ALREADY_ATTEMPTED',
  'CHECKOUT_RELOAD_NOT_REQUIRED',
  'CHECKOUT_RELOAD_ORIGINAL_CHANGED',
  'CHECKOUT_RELOAD_STATE_UNAVAILABLE',
  'CHECKOUT_RELOAD_FAILED',
  'CHECKOUT_RELOAD_PAGE_CLOSED',
  'CHECKOUT_RELOAD_GUARD_UNAVAILABLE',
  'CHECKOUT_RELOAD_FRAME_WRITE_UNPROVEN'
];

const eventShape = {
  event: oneOf(EVENTS),
  elapsedMs: elapsed,
  endpoint: oneOf(ENDPOINTS),
  frame: oneOf(['main', 'embedded', 'unknown']),
  method: oneOf(METHODS),
  status,
  code: oneOf(CODES),
  directive: oneOf(DIRECTIVES),
  requestId: integer(10000, 1),
  frameId: integer(10000, 1),
  resourceType: oneOf(RESOURCES),
  routeTemplate: oneOf(ROUTES),
  source: oneOf(SOURCES),
  ruleId: oneOf(RULES),
  abortState: oneOf(ABORT_STATES),
  failureCode: oneOf(FAILURE_CODES),
  navigationRelated: oneOf(['possible']),
  ownerEndpoint: oneOf(ENDPOINTS),
  startedMs: elapsed,
  responseMs: elapsed,
  durationMs: elapsed
};
const validEvent = closed(eventShape, ['event', 'elapsedMs', 'endpoint', 'frame']);
const failureEvent: Check = (v) =>
  record(v) &&
  (['request_failed', 'script_error', 'console_error', 'csp'].includes(String(v.event)) ||
    (v.event === 'response' && Number(v.status) >= 400));
const validFailureClass = closed(
  { ...eventShape, count: integer(10000, 1), lastElapsedMs: elapsed },
  ['event', 'elapsedMs', 'endpoint', 'frame', 'count', 'lastElapsedMs']
);
const initializationShape = {
  version: oneOf([1, 2]),
  elapsedMs: elapsed,
  eventCount: count,
  readFailures: count,
  truncated: bool,
  events: list(validEvent, 64),
  firstFailure: (v: unknown) => v === null || (validEvent(v) && failureEvent(v)),
  failureClasses: list((v) => validFailureClass(v) && failureEvent(v), 32),
  failureClassesTruncated: bool,
  criticalEvents: list(validEvent, 96),
  criticalEventCount: count,
  criticalTruncated: bool,
  requestCounts: list(
    closed(
      {
        endpoint: oneOf(ENDPOINTS),
        started: count,
        responses: count,
        finished: count,
        failed: count,
        pending: count
      },
      ['endpoint', 'started', 'responses', 'finished', 'failed', 'pending']
    ),
    ENDPOINTS.length
  ),
  pendingRequests: list((v) => validEvent(v) && record(v) && v.event === 'request', 48),
  pendingRequestCount: count,
  pendingRequestsTruncated: bool
};
const validInitialization: Check = (v) => {
  if (
    !closed(initializationShape, [
      'version',
      'elapsedMs',
      'eventCount',
      'readFailures',
      'truncated',
      'events',
      'firstFailure',
      'failureClasses',
      'failureClassesTruncated'
    ])(v) ||
    !record(v)
  )
    return false;
  const extra = [
    'criticalEvents',
    'criticalEventCount',
    'criticalTruncated',
    'requestCounts',
    'pendingRequests',
    'pendingRequestCount',
    'pendingRequestsTruncated'
  ];
  if (v.version === 2 ? !extra.every((key) => key in v) : extra.some((key) => key in v))
    return false;
  if (Number(v.eventCount) < (v.events as unknown[]).length) return false;
  if (v.version === 2) {
    if (
      Number(v.criticalEventCount) < (v.criticalEvents as unknown[]).length ||
      Number(v.pendingRequestCount) < (v.pendingRequests as unknown[]).length
    )
      return false;
    const rows = v.requestCounts as Row[];
    if (new Set(rows.map((row) => row.endpoint)).size !== rows.length) return false;
  }
  return true;
};
const STEPS = [
  'navigation',
  'login_gate',
  'login_chrome',
  'login_button',
  'login_link',
  'signup_button',
  'signup_link',
  'signup_text',
  'tailored_text',
  'login_text',
  'readiness',
  'final_page',
  'final_auth'
];
const MEDIA_PHASES = [
  'idle',
  'fonts',
  'frames',
  'mask',
  'screenshot',
  'write',
  'cleanup',
  'settled'
];
const validAwaits = closed(
  {
    version: oneOf([1]),
    elapsedMs: elapsed,
    failureCode: oneOf([
      'BUDGET_TIMEOUT',
      'PLAYWRIGHT_TIMEOUT',
      'AUTH_READ_FAILED',
      'LEASE_LOST',
      'VERIFICATION_CANCELLED',
      'OTHER'
    ]),
    pageKind: oneOf(['native_checkout', 'hosted_checkout', 'login', 'other', 'closed', 'unknown']),
    steps: list(
      closed(
        {
          step: oneOf(STEPS),
          state: oneOf(['pending', 'completed', 'true', 'false', 'read_failed']),
          startedMs: elapsed,
          remainingMs: elapsed,
          endedMs: elapsed,
          durationMs: elapsed,
          remainingAfterMs: elapsed,
          errorClass: oneOf(ERRORS)
        },
        ['step', 'state', 'startedMs', 'remainingMs']
      ),
      48
    ),
    media: closed(
      {
        available: bool,
        busy: bool,
        chainPending: bool,
        captureTimedOut: bool,
        fontsReady: bool,
        phase: oneOf(MEDIA_PHASES),
        failurePhase: oneOf(MEDIA_PHASES),
        phaseElapsedMs: elapsed,
        lastStartedAgoMs: elapsed,
        lastFinishedAgoMs: elapsed,
        frameIndex: elapsed,
        completedFrames: elapsed
      },
      ['available']
    ),
    cleanup: closed(
      { frozenAtMs: elapsed, closeStartedMs: elapsed, closeEndedMs: elapsed, closeConfirmed: bool },
      ['frozenAtMs']
    )
  },
  ['version', 'elapsedMs', 'steps']
);
const validLoading = closed(
  {
    reloadAttempts: oneOf([1]),
    blockedWrites: count,
    code: oneOf(RELOAD_CODES),
    blockedRequestDiagnostics: list(
      closed(
        {
          operation: oneOf(BLOCKED_REQUEST_OPERATIONS),
          reason: oneOf(BLOCKED_REQUEST_REASONS),
          count: integer(10000, 1)
        },
        ['operation', 'reason', 'count']
      ),
      16
    )
  },
  ['reloadAttempts', 'blockedWrites', 'code']
);
const validProbe = closed({
  shadowCoverage: oneOf(['open_only']),
  complete: bool,
  timedOut: bool,
  aborted: bool,
  pageClosed: bool,
  truncated: bool,
  framesInspected: count,
  framesFailed: count,
  numberComparison: closed({ semanticEligible: count, geometryEditable: count }, [
    'semanticEligible',
    'geometryEditable'
  ]),
  rows: list(
    closed(
      {
        field: oneOf(FIELDS),
        source: oneOf(['control', 'frame']),
        reason: oneOf([
          'eligible',
          'zero_geometry',
          'hidden',
          'inert',
          'aria_hidden',
          'display_none',
          'visibility_hidden',
          'opacity_zero',
          'content_visibility_hidden',
          'modal_background',
          'aria_disabled',
          'disabled',
          'readonly',
          'excluded_type'
        ]),
        at: oneOf(['self', 'ancestor', 'computed', 'none']),
        frameKind: oneOf(['main', 'embedded']),
        boxVisible: bool,
        editable: bool,
        count: integer(10000, 1)
      },
      ['field', 'source', 'reason', 'at', 'frameKind', 'boxVisible', 'editable', 'count']
    ),
    64
  ),
  failures: list(
    closed(
      {
        phase: oneOf(['frame_scan', 'frame_owner', 'control_snapshot']),
        reason: oneOf(ERRORS),
        count: integer(10000, 1)
      },
      ['phase', 'reason', 'count']
    ),
    15
  )
});
export function validCheckoutOpenDiagnostics(value: unknown, validInspection: Check): boolean {
  return closed(
    {
      stage: oneOf(['navigation', 'login', 'readiness', 'final_check']),
      reason: oneOf([
        'timeout',
        'http_error',
        'original_changed',
        'session_required',
        'cancelled',
        'network_error',
        'page_closed',
        'not_ready',
        'check_failed',
        'read_incomplete',
        'error_page'
      ]),
      code: oneOf(OPEN_CODES),
      httpStatus: status,
      missing: list(oneOf(FIELDS), 11),
      controls: list(
        closed(
          {
            tag: oneOf(['input', 'select', 'textarea', 'other']),
            role: oneOf(['combobox', null]),
            fields: list(oneOf(FIELDS), 11),
            required: bool,
            readOnly: bool
          },
          ['tag', 'role', 'fields']
        ),
        128
      ),
      candidateCounts: list(closed({ field: oneOf(FIELDS), count }, ['field', 'count']), 11),
      previousCardReadiness: closed(
        { ready: bool, missing: list(oneOf(FIELDS), 11), complete: bool, scanned: count },
        ['ready', 'missing']
      ),
      inspection: validInspection,
      initialization: validInitialization,
      awaits: validAwaits,
      loading: validLoading,
      exclusionProbe: validProbe
    },
    ['stage', 'reason']
  )(value);
}
export function validTruncationMetadata(report: Record<string, unknown>): boolean {
  if (report.diagnosticsTruncated === undefined && report.diagnosticsOmitted === undefined)
    return true;
  return (
    typeof report.diagnosticsTruncated === 'boolean' &&
    list(oneOf(DIAGNOSTIC_OMISSIONS), 8)(report.diagnosticsOmitted) &&
    new Set(report.diagnosticsOmitted as string[]).size ===
      (report.diagnosticsOmitted as string[]).length &&
    report.diagnosticsTruncated === (report.diagnosticsOmitted as string[]).length > 0
  );
}
