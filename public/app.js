'use strict';

const COLORS = ['#3b82f6', '#22d3ee', '#a78bfa', '#f5b544', '#34d399', '#f97362'];
const state = { summary: null, config: null, timer: null, charts: new Map(), loading: false };

const $ = (id) => document.getElementById(id);

function esc(value) {
  return String(value === undefined || value === null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function fmt(n) {
  const value = Number(n) || 0;
  if (Math.abs(value) >= 1e8) return `${(value / 1e8).toFixed(2)} 亿`;
  if (Math.abs(value) >= 1e4) return `${(value / 1e4).toFixed(2)} 万`;
  return value.toLocaleString('zh-CN');
}

function fmtFull(n) {
  return (Number(n) || 0).toLocaleString('zh-CN');
}

function fmtTime(ts, withDate) {
  if (!ts) return '-';
  const d = new Date(ts * 1000);
  const pad = (v) => String(v).padStart(2, '0');
  const hhmm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (!withDate) return hhmm;
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${hhmm}`;
}

function fmtClock(ms) {
  if (!ms) return '-';
  const d = new Date(ms);
  const pad = (v) => String(v).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function chartOf(id) {
  if (!state.charts.has(id)) {
    state.charts.set(id, echarts.init($(id), null, { renderer: 'canvas' }));
  }
  return state.charts.get(id);
}

const AXIS_STYLE = {
  axisLine: { lineStyle: { color: '#2b3a58' } },
  axisLabel: { color: '#8d9bb5', fontSize: 11 },
  splitLine: { lineStyle: { color: 'rgba(43,58,88,0.5)' } }
};

const TOOLTIP = {
  trigger: 'axis',
  backgroundColor: 'rgba(15,23,42,0.95)',
  borderColor: '#2b3a58',
  textStyle: { color: '#e8eef8', fontSize: 12 }
};

function emptyOption(text) {
  return {
    xAxis: { show: false },
    yAxis: { show: false },
    series: [],
    title: {
      text: text || '暂无数据',
      left: 'center',
      top: 'middle',
      textStyle: { color: '#5b6b87', fontSize: 12, fontWeight: 'normal' }
    }
  };
}

function renderKpis(summary) {
  const t = summary.totals;
  const s = summary.siteTotals;
  const qpsWindow = (summary.instances[0] && summary.instances[0].qpsWindowSeconds) || 15;
  const cards = [
    { label: '在线实例', value: `${t.online}/${t.total}`, extra: '采集正常 / 已配置', cls: t.online === t.total ? 'ok' : 'danger' },
    { label: '今日请求', value: fmt(s.requests), extra: `${s.count} 个应用 · 应用维度「今日」口径` },
    { label: '今日拦截', value: fmt(s.denied), extra: s.requests ? `拦截率 ${(s.denied / s.requests * 100).toFixed(3)}% · 应用维度「今日」口径` : '暂无请求', cls: 'danger' },
    { label: '今日黑名单拦截', value: fmt(t.blacklistToday), extra: '命中黑名单被阻断的请求 · 各实例之和（今日）', cls: 'danger' },
    { label: '今日频率限制', value: fmt(t.rateLimitToday), extra: '触发访问限制的源 IP 次数 · 各实例之和（今日）', cls: 'warn' },
    { label: '请求总量', value: fmt(t.requests), extra: `窗口内 · PV ${fmt(t.pv)} · 独立 IP ${fmt(t.ip)}（各实例之和）` },
    { label: '实时 QPS', value: fmtFull(t.qps), extra: `各实例之和 · 最近 ${qpsWindow} 秒平均` },
    { label: '攻击拦截', value: fmt(t.intercept), extra: `窗口内 · 攻击源 IP ${fmt(t.attackIp)}（各实例之和）`, cls: 'danger' },
    { label: '异常响应', value: fmt(t.error4xx + t.error5xx), extra: `窗口内 · 4xx ${fmt(t.error4xx)} · 5xx ${fmt(t.error5xx)}`, cls: 'warn' },
    { label: '会话数', value: fmt(t.session), extra: '窗口内会话（各实例之和，未跨实例去重）' }
  ];

  $('kpis').innerHTML = cards.map((card) => `
    <div class="kpi ${card.cls || ''}">
      <div class="label">${card.label}</div>
      <div class="value">${card.value}</div>
      <div class="extra">${card.extra}</div>
    </div>
  `).join('');
}

function renderAlerts(summary) {
  const problems = [];
  for (const instance of summary.instances) {
    if (!instance.online) problems.push(`${instance.name}: ${instance.error || '无法连接或鉴权失败'}`);
    else if (instance.error) problems.push(`${instance.name}: ${instance.error}`);
    else {
      const failed = (instance.metricErrors || []).filter((item) => item.error);
      for (const item of failed) problems.push(`${instance.name} · ${item.key}: ${item.error}`);
    }
  }
  const box = $('alerts');
  const skipped = (state.config && state.config.instances ? state.config.instances : []).filter((item) => !item.enabled);
  if (!problems.length && !skipped.length) {
    box.classList.add('hidden');
    box.innerHTML = '';
    return;
  }
  box.classList.remove('hidden');
  box.classList.toggle('info', !problems.length);
  const problemHtml = problems.length
    ? `<strong>采集异常（${problems.length}）</strong><ul>${problems.slice(0, 8).map((p) => `<li>${esc(p)}</li>`).join('')}</ul>`
    : '';
  const skipHtml = skipped.length
    ? `<div>还有 ${skipped.length} 台实例未启用（${skipped.map((item) => esc(item.name)).join('、')}）：在 config.json 中补全 baseUrl 与 token 后重启即可纳入汇总。</div>`
    : '';
  box.innerHTML = problemHtml + skipHtml;
}

function renderAccessTrend(summary) {
  const trend = summary.trends.access;
  if (!trend.times.length) {
    chartOf('chart-access').setOption(emptyOption(), { notMerge: true });
    return;
  }
  const times = trend.times.map((ts) => fmtTime(ts, trend.times[trend.times.length - 1] - trend.times[0] > 86400));
  chartOf('chart-access').setOption({
    color: COLORS,
    tooltip: { ...TOOLTIP, valueFormatter: (v) => fmtFull(v) },
    legend: { textStyle: { color: '#8d9bb5' }, top: 0 },
    grid: { left: 52, right: 16, top: 36, bottom: 28 },
    xAxis: { type: 'category', boundaryGap: false, data: times, ...AXIS_STYLE },
    yAxis: { type: 'value', ...AXIS_STYLE, axisLabel: { color: '#8d9bb5', fontSize: 11, formatter: (v) => fmt(v) } },
    series: [
      ...trend.series.map((row, i) => ({
        name: row.name,
        type: 'line',
        stack: 'access',
        smooth: true,
        showSymbol: false,
        areaStyle: { opacity: 0.25 },
        lineStyle: { width: 1.5, color: COLORS[i % COLORS.length] },
        itemStyle: { color: COLORS[i % COLORS.length] },
        data: row.values
      })),
      {
        name: '合计',
        type: 'line',
        smooth: true,
        showSymbol: false,
        lineStyle: { width: 1, type: 'dashed', color: '#e8eef8' },
        itemStyle: { color: '#e8eef8' },
        data: trend.totals
      }
    ]
  }, { notMerge: true });
}

function renderInterceptTrend(summary) {
  const trend = summary.trends.intercept;
  if (!trend.times.length) {
    chartOf('chart-intercept').setOption(emptyOption(), { notMerge: true });
    return;
  }
  const times = trend.times.map((ts) => fmtTime(ts, trend.times[trend.times.length - 1] - trend.times[0] > 86400));
  chartOf('chart-intercept').setOption({
    color: COLORS,
    tooltip: { ...TOOLTIP, valueFormatter: (v) => fmtFull(v) },
    legend: { textStyle: { color: '#8d9bb5' }, top: 0 },
    grid: { left: 52, right: 16, top: 36, bottom: 28 },
    xAxis: { type: 'category', boundaryGap: false, data: times, ...AXIS_STYLE },
    yAxis: { type: 'value', ...AXIS_STYLE, minInterval: 1 },
    series: [
      ...trend.series.map((row, i) => ({
        name: row.name,
        type: 'line',
        smooth: true,
        showSymbol: false,
        lineStyle: { width: 2, color: COLORS[i % COLORS.length] },
        itemStyle: { color: COLORS[i % COLORS.length] },
        data: row.values
      })),
      {
        name: '合计',
        type: 'line',
        smooth: true,
        showSymbol: false,
        lineStyle: { width: 1, type: 'dashed', color: '#e8eef8' },
        itemStyle: { color: '#e8eef8' },
        data: trend.totals
      }
    ]
  }, { notMerge: true });
}

function renderPie(id, rows, unit) {
  const data = rows.filter((row) => Number(row.value) > 0);
  chartOf(id).setOption({
    color: COLORS,
    tooltip: {
      trigger: 'item',
      backgroundColor: 'rgba(15,23,42,0.95)',
      borderColor: '#2b3a58',
      textStyle: { color: '#e8eef8', fontSize: 12 },
      formatter: (p) => `${p.name}<br/>${fmtFull(p.value)} (${p.percent}%)`
    },
    legend: { bottom: 0, textStyle: { color: '#8d9bb5', fontSize: 11 }, itemWidth: 10, itemHeight: 10 },
    series: [{
      type: 'pie',
      radius: ['45%', '68%'],
      center: ['50%', '44%'],
      avoidLabelOverlap: true,
      label: { color: '#e8eef8', fontSize: 11, formatter: unit === 'short' ? '{b}' : '{b}\n{c}' },
      labelLine: { lineStyle: { color: '#2b3a58' } },
      data: data.length ? data : [{ name: '暂无数据', value: 1, itemStyle: { color: '#2b3a58' }, label: { color: '#8d9bb5' } }]
    }]
  }, { notMerge: true });
}

function renderBar(id, rows, color) {
  if (!rows.length) {
    chartOf(id).setOption(emptyOption(), { notMerge: true });
    return;
  }
  const sorted = rows.slice().sort((a, b) => a.value - b.value);
  chartOf(id).setOption({
    tooltip: {
      trigger: 'item',
      backgroundColor: 'rgba(15,23,42,0.95)',
      borderColor: '#2b3a58',
      textStyle: { color: '#e8eef8', fontSize: 12 },
      formatter: (p) => `${p.name}<br/>${fmtFull(p.value)}`
    },
    grid: { left: 8, right: 48, top: 8, bottom: 8, containLabel: true },
    xAxis: { type: 'value', ...AXIS_STYLE, splitLine: { show: false }, axisLabel: { show: false } },
    yAxis: {
      type: 'category',
      data: sorted.map((row) => row.name),
      ...AXIS_STYLE,
      splitLine: { show: false },
      axisLabel: { color: '#c9d6ea', fontSize: 11, width: 92, overflow: 'truncate' }
    },
    series: [{
      type: 'bar',
      data: sorted.map((row) => row.value),
      barWidth: 12,
      itemStyle: { color: color || '#3b82f6', borderRadius: [0, 6, 6, 0] },
      label: { show: true, position: 'right', color: '#8d9bb5', fontSize: 11, formatter: (p) => fmt(p.value) }
    }]
  }, { notMerge: true });
}

function renderInstanceCards(summary) {
  $('instances').innerHTML = summary.instances.map((instance) => {
    const metrics = [
      ['请求量', fmt(instance.access.requests)],
      ['实时 QPS', fmtFull(instance.qps)],
      ['攻击拦截', fmt(instance.interceptTotal)],
      ['黑名单(今日)', fmt(instance.blacklistToday)],
      ['频率限制(今日)', fmt(instance.rateLimitToday)],
      ['攻击源 IP', fmt(instance.attackIp)],
      ['独立 IP', fmt(instance.access.ip)],
      ['异常响应', fmt(instance.errors.error4xx + instance.errors.error5xx)],
      ['应用数', `${instance.siteEnabledCount}/${instance.siteCount}`],
      ['采集耗时', `${instance.latencyMs} ms`]
    ];
    const error = instance.error
      ? `<div class="instance-error">${esc(instance.error)}</div>`
      : '';
    const lastOk = instance.lastOkAt ? `最近成功 ${fmtClock(instance.lastOkAt)}` : '尚未采集成功';
    return `
      <div class="instance">
        <div class="instance-head">
          <div class="instance-name">
            <span class="dot ${instance.online ? '' : 'off'}"></span>${esc(instance.name)}
          </div>
          <span class="tag">${esc(instance.version || '版本未知')}${instance.licensed ? ' · 授权' : ' · 社区版'}</span>
        </div>
        <div class="instance-url">${esc(instance.baseUrl)} · ${esc(lastOk)}</div>
        <div class="instance-metrics">
          ${metrics.map(([label, value]) => `
            <div>
              <div class="metric-label">${label}</div>
              <div class="metric-value">${value}</div>
            </div>`).join('')}
        </div>
        ${error}
      </div>`;
  }).join('');
}

function renderEvents(summary) {
  const rows = summary.recentEvents || [];
  const body = document.querySelector('#events tbody');
  if (!rows.length) {
    body.innerHTML = '<tr><td colspan="7" style="color:#8d9bb5">暂无攻击事件</td></tr>';
    return;
  }
  body.innerHTML = rows.map((row) => {
    const deny = row.action === 1;
    const region = [...new Set([row.countryName || row.country, row.province, row.city].filter(Boolean))].join(' ') || '-';
    const target = `${row.host || '-'}${row.url || ''}`;
    const riskClass = row.riskLevel >= 4 ? 'r4' : row.riskLevel === 3 ? 'r3' : row.riskLevel === 2 ? 'r2' : 'r1';
    return `<tr>
      <td>${esc(fmtTime(row.time, true))}</td>
      <td>${esc(row.instance)}</td>
      <td>${esc(row.srcIp)}</td>
      <td>${esc(region)}</td>
      <td title="${esc(target)}">${esc(target.length > 40 ? `${target.slice(0, 40)}…` : target)}</td>
      <td><span class="pill ${deny ? 'deny' : 'pass'}">${deny ? '拦截' : '观察'}</span></td>
      <td><span class="risk ${riskClass}">${esc(row.ruleName || row.rule || '-')}</span></td>
    </tr>`;
  }).join('');
}

// 黑名单拦截日志：多实例合并的命中明细，按时间倒序
function renderBlacklist(summary) {
  const rows = summary.blacklistLogs || [];
  const today = (summary.blacklistTotals && summary.blacklistTotals.today) || 0;
  const instances = (summary.instances || []).filter((item) => item.online).length;
  $('blacklist-summary').textContent = `今日黑名单拦截 ${fmtFull(today)} 次 · 合并 ${instances} 台在线实例的最近 ${rows.length} 条命中明细`;

  const body = document.querySelector('#blacklist tbody');
  if (!rows.length) {
    body.innerHTML = '<tr><td colspan="7" style="color:#8d9bb5">暂无黑名单命中记录</td></tr>';
    return;
  }
  body.innerHTML = rows.map((row) => {
    const deny = row.action === 1;
    const region = [...new Set([row.countryName || row.country, row.province, row.city].filter(Boolean))].join(' ') || '-';
    const target = `${row.host || '-'}${row.url || ''}`;
    return `<tr>
      <td>${esc(fmtTime(row.time, true))}</td>
      <td>${esc(row.instance)}</td>
      <td>${esc(row.srcIp || '-')}</td>
      <td>${esc(region)}</td>
      <td title="${esc(target)}">${esc(target.length > 44 ? `${target.slice(0, 44)}…` : target)}</td>
      <td title="${esc(row.rule || row.policy || '')}">${esc(row.rule || row.policy || '-')}</td>
      <td><span class="pill ${deny ? 'deny' : 'pass'}">${deny ? '拦截' : '放行'}</span></td>
    </tr>`;
  }).join('');
}

// 频率限制日志：/open/records/acl 的访问限制命中明细，多实例合并后按时间倒序
function renderRateLimit(summary) {
  const rows = summary.rateLimitLogs || [];
  const today = (summary.rateLimitTotals && summary.rateLimitTotals.today) || 0;
  const online = (summary.instances || []).filter((item) => item.online).length;
  $('ratelimit-summary').textContent = `今日触发 ${fmtFull(today)} 次 · 合并 ${online} 台在线实例的最近 ${rows.length} 条访问限制明细`;

  const body = document.querySelector('#ratelimit tbody');
  if (!rows.length) {
    body.innerHTML = '<tr><td colspan="9" style="color:#8d9bb5">暂无频率限制记录</td></tr>';
    return;
  }
  body.innerHTML = rows.map((row) => {
    const region = [...new Set([row.countryName || row.country, row.province, row.city].filter(Boolean))].join(' ') || '-';
    const threshold = row.count && row.period ? `${fmtFull(row.count)} 次 / ${row.period} 秒` : '-';
    const action = row.blockMin ? `${row.actionName} · ${row.blockMin} 分钟` : row.actionName;
    const banned = row.action === 'ban';
    return `<tr>
      <td>${esc(fmtTime(row.time, true))}</td>
      <td>${esc(row.instance)}</td>
      <td>${esc(row.srcIp || '-')}</td>
      <td>${esc(region)}</td>
      <td title="${esc(row.site || '')}">${esc(row.site || '-')}</td>
      <td>${esc(row.rule || '-')}</td>
      <td>${esc(threshold)}</td>
      <td><span class="pill ${banned ? 'deny' : 'pass'}">${esc(action)}</span></td>
      <td class="${row.deniedCount ? 'risk r3' : ''}">${fmtFull(row.deniedCount)}</td>
    </tr>`;
  }).join('');
}

function renderSites(summary) {
  const rows = summary.sites || [];
  const body = document.querySelector('#sites tbody');
  const totals = summary.siteTotals || { requests: 0, denied: 0, count: 0 };
  $('site-summary').textContent = `合计 今日请求 ${fmt(totals.requests)} · 今日拦截 ${fmt(totals.denied)}（雷池接口「今日」口径，按实例分组）`;
  if (!rows.length) {
    body.innerHTML = '<tr><td colspan="7" style="color:#8d9bb5">暂无应用数据（需配置并启用实例）</td></tr>';
    return;
  }

  // 同名应用在不同实例上的数值差异可能很大，按实例分组展示，避免看串行
  const order = (summary.instances || []).map((item) => item.name);
  const groups = new Map();
  for (const row of rows) {
    if (!groups.has(row.instance)) groups.set(row.instance, []);
    groups.get(row.instance).push(row);
  }
  const groupNames = Array.from(groups.keys()).sort((a, b) => {
    const ia = order.indexOf(a);
    const ib = order.indexOf(b);
    return (ia < 0 ? Number.MAX_SAFE_INTEGER : ia) - (ib < 0 ? Number.MAX_SAFE_INTEGER : ib);
  });

  body.innerHTML = groupNames.map((name) => {
    const groupRows = groups.get(name);
    const requests = groupRows.reduce((acc, row) => acc + (Number(row.requests) || 0), 0);
    const denied = groupRows.reduce((acc, row) => acc + (Number(row.denied) || 0), 0);
    const head = `<tr class="group"><td colspan="7"><span class="instance-chip">${esc(name)}</span>今日请求 ${fmtFull(requests)} · 今日拦截 ${fmtFull(denied)} · ${groupRows.length} 个应用</td></tr>`;
    const lines = groupRows.map((row) => {
      const rate = row.requests ? `${(row.denied / row.requests * 100).toFixed(3)}%` : '-';
      return `<tr>
      <td>${esc(row.name)}${row.enabled ? '' : ' <span class="pill">已停用</span>'}</td>
      <td title="${esc((row.hosts || []).join(', '))}">${esc((row.hosts || []).join(', '))}</td>
      <td>${esc((row.ports || []).join(', '))}</td>
      <td>${fmtFull(row.requests)}</td>
      <td class="${row.denied ? 'risk r3' : ''}">${fmtFull(row.denied)}</td>
      <td>${rate}</td>
      <td>${esc(row.modeName)}</td>
    </tr>`;
    });
    return head + lines.join('');
  }).join('');
}

function renderWindow(summary) {
  const t = summary.totals;
  const windowText = summary.window.from
    ? `数据窗口 ${fmtTime(summary.window.from, true)} ~ ${fmtTime(summary.window.to, true)}`
    : '暂无数据窗口';
  $('access-window').textContent = windowText;
  $('intercept-window').textContent = windowText;
  $('subtitle').textContent = `${t.online}/${t.total} 台在线 · 更新于 ${fmtClock(summary.generatedAt)} · 窗口 ${summary.range}`;
}

function render(summary) {
  state.summary = summary;
  renderWindow(summary);
  renderAlerts(summary);
  renderKpis(summary);
  renderAccessTrend(summary);
  renderInterceptTrend(summary);
  renderPie('chart-intercept-type', summary.interceptTypes, 'full');
  renderBar('chart-attack-type', summary.attackTypes, '#f97362');
  renderBar('chart-location', summary.provinces, '#22d3ee');
  renderPie('chart-status', summary.statusCodes, 'short');
  const rank = summary.domains.length ? summary.domains : summary.browsers;
  renderBar('chart-rank-mixed', rank, '#a78bfa');
  renderInstanceCards(summary);
  renderSites(summary);
  renderEvents(summary);
  renderBlacklist(summary);
  renderRateLimit(summary);
}

async function loadSummary(force) {
  if (state.loading) return;
  state.loading = true;
  const button = $('refresh');
  button.disabled = true;
  try {
    const res = await fetch(force ? '/api/refresh' : '/api/summary', {
      method: force ? 'POST' : 'GET',
      cache: 'no-store'
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    render(await res.json());
  } catch (err) {
    const box = $('alerts');
    box.classList.remove('hidden');
    box.innerHTML = `<strong>获取汇总数据失败</strong><ul><li>${err.message}</li></ul>`;
  } finally {
    state.loading = false;
    button.disabled = false;
  }
}

function setupAutoRefresh() {
  const select = $('interval');
  const apply = () => {
    if (state.timer) clearInterval(state.timer);
    const ms = Number(select.value) || 0;
    if (ms > 0) state.timer = setInterval(() => loadSummary(false), ms);
  };
  select.addEventListener('change', apply);
  apply();
}

function resizeCharts() {
  for (const chart of state.charts.values()) chart.resize();
}

async function loadConfig() {
  try {
    const res = await fetch('/api/config', { cache: 'no-store' });
    if (res.ok) state.config = await res.json();
  } catch (err) {
    state.config = null;
  }
  if (state.summary) renderAlerts(state.summary);
}

window.addEventListener('resize', resizeCharts);
$('refresh').addEventListener('click', () => loadSummary(true));

setupAutoRefresh();
loadConfig();
loadSummary(false);
