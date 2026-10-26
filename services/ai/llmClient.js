const { randomUUID } = require("crypto");
const { getConfig, publicConfig } = require("./config");

// OpenAI-compatible chat client shared by every provider. Cloud API keys are
// used as a pool: requests spread over every key in parallel, and a key that
// answers 429/401/5xx is cooled down while the other keys keep serving.

class LlmError extends Error {
  constructor(code, message, { status, retryable = false, retryAfter = null } = {}) {
    super(message);
    this.name = "LlmError";
    this.code = code;
    this.status = status;
    this.retryable = retryable;
    this.retryAfter = retryAfter;
  }
}

const BREAKER_THRESHOLD = 3;
const BREAKER_COOLDOWN_MS = 30_000;
const KEY_POLL_MS = 100;
const COOLDOWN = {
  rateLimitMs: 15_000,
  authMs: 10 * 60_000,
  serverMs: 20_000,
  badResponseMs: 5_000,
  timeoutMs: 10_000,
  networkMs: 10_000,
};

// Global breaker: it counts failed turns, not failed keys, so one rate-limited
// key never disables the whole pool.
const state = {
  failures: 0,
  openUntil: 0,
  lastError: null,
  lastSuccessAt: null,
  lastLatencyMs: null,
};

// Key pool: stats survive config reloads and are keyed by the secret itself
// (never exposed outside this module).
const pool = new Map();
let waiters = [];
let rotation = 0;

const keyEntries = (config) => {
  const values = config.apiKeys.length ? config.apiKeys : [null];
  return values.map((value, index) => {
    const id = value || "__default__";
    let entry = pool.get(id);
    if (!entry) {
      entry = {
        value,
        index: index + 1,
        active: 0,
        requests: 0,
        successes: 0,
        failures: 0,
        coolingUntil: 0,
        lastError: null,
        lastSuccessAt: null,
        lastLatencyMs: null,
      };
      pool.set(id, entry);
    }
    entry.index = index + 1;
    return entry;
  });
};

const chooseKey = (keys, limit, exclude) => {
  const now = Date.now();
  let best = null;
  let bestIndex = 0;
  for (let i = 0; i < keys.length; i += 1) {
    const index = (rotation + i) % keys.length;
    const key = keys[index];
    if (exclude?.has(key)) continue;
    if (now < key.coolingUntil) continue;
    if (key.active >= limit) continue;
    if (!best || key.active < best.active) {
      best = key;
      bestIndex = index;
    }
  }
  if (best) rotation = (bestIndex + 1) % keys.length;
  return best;
};

// Waits for a free slot on any key; keys in cooldown become usable by time,
// so a queued waiter re-checks until it is assigned or times out.
const acquire = (keys, limit, timeoutMs, exclude) => {
  const immediate = chooseKey(keys, limit, exclude);
  if (immediate) {
    immediate.active += 1;
    return Promise.resolve(immediate);
  }

  return new Promise((resolve, reject) => {
    const waiter = { keys, limit, exclude };
    const cleanup = () => {
      clearTimeout(waiter.timer);
      clearInterval(waiter.poll);
      const index = waiters.indexOf(waiter);
      if (index !== -1) waiters.splice(index, 1);
    };
    waiter.assign = (key) => {
      cleanup();
      key.active += 1;
      resolve(key);
    };
    waiter.settle = () => {
      const key = chooseKey(keys, limit, exclude);
      if (key) waiter.assign(key);
    };
    waiter.timer = setTimeout(() => {
      cleanup();
      reject(new LlmError("LLM_BUSY", "Диспетчер занят: попробуйте ещё раз", { retryable: true }));
    }, timeoutMs);
    waiter.poll = setInterval(waiter.settle, KEY_POLL_MS);
    waiters.push(waiter);
  });
};

const release = (key) => {
  key.active = Math.max(0, key.active - 1);
  for (let i = 0; i < waiters.length; ) {
    const waiter = waiters[i];
    const next = chooseKey(waiter.keys, waiter.limit, waiter.exclude);
    if (!next) {
      i += 1;
      continue;
    }
    // assign() removes the waiter from the queue, so keep the same index
    waiter.assign(next);
  }
};

const breakerOpen = () => Date.now() < state.openUntil;

const recordFailure = (error) => {
  state.failures += 1;
  state.lastError = { code: error.code ?? "LLM_ERROR", message: error.message, at: new Date() };
  if (state.failures >= BREAKER_THRESHOLD) {
    state.openUntil = Date.now() + BREAKER_COOLDOWN_MS;
  }
};

const recordSuccess = (latencyMs) => {
  state.failures = 0;
  state.openUntil = 0;
  state.lastError = null;
  state.lastSuccessAt = new Date();
  state.lastLatencyMs = latencyMs;
};

const retryAfterMs = (error) => {
  const value = error?.retryAfter;
  if (!value) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.min(120_000, Math.max(1_000, seconds * 1_000));
  const date = Date.parse(value);
  if (!Number.isNaN(date)) return Math.min(120_000, Math.max(1_000, date - Date.now()));
  return 0;
};

const cooldownFor = (error) => {
  if (error.status === 429) return retryAfterMs(error) || COOLDOWN.rateLimitMs;
  if (error.status === 401 || error.status === 403) return COOLDOWN.authMs;
  if (error.status >= 500) return COOLDOWN.serverMs;
  if (error.code === "LLM_BAD_RESPONSE") return COOLDOWN.badResponseMs;
  if (error.code === "LLM_TIMEOUT") return COOLDOWN.timeoutMs;
  if (error.code === "LLM_NETWORK") return COOLDOWN.networkMs;
  return 0;
};

// A timeout or a network failure is not key-specific: rotating keys would only
// repeat the same long wait, so those end the turn.
const retryOnAnotherKey = (error) =>
  error.status === 429 ||
  error.status === 401 ||
  error.status === 403 ||
  error.status >= 500 ||
  error.code === "LLM_BAD_RESPONSE";

// fetch + JSON with a hard timeout; an external abort signal is honoured too.
// A string body is sent as-is (the GigaChat OAuth form), objects become JSON.
const postJson = async (url, { headers, body, timeoutMs, signal }) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
      signal: controller.signal,
    });
    const raw = await response.text();
    let data = null;
    try {
      data = raw ? JSON.parse(raw) : null;
    } catch {
      data = null;
    }
    if (!response.ok) {
      const detail =
        data?.error?.message ?? data?.message ?? raw.slice(0, 300) ?? "";
      throw new LlmError(
        response.status === 429 ? "LLM_RATE_LIMIT" : "LLM_HTTP",
        `Модель ответила ошибкой ${response.status}${detail ? `: ${detail}` : ""}`,
        {
          status: response.status,
          retryable: response.status === 429 || response.status >= 500,
          retryAfter: response.headers?.get?.("retry-after") ?? null,
        }
      );
    }
    if (!data) throw new LlmError("LLM_BAD_RESPONSE", "Модель вернула не JSON", { retryable: true });
    return data;
  } catch (error) {
    if (error.name === "AbortError") {
      throw new LlmError("LLM_TIMEOUT", "Модель не ответила вовремя", { retryable: true });
    }
    if (error instanceof LlmError) throw error;
    throw new LlmError("LLM_NETWORK", `Нет связи с моделью: ${error.message}`, { retryable: true });
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener("abort", onAbort);
  }
};

// GigaChat uses OAuth: the static key is exchanged for a short-lived token
let gigachatToken = { value: "", expiresAt: 0 };

const getGigaChatToken = async (config, signal) => {
  if (gigachatToken.value && Date.now() < gigachatToken.expiresAt) return gigachatToken.value;

  const scope = process.env.AI_GIGACHAT_SCOPE || "GIGACHAT_API_PERS";
  const data = await postJson("https://ngw.devices.sberbank.ru:9443/api/v2/oauth", {
    headers: {
      Authorization: `Basic ${config.apiKey}`,
      Accept: "application/json",
      RqUID: randomUUID(),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: `scope=${encodeURIComponent(scope)}`,
    timeoutMs: config.timeoutMs,
    signal,
  });

  if (!data.access_token)
    throw new LlmError("LLM_AUTH", "GigaChat не выдал токен: проверьте AI_API_KEY");

  // The token lives 30 minutes; refresh two minutes early
  const expiresAt = Number(data.expires_at) || Date.now() + 1_800_000;
  gigachatToken = {
    value: data.access_token,
    expiresAt: Math.max(Date.now() + 60_000, expiresAt - 120_000),
  };
  return gigachatToken.value;
};

// Completions return reasoning blocks from Qwen by default: strip them so the
// reply stays clean even when the reasoning switch is not supported
const cleanText = (text) =>
  String(text ?? "")
    .replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, "")
    .replace(/^\s*(?:Ответ|Assistant)\s*:\s*/i, "")
    .trim();

const chat = async ({ messages, temperature = 0.2, maxTokens, json = false, signal }) => {
  const config = getConfig();
  if (config.disabled) throw new LlmError("LLM_DISABLED", "AI-диспетчер выключен");
  if (!config.configured)
    throw new LlmError("LLM_NOT_CONFIGURED", `Провайдер ${config.name} не настроен`);
  if (breakerOpen())
    throw new LlmError("LLM_COOLDOWN", "Модель временно недоступна после ошибок", { retryable: true });

  const started = Date.now();
  const deadline = started + config.timeoutMs;
  const keys = keyEntries(config);
  // Every key is tried once per turn by default; AI_KEY_ATTEMPTS caps it
  const cap = Number(process.env.AI_KEY_ATTEMPTS || 0);
  const maxAttempts = config.gigachat
    ? 1
    : Math.min(keys.length, cap > 0 ? cap : keys.length);
  const tried = new Set();
  let lastError = null;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const left = deadline - Date.now();
    if (left <= 500) break;

    // Waiting for a key that is cooling for minutes only burns the turn budget
    const untried = keys.filter((key) => !tried.has(key));
    if (untried.length > 0 && untried.every((key) => Date.now() < key.coolingUntil)) {
      lastError = new LlmError("LLM_COOLDOWN", "Все ключи модели временно недоступны", {
        retryable: true,
      });
      break;
    }

    let key;
    try {
      key = await acquire(keys, config.concurrency, left, tried);
    } catch (error) {
      lastError = error;
      break;
    }
    tried.add(key);
    key.requests += 1;

    try {
      let token = key.value;
      const headers = {};
      if (config.gigachat) {
        token = await getGigaChatToken(config, signal);
      }
      if (token) headers.Authorization = `Bearer ${token}`;

      const body = {
        model: config.model,
        messages,
        temperature,
        max_tokens: maxTokens ?? config.maxTokens,
        stream: false,
      };
      // llama.cpp and GigaChat do not always accept response_format: only the
      // cloud OpenAI-compatible providers get it, the prompt asks for JSON anyway
      if (json && config.cloud && !config.gigachat) body.response_format = { type: "json_object" };

      const data = await postJson(`${config.baseUrl}/chat/completions`, {
        headers,
        body,
        timeoutMs: Math.max(1000, deadline - Date.now()),
        signal,
      });

      const message = data?.choices?.[0]?.message ?? {};
      const text = cleanText(message.content);
      const latencyMs = Date.now() - started;
      key.successes += 1;
      key.lastSuccessAt = new Date();
      key.lastLatencyMs = latencyMs;
      key.lastError = null;
      key.coolingUntil = 0;
      recordSuccess(latencyMs);
      release(key);

      return {
        text,
        provider: config.name,
        model: data.model ?? config.model,
        latencyMs,
        usage: data.usage ?? null,
        keyIndex: key.index,
      };
    } catch (error) {
      key.failures += 1;
      key.lastError = {
        code: error.code ?? "LLM_ERROR",
        message: error.message,
        at: new Date(),
      };
      const cooldown = cooldownFor(error);
      if (cooldown > 0) key.coolingUntil = Math.max(key.coolingUntil, Date.now() + cooldown);
      release(key);
      lastError = error;
      if (!retryOnAnotherKey(error)) break;
    }
  }

  const failure =
    lastError ??
    new LlmError("LLM_BUSY", "Диспетчер занят: попробуйте ещё раз", { retryable: true });
  // Being busy is not a provider failure: only real errors open the breaker
  if (failure.code !== "LLM_BUSY") recordFailure(failure);
  throw failure;
};

// Groq's JSON mode refuses a generation it cannot wrap into an object
// ("Failed to generate JSON", HTTP 400). The same turn usually answers fine
// without the constraint, and free text is still a useful reply.
const isJsonRejection = (error) =>
  error instanceof LlmError && error.status === 400 && /json/i.test(error.message ?? "");

const chatJson = async (options) => {
  try {
    return await chat({ ...options, json: true });
  } catch (error) {
    if (!isJsonRejection(error)) throw error;
    return chat({ ...options, json: false });
  }
};

// Tolerant JSON extraction: the model may wrap the object in fences or prose
const parseJson = (text) => {
  if (!text) return null;
  const fenced = String(text).match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : String(text);
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
};

const poolStatus = () => {
  const config = getConfig();
  return {
    config,
    keys: keyEntries(config).map((key) => ({
      index: key.index,
      active: key.active,
      cooling: Date.now() < key.coolingUntil,
      coolingUntil: key.coolingUntil ? new Date(key.coolingUntil) : null,
      requests: key.requests,
      successes: key.successes,
      failures: key.failures,
      lastError: key.lastError,
      lastSuccessAt: key.lastSuccessAt,
      lastLatencyMs: key.lastLatencyMs,
    })),
  };
};

const status = () => {
  const { config, keys } = poolStatus();
  return {
    ...publicConfig(config),
    active: keys.reduce((sum, key) => sum + key.active, 0),
    parallel: keys.length * config.concurrency,
    queued: waiters.length,
    breakerOpen: breakerOpen(),
    openUntil: state.openUntil ? new Date(state.openUntil) : null,
    failures: state.failures,
    lastError: state.lastError,
    lastSuccessAt: state.lastSuccessAt,
    lastLatencyMs: state.lastLatencyMs,
    keys,
  };
};

// Smallest possible round-trip: used by the diagnostics endpoint and tests
const ping = async () => {
  const result = await chat({
    messages: [
      { role: "system", content: "Отвечай одним словом." },
      { role: "user", content: "Скажи «на связи»." },
    ],
    maxTokens: 8,
    temperature: 0,
  });
  return { ok: true, ...result };
};

module.exports = { LlmError, chat, chatJson, parseJson, status, ping, cleanText };
