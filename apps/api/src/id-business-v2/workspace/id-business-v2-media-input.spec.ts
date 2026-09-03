import { describe, expect, it } from 'vitest';
import { normalizeV2MediaInput } from './id-business-v2-media-input';

describe('normalizeV2MediaInput', () => {
  it('extracts a Douyin short link from pasted Chinese share text and selects F2', () => {
    expect(
      normalizeV2MediaInput('复制打开抖音，看看【作品】 https://v.douyin.com/abc123/ ！')
    ).toMatchObject({
      engine: 'f2',
      platform: 'douyin',
      url: 'https://v.douyin.com/abc123/'
    });
  });

  it.each([
    ['https://www.tiktok.com/@member/video/1', 'tiktok'],
    ['https://youtu.be/example', 'youtube'],
    ['https://www.instagram.com/reel/example/', 'instagram'],
    ['https://x.com/member/status/1', 'x'],
    ['https://www.bilibili.com/video/BV1example', 'bilibili']
  ])('routes %s through the multi-platform resolver', (url, platform) => {
    expect(normalizeV2MediaInput(url)).toMatchObject({ engine: 'yt-dlp', platform });
  });

  it('rejects credentials, custom ports and unsupported hosts', () => {
    expect(() => normalizeV2MediaInput('https://user:pass@youtube.com/watch?v=1')).toThrow(
      '作品链接格式无效'
    );
    expect(() => normalizeV2MediaInput('https://youtube.com:8443/watch?v=1')).toThrow(
      '作品链接格式无效'
    );
    expect(() => normalizeV2MediaInput('https://youtube.com.attacker.invalid/watch?v=1')).toThrow(
      '暂不支持该平台'
    );
  });
});
