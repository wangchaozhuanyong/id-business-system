export const V2_SKELETON_KINDS = [
  'table',
  'form',
  'metrics',
  'settings',
  'detail',
  'cards',
  'inline',
  'control'
] as const;

export type V2SkeletonKind = (typeof V2_SKELETON_KINDS)[number];
