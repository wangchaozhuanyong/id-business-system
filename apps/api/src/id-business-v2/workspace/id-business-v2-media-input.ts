import { BadRequestException } from '@nestjs/common';
import { V2_MEDIA_RESOLVER_LIMITS, type V2MediaPlatform } from '@apple-business/shared';

export type V2MediaResolverEngine = 'f2' | 'yt-dlp';

export interface NormalizedV2MediaInput {
  engine: V2MediaResolverEngine;
  platform: V2MediaPlatform;
  url: string;
}

interface SupportedMediaHost {
  engine: V2MediaResolverEngine;
  hosts: readonly string[];
  platform: V2MediaPlatform;
}

const SUPPORTED_MEDIA_HOSTS: readonly SupportedMediaHost[] = [
  { engine: 'f2', hosts: ['douyin.com'], platform: 'douyin' },
  { engine: 'yt-dlp', hosts: ['tiktok.com'], platform: 'tiktok' },
  { engine: 'yt-dlp', hosts: ['youtube.com', 'youtu.be'], platform: 'youtube' },
  { engine: 'yt-dlp', hosts: ['instagram.com'], platform: 'instagram' },
  { engine: 'yt-dlp', hosts: ['x.com', 'twitter.com'], platform: 'x' },
  { engine: 'yt-dlp', hosts: ['bilibili.com', 'b23.tv'], platform: 'bilibili' },
  { engine: 'yt-dlp', hosts: ['facebook.com', 'fb.watch'], platform: 'facebook' },
  { engine: 'yt-dlp', hosts: ['vimeo.com'], platform: 'vimeo' },
  { engine: 'yt-dlp', hosts: ['reddit.com', 'redd.it'], platform: 'reddit' },
  { engine: 'yt-dlp', hosts: ['soundcloud.com'], platform: 'soundcloud' },
  { engine: 'yt-dlp', hosts: ['twitch.tv'], platform: 'twitch' },
  { engine: 'yt-dlp', hosts: ['pinterest.com', 'pin.it'], platform: 'pinterest' },
  { engine: 'yt-dlp', hosts: ['dailymotion.com', 'dai.ly'], platform: 'dailymotion' },
  { engine: 'yt-dlp', hosts: ['weibo.com', 'weibo.cn'], platform: 'weibo' }
] as const;

const URL_IN_TEXT_PATTERN = /https?:\/\/[^\s<>"'`]+/iu;
const TRAILING_SHARE_PUNCTUATION = /[),.;!?\]}，。；！？）】》」』]+$/u;

export function normalizeV2MediaInput(value: unknown): NormalizedV2MediaInput {
  if (typeof value !== 'string') throw new BadRequestException('请粘贴作品链接或分享文本');
  const input = value.trim();
  if (!input || input.length > V2_MEDIA_RESOLVER_LIMITS.inputLength) {
    throw new BadRequestException(
      `作品链接或分享文本长度必须为 1 至 ${V2_MEDIA_RESOLVER_LIMITS.inputLength} 个字符`
    );
  }

  const matchedUrl = input.match(URL_IN_TEXT_PATTERN)?.[0];
  const rawUrl = (matchedUrl ?? (/^[^\s/]+\.[^\s]+$/u.test(input) ? `https://${input}` : ''))
    .replace(TRAILING_SHARE_PUNCTUATION, '')
    .trim();
  if (!rawUrl) throw new BadRequestException('没有找到可解析的作品链接');

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new BadRequestException('作品链接格式无效');
  }
  if (
    !['http:', 'https:'].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    (parsed.port && parsed.port !== '80' && parsed.port !== '443')
  ) {
    throw new BadRequestException('作品链接格式无效');
  }

  const hostname = parsed.hostname.toLowerCase().replace(/\.$/u, '');
  const supported = SUPPORTED_MEDIA_HOSTS.find(({ hosts }) =>
    hosts.some((host) => hostname === host || hostname.endsWith(`.${host}`))
  );
  if (!supported) {
    throw new BadRequestException(
      '暂不支持该平台，请使用抖音、TikTok、YouTube、Instagram、X、B站等已支持平台的作品链接'
    );
  }

  parsed.hash = '';
  return {
    engine: supported.engine,
    platform: supported.platform,
    url: parsed.toString()
  };
}
