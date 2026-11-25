// 离线运行时：用 node:vm 加载真实插件模块，host 与 fetch 全部由测试掌控。
// 每个测试都必须创建一个新的 runtime，模块级缓存 / 熔断状态才不会互相污染。
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

export const root = fileURLToPath(new URL("../", import.meta.url));
const SEPARATOR = "-36cd479b6b5-";
const RealDate = Date;
const RESPONSE = Symbol("mock-response");

// ---------------------------------------------------------------------------
// 响应说明（spec）：测试用 json()/text()/status()/networkError() 描述一次 mock
// fetch 的返回值。响应对象尽量贴近浏览器 fetch，够插件用即可。
// ---------------------------------------------------------------------------
function spec(kind, body, options = {}) {
  return {
    [RESPONSE]: true,
    kind,
    body,
    status: options.status ?? 200,
    headers: options.headers || {},
    cookies: options.cookies || [],
    url: options.url || "",
  };
}

export function json(body, options = {}) {
  return spec("json", body, options);
}

export function text(body, options = {}) {
  return spec("text", body, options);
}

export function status(code, options = {}) {
  return spec("empty", "", { ...options, status: code });
}

export function networkError(message = "mock network error") {
  return { [RESPONSE]: true, kind: "network", message };
}

export const reply = { json, text, status, networkError };

function makeHeaders(raw = {}, cookies = []) {
  const source = { ...(raw || {}) };
  const setCookies = [
    ...(Array.isArray(cookies) ? cookies : []),
    ...(Array.isArray(source["set-cookie"]) ? source["set-cookie"] : []),
  ];
  delete source["set-cookie"];
  const entries = Object.entries(source).map(([name, value]) => [String(name).toLowerCase(), String(value)]);
  const map = new Map(entries);
  const headers = {
    get(name) {
      const key = String(name).toLowerCase();
      return map.has(key) ? map.get(key) : null;
    },
    has(name) {
      return map.has(String(name).toLowerCase());
    },
    forEach(callback) {
      for (const [name, value] of map) callback(value, name, headers);
    },
    getSetCookie() {
      return [...setCookies];
    },
  };
  // 有的实现会直接读 headers["content-type"]，两种写法都兼容。
  for (const [name, value] of map) headers[name] = value;
  return headers;
}

function makeResponse(value, url) {
  const kind = value?.kind || "empty";
  const code = Number(value?.status ?? 200);
  const body = kind === "json" ? JSON.stringify(value.body) : String(value?.body ?? "");
  const headers = makeHeaders(value?.headers, value?.cookies);
  const response = {
    ok: code >= 200 && code < 300,
    status: code,
    statusText: String(value?.statusText || ""),
    url,
    headers,
    async json() {
      if (kind === "json") return value.body;
      try {
        return JSON.parse(body);
      } catch {
        throw new SyntaxError("Unexpected token in JSON");
      }
    },
    async text() {
      return body;
    },
    async arrayBuffer() {
      return new TextEncoder().encode(body).buffer;
    },
    clone() {
      return makeResponse(value, url);
    },
  };
  return response;
}

function isResponseSpec(value) {
  return Boolean(value && value[RESPONSE]);
}

// ---------------------------------------------------------------------------
// runtime
// ---------------------------------------------------------------------------
export async function runtime(options = {}) {
  const requests = [];
  const routes = [];
  const opened = [];
  const payloads = [];
  const aesCalls = [];
  const store = new Map(Object.entries(options.storage || {}));
  // 默认：直链探测可用。测试按需覆盖 state.probe.head / state.probe.range。
  const defaultProbe = {
    head: status(200, { headers: { "content-type": "audio/mpeg", "content-length": "2048" } }),
    range: status(206, {
      headers: {
        "content-type": "audio/mpeg",
        "content-length": "1",
        "content-range": "bytes 0-0/2048",
      },
    }),
  };
  const state = {
    language: "zh-CN",
    settings: {},
    ...options,
  };
  state.settings = { ...(options.settings || {}) };
  state.probe = {
    head: options.probe?.head ?? defaultProbe.head,
    range: options.probe?.range ?? defaultProbe.range,
  };

  let now = options.now == null
    ? RealDate.parse("2026-11-25T00:00:00Z")
    : typeof options.now === "string"
      ? RealDate.parse(options.now)
      : Number(options.now);
  const clock = {
    now: () => now,
    set(value) {
      now = value instanceof RealDate ? value.getTime() : Number(value);
      return now;
    },
    advance(ms) {
      now += Number(ms) || 0;
      return now;
    },
  };

  // 让 Date.now()/new Date() 走可控时钟；Date(x) 当函数调用时保持原生行为。
  function FakeDate(...args) {
    if (!new.target) return new RealDate(now).toString();
    if (args.length === 0) return new RealDate(now);
    return new RealDate(...args);
  }
  FakeDate.prototype = RealDate.prototype;
  FakeDate.now = () => now;
  FakeDate.parse = RealDate.parse;
  FakeDate.UTC = RealDate.UTC;

  const dictionaries = new Map();
  function dictionary(language) {
    if (dictionaries.has(language)) return dictionaries.get(language);
    let result = {};
    try {
      result = JSON.parse(readFileSync(path.join(root, "locales", `${language}.json`), "utf8"));
    } catch {
      result = {};
    }
    dictionaries.set(language, result);
    return result;
  }

  const crypto = {
    md5: (value) => createHash("md5").update(String(value)).digest("hex"),
    // 真实实现返回 AES-128-ECB 密文；这里只需要占位 hex，同时留下 eapi 明文。
    aesEcbEncrypt: (key, value) => {
      const raw = String(value);
      const parts = raw.split(SEPARATOR);
      let payload = null;
      try {
        payload = JSON.parse(parts[1]);
      } catch {
        payload = null;
      }
      state.payload = payload;
      payloads.push(payload);
      // eapi 明文三段：接口路径 / JSON body / md5 摘要，供测试校验请求合法性。
      aesCalls.push({
        key: String(key),
        text: raw,
        path: parts[0],
        body: parts[1],
        digest: parts[2],
        payload,
      });
      return createHash("sha256").update(`${key}\u0000${raw}`).digest("hex");
    },
  };

  function route(pattern, handler) {
    routes.push({ pattern, handler });
    return runtimeApi;
  }

  function matches(pattern, request) {
    if (typeof pattern === "function") return Boolean(pattern(request, request.url));
    if (pattern instanceof RegExp) {
      pattern.lastIndex = 0;
      return pattern.test(request.url);
    }
    return request.url.includes(String(pattern));
  }

  function probeSpec(configured, request) {
    const value = typeof configured === "function" ? configured(request) : configured;
    return value == null ? undefined : value;
  }

  async function fetchMock(input, init = {}) {
    const url = typeof input === "string" ? input : String(input?.url ?? input);
    const method = String(init?.method || input?.method || "GET").toUpperCase();
    const rawHeaders = init?.headers || input?.headers || {};
    const headers = {};
    if (rawHeaders && typeof rawHeaders.forEach === "function") {
      rawHeaders.forEach((value, name) => {
        headers[String(name).toLowerCase()] = String(value);
      });
    } else {
      for (const [name, value] of Object.entries(rawHeaders)) headers[name.toLowerCase()] = String(value);
    }
    const request = {
      url,
      method,
      headers,
      body: init?.body,
      payload: url.includes("interfacepc.music.163.com") ? state.payload : null,
    };
    requests.push(request);

    for (const entry of routes) {
      if (!matches(entry.pattern, request)) continue;
      const produced = typeof entry.handler === "function" ? await entry.handler(request) : entry.handler;
      if (produced == null) continue;
      if (isResponseSpec(produced)) {
        if (produced.kind === "network") throw new Error(produced.message);
        return makeResponse(produced, url);
      }
      return makeResponse(json(produced), url);
    }

    if (url.includes("interfacepc.music.163.com")) {
      const produced = typeof state.eapi === "function" ? await state.eapi(request) : null;
      if (isResponseSpec(produced)) return makeResponse(produced, url);
      return makeResponse(json(produced ?? { code: 200 }), url);
    }

    // 探测请求没有显式路由时走 probe 配置；其它漏配请求直接失败，避免联网。
    if (method === "HEAD") {
      const produced = probeSpec(state.probe.head, request);
      if (produced) {
        if (isResponseSpec(produced)) return makeResponse(produced, url);
        return makeResponse(json(produced), url);
      }
    }
    if (method === "GET" && headers.range) {
      const produced = probeSpec(state.probe.range, request);
      if (produced) {
        if (isResponseSpec(produced)) return makeResponse(produced, url);
        return makeResponse(json(produced), url);
      }
    }
    throw new Error(`unexpected fetch: ${method} ${url}`);
  }

  const host = {
    platform: options.platform ?? "darwin",
    arch: options.arch ?? "amd64",
    dir: root.replace(/\/$/, ""),
    setting: (key) => {
      const value = state.settings?.[key];
      return value == null ? "" : value;
    },
    t: (message) => {
      const messages = dictionary(state.language);
      return Object.prototype.hasOwnProperty.call(messages, message) ? messages[message] : message;
    },
    storage: {
      get: (key) => store.get(key),
      set: (key, value) => {
        store.set(key, value);
      },
      remove: (key) => {
        store.delete(key);
      },
    },
    crypto,
    openURL: (url) => {
      opened.push(String(url));
      state.opened = String(url);
    },
  };

  const context = vm.createContext({
    URL,
    URLSearchParams,
    AbortSignal,
    TextEncoder,
    TextDecoder,
    atob,
    btoa,
    console,
    Date: FakeDate,
    // 插件里的超时/退避不应拖慢测试；实际取到响应后都会清掉。
    setTimeout: (fn, ms, ...args) => setTimeout(fn, Math.min(Number(ms) || 0, 5), ...args),
    clearTimeout,
    setInterval,
    clearInterval,
    fetch: fetchMock,
    host,
  });

  const modules = new Map();
  function load(file) {
    const absolute = path.isAbsolute(file) ? file : path.join(root, file);
    if (path.relative(root, absolute).startsWith("..")) throw new Error(`拒绝加载项目外模块: ${absolute}`);
    if (modules.has(absolute)) return modules.get(absolute);
    const mod = new vm.SourceTextModule(readFileSync(absolute, "utf8"), {
      context,
      identifier: absolute,
    });
    modules.set(absolute, mod);
    return mod;
  }

  async function link(specifier, referencing) {
    return load(path.resolve(path.dirname(referencing.identifier), specifier));
  }

  async function evaluate(file) {
    const mod = load(file);
    if (mod.status === "unlinked") await mod.link(link);
    if (mod.status === "linked") await mod.evaluate();
    if (mod.status === "errored") throw mod.error;
    return mod.namespace;
  }

  const main = load(options.entry || "index.js");
  await main.link(link);
  await main.evaluate();

  const runtimeApi = {
    state,
    store,
    requests,
    routes,
    opened,
    payloads,
    aesCalls,
    clock,
    host,
    entry: options.entry || "index.js",
    plugin: main.namespace,
    route,
    module: evaluate,
    async i18n() {
      return evaluate("i18n.js");
    },
    payload: () => state.payload,
    // 最近一次 eapi 请求的明文 payload（供断言路径参数）。
    lastEapi: () => [...requests].reverse().find((request) => request.url.includes("interfacepc.music.163.com")),
  };
  return runtimeApi;
}
