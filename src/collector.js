'use strict';

const { LeichiClient } = require('./leichi');
const { INTERCEPT_TYPES, attackTypeName, moduleName, aclActionName } = require('./labels');

const INTERCEPT_KEYS = ['block', 'blacklist', 'rate_limit', 'challenge', 'auth_defense', 'offline'];

// 应用运行模式（雷池前端枚举 Defense=0 / Offline=1 / Dryrun=2）
const SITE_MODES = { 0: '防护', 1: '维护', 2: '观察' };

// /stat/qps 返回的每个采样点是「该 5 秒窗口内收到的请求数」，不是每秒请求数。
// 雷池控制台前端同样按 value / 5 换算（statQps: Math.ceil(sum / 5)），这里保持一致。
const QPS_BUCKET_SECONDS = 5;
// 取最近若干个「已走完」的窗口求平均：既避开当前未累积完的窗口，又能平滑掉单点抖动。
const QPS_AVERAGE_BUCKETS = 3;

let regionNames = null;
try {
  regionNames = new Intl.DisplayNames(['zh-CN'], { type: 'region' });
} catch (err) {
  regionNames = null;
}

// 把国家/地区代码转换成中文名称，例如 CN -> 中国
function countryText(code) {
  if (!code) return '';
  const key = String(code).toUpperCase();
  if (!regionNames || key.length !== 2) return key;
  try {
    return regionNames.of(key) || key;
  } catch (err) {
    return key;
  }
}

// 本机时区的「今日 00:00」，用于按自然日统计黑名单拦截条数
function startOfTodayMs() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
}

// 频率限制日志接口的 begin/end 用秒，这里给出「今日 00:00」的秒级时间戳
function startOfTodaySeconds() {
  return Math.floor(startOfTodayMs() / 1000);
}

// 雷池的 created_at 是带时区的 ISO 字符串（微秒精度），这里统一换算成秒级时间戳
function isoToSeconds(text) {
  if (!text) return 0;
  const normalized = String(text).replace(/(\.\d{3})\d+/, '$1');
  const ms = Date.parse(normalized);
  return Number.isFinite(ms) ? Math.round(ms / 1000) : 0;
}

const METRICS = [
  { key: 'qps', tier: 'fast', fetch: (c) => c.qps(12) },
  { key: 'access', tier: 'slow', fetch: (c, ctx) => c.access(ctx.range) },
  { key: 'attack', tier: 'slow', fetch: (c, ctx) => c.attack(ctx.range) },
  { key: 'accessTrend', tier: 'slow', fetch: (c, ctx) => c.accessTrend(ctx.range) },
  { key: 'interceptTrend', tier: 'slow', fetch: (c, ctx) => c.interceptTrend(ctx.range) },
  { key: 'statusCodes', tier: 'slow', fetch: (c, ctx) => c.statusCodes(ctx.range, 10) },
  { key: 'errorStatusCodes', tier: 'slow', fetch: (c, ctx) => c.errorStatusCodes(ctx.range) },
  { key: 'locations', tier: 'slow', fetch: (c, ctx) => c.locations(ctx.range, 10) },
  { key: 'domains', tier: 'slow', fetch: (c, ctx) => c.domains(ctx.range, 10) },
  { key: 'clients', tier: 'slow', fetch: (c, ctx) => c.clients(ctx.range, 10) },
  { key: 'attackTypes', tier: 'slow', fetch: (c, ctx) => c.securityTrends('attack_type', ctx.range, 10) },
  { key: 'events', tier: 'fast', fetch: (c, ctx) => c.records(ctx.recordLimit) },
  // 黑名单拦截日志：最近若干条明细 + 今日拦截条数（明细走高频，今日计数走低频）
  { key: 'blacklistLogs', tier: 'fast', fetch: (c, ctx) => c.ruleRecords({ pageSize: ctx.recordLimit, action: 1 }) },
  {
    key: 'blacklistToday',
    tier: 'slow',
    fetch: (c) => c.ruleRecords({ pageSize: 1, action: 1, start: startOfTodayMs(), end: Date.now() })
  },
  // 频率限制拦截日志：最近若干条明细 + 今日触发条数（begin/end 为秒）
  { key: 'rateLimitLogs', tier: 'fast', fetch: (c, ctx) => c.aclRecords({ pageSize: ctx.recordLimit }) },
  {
    key: 'rateLimitToday',
    tier: 'slow',
    fetch: (c) => c.aclRecords({ pageSize: 1, begin: startOfTodaySeconds(), end: Math.floor(Date.now() / 1000) })
  },
  { key: 'system', tier: 'meta', fetch: (c) => c.system() },
  { key: 'sites', tier: 'slow', fetch: (c) => c.sites() }
];

function sum(list) {
  return list.reduce((acc, n) => acc + (Number.isFinite(Number(n)) ? Number(n) : 0), 0);
}

// 简单的并发闸门，避免瞬间打爆雷池控制台
function createLimiter(max) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= max || !queue.length) return;
    active += 1;
    const job = queue.shift();
    Promise.resolve()
      .then(job.fn)
      .then(job.resolve, job.reject)
      .finally(() => {
        active -= 1;
        next();
      });
  };
  return (fn) => new Promise((resolve, reject) => {
    queue.push({ fn, resolve, reject });
    next();
  });
}

class Collector {
  constructor(config, logger) {
    this.config = config;
    this.logger = logger || console;
    this.limiter = createLimiter(8);
    this.instances = config.instances.map((item) => ({
      meta: item,
      client: new LeichiClient({
        name: item.name,
        baseUrl: item.baseUrl,
        token: item.token,
        allowInsecureTls: item.allowInsecureTls,
        timeoutMs: config.refresh.timeoutMs
      }),
      state: {
        cache: new Map(),
        online: false,
        lastError: '',
        lastOkAt: 0,
        lastLatencyMs: 0,
        consecutiveErrors: 0
      }
    }));
    this.range = { time_preset: config.range || 'last1Day' };
    this.lastSnapshotAt = 0;
  }

  ttlOf(tier) {
    const refresh = this.config.refresh;
    if (tier === 'fast') return refresh.fastMs;
    if (tier === 'meta') return refresh.metaMs;
    return refresh.slowMs;
  }

  async fetchMetric(entry, metric) {
    const now = Date.now();
    const cached = entry.state.cache.get(metric.key);
    if (cached && now - cached.at < this.ttlOf(metric.tier)) return;

    try {
      const result = await this.limiter(() => metric.fetch(entry.client, {
        range: this.range,
        recordLimit: this.config.refresh.recordLimit
      }));
      entry.state.cache.set(metric.key, { value: result.data, at: Date.now(), error: '' });
      entry.state.online = true;
      entry.state.lastOkAt = Date.now();
      entry.state.lastError = '';
      entry.state.lastLatencyMs = result.latencyMs;
      entry.state.consecutiveErrors = 0;
    } catch (err) {
      const message = err && err.message ? err.message : String(err);
      entry.state.cache.set(metric.key, {
        value: cached ? cached.value : null,
        at: cached ? cached.at : 0,
        error: message
      });
      entry.state.consecutiveErrors += 1;
      entry.state.lastError = message;
      if (entry.state.consecutiveErrors >= 2) entry.state.online = false;
      this.logger.warn(`[${entry.meta.name}] ${metric.key} 采集失败: ${message}`);
    }
  }

  async tick() {
    const enabled = this.instances.filter((entry) => entry.meta.enabled);
    await Promise.all(enabled.map((entry) => Promise.all(
      METRICS.map((metric) => this.fetchMetric(entry, metric))
    )));
    this.lastSnapshotAt = Date.now();
  }

  start() {
    this.tick().catch((err) => this.logger.error(err));
    this.timer = setInterval(() => {
      this.tick().catch((err) => this.logger.error(err));
    }, Math.max(2000, Math.min(5000, this.config.refresh.fastMs)));
    if (this.timer.unref) this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  value(entry, key) {
    const item = entry.state.cache.get(key);
    return item ? item.value : null;
  }

  metricError(entry, key) {
    const item = entry.state.cache.get(key);
    return item ? item.error : '';
  }

  summarizeInstance(entry) {
    const name = entry.meta.name;
    const access = this.value(entry, 'access') || {};
    const attack = this.value(entry, 'attack') || {};
    const intercept = attack.intercept || {};
    const qps = this.value(entry, 'qps') || {};
    const nodes = Array.isArray(qps.nodes) ? qps.nodes : [];
    // 每个采样点把该窗口内所有节点/监听的计数相加，得到窗口请求数
    const buckets = nodes.map((node) => {
      let total = 0;
      for (const [key, value] of Object.entries(node)) {
        if (key === 'time') continue;
        total += Number(value) || 0;
      }
      return { label: String(node.time || ''), value: total };
    });
    // 最后一个采样点一般还在累积（当前窗口未走完），算实时 QPS 时排除
    const completeBuckets = buckets.length > 1 ? buckets.slice(0, -1) : buckets;
    const recentBuckets = completeBuckets.slice(-QPS_AVERAGE_BUCKETS);
    const qpsPerSecond = recentBuckets.length
      ? Math.round(sum(recentBuckets.map((bucket) => bucket.value)) / recentBuckets.length / QPS_BUCKET_SECONDS)
      : 0;
    const system = this.value(entry, 'system') || {};
    const sites = this.value(entry, 'sites');
    const siteList = sites && Array.isArray(sites.data) ? sites.data : [];
    const errors = this.value(entry, 'errorStatusCodes') || {};
    const blacklistToday = this.value(entry, 'blacklistToday') || {};
    const rateLimitToday = this.value(entry, 'rateLimitToday') || {};

    return {
      name,
      baseUrl: entry.meta.baseUrl,
      enabled: entry.meta.enabled,
      online: entry.state.online,
      error: entry.state.lastError,
      latencyMs: entry.state.lastLatencyMs,
      lastOkAt: entry.state.lastOkAt,
      version: system.version || '',
      machineId: system.machine_id || '',
      licensed: Boolean(system.license && system.license.valid),
      serverTime: system.time || '',
      siteCount: siteList.length,
      siteEnabledCount: siteList.filter((s) => s.is_enabled).length,
      // 应用维度：req_value / denied_value 是雷池控制台「应用」页展示的今日请求与今日拦截
      sites: siteList.map((site) => {
        const mode = Number(site.mode);
        const hosts = Array.isArray(site.server_names) ? site.server_names : [];
        return {
          id: site.id,
          name: site.comment || hosts[0] || `应用 ${site.id}`,
          hosts,
          ports: Array.isArray(site.ports) ? site.ports : [],
          requests: Number(site.req_value) || 0,
          denied: Number(site.denied_value) || 0,
          mode: Number.isFinite(mode) ? mode : -1,
          modeName: SITE_MODES[mode] || `模式 ${site.mode}`,
          enabled: Boolean(site.is_enabled)
        };
      }),
      access: {
        requests: Number(access.access) || 0,
        pv: Number(access.pv) || 0,
        ip: Number(access.ip) || 0,
        session: Number(access.session) || 0
      },
      intercept: INTERCEPT_KEYS.reduce((acc, key) => {
        acc[key] = Number(intercept[key]) || 0;
        return acc;
      }, {}),
      interceptTotal: sum(INTERCEPT_KEYS.map((key) => intercept[key])),
      attackIp: Number(attack.attack_ip) || 0,
      // 黑名单拦截（今日）：/open/records/rule?action=1 的 total
      blacklistToday: Number(blacklistToday.total) || 0,
      // 频率限制拦截（今日）：/open/records/acl 按 begin/end 过滤后的 total
      rateLimitToday: Number(rateLimitToday.total) || 0,
      errors: {
        error4xx: Number(errors.error_4xx) || 0,
        error5xx: Number(errors.error_5xx) || 0
      },
      qps: qpsPerSecond,
      qpsSamples: buckets.map((bucket) => ({ label: bucket.label, value: Math.round(bucket.value / QPS_BUCKET_SECONDS) })),
      qpsWindowSeconds: recentBuckets.length * QPS_BUCKET_SECONDS,
      metricErrors: METRICS
        .map((metric) => ({ key: metric.key, error: this.metricError(entry, metric.key) }))
        .filter((item) => item.error)
    };
  }

  collectTrend(entry, key) {
    const data = this.value(entry, key);
    if (!Array.isArray(data)) return [];
    return data
      .map((item) => ({ time: Number(item.time) || 0, count: Number(item.count) || 0 }))
      .filter((item) => item.time > 0)
      .sort((a, b) => a.time - b.time);
  }

  mergeTrends(instances, key) {
    const series = instances.map((entry) => ({
      name: entry.meta.name,
      points: this.collectTrend(entry, key)
    }));
    const times = [];
    const index = new Map();
    for (const item of series) {
      for (const point of item.points) {
        if (!index.has(point.time)) {
          index.set(point.time, times.length);
          times.push(point.time);
        }
      }
    }
    times.sort((a, b) => a - b);
    const rows = series.map((item) => {
      const bucket = new Array(times.length).fill(0);
      for (const point of item.points) bucket[index.get(point.time)] = point.count;
      return { name: item.name, values: bucket };
    });
    const totals = times.map((_, i) => rows.reduce((acc, row) => acc + (row.values[i] || 0), 0));
    return { times, series: rows, totals };
  }

  mergeRank(instances, key, pick) {
    const bucket = new Map();
    for (const entry of instances) {
      const data = this.value(entry, key);
      if (!Array.isArray(data)) continue;
      for (const item of data) {
        const label = pick(item);
        if (!label) continue;
        bucket.set(label, (bucket.get(label) || 0) + (Number(item.count) || 0));
      }
    }
    return Array.from(bucket.entries())
      .map(([name, value]) => ({ name, value }))
      .sort((a, b) => b.value - a.value);
  }

  collectAttackTypes(instances) {
    const bucket = new Map();
    for (const entry of instances) {
      const data = this.value(entry, 'attackTypes');
      const top = data && Array.isArray(data.top) ? data.top : [];
      for (const item of top) {
        for (const [id, count] of Object.entries(item)) {
          const name = attackTypeName(id);
          bucket.set(name, (bucket.get(name) || 0) + (Number(count) || 0));
        }
      }
    }
    return Array.from(bucket.entries())
      .map(([name, value]) => ({ name, value }))
      .sort((a, b) => b.value - a.value);
  }

  collectEvents(instances) {
    const rows = [];
    for (const entry of instances) {
      const data = this.value(entry, 'events');
      const list = data && Array.isArray(data.data) ? data.data : [];
      for (const item of list) {
        rows.push({
          instance: entry.meta.name,
          time: Number(item.created_at) || 0,
          srcIp: item.src_ip || '',
          country: item.country || '',
          countryName: countryText(item.country),
          province: item.province || '',
          city: item.city || '',
          host: item.host || '',
          url: item.url_path || '',
          action: Number(item.action),
          riskLevel: Number(item.risk_level) || 0,
          rule: item.rule_id || item.short_rule_id || '',
          ruleName: ruleLabel(item.rule_id || item.short_rule_id),
          siteUuid: item.site_uuid || ''
        });
      }
    }
    rows.sort((a, b) => b.time - a.time);
    return rows.slice(0, this.config.refresh.recordLimit);
  }

  // 黑名单拦截日志：/open/records/rule 的明细，多实例合并后按时间倒序
  collectBlacklistLogs(instances) {
    const rows = [];
    for (const entry of instances) {
      const data = this.value(entry, 'blacklistLogs');
      const list = data && Array.isArray(data.data) ? data.data : [];
      for (const item of list) {
        const rule = item.reason || item.policy_name || item.rule_id || '';
        rows.push({
          instance: entry.meta.name,
          time: Number(item.created_at) || 0,
          srcIp: item.src_ip || '',
          country: item.country || '',
          countryName: countryText(item.country),
          province: item.province || '',
          city: item.city || '',
          host: item.host || '',
          url: item.url_path || '',
          method: item.method || '',
          action: Number(item.action),
          module: item.module || '',
          rule,
          policy: item.policy_name || '',
          siteUuid: item.site_uuid || ''
        });
      }
    }
    rows.sort((a, b) => b.time - a.time);
    return rows.slice(0, this.config.refresh.recordLimit);
  }

  // 频率限制拦截日志：/open/records/acl 的明细，多实例合并后按时间倒序
  collectRateLimitLogs(instances) {
    const rows = [];
    for (const entry of instances) {
      const data = this.value(entry, 'rateLimitLogs');
      const list = data && Array.isArray(data.data) ? data.data : [];
      for (const item of list) {
        rows.push({
          instance: entry.meta.name,
          time: isoToSeconds(item.created_at),
          validBefore: isoToSeconds(item.valid_before),
          srcIp: item.ip || '',
          country: item.country || '',
          countryName: countryText(item.country),
          province: item.province || '',
          city: item.city || '',
          site: item.site_comment || (Array.isArray(item.site_server_names) ? item.site_server_names[0] : '') || '',
          rule: item.reason || '',
          count: Number(item.count) || 0,
          period: Number(item.period) || 0,
          blockMin: Number(item.block_min) || 0,
          deniedCount: Number(item.denied_count) || 0,
          action: item.action || item.result || '',
          actionName: aclActionName(item.action || item.result)
        });
      }
    }
    rows.sort((a, b) => b.time - a.time);
    return rows.slice(0, this.config.refresh.recordLimit);
  }

  snapshot() {
    const instances = this.instances.filter((entry) => entry.meta.enabled);
    const summaries = instances.map((entry) => this.summarizeInstance(entry));
    const accessTrend = this.mergeTrends(instances, 'accessTrend');
    const interceptTrend = this.mergeTrends(instances, 'interceptTrend');

    const interceptTotals = INTERCEPT_KEYS.reduce((acc, key) => {
      acc[key] = sum(summaries.map((item) => item.intercept[key]));
      return acc;
    }, {});

    const window = {
      from: accessTrend.times.length ? accessTrend.times[0] : 0,
      to: accessTrend.times.length ? accessTrend.times[accessTrend.times.length - 1] : 0
    };

    // 按实例分组、组内按请求量倒序：同名应用在不同实例上数值不同，混排容易看串行
    const siteRows = [];
    for (const item of summaries) {
      const rows = [];
      for (const site of item.sites || []) {
        rows.push({ instance: item.name, ...site });
      }
      rows.sort((a, b) => b.requests - a.requests);
      siteRows.push(...rows);
    }

    return {
      generatedAt: Date.now(),
      lastSnapshotAt: this.lastSnapshotAt,
      range: this.range.time_preset,
      window,
      siteTotals: {
        requests: sum(siteRows.map((row) => row.requests)),
        denied: sum(siteRows.map((row) => row.denied)),
        count: siteRows.length
      },
      blacklistTotals: {
        today: sum(summaries.map((item) => item.blacklistToday))
      },
      rateLimitTotals: {
        today: sum(summaries.map((item) => item.rateLimitToday))
      },
      sites: siteRows,
      totals: {
        requests: sum(summaries.map((item) => item.access.requests)),
        pv: sum(summaries.map((item) => item.access.pv)),
        ip: sum(summaries.map((item) => item.access.ip)),
        session: sum(summaries.map((item) => item.access.session)),
        attackIp: sum(summaries.map((item) => item.attackIp)),
        intercept: sum(Object.values(interceptTotals)),
        blacklistToday: sum(summaries.map((item) => item.blacklistToday)),
        rateLimitToday: sum(summaries.map((item) => item.rateLimitToday)),
        qps: sum(summaries.map((item) => item.qps)),
        error4xx: sum(summaries.map((item) => item.errors.error4xx)),
        error5xx: sum(summaries.map((item) => item.errors.error5xx)),
        online: summaries.filter((item) => item.online).length,
        total: summaries.length
      },
      interceptTypes: INTERCEPT_KEYS.map((key) => ({
        key,
        name: INTERCEPT_TYPES[key] || key,
        value: interceptTotals[key] || 0
      })),
      instances: summaries,
      trends: {
        access: accessTrend,
        intercept: interceptTrend
      },
      provinces: this.mergeRank(instances, 'locations', (item) => {
        if (!item) return '';
        const country = countryText(item.country) || '未知地区';
        return item.province ? `${country} · ${item.province}` : country;
      }).slice(0, 10),
      statusCodes: this.mergeRank(instances, 'statusCodes', (item) => (item ? item.status_code : '')).slice(0, 10),
      domains: this.mergeRank(instances, 'domains', (item) => (item ? item.domain : '')).slice(0, 10),
      browsers: (() => {
        const bucket = new Map();
        for (const entry of instances) {
          const data = this.value(entry, 'clients');
          // 字段名随雷池版本变化：老版本返回 OS/Browser，新版本 schema 为 os/browser
          const list = data && (Array.isArray(data.Browser) ? data.Browser : Array.isArray(data.browser) ? data.browser : []) || [];
          for (const item of list) {
            bucket.set(item.browser, (bucket.get(item.browser) || 0) + (Number(item.count) || 0));
          }
        }
        return Array.from(bucket.entries()).map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value).slice(0, 8);
      })(),
      attackTypes: this.collectAttackTypes(instances).slice(0, 10),
      recentEvents: this.collectEvents(instances),
      blacklistLogs: this.collectBlacklistLogs(instances),
      rateLimitLogs: this.collectRateLimitLogs(instances)
    };
  }
}

function ruleLabel(rule) {
  if (!rule) return '';
  const text = String(rule);
  if (text.startsWith('m_')) return moduleName(text);
  if (/^\d+$/.test(text)) return attackTypeName(text);
  return moduleName(text);
}

module.exports = { Collector };
