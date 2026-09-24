'use strict';

// 攻击类型编号 -> 名称（取自雷池控制台前端词条）
const ATTACK_TYPES = {
  0: 'SQL 注入',
  1: 'XSS',
  2: 'CSRF',
  3: 'SSRF',
  4: '拒绝服务',
  5: '后门',
  6: '反序列化',
  7: '代码执行',
  8: '代码注入',
  9: '命令注入',
  10: '文件上传',
  11: '文件包含',
  12: '重定向',
  13: '权限不当',
  14: '信息泄露',
  15: '未授权访问',
  16: '不安全的配置',
  17: 'XXE',
  18: 'XPath 注入',
  19: 'LDAP 注入',
  20: '目录穿越',
  21: '扫描器',
  22: '水平权限绕过',
  23: '垂直权限绕过',
  24: '文件修改',
  25: '文件读取',
  26: '文件删除',
  27: '逻辑错误',
  28: 'CRLF 注入',
  29: '模板注入',
  30: '点击劫持',
  31: '缓冲区溢出',
  32: '整数溢出',
  33: '格式化字符串',
  34: '条件竞争',
  35: 'HTTP 协议违规',
  36: 'HTTP 请求走私',
  61: '超时',
  62: '未知',
  63: '威胁情报',
  64: 'Cookie 篡改'
};

// 检测模块编号 -> 名称
const MODULES = {
  blacklist: '黑名单',
  whitelist: '白名单',
  m_asp_code_injection: 'ASP 代码注入检测',
  m_cmd_injection: '命令注入检测',
  m_csrf: 'CSRF 检测',
  m_file_include: '文件包含检测',
  m_file_upload: '文件上传检测',
  m_http: '畸形 HTTP 协议检测',
  m_java: 'JAVA 代码注入检测',
  m_java_unserialize: 'JAVA 反序列化检测',
  m_php_code_injection: 'PHP 代码注入检测',
  m_php_unserialize: 'PHP 反序列化检测',
  m_response: '服务器响应检测',
  m_rule: '加强规则',
  m_scanner: '机器人检测',
  m_sqli: 'SQL 注入检测',
  m_ssrf: 'SSRF 检测',
  m_ssti: '模板注入检测',
  m_timeout: '检测超时',
  m_xss: 'XSS 检测'
};

// 拦截类型（/stat/advance/attack 的 intercept 字段）
const INTERCEPT_TYPES = {
  block: '攻击拦截',
  blacklist: '黑名单',
  rate_limit: '频率限制',
  challenge: '人机验证',
  auth_defense: '认证防护',
  offline: '离线拦截'
};

// 频率限制（访问限制）的处置方式（/open/records/acl 的 action / result 字段）
const ACL_ACTIONS = {
  ban: '封禁',
  challenge: '人机验证',
  challenge_v1: '人机验证'
};

function attackTypeName(id) {
  const key = Number(id);
  if (Number.isFinite(key) && ATTACK_TYPES[key]) return ATTACK_TYPES[key];
  return Number.isFinite(key) ? `攻击类型 ${id}` : String(id);
}

function moduleName(key) {
  return MODULES[key] || key || '未知规则';
}

function aclActionName(action) {
  const key = String(action || '');
  return ACL_ACTIONS[key] || key || '未知处置';
}

module.exports = { ATTACK_TYPES, MODULES, INTERCEPT_TYPES, ACL_ACTIONS, attackTypeName, moduleName, aclActionName };
