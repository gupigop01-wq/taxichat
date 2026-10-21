const request = require("supertest");
const fs = require("fs/promises");
const path = require("path");
const app = require("../app");
const { connectTestDb, disconnectTestDb } = require("./db");
const { setupPilotCity } = require("./orderSetup");

beforeAll(connectTestDb);
afterAll(disconnectTestDb);

describe("media uploads without Cloudinary credentials", () => {
  let cookie;
  beforeAll(async () => {
    const world = await setupPilotCity(app);
    cookie = world.passenger.cookie;
  });

  it.each([
    ["image", "image/png", "png"],
    ["video", "audio/webm", "webm"],
  ])("uploads and serves %s locally", async (fileType, mime, extension) => {
    const bytes = Buffer.from(`test-${fileType}`);
    const uploaded = await request(app).post("/api/upload").set("Cookie", cookie).send({
      data: `data:${mime};base64,${bytes.toString("base64")}`,
      fileType,
    });
    expect(uploaded.status).toBe(200);
    const url = uploaded.body.data.uploadData.secure_url;
    expect(url).toMatch(new RegExp(`^/api/uploads/[0-9a-f-]+\\.${extension}$`));
    const retrieved = await request(app).get(url).set("Cookie", cookie).buffer(true)
      .parse((res, callback) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => callback(null, Buffer.concat(chunks)));
      });
    expect(retrieved.status).toBe(200);
    expect(retrieved.headers["content-type"]).toMatch(mime);
    expect(retrieved.body).toEqual(bytes);
  });

  it("rejects unsupported content and anonymous requests", async () => {
    expect((await request(app).post("/api/upload").send({ fileType: "image", data: "data:text/html;base64,SGk=" })).status).toBe(401);
    const invalid = await request(app).post("/api/upload").set("Cookie", cookie)
      .send({ fileType: "image", data: "data:text/html;base64,SGk=" });
    expect(invalid.status).toBe(400);
  });

  it("serves WebM audio even if Android labels the recorded blob as WAV", async () => {
    const bytes = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81]);
    const uploaded = await request(app).post("/api/upload").set("Cookie", cookie).send({
      data: `data:audio/wav;base64,${bytes.toString("base64")}`,
      fileType: "video",
    });
    expect(uploaded.status).toBe(200);
    const url = uploaded.body.data.uploadData.secure_url;
    expect(url).toMatch(/\.webm$/);
    const retrieved = await request(app).get(url).set("Cookie", cookie);
    expect(retrieved.headers["content-type"]).toMatch(/audio\/webm/);
  });

  it("serves previously mislabeled WAV files as WebM", async () => {
    const bytes = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81]);
    const filename = "d743f218-000e-4f6b-bd49-d53590482b70.wav";
    const filePath = path.join(__dirname, "..", "uploads", filename);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, bytes);
    try {
      const response = await request(app).get(`/api/uploads/${filename}`).set("Cookie", cookie);
      expect(response.status).toBe(200);
      expect(response.headers["content-type"]).toMatch(/audio\/webm/);
    } finally {
      await fs.unlink(filePath);
    }
  });
});
