import { Injectable } from '@nestjs/common';
import { idBusinessV2RelayFetchJson } from './id-business-v2-relay-http';

const GEMINI_ORIGIN = 'https://generativelanguage.googleapis.com';

@Injectable()
export class IdBusinessV2RelayGeminiClient {
  async listModels(apiKey: string) {
    const models: Array<Record<string, unknown>> = [];
    let pageToken = '';
    do {
      const query = new URLSearchParams({ pageSize: '1000' });
      if (pageToken) query.set('pageToken', pageToken);
      const payload = await this.request<Record<string, unknown>>(
        `/v1beta/models?${query.toString()}`,
        apiKey
      );
      if (Array.isArray(payload.models)) {
        models.push(
          ...payload.models.filter((model): model is Record<string, unknown> =>
            Boolean(model && typeof model === 'object' && !Array.isArray(model))
          )
        );
      }
      pageToken = typeof payload.nextPageToken === 'string' ? payload.nextPageToken : '';
    } while (pageToken);
    return models;
  }

  async assertModelsAvailable(apiKey: string, models: string[]) {
    const available = new Set(
      (await this.listModels(apiKey)).map((model) =>
        String(model.name || '').replace(/^models\//, '')
      )
    );
    const missing = models.filter((model) => !available.has(model));
    if (missing.length) throw new Error(`Gemini API Key 当前不可调用：${missing.join('、')}`);
  }

  async testText(apiKey: string, model: string) {
    const payload = await this.generate(apiKey, model, {
      contents: [{ role: 'user', parts: [{ text: '只回复：Gemini API 直测成功' }] }],
      generationConfig: { maxOutputTokens: 64 }
    });
    const candidates = Array.isArray(payload.candidates) ? payload.candidates : [];
    const content = this.record(this.record(candidates[0]).content);
    const parts = Array.isArray(content.parts) ? content.parts : [];
    if (!parts.some((part) => typeof this.record(part).text === 'string')) {
      throw new Error(`${model} 未返回文本`);
    }
  }

  async testTts(apiKey: string, model: string) {
    const payload = await this.generate(apiKey, model, {
      contents: [{ role: 'user', parts: [{ text: '请自然朗读：Gemini API TTS 直测成功。' }] }],
      generationConfig: {
        responseModalities: ['AUDIO'],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } } }
      }
    });
    const candidates = Array.isArray(payload.candidates) ? payload.candidates : [];
    const content = this.record(this.record(candidates[0]).content);
    const parts = Array.isArray(content.parts) ? content.parts : [];
    const hasAudio = parts.some((part) => {
      const value = this.record(part);
      return Boolean(this.record(value.inlineData).data || this.record(value.inline_data).data);
    });
    if (!hasAudio) throw new Error(`${model} 未返回音频`);
  }

  private generate(apiKey: string, model: string, body: Record<string, unknown>) {
    return this.request<Record<string, unknown>>(
      `/v1beta/models/${encodeURIComponent(model)}:generateContent`,
      apiKey,
      { method: 'POST', body: JSON.stringify(body) }
    );
  }

  private request<T>(path: string, apiKey: string, options: RequestInit = {}) {
    return idBusinessV2RelayFetchJson(`${GEMINI_ORIGIN}${path}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey,
        ...options.headers
      },
      signal: AbortSignal.timeout(180_000)
    }) as Promise<T>;
  }

  private record(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  }
}
