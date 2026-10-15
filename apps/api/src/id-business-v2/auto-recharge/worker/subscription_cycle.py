"""API 授予的下一账期资格；只读核实不能授权支付或推断免费资格。"""
from datetime import datetime, timezone
import hashlib
import json
import re
import time
from urllib.parse import urlencode

from checkout_core import Stop, unique_object

RECORD_KEY = re.compile(r'^(?:payments/|history/)?[a-f0-9]{64}(?:-(?:go|pro-(?:5x|20x|500)))?\.json$')
DIGEST = re.compile(r'^[a-f0-9]{64}$')


def timestamp(value):
    try:
        result = datetime.fromisoformat(value.replace('Z', '+00:00'))
        if not result.tzinfo:
            raise ValueError()
        return result.timestamp()
    except (ValueError, TypeError, AttributeError):
        raise Stop('invalid_subscription_cycle_state') from None


def grant_valid(grant, account_key, target_plan, *, job_id=None, consumed=False, allow_expired=False):
    if (not isinstance(grant, dict) or type(grant.get('protocol')) is not int or grant['protocol'] != 1
            or grant.get('accountKey') != account_key or grant.get('targetPlan') != target_plan
            or not isinstance(grant.get('jobId'), str)
            or not re.fullmatch(r'[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}', grant['jobId'])
            or job_id is not None and grant['jobId'] != job_id
            or not isinstance(grant.get('reviewDigest'), str) or not DIGEST.fullmatch(grant['reviewDigest'])
            or type(grant.get('checkoutRevision')) is not int or grant['checkoutRevision'] < 0
            or not isinstance(grant.get('checkoutFileKey'), str) or not RECORD_KEY.fullmatch(grant['checkoutFileKey'])
            or grant['checkoutFileKey'].startswith(('payments/', 'history/'))
            or grant.get('status') not in ({'granted', 'consumed'} if consumed else {'granted'})):
        return False
    try:
        expiry = timestamp(grant.get('expiresAt'))
        return grant['status'] == 'consumed' or allow_expired or expiry > time.time()
    except Stop:
        return False


def complete_payment(record):
    from bitbrowser_retry import historical_payment_completed
    return isinstance(record, dict) and historical_payment_completed(record)


def resolved_without_bank_request(record):
    from attempt_ledger import confirmed_no_bank_request, declined_payment_resolved
    if not isinstance(record, dict) or record.get('payment_evidence'):
        return False
    if declined_payment_resolved(record):
        return True
    count = record.get('confirmation_requests_sent')
    return (record.get('cancelled_before_confirmation') is True
            and record.get('payment_status') == 'cancelled' and type(count) is int and count == 0
            or confirmed_no_bank_request(record) and record.get('payment_status') == 'unknown'
            and record.get('payment_attempted') is True and type(count) is int and count == 1)


def cycle_resolution_matches(record, grant):
    resolution = record.get('cycle_resolution') if isinstance(record, dict) else None
    account_key = record.get('account_key') or (resolution or {}).get('account_key')
    if (not isinstance(grant, dict) or not grant_valid(grant, account_key, grant.get('targetPlan'), consumed=True)
            or not isinstance(resolution, dict)):
        return False
    return (type(resolution.get('protocol')) is int and resolution['protocol'] == 1
            and resolution.get('status') == 'closed'
            and resolution.get('source_job_id') == grant['jobId']
            and resolution.get('account_key') == grant['accountKey']
            and resolution.get('target_plan') == grant['targetPlan']
            and resolution.get('review_digest') == grant['reviewDigest']
            and isinstance(resolution.get('original_document_digest'), str)
            and DIGEST.fullmatch(resolution['original_document_digest']) is not None
            and isinstance(resolution.get('closed_at'), str))


def closed_payment_allowed(record, grant):
    return complete_payment(record) and cycle_resolution_matches(record, grant)


def closed_payment_for_observation(record):
    from plans import PLANS
    resolution = record.get('cycle_resolution') if isinstance(record, dict) else None
    if (not complete_payment(record) or not isinstance(resolution, dict)
            or type(resolution.get('protocol')) is not int or resolution['protocol'] != 1
            or resolution.get('status') != 'closed' or resolution.get('account_key') != record.get('account_key')
            or resolution.get('target_plan') not in PLANS
            or not isinstance(resolution.get('source_job_id'), str)
            or not re.fullmatch(r'[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}', resolution['source_job_id'])
            or any(not isinstance(resolution.get(key), str) or not DIGEST.fullmatch(resolution[key])
                   for key in ('original_document_digest', 'review_digest'))):
        return False
    try:
        return timestamp(resolution.get('closed_at')) <= time.time() + 10
    except Stop:
        return False


def attested_closed_payment(record, context, file_key):
    resolution = record.get('cycle_resolution') if isinstance(record, dict) else None
    if (not isinstance(context, dict) or context.get('protocol') != 1
            or context.get('accountKey') != record.get('account_key') or not complete_payment(record)
            or not isinstance(resolution, dict) or resolution.get('protocol') != 1
            or resolution.get('status') != 'closed' or resolution.get('account_key') != record.get('account_key')
            or not isinstance(resolution.get('original_document_digest'), str)
            or not DIGEST.fullmatch(resolution['original_document_digest'])):
        return False
    operation = record.get('upgrade_identifier') or record.get('checkout_identifier')
    return any(isinstance(source, dict) and source.get('fileKey') == file_key
               and source.get('operationIdentifier') == operation
               and source.get('targetPlan') == record.get('target_plan', 'plus')
               for source in context.get('sources', []))


def inspection_only_allowed(job, target):
    context = getattr(job, 'next_cycle_context', None)
    if (job.payload.get('subscriptionCycleProtocol') != 1 or job.payload['mode'] != 'payment'
            or not isinstance(context, dict) or context.get('protocol') != 1
            or context.get('jobId') != job.id or context.get('accountKey') != job.account_key
            or context.get('targetPlan') != job.payload['plan'] or not context.get('sources')
            or context.get('grant', {}).get('status') == 'consumed'):
        return False
    key = hashlib.sha256(target.account_id.encode()).hexdigest()
    if key != job.account_key:
        raise Stop('official_account_mismatch', account_matched=False)
    sources = {item.get('fileKey') for item in context['sources'] if isinstance(item, dict)}
    completed = 0
    for path in (job.root / 'payments').glob('*.json'):
        if path.is_symlink() or path.stat().st_size > 65536:
            raise Stop('invalid_payment_record')
        try:
            record = json.loads(path.read_bytes(), object_pairs_hook=unique_object)
        except (ValueError, TypeError):
            raise Stop('invalid_payment_record') from None
        if not isinstance(record, dict):
            raise Stop('invalid_payment_record')
        if record.get('account_key') != key:
            continue
        if resolved_without_bank_request(record):
            continue
        if not complete_payment(record) or str(path.relative_to(job.root)) not in sources:
            return False
        completed += 1
    return completed > 0


def bound_period(value, account_key, target_plan):
    if (not isinstance(value, dict) or value.get('source') != 'official_subscription_response'
            or value.get('account_key') != account_key or value.get('target_plan') != target_plan):
        return None
    try:
        start, end = timestamp(value.get('start')), timestamp(value.get('end'))
        if not 0 < end - start <= 32 * 86400:
            return None
        return {key: value[key] for key in ('source', 'start', 'end', 'account_key', 'target_plan')}
    except Stop:
        return None


def assert_inspection_eligible(inspection, context):
    if (inspection.get('account_key') != context.get('accountKey') or inspection.get('account_matched') is not True
            or inspection.get('current_plan') != 'free' or inspection.get('has_active_subscription') is not False):
        raise Stop('subscription_state_unverified', user_action_required=True)
    periods = [inspection.get('previous_period')]
    periods.extend(source.get('subscriptionPeriod') for source in context.get('sources', []) if isinstance(source, dict))
    for period in periods:
        if isinstance(period, dict) and timestamp(period.get('end')) > time.time():
            raise Stop('existing_subscription_conflict', user_action_required=True)


async def read_inspection(page, target, context):
    from browser_checkout import browser_read, check_session
    from subscription_upgrade import SUBSCRIPTION_PATH
    key = hashlib.sha256(target.account_id.encode()).hexdigest()
    if context.get('accountKey') != key:
        raise Stop('official_account_mismatch', account_matched=False)
    refreshed, first = await check_session(page, target)
    previous = None
    try:
        subscription = await browser_read(page, SUBSCRIPTION_PATH + '?' + urlencode({'account_id': target.account_id}), refreshed)
        if isinstance(subscription, dict) and subscription.get('account_id') not in (None, target.account_id):
            raise Stop('official_account_mismatch', account_matched=False)
        if isinstance(subscription, dict) and subscription.get('active_until') is not None:
            try:
                future_end = timestamp(subscription['active_until']) > time.time()
            except Stop:
                raise Stop('subscription_state_unverified', user_action_required=True) from None
            if future_end:
                raise Stop('existing_subscription_conflict', user_action_required=True)
        if isinstance(subscription, dict) and subscription.get('account_id') == target.account_id:
            mapping = {'go': 'go', 'plus': 'plus', 'prolite': 'pro-5x', 'pro': 'pro-20x', 'promax': 'pro-500'}
            previous_plan = mapping.get(subscription.get('plan_type'))
            value = {'source': 'official_subscription_response', 'start': subscription.get('active_start'),
                     'end': subscription.get('active_until'), 'account_key': key,
                     'target_plan': previous_plan}
            if any(isinstance(source, dict) and source.get('targetPlan') == previous_plan for source in context.get('sources', [])):
                previous = bound_period(value, key, previous_plan)
    except Stop as exc:
        if exc.report.get('reason') in {'official_account_mismatch', 'official_user_mismatch', 'operation_cancelled',
                                      'existing_subscription_conflict', 'subscription_state_unverified'}:
            raise
    # A historical API-persisted official period remains valid evidence; record
    # creation time and a Free label can never replace it.
    if previous is None:
        for source in context.get('sources', []):
            if isinstance(source, dict):
                candidate = bound_period(source.get('subscriptionPeriod'), key, source.get('targetPlan'))
                if candidate and (previous is None or timestamp(candidate['end']) > timestamp(previous['end'])):
                    previous = candidate
    _, current = await check_session(page, target)
    if (first.get('account_matched') is not True or current.get('account_matched') is not True
            or first.get('current_plan') != current.get('current_plan')
            or first.get('has_active_subscription') is not current.get('has_active_subscription')):
        raise Stop('subscription_state_changed', account_matched=False)
    return {'source': 'official_account_response', 'account_key': key, 'account_matched': True,
            'current_plan': current.get('current_plan', 'unknown'),
            'has_active_subscription': current.get('has_active_subscription')
                if type(current.get('has_active_subscription')) is bool else None,
            'checked_at': datetime.now(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z'),
            **({'previous_period': previous} if previous else {})}
