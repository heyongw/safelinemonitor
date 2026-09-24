'use strict';

const { request, buildQuery } = require('./httpclient');

// 雷池控制台 API 客户端。所有接口前缀为 /api，鉴权使用请求头 X-SLCE-API-Token。
class LeichiClient {
  constructor(options) {
    this.name = options.name;
    this.baseUrl = String(options.baseUrl || '').replace(/\/+$/, '');
    this.token = options.token;
    this.allowInsecureTls = options.allowInsecureTls !== false;
    this.timeoutMs = options.timeoutMs || 10000;
  }

  async raw(pathname, params, options) {
    const url = `${this.baseUrl}/api${pathname}${buildQuery(params)}`;
    const startedAt = Date.now();
    const res = await request(url, {
      method: (options && options.method) || 'GET',
      headers: {
        'X-SLCE-API-Token': this.token,
        Accept: 'application/json'
      },
      body: options && options.body,
      timeoutMs: this.timeoutMs,
      allowInsecureTls: this.allowInsecureTls
    });
    const latencyMs = Date.now() - startedAt;

    let payload;
    try {
      payload = JSON.parse(res.body);
    } catch (err) {
      throw new Error(`响应不是合法 JSON (HTTP ${res.status}): ${res.body.slice(0, 120)}`);
    }

    if (res.status === 401) {
      throw new Error('鉴权失败(401)，请检查 API Token 是否正确');
    }
    if (payload && payload.err) {
      throw new Error(`${payload.err}${payload.msg ? `: ${payload.msg}` : ''}`);
    }
    if (res.status >= 400) {
      throw new Error(`请求失败 HTTP ${res.status}: ${res.body.slice(0, 120)}`);
    }
    return { data: payload ? payload.data : null, latencyMs };
  }

  // ---- 系统与资产 ----
  system() {
    return this.raw('/open/system');
  }

  sites() {
    return this.raw('/open/site');
  }

  // ---- 攻击 / 拦截日志 ----
  // 黑白名单命中日志：社区版与企业版均可用。start/end 单位为毫秒。
  ruleRecords(options) {
    const params = {
      page: (options && options.page) || 1,
      page_size: (options && options.pageSize) || 20
    };
    if (options && options.action !== undefined) params.action = options.action;
    if (options && options.start) params.start = options.start;
    if (options && options.end) params.end = options.end;
    return this.raw('/open/records/rule', params);
  }

  // 频率限制（访问限制）拦截日志：社区版也能用。begin/end 单位为秒，而非毫秒。
  aclRecords(options) {
    const params = {
      page: (options && options.page) || 1,
      page_size: (options && options.pageSize) || 20
    };
    if (options && options.begin) params.begin = options.begin;
    if (options && options.end) params.end = options.end;
    if (options && options.ip) params.ip = options.ip;
    if (options && options.site) params.site = options.site;
    return this.raw('/open/records/acl', params);
  }

  // ---- 实时与统计 ----
  qps(count, siteId) {
    return this.raw('/stat/qps', { count: count || 12, site_id: siteId === undefined ? 0 : siteId });
  }

  access(range) {
    return this.raw('/stat/advance/access', range);
  }

  attack(range) {
    return this.raw('/stat/advance/attack', range);
  }

  accessTrend(range) {
    return this.raw('/stat/advance/trend/access', range);
  }

  interceptTrend(range) {
    return this.raw('/stat/advance/trend/intercept', range);
  }

  statusCodes(range, size) {
    // upstream=true 才返回完整的响应状态码分布；upstream=false 只有被拦截状态（403/429/502）
    return this.raw('/stat/advance/status_code', Object.assign({ size: size || 10, upstream: true }, range));
  }

  errorStatusCodes(range) {
    return this.raw('/stat/advance/error_status_code', Object.assign({ upstream: false }, range));
  }

  locations(range, size) {
    return this.raw('/stat/advance/location', Object.assign({ size: size || 10, action: 0, global: true }, range));
  }

  domains(range, size) {
    return this.raw('/stat/advance/domain', Object.assign({ size: size || 10, refer: false }, range));
  }

  clients(range, size) {
    return this.raw('/stat/advance/client', Object.assign({ size: size || 10 }, range));
  }

  pages(range, size) {
    return this.raw('/stat/advance/page', Object.assign({ size: size || 10, refer: false }, range));
  }

  securityTrends(type, range, top) {
    return this.raw('/open/security_posture/trends', Object.assign({ type, top: top || 10 }, range));
  }

  records(limit) {
    return this.raw('/open/records', { page: 1, page_size: limit || 20 });
  }
}

module.exports = { LeichiClient };
