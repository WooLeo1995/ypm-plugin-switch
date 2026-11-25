// 每次显示时读取宿主语言，切换语言无需重载插件。占位符按名字替换。
export function t(message, values = {}) {
  const translated = host.t(message);
  return String(translated).replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g, (match, key) =>
    Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : match);
}

export function setting(key) {
  const value = host.setting(key);
  return value == null ? "" : String(value);
}

export function flag(key) {
  return setting(key) === "true";
}
