// 音源返回的地址可能带反斜杠转义、协议相对路径或 http，这里统一成可请求的绝对地址。
export function normalizeUrl(raw) {
  let value = String(raw ?? "").trim().replace(/\\(.)/g, "$1");
  if (!value) return "";
  if (value.startsWith("//")) value = `https:${value}`;
  if (!/^https?:\/\//i.test(value)) return "";
  return value;
}
