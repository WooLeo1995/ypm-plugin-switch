// 网易云客户端 eapi：AES-128-ECB 加密参数，匿名请求，不保存任何 Cookie 或凭据。
import { t } from "../i18n.js";

const ORIGIN = "https://interfacepc.music.163.com";
const KEY = "e82ckenh8dichen8";
const SEPARATOR = "-36cd479b6b5-";
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36";

export function fail(code, message, retryable = false) {
  throw Object.assign(new Error(t(message)), { code, retryable });
}

export function id(value) {
  const text = String(value ?? "");
  if (!/^\d+$/.test(text)) fail("unavailable", "无效的网易云资源编号");
  return text;
}

function deviceId() {
  let value = host.storage.get("deviceId");
  if (!value) {
    value = host.crypto.md5(`${Date.now()}:${Math.random()}`);
    host.storage.set("deviceId", value);
  }
  return String(value);
}

function describe(code, message) {
  return t("网易云请求失败（{code}）：{message}", {
    code,
    message: String(message || t("请稍后重试")).slice(0, 180),
  });
}

// 所有接口共用：拼 header、加密、请求、校验 code。
export async function api(path, data = {}) {
  if (!/^\/api\/[A-Za-z0-9/_-]+$/.test(path)) fail("failed", "无效的接口路径");
  const header = {
    os: "pc",
    appver: "3.1.11",
    deviceId: deviceId(),
    versioncode: "140",
    osver: "Microsoft-Windows-10-Professional-build-19045-64bit",
    channel: "netease",
    resolution: "1920x1080",
    __csrf: "",
    requestId: `${Date.now()}_${Math.floor(Math.random() * 10000)}`,
  };
  const body = JSON.stringify({ ...data, header });
  const digest = host.crypto.md5(`nobody${path}use${body}md5forencrypt`);
  const params = host.crypto.aesEcbEncrypt(KEY, `${path}${SEPARATOR}${body}${SEPARATOR}${digest}`);

  let response;
  try {
    response = await fetch(ORIGIN + path.replace(/^\/api\//, "/eapi/"), {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Referer": "https://music.163.com/",
        "User-Agent": USER_AGENT,
      },
      body: new URLSearchParams({ params }).toString(),
      signal: AbortSignal.timeout(15000),
    });
  } catch (_) {
    fail("failed", "无法连接网易云音乐，请检查网络或稍后重试", true);
  }

  const status = Number(response.status);
  if (status === 401) fail("unavailable", "网易云接口要求登录，本插件不支持登录");
  if (status < 200 || status >= 300) {
    fail("failed", t("网易云服务暂时不可用（HTTP {status}），请稍后重试", { status }), status === 429 || status >= 500);
  }

  let result;
  try {
    result = await response.json();
  } catch (_) {
    fail("failed", "网易云返回了无法识别的响应，请稍后重试", true);
  }

  const code = Number(result.code ?? 200);
  if (code !== 200) {
    if ([301, 302, 401].includes(code)) fail("unavailable", "网易云接口要求登录或已限制访问");
    if (code === -462 || code === 405) fail("failed", "网易云要求安全验证，请稍后重试");
    fail("failed", describe(code, result.message || result.msg));
  }
  return result;
}
