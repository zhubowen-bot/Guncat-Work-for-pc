// 预置配置方案：用户装上就有、只需要补一个 API Key 就能用的方案。
//
// 与普通方案（用户自己「新建配置」出来的）存在同一份 apiProfiles 列表里，
// 这样切换、保存、筛选模型的逻辑完全复用，不需要维护第二套配置来源。
import { ApiConfig } from './ApiConfig';
import { ApiProfile } from './ApiProfile';

/** 一份预置方案的定义（名称 / 接入方式 / 地址 / 预留模型） */
export class ApiProfilePresetDef {
  id: string = '';
  name: string = '';
  provider: string = '';
  baseUrl: string = '';
  models: string[] = [];
}

export class ApiProfilePresets {
  static readonly DEEPSEEK_ID: string = 'preset-deepseek';
  static readonly OPENCODE_GO_ID: string = 'preset-opencode-go';

  /**
   * 预置方案表。
   *
   * Opencode Go 的 Anthropic Messages 端点固定挂在 /inference/go/anthropic 下，
   * LLMProtocol 会给它补 /v1/messages。该网关要求 x-opencode-session 请求头，
   * 请求头由 ProviderHeaders 在发请求时统一补上。
   */
  static all(): ApiProfilePresetDef[] {
    let deepseek: ApiProfilePresetDef = new ApiProfilePresetDef();
    deepseek.id = ApiProfilePresets.DEEPSEEK_ID;
    deepseek.name = 'Deepseek';
    deepseek.provider = 'anthropic-messages';
    deepseek.baseUrl = 'https://api.deepseek.com';
    // 只预留这一个模型；其他模型不预先填进方案
    deepseek.models = ['deepseek-flash'];

    let opencodeGo: ApiProfilePresetDef = new ApiProfilePresetDef();
    opencodeGo.id = ApiProfilePresets.OPENCODE_GO_ID;
    opencodeGo.name = 'Opencode Go';
    opencodeGo.provider = 'anthropic-messages';
    opencodeGo.baseUrl = 'https://opencode.ai/inference/go/anthropic';
    // 只预留这一个模型；其他模型不预先填进方案
    opencodeGo.models = ['deepseek-v4.1-flash'];
    return [deepseek, opencodeGo];
  }

  static isPresetId(id: string): boolean {
    return id === ApiProfilePresets.DEEPSEEK_ID || id === ApiProfilePresets.OPENCODE_GO_ID;
  }

  /**
   * 现有方案是否就是 DeepSeek 主域名配置（用于「兼容合并」）。
   * 允许带尾斜杠与子路径，但只认 api.deepseek.com 这个主机名 ——
   * 用户自建的代理域名不应被误判成官方地址。
   */
  static isDeepseekBaseUrl(baseUrl: string): boolean {
    let value: string = baseUrl.trim().toLowerCase();
    return /^https?:\/\/api\.deepseek\.com(\/|$)/.test(value);
  }

  /** 按定义造一份空 Key 的方案 */
  static toProfile(def: ApiProfilePresetDef): ApiProfile {
    let profile: ApiProfile = new ApiProfile();
    profile.id = def.id;
    profile.name = def.name;
    let config: ApiConfig = new ApiConfig();
    config.provider = def.provider;
    config.baseUrl = def.baseUrl;
    config.models = def.models.slice();
    config.model = def.models.length > 0 ? def.models[0] : '';
    profile.apiConfig = config;
    return profile;
  }
}
