'use strict';

const http = require('http');
const https = require('https');

// 极简 HTTP 客户端：零依赖，支持自签名 HTTPS 证书、超时与查询串拼装。

function normalizeParam(value) {
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return String(value);
}

function buildQuery(params) {
  const pairs = [];
  for (const [key, value] of Object.entries(params || {})) {
    if (value === undefined || value === null || value === '') continue;
    pairs.push(`${encodeURIComponent(key)}=${encodeURIComponent(normalizeParam(value))}`);
  }
  return pairs.length ? `?${pairs.join('&')}` : '';
}

function request(url, options) {
  const {
    method = 'GET',
    headers = {},
    body,
    timeoutMs = 10000,
    allowInsecureTls = true
  } = options || {};

  return new Promise((resolve, reject) => {
    let target;
    try {
      target = new URL(url);
    } catch (err) {
      reject(new Error(`URL 无效: ${url}`));
      return;
    }

    const isHttps = target.protocol === 'https:';
    const transport = isHttps ? https : http;
    const payload = body === undefined || body === null
      ? null
      : typeof body === 'string' ? body : JSON.stringify(body);

    const reqHeaders = Object.assign({}, headers);
    if (payload !== null) {
      if (!reqHeaders['Content-Type']) reqHeaders['Content-Type'] = 'application/json';
      reqHeaders['Content-Length'] = Buffer.byteLength(payload);
    }

    const req = transport.request(
      {
        method,
        hostname: target.hostname,
        port: target.port || (isHttps ? 443 : 80),
        path: `${target.pathname}${target.search}`,
        headers: reqHeaders,
        rejectUnauthorized: isHttps ? !allowInsecureTls : undefined,
        timeout: timeoutMs,
        agent: false
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8')
          });
        });
      }
    );

    req.on('timeout', () => req.destroy(new Error(`请求超时(${timeoutMs}ms)`)));
    req.on('error', reject);
    if (payload !== null) req.write(payload);
    req.end();
  });
}

module.exports = { request, buildQuery };
