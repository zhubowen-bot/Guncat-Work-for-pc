// 网关专属请求头。
//
// 大多数 OpenAI/Anthropic 兼容服务只认标准的 Authorization / x-api-key，
// 但 Opencode Go 在 2026-09 之后要求每个请求带上稳定的会话标识，
// 缺了会直接返回 400 MissingSessionID。这些头只按 Base URL 识别、只补不覆盖，
// 用户自己填的额外请求头仍然优先。
import { ApiConfig } from '../model/ApiConfig';

export class ProviderHeaders {
  static readonly OPENCODE_SESSION_HEADER: string = 'x-opencode-session';

  /** 是否 Opencode（Go / Zen）网关：两种接入方式共用同一个主机名 */
  static isOpenCode(baseUrl: string): boolean {
    let value: string = baseUrl.trim().toLowerCase();
    return value.indexOf('opencode.ai/') >= 0 || value === 'https://opencode.ai' ||
      value === 'http://opencode.ai';
  }

  /** 把网关要求的请求头补进 headers（原地修改并返回，便于链式使用） */
  static apply(config: ApiConfig, headers: Record<string, string>): Record<string, string> {
    if (!ProviderHeaders.isOpenCode(config.baseUrl)) {
      return headers;
    }
    if (headers[ProviderHeaders.OPENCODE_SESSION_HEADER] === undefined) {
      let sessionId: string = config.sessionId.trim();
      if (sessionId === '') {
        sessionId = ProviderHeaders.fallbackSessionIdOf();
      }
      headers[ProviderHeaders.OPENCODE_SESSION_HEADER] = sessionId;
    }
    return headers;
  }

  /** 没有会话上下文时（标题生成等辅助请求）退回到进程级稳定 id */
  private static fallbackSessionId: string = '';

  private static fallbackSessionIdOf(): string {
    if (ProviderHeaders.fallbackSessionId === '') {
      ProviderHeaders.fallbackSessionId = ProviderHeaders.newSessionId();
    }
    return ProviderHeaders.fallbackSessionId;
  }

  static newSessionId(): string {
    let hex: string = '0123456789abcdef';
    let raw: string = '';
    for (let i: number = 0; i < 32; i++) {
      raw += hex.charAt(Math.floor(Math.random() * 16));
    }
    // UUID v4 形状：会话头是可观测字段，保持标准形状便于服务端与日志识别
    let variant: string = ((parseInt(raw.charAt(16), 16) & 0x3) | 0x8).toString(16);
    return raw.substring(0, 8) + '-' + raw.substring(8, 12) + '-4' +
      raw.substring(13, 16) + '-' + variant + raw.substring(17, 20) + '-' +
      raw.substring(20, 32);
  }
}
