// Free-form answers must survive a provider that rejects its own JSON mode:
// Groq answers 400 "Failed to generate JSON" when the model cannot wrap the
// reply into an object, and the same turn usually works as plain text.
const saved = {
  AI_ENABLED: process.env.AI_ENABLED,
  AI_PROVIDER: process.env.AI_PROVIDER,
  AI_BASE_URL: process.env.AI_BASE_URL,
  AI_MODEL: process.env.AI_MODEL,
  AI_API_KEY: process.env.AI_API_KEY,
};
process.env.AI_ENABLED = "1";
process.env.AI_PROVIDER = "groq";
process.env.AI_BASE_URL = "https://llm.test/v1";
process.env.AI_MODEL = "test-model";
process.env.AI_API_KEY = "test-key";

const { chatJson } = require("../services/ai/llmClient");

const ok = (content) => ({
  ok: true,
  status: 200,
  headers: { get: () => null },
  text: async () =>
    JSON.stringify({ model: "test-model", choices: [{ message: { content } }], usage: {} }),
});

const bad = (message) => ({
  ok: false,
  status: 400,
  headers: { get: () => null },
  text: async () => JSON.stringify({ error: { message } }),
});

const messages = [{ role: "user", content: "сколько живет тигр" }];

describe("LLM JSON fallback", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  afterAll(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("retries the turn as free text when the provider cannot produce JSON", async () => {
    const formats = [];
    global.fetch = async (url, init) => {
      formats.push(JSON.parse(init.body).response_format ?? null);
      return formats.length === 1
        ? bad("Failed to generate JSON. Please adjust your prompt.")
        : ok("Тигр в природе живёт 10–15 лет, в зоопарке — до 20.");
    };

    const result = await chatJson({ messages });

    expect(result.text).toContain("Тигр");
    expect(formats).toEqual([{ type: "json_object" }, null]);
  });

  it("does not retry a request the provider rejected for another reason", async () => {
    let calls = 0;
    global.fetch = async () => {
      calls += 1;
      return bad("invalid request");
    };

    await expect(chatJson({ messages })).rejects.toMatchObject({
      code: "LLM_HTTP",
      status: 400,
    });
    expect(calls).toBe(1);
  });
});
