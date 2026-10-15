import { BadRequestException } from '@nestjs/common';
export function bankRechargeObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new BadRequestException('请求格式无效');
  return value as Record<string, unknown>;
}
export function bankRechargeText(value: unknown, label: string, max: number, required = true) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (
    (required && !text) ||
    text.length > max ||
    [...text].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
  )
    throw new BadRequestException(`${label}格式无效`);
  return text;
}
export function bankRechargeId(value: unknown, label = '代理编号') {
  const text = bankRechargeText(value, label, 36);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(text))
    throw new BadRequestException(`${label}格式无效`);
  return text;
}
export function proxyRemark(value: unknown) {
  if (value === undefined || value === null) return '';
  if (
    typeof value !== 'string' ||
    value.length > 1200 ||
    [...value].some(
      (character) =>
        (character.charCodeAt(0) < 32 && !['\n', '\r', '\t'].includes(character)) ||
        character.charCodeAt(0) === 127
    )
  )
    throw new BadRequestException('备注格式无效');
  return value.trim();
}
