import type { V2RechargeHandoffCommand, V2RechargeHandoffFrame, V2RechargeJob } from './contracts';

export type RechargeHandoffAction =
  | { type: 'click'; x: number; y: number }
  | { type: 'key'; key: Extract<V2RechargeHandoffCommand, { type: 'key' }>['key'] }
  | { type: 'text'; text: string }
  | { type: 'scroll'; deltaY: number };

const uuid = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;

export function validHandoffFrame(frame: V2RechargeHandoffFrame, now = Date.now()) {
  return (
    uuid.test(frame.sessionId) &&
    uuid.test(frame.frameId) &&
    Number.isSafeInteger(frame.revision) &&
    frame.revision >= 1 &&
    (frame.kind === 'hcaptcha' || frame.kind === 'bank') &&
    /^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(frame.image) &&
    Number.isSafeInteger(frame.width) &&
    frame.width > 0 &&
    frame.width <= 2048 &&
    Number.isSafeInteger(frame.height) &&
    frame.height > 0 &&
    frame.height <= 2048 &&
    Number.isFinite(Date.parse(frame.expiresAt)) &&
    Date.parse(frame.expiresAt) > now &&
    Date.parse(frame.expiresAt) - now <= 301_000
  );
}

export function handoffEligible(job: V2RechargeJob | undefined) {
  return (
    job?.action === 'server' &&
    job.state === 'awaiting_human_verification' &&
    job.result.handoff_available === true &&
    uuid.test(job.result.handoff_session_id ?? '') &&
    Number.isInteger(job.result.handoff_generation) &&
    (job.result.handoff_generation ?? 0) >= 1 &&
    (job.result.handoff_generation ?? 0) <= 10 &&
    job.result.stage === 'human_verification_ready'
  );
}

export function handoffCoordinates(
  frame: Pick<V2RechargeHandoffFrame, 'width' | 'height'>,
  bounds: { left: number; top: number; width: number; height: number },
  clientX: number,
  clientY: number
) {
  if (
    bounds.width <= 0 ||
    bounds.height <= 0 ||
    !Number.isFinite(clientX) ||
    !Number.isFinite(clientY)
  )
    return null;
  const x = clientX - bounds.left;
  const y = clientY - bounds.top;
  if (x < 0 || y < 0 || x > bounds.width || y > bounds.height) return null;
  return {
    x: Math.min(frame.width - 1, Math.floor((x * frame.width) / bounds.width)),
    y: Math.min(frame.height - 1, Math.floor((y * frame.height) / bounds.height))
  };
}

export function validHandoffAction(action: RechargeHandoffAction, frame: V2RechargeHandoffFrame) {
  if (action.type === 'click')
    return (
      Number.isSafeInteger(action.x) &&
      Number.isSafeInteger(action.y) &&
      action.x >= 0 &&
      action.x < frame.width &&
      action.y >= 0 &&
      action.y < frame.height
    );
  if (action.type === 'text')
    return (
      action.text.length > 0 &&
      action.text.length <= 64 &&
      Array.from(action.text).every(
        (character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127
      )
    );
  if (action.type === 'scroll')
    return Number.isSafeInteger(action.deltaY) && Math.abs(action.deltaY) <= 600;
  return [
    'Tab',
    'Enter',
    'Space',
    'Backspace',
    'ArrowUp',
    'ArrowDown',
    'ArrowLeft',
    'ArrowRight'
  ].includes(action.key);
}
