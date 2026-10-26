// Groq key pool: any number of keys, used in parallel, with automatic
// rotation of a rate-limited or broken key. Network is mocked.
process.env.AI_ENABLED = "1";
process.env.AI_PROVIDER = "groq";
process.env.AI_BASE_URL = "http://llm.test/v1";
process.env.AI_MODEL = "test-model";
process.env.AI_CONCURRENCY = "1";
process.env.AI_TIMEOUT_MS = "5000";
process.env.AI_API_KEY = "";
process.env.AI_API_KEYS = "";

const { getConfig, publicConfig } = require("../services/ai/config");
const llmClient = require("../services/ai/llmClient");

const okReply = (text = '{"reply":"ok"}') => ({
  ok: true,
  status: 200,
  headers: { get: () => null },
  text: async () =>
    JSON.stringify({ choices: [{ message: { content: text } }], model: "test" }),
});

const httpError = (status, { retryAfter = null, message = "error" } = {}) => ({
  ok: false,
  status,
  headers: {
    get: (name) => (String(name).toLowerCase() === "retry-after" ? retryAfter : null),
  },
  text: async () => JSON.stringify({ error: { message } }),
});

const chatOnce = () =>
  llmClient.chat({ messages: [{ role: "user", content: "тест" }], maxTokens: 8 });

describe("Groq API key pool", () => {
  beforeEach(() => {
    process.env.AI_ENABLED = "1";
    process.env.AI_PROVIDER = "groq";
    process.env.AI_API_KEY = "";
    process.env.AI_API_KEYS = "";
    process.env.LOCAL_LLM_API_KEY = "";
    delete global.fetch;
  });

  it("parses any number of keys, dedupes and never exposes them", () => {
    process.env.AI_API_KEYS = " key-a, key-b\nkey-a ; key-c ";

    const config = getConfig();
    expect(config.apiKeys).toEqual(["key-a", "key-b", "key-c"]);
    expect(config.apiKey).toBe("key-a");
    expect(config.configured).toBe(true);

    const pub = publicConfig();
    expect(pub.keyCount).toBe(3);
    expect(JSON.stringify(pub)).not.toContain("key-a");

    llmClient.status().keys.forEach((key) => {
      expect(key).not.toHaveProperty("value");
      expect(JSON.stringify(key)).not.toContain("key-");
    });
  });

  it("keeps a single AI_API_KEY working and never sends cloud keys to local", () => {
    process.env.AI_API_KEY = "single-key";
    expect(getConfig().apiKeys).toEqual(["single-key"]);

    // The cloud pool stays out of the phone; local only takes its own key
    process.env.AI_API_KEY = "";
    process.env.AI_API_KEYS = "cloud-a,cloud-b";
    process.env.AI_PROVIDER = "local";
    expect(getConfig().apiKeys).toEqual([]);

    process.env.LOCAL_LLM_API_KEY = "phone-key";
    expect(getConfig().apiKeys).toEqual(["phone-key"]);
    process.env.AI_PROVIDER = "groq";
  });

  it("serves two simultaneous requests with two different keys", async () => {
    process.env.AI_API_KEYS = "pk-1,pk-2";
    const pending = [];
    global.fetch = jest.fn(
      () => new Promise((resolve) => pending.push(resolve))
    );

    const first = chatOnce();
    const second = chatOnce();
    // Both requests must be in flight before either answer arrives
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(global.fetch).toHaveBeenCalledTimes(2);
    const auth = global.fetch.mock.calls.map((call) => call[1].headers.Authorization);
    expect(new Set(auth).size).toBe(2);

    pending.forEach((resolve) => resolve(okReply()));
    const results = await Promise.all([first, second]);
    expect(results.map((result) => result.text)).toEqual(['{"reply":"ok"}', '{"reply":"ok"}']);
    expect(new Set(results.map((result) => result.keyIndex)).size).toBe(2);
  });

  it("rotates to the next key when one is rate limited", async () => {
    process.env.AI_API_KEYS = "rk-1,rk-2";
    const attempted = [];
    global.fetch = jest.fn(async (url, options) => {
      attempted.push(options.headers.Authorization.slice(7));
      return attempted.length === 1
        ? httpError(429, { retryAfter: "30" })
        : okReply('{"reply":"rotated"}');
    });

    const result = await chatOnce();

    expect(result.text).toBe('{"reply":"rotated"}');
    expect(attempted).toHaveLength(2);
    expect(attempted[0]).not.toBe(attempted[1]);

    const failedIndex = attempted[0] === "rk-1" ? 1 : 2;
    const failedKey = llmClient.status().keys.find((key) => key.index === failedIndex);
    expect(failedKey.cooling).toBe(true);
    expect(result.keyIndex).not.toBe(failedIndex);
  });

  it("does not rotate on a bad request and does not cool the key", async () => {
    process.env.AI_API_KEYS = "bad-1,bad-2";
    global.fetch = jest.fn(async () => httpError(400, { message: "bad request" }));

    await expect(chatOnce()).rejects.toMatchObject({ code: "LLM_HTTP", status: 400 });

    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(llmClient.status().keys.every((key) => !key.cooling)).toBe(true);
  });

  it("tries every key once and reports rate limits without opening the breaker", async () => {
    process.env.AI_API_KEYS = "rl-1,rl-2,rl-3";
    global.fetch = jest.fn(async () => httpError(429, { retryAfter: "1" }));

    await expect(chatOnce()).rejects.toMatchObject({ code: "LLM_RATE_LIMIT" });

    expect(global.fetch).toHaveBeenCalledTimes(3);
    const status = llmClient.status();
    expect(status.keys).toHaveLength(3);
    expect(status.keys.every((key) => key.cooling)).toBe(true);
    expect(status.breakerOpen).toBe(false);
    expect(status.parallel).toBe(3);
  });
});
