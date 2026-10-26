// LLM provider configuration. Everything is switchable through .env so the
// same code works with the phone (local llama.cpp), free cloud tiers and the
// Russian GigaChat API. "AI_PROVIDER=off" disables the model entirely and
// leaves the deterministic dispatcher in charge.
const PROVIDERS = {
  local: {
    baseUrl: "http://127.0.0.1:8080/v1",
    model: "qwen3-4b-abl",
    concurrency: 1,
    // The phone generates ~2.5 tokens/s: a short reply must fit the timeout
    timeoutMs: 45000,
    maxTokens: 160,
    cloud: false,
    needsKey: false,
  },
  groq: {
    baseUrl: "https://api.groq.com/openai/v1",
    model: "openai/gpt-oss-120b",
    concurrency: 2,
    timeoutMs: 12000,
    // gpt-oss spends most of the completion budget on reasoning tokens: at 220
    // the content came back empty and every turn fell back to a canned reply
    maxTokens: 1024,
    cloud: true,
    needsKey: true,
  },
  gemini: {
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    model: "gemini-2.5-flash",
    concurrency: 2,
    timeoutMs: 15000,
    maxTokens: 220,
    cloud: true,
    needsKey: true,
  },
  openrouter: {
    baseUrl: "https://openrouter.ai/api/v1",
    model: "meta-llama/llama-3.3-70b-instruct",
    concurrency: 2,
    timeoutMs: 20000,
    maxTokens: 220,
    cloud: true,
    needsKey: true,
  },
  gigachat: {
    baseUrl: "https://gigachat.devices.sberbank.ru/api/v1",
    model: "GigaChat-2",
    concurrency: 1,
    timeoutMs: 20000,
    maxTokens: 220,
    cloud: true,
    needsKey: true,
    gigachat: true,
  },
};

const pickProviderName = () => {
  const explicit = (process.env.AI_PROVIDER ?? "").trim().toLowerCase();
  if (explicit === "off" || explicit === "none") return "off";
  if (explicit === "custom") return "custom";
  if (explicit && PROVIDERS[explicit]) return explicit;
  // Without an explicit provider a configured key means a cloud provider,
  // otherwise the local llama-server on the VPS loopback.
  if (process.env.AI_BASE_URL) return "custom";
  return "local";
};

const parseKeyList = (raw) =>
  String(raw ?? "")
    .split(/[\s,;]+/)
    .map((item) => item.trim())
    .filter(Boolean);

// API keys form a pool: every key serves requests in parallel and one failing
// key (429 / 401 / 5xx) is rotated out without stopping the others.
// AI_API_KEYS is the primary comma-separated list; AI_API_KEY stays supported
// as a single-key shorthand. The local llama-server never receives cloud keys.
const readApiKeys = (name) => {
  const keys = name === "local" ? [] : parseKeyList(process.env.AI_API_KEYS);
  const single =
    name === "local" || name === "custom"
      ? process.env.LOCAL_LLM_API_KEY || process.env.AI_API_KEY
      : process.env.AI_API_KEY;
  const trimmed = String(single ?? "").trim();
  if (trimmed) keys.unshift(trimmed);
  return [...new Set(keys)];
};

const getConfig = () => {
  const name = pickProviderName();
  const disabled = process.env.AI_ENABLED === "0" || name === "off";

  const preset = PROVIDERS[name] ?? {};
  const baseUrl = (process.env.AI_BASE_URL || preset.baseUrl || "").replace(/\/+$/, "");
  const model = process.env.AI_MODEL || preset.model || "";
  // GigaChat exchanges a single OAuth secret for a token, so it cannot use a
  // pool of independent keys
  const poolKeys = readApiKeys(name);
  const apiKeys = preset.gigachat ? poolKeys.slice(0, 1) : poolKeys;
  const apiKey = apiKeys[0] ?? "";

  const configured =
    !disabled &&
    Boolean(baseUrl && model) &&
    (!preset.needsKey || apiKeys.length > 0);

  return {
    name,
    disabled,
    configured,
    baseUrl,
    model,
    apiKey,
    apiKeys,
    gigachat: preset.gigachat === true,
    cloud: preset.cloud === true,
    concurrency: Number(process.env.AI_CONCURRENCY || preset.concurrency || 1),
    timeoutMs: Number(process.env.AI_TIMEOUT_MS || preset.timeoutMs || 15000),
    maxTokens: Number(process.env.AI_MAX_TOKENS || preset.maxTokens || 220),
  };
};

// Public view for diagnostics: never exposes the keys themselves
const publicConfig = (config = getConfig()) => ({
  provider: config.name,
  model: config.model,
  configured: config.configured,
  baseUrl: config.baseUrl,
  cloud: config.cloud,
  timeoutMs: config.timeoutMs,
  keyCount: config.apiKeys.length,
  concurrency: config.concurrency,
});

module.exports = { getConfig, publicConfig, PROVIDERS };
