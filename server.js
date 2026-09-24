'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const { loadConfig, ROOT } = require('./src/config');
const { Collector } = require('./src/collector');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.map': 'application/json; charset=utf-8'
};

const PUBLIC_DIR = path.join(ROOT, 'public');

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}

function sendFile(res, filePath) {
  fs.readFile(filePath, (err, content) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache'
    });
    res.end(content);
  });
}

async function main() {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }

  const collector = new Collector(config);
  collector.start();

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const pathname = decodeURIComponent(url.pathname);

    if (pathname === '/api/summary') {
      sendJson(res, 200, collector.snapshot());
      return;
    }

    if (pathname === '/api/config') {
      sendJson(res, 200, {
        range: collector.range.time_preset,
        refresh: config.refresh,
        instances: config.instances.map((item) => ({
          name: item.name,
          baseUrl: item.baseUrl,
          enabled: item.enabled
        }))
      });
      return;
    }

    if (pathname === '/api/health') {
      const snapshot = collector.snapshot();
      sendJson(res, 200, { ok: true, generatedAt: snapshot.generatedAt, totals: snapshot.totals });
      return;
    }

    if (pathname === '/api/refresh' && req.method === 'POST') {
      for (const entry of collector.instances) {
        for (const [key, item] of entry.state.cache) entry.state.cache.set(key, { ...item, at: 0 });
      }
      await collector.tick();
      sendJson(res, 200, collector.snapshot());
      return;
    }

    const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    const target = path.join(PUBLIC_DIR, relative);
    if (!target.startsWith(PUBLIC_DIR)) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Forbidden');
      return;
    }
    if (!fs.existsSync(target) || fs.statSync(target).isDirectory()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
      return;
    }
    sendFile(res, target);
  });

  server.listen(config.listen.port, config.listen.host, () => {
    const instances = config.instances.filter((item) => item.enabled);
    console.log(`雷池汇总监控已启动: http://${config.listen.host}:${config.listen.port}`);
    console.log(`配置文件: ${config.file}`);
    console.log(`已启用实例: ${instances.map((item) => `${item.name}(${item.baseUrl})`).join(', ') || '无'}`);
    const skipped = config.instances.filter((item) => !item.enabled);
    if (skipped.length) {
      console.log(`未启用实例: ${skipped.map((item) => item.name).join(', ')} (请在 config.json 中补全 baseUrl 与 token)`);
    }
  });

  const shutdown = () => {
    console.log('\n正在退出...');
    collector.stop();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main();
