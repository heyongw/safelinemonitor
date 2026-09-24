'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

const DEFAULTS = {
  listen: { host: '0.0.0.0', port: 8088 },
  range: 'last1Day',
  refresh: {
    fastMs: 10000,
    slowMs: 60000,
    metaMs: 300000,
    timeoutMs: 10000,
    recordLimit: 20
  }
};

// 雷池前端使用的时间范围取值；社区版只返回默认窗口，企业版会按此范围统计。
const ALLOWED_RANGES = ['today', 'last1Day', 'last7Day', 'last30Day'];

function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function normalizeInstance(raw, index) {
  const token = String((raw && raw.token) || '').trim();
  const baseUrl = String((raw && (raw.baseUrl || raw.url)) || '').trim().replace(/\/+$/, '');
  return {
    name: String((raw && raw.name) || `雷池-${index + 1}`).trim(),
    baseUrl,
    token,
    allowInsecureTls: !(raw && raw.allowInsecureTls === false),
    enabled: !(raw && raw.enabled === false) && Boolean(baseUrl) && Boolean(token)
  };
}

function loadConfig() {
  const file = process.env.LEICHI_CONFIG || path.join(ROOT, 'config.json');
  if (!fs.existsSync(file)) {
    throw new Error(
      `未找到配置文件 ${file}\n请先复制 config.example.json 为 config.json，并填写三台雷池的地址与 API Token。`
    );
  }

  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`解析配置文件失败 ${file}: ${err.message}`);
  }

  const instances = Array.isArray(raw.instances) ? raw.instances.map(normalizeInstance) : [];
  if (!instances.length) throw new Error(`配置文件 ${file} 中没有配置任何 instances`);

  return {
    file,
    range: ALLOWED_RANGES.includes(raw.range) ? raw.range : DEFAULTS.range,
    listen: {
      host: String((raw.listen && raw.listen.host) || DEFAULTS.listen.host),
      port: num(raw.listen && raw.listen.port, DEFAULTS.listen.port)
    },
    refresh: {
      fastMs: num(raw.refresh && raw.refresh.fastMs, DEFAULTS.refresh.fastMs),
      slowMs: num(raw.refresh && raw.refresh.slowMs, DEFAULTS.refresh.slowMs),
      metaMs: num(raw.refresh && raw.refresh.metaMs, DEFAULTS.refresh.metaMs),
      timeoutMs: num(raw.refresh && raw.refresh.timeoutMs, DEFAULTS.refresh.timeoutMs),
      recordLimit: num(raw.refresh && raw.refresh.recordLimit, DEFAULTS.refresh.recordLimit)
    },
    instances
  };
}

module.exports = { loadConfig, ROOT, DEFAULTS, ALLOWED_RANGES };
