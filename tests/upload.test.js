const request = require("supertest");
const fs = require("fs/promises");
const { mkdtempSync } = require("fs");
const os = require("os");
const path = require("path");
const { connectTestDb, disconnectTestDb } = require("./db");
const { registerUser } = require("./helpers");

jest.mock("../utilities/Cloudinary", () => ({
  cloudinary: { uploader: { upload: jest.fn() } },
}));

const credentialKeys = ["CLOUDINARY_NAME", "CLOUDINARY_API_KEY", "CLOUDINARY_API_SECRET"];
const savedEnvironment = Object.fromEntries(
  ["NODE_ENV", "UPLOAD_DIR", ...credentialKeys].map((key) => [key, process.env[key]])
);
const uploadDirectory = mkdtempSync(path.join(os.tmpdir(), "taxichat-upload-"));
process.env.UPLOAD_DIR = uploadDirectory;
for (const key of credentialKeys) delete process.env[key];

const app = require("../app");
const { cloudinary } = require("../utilities/Cloudinary");
let cookie;

beforeAll(async () => {
  await connectTestDb();
  cookie = (await registerUser(app)).cookie;
});

beforeEach(async () => {
  process.env.NODE_ENV = "test";
  for (const key of credentialKeys) delete process.env[key];
  cloudinary.uploader.upload.mockReset().mockRejectedValue(new Error("Unexpected Cloudinary call"));
  await fs.mkdir(uploadDirectory, { recursive: true });
});

afterEach(async () => {
  jest.restoreAllMocks();
  await fs.rm(uploadDirectory, { recursive: true, force: true });
});

afterAll(async () => {
  try {
    await disconnectTestDb();
  } finally {
    await fs.rm(uploadDirectory, { recursive: true, force: true });
    for (const [key, value] of Object.entries(savedEnvironment)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

const parseBinary = (res, callback) => {
  const chunks = [];
  res.on("data", (chunk) => chunks.push(chunk));
  res.on("end", () => callback(null, Buffer.concat(chunks)));
};

const uploadFile = (fileType, mime, bytes) => request(app).post("/api/upload").set("Cookie", cookie).send({
  data: `data:${mime};base64,${bytes.toString("base64")}`,
  fileType,
});

const webm = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81]);

describe("local media uploads", () => {

  it.each([
    ["image", "image/jpeg", "jpg"],
    ["image", "image/png", "png"],
    ["image", "image/webp", "webp"],
    ["image", "image/gif", "gif"],
    ["video", "audio/webm", "webm"],
    ["video", "audio/ogg", "ogg"],
    ["video", "audio/mp4", "m4a"],
    ["video", "audio/mpeg", "mp3"],
    ["video", "audio/wav", "wav"],
  ])("uploads %s %s and serves its original bytes", async (fileType, mime, extension) => {
    const bytes = Buffer.from(`test-${mime}`);
    const uploaded = await uploadFile(fileType, mime, bytes);
    expect(uploaded.status).toBe(200);
    const url = uploaded.body.data.uploadData.secure_url;
    expect(url).toMatch(new RegExp(`^/api/uploads/[0-9a-f-]+\\.${extension}$`));
    expect(uploaded.body.data.uploadData).not.toHaveProperty("public_id");
    const retrieved = await request(app).get(url).set("Cookie", cookie).buffer(true).parse(parseBinary);
    expect(retrieved.status).toBe(200);
    expect(retrieved.headers["content-type"]).toBe(mime);
    expect(retrieved.headers["x-content-type-options"]).toBe("nosniff");
    expect(retrieved.body).toEqual(bytes);
    expect(cloudinary.uploader.upload).not.toHaveBeenCalled();
  });

  it("requires authentication for uploads and downloads", async () => {
    const body = { fileType: "image", data: "data:image/png;base64,SGk=" };
    expect((await request(app).post("/api/upload").send(body)).status).toBe(401);
    const uploaded = await uploadFile("image", "image/png", Buffer.from("test"));
    const url = uploaded.body.data.uploadData.secure_url;
    expect((await request(app).get(url)).status).toBe(401);
    expect((await request(app).get(url).set("Cookie", "telegramToken=invalid")).status).toBe(401);
  });

  it.each(["audio/wav", "audio/mp3", "audio/webm;codecs=opus"])(
    "detects WebM audio declared as %s",
    async (mime) => {
      const uploaded = await uploadFile("video", mime, webm);
      expect(uploaded.status).toBe(200);
      const url = uploaded.body.data.uploadData.secure_url;
      expect(url).toMatch(/\.webm$/);
      const retrieved = await request(app).get(url).set("Cookie", cookie).buffer(true).parse(parseBinary);
      expect(retrieved.headers["content-type"]).toBe("audio/webm");
      expect(retrieved.body).toEqual(webm);
    }
  );

  it("normalizes the legacy audio/mp3 MIME to audio/mpeg", async () => {
    const uploaded = await uploadFile("video", "audio/mp3", Buffer.from("ID3test"));
    expect(uploaded.status).toBe(200);
    const url = uploaded.body.data.uploadData.secure_url;
    expect(url).toMatch(/\.mp3$/);
    const retrieved = await request(app).get(url).set("Cookie", cookie);
    expect(retrieved.headers["content-type"]).toBe("audio/mpeg");
  });

  it("supports authenticated byte ranges and HEAD for audio", async () => {
    const bytes = Buffer.concat([webm, Buffer.from("0123456789")]);
    const uploaded = await uploadFile("video", "audio/webm", bytes);
    const url = uploaded.body.data.uploadData.secure_url;
    const range = await request(app).get(url).set("Cookie", cookie).set("Range", "bytes=4-9")
      .buffer(true).parse(parseBinary);
    expect(range.status).toBe(206);
    expect(range.headers["content-type"]).toBe("audio/webm");
    expect(range.headers["content-range"]).toBe(`bytes 4-9/${bytes.length}`);
    expect(range.headers["accept-ranges"]).toBe("bytes");
    expect(range.headers["content-length"]).toBe("6");
    expect(range.body).toEqual(bytes.subarray(4, 10));

    const suffix = await request(app).get(url).set("Cookie", cookie).set("Range", "bytes=-4")
      .buffer(true).parse(parseBinary);
    expect(suffix.status).toBe(206);
    expect(suffix.body).toEqual(bytes.subarray(-4));
    expect((await request(app).get(url).set("Cookie", cookie).set("Range", "bytes=100-200")).status).toBe(416);

    const head = await request(app).head(url).set("Cookie", cookie);
    expect(head.status).toBe(200);
    expect(head.headers["content-length"]).toBe(String(bytes.length));
    expect(head.text).toBeUndefined();
  });

  it("serves previously mislabeled WAV files as WebM", async () => {
    const filename = "d743f218-000e-4f6b-bd49-d53590482b70.wav";
    await fs.writeFile(path.join(uploadDirectory, filename), webm);
    const response = await request(app).get(`/api/uploads/${filename}`).set("Cookie", cookie);
    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toBe("audio/webm");
  });

  it.each([
    "not-a-uuid.png",
    "d743f218-000e-4f6b-bd49-d53590482b70.txt",
    "d743f218-000e-4f6b-bd49-d53590482b70.png",
    "..%2f..%2fpackage.json",
    "..%5c..%5cpackage.json",
  ])("returns 404 for invalid or missing filename %s", async (filename) => {
    const response = await request(app).get(`/api/uploads/${filename}`).set("Cookie", cookie);
    expect(response.status).toBe(404);
  });
});

describe("upload validation", () => {
  it.each([
    {},
    { fileType: "image" },
    { fileType: "image", data: null },
    { fileType: "image", data: 123 },
    { fileType: "image", data: {} },
    { fileType: "image", data: [] },
    { fileType: "image", data: "broken" },
    { fileType: "image", data: "https://example.com/image.png" },
    { fileType: "image", data: "data:text/html;base64,SGk=" },
    { fileType: "image", data: "data:image/png/extra;base64,SGk=" },
    { fileType: "image", data: "data:image/png;foo=bar;base64,SGk=" },
    { fileType: "image", data: "data:image/constructor;base64,SGk=" },
    { fileType: "image", data: "data:image/__proto__;base64,SGk=" },
    { fileType: "video", data: "data:audio/constructor;base64,SGk=" },
    { fileType: "constructor", data: "data:image/png;base64,SGk=" },
    { fileType: "__proto__", data: "data:image/png;base64,SGk=" },
    { fileType: "toString", data: "data:image/png;base64,SGk=" },
    { fileType: ["image"], data: "data:image/png;base64,SGk=" },
    { data: "data:image/png;base64,SGk=" },
    { fileType: "video", data: "data:image/png;base64,SGk=" },
    { fileType: "image", data: "data:audio/mpeg;base64,SGk=" },
    { fileType: "image", data: "data:image/png;base64,@" },
    { fileType: "image", data: "data:image/png;base64,A" },
    { fileType: "image", data: "data:image/png;base64,AB==" },
  ])("rejects malformed or unsupported request %#", async (body) => {
    const response = await request(app).post("/api/upload").set("Cookie", cookie).send(body);
    expect(response.status).toBe(400);
    expect(cloudinary.uploader.upload).not.toHaveBeenCalled();
    expect(await fs.readdir(uploadDirectory)).toEqual([]);
  });

  it("rejects an empty upload", async () => {
    expect((await uploadFile("image", "image/png", Buffer.alloc(0))).status).toBe(413);
    expect(cloudinary.uploader.upload).not.toHaveBeenCalled();
  });

  it.each([
    ["image", "image/png", 10],
    ["video", "audio/webm", 15],
  ])("accepts %s files exactly at the size limit", async (fileType, mime, limitMb) => {
    const response = await uploadFile(fileType, mime, Buffer.alloc(limitMb * 1024 * 1024));
    expect(response.status).toBe(200);
    const filename = path.basename(response.body.data.uploadData.secure_url);
    expect((await fs.stat(path.join(uploadDirectory, filename))).size).toBe(limitMb * 1024 * 1024);
  });

  it.each([
    ["image", "image/png", 10],
    ["video", "audio/webm", 15],
  ])("rejects %s files one byte above the size limit", async (fileType, mime, limitMb) => {
    const response = await uploadFile(fileType, mime, Buffer.alloc(limitMb * 1024 * 1024 + 1));
    expect(response.status).toBe(413);
    expect(cloudinary.uploader.upload).not.toHaveBeenCalled();
    expect(await fs.readdir(uploadDirectory)).toEqual([]);
  });

  it("returns 503 in production without Cloudinary and writes no file", async () => {
    process.env.NODE_ENV = "production";
    const response = await uploadFile("image", "image/png", Buffer.from("test"));
    expect(response.status).toBe(503);
    expect(cloudinary.uploader.upload).not.toHaveBeenCalled();
    expect(await fs.readdir(uploadDirectory)).toEqual([]);
  });
});

describe("configured Cloudinary uploads", () => {
  beforeEach(() => {
    for (const key of credentialKeys) process.env[key] = "upload-test-placeholder";
  });

  it("uploads images with the existing resize options in production", async () => {
    process.env.NODE_ENV = "production";
    const uploadData = { secure_url: "https://res.cloudinary.com/test/image/upload/photo.png", public_id: "photo" };
    cloudinary.uploader.upload.mockResolvedValue(uploadData);
    const response = await uploadFile("image", "image/png", Buffer.from("test"));
    expect(response.status).toBe(200);
    expect(response.body.data.uploadData).toEqual(uploadData);
    expect(cloudinary.uploader.upload).toHaveBeenCalledTimes(1);
    expect(cloudinary.uploader.upload).toHaveBeenCalledWith("data:image/png;base64,dGVzdA==", {
      upload_preset: "telegram_preset", resource_type: "image", width: 400, height: 400, crop: "limit",
    });
    expect(await fs.readdir(uploadDirectory)).toEqual([]);
  });

  it("sends the detected audio MIME without image transformations", async () => {
    cloudinary.uploader.upload.mockResolvedValue({ secure_url: "https://res.cloudinary.com/test/video/upload/voice.webm" });
    const response = await uploadFile("video", "audio/mp3", webm);
    expect(response.status).toBe(200);
    expect(cloudinary.uploader.upload).toHaveBeenCalledWith(`data:audio/webm;base64,${webm.toString("base64")}`, {
      upload_preset: "telegram_preset", resource_type: "video",
    });
    expect(await fs.readdir(uploadDirectory)).toEqual([]);
  });

  it("forwards Cloudinary failures without falling back to local storage", async () => {
    jest.spyOn(console, "error").mockImplementation(() => {});
    cloudinary.uploader.upload.mockRejectedValue(new Error("Cloudinary unavailable"));
    const response = await uploadFile("image", "image/png", Buffer.from("test"));
    expect(response.status).toBe(500);
    expect(cloudinary.uploader.upload).toHaveBeenCalledTimes(1);
    expect(await fs.readdir(uploadDirectory)).toEqual([]);
  });
});
