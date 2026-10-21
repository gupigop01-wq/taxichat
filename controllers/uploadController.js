const crypto = require("crypto");
const fs = require("fs/promises");
const path = require("path");
const catchAsyncError = require("../utilities/catchAsyncError");
const ApiError = require("../utilities/errors");
const { cloudinary } = require("../utilities/Cloudinary");

const uploadDirectory = path.join(__dirname, "..", "uploads");
const formats = {
  image: {
    jpeg: { extension: "jpg", mime: "image/jpeg" },
    png: { extension: "png", mime: "image/png" },
    webp: { extension: "webp", mime: "image/webp" },
    gif: { extension: "gif", mime: "image/gif" },
  },
  video: {
    webm: { extension: "webm", mime: "audio/webm" },
    ogg: { extension: "ogg", mime: "audio/ogg" },
    mp4: { extension: "m4a", mime: "audio/mp4" },
    mpeg: { extension: "mp3", mime: "audio/mpeg" },
    wav: { extension: "wav", mime: "audio/wav" },
  },
};

const hasCloudinary = () =>
  Boolean(process.env.CLOUDINARY_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET);

const detectAudioFormat = (content, declared) => {
  if (content.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) return formats.video.webm;
  if (content.toString("ascii", 0, 4) === "OggS") return formats.video.ogg;
  if (content.toString("ascii", 0, 4) === "RIFF" && content.toString("ascii", 8, 12) === "WAVE") return formats.video.wav;
  if (content.toString("ascii", 4, 8) === "ftyp") return formats.video.mp4;
  if (content.toString("ascii", 0, 3) === "ID3" ||
      (content[0] === 0xff && (content[1] & 0xe0) === 0xe0)) return formats.video.mpeg;
  return declared;
};

exports.upload = catchAsyncError(async (req, res) => {
  const { data, fileType } = req.body;
  const match = typeof data === "string" && /^data:([^;,]+)(?:;codecs=[^;,]+)?;base64,([A-Za-z0-9+/]+={0,2})$/.exec(data);
  const subtype = match?.[1].split("/")[1];
  let format = formats[fileType]?.[subtype];
  if (!format || !match[1].startsWith(fileType === "image" ? "image/" : "audio/")) {
    throw new ApiError(400, "Неподдерживаемый формат файла");
  }
  const content = Buffer.from(match[2], "base64");
  if (!content.length || content.length > (fileType === "image" ? 10 : 15) * 1024 * 1024) {
    throw new ApiError(413, "Файл пустой или слишком большой");
  }
  if (fileType === "video") format = detectAudioFormat(content, format);

  let uploadData;
  if (hasCloudinary()) {
    const uploadSource = `data:${format.mime};base64,${match[2]}`;
    uploadData = await cloudinary.uploader.upload(uploadSource, {
      upload_preset: "telegram_preset",
      resource_type: fileType,
      ...(fileType === "image" && { width: 400, height: 400, crop: "limit" }),
    });
  } else if (process.env.NODE_ENV !== "production") {
    await fs.mkdir(uploadDirectory, { recursive: true });
    const filename = `${crypto.randomUUID()}.${format.extension}`;
    await fs.writeFile(path.join(uploadDirectory, filename), content, { flag: "wx" });
    uploadData = { secure_url: `/api/uploads/${filename}` };
  } else {
    throw new ApiError(503, "Загрузка файлов не настроена на сервере");
  }

  res.json({ status: "success", data: { uploadData } });
});

exports.download = catchAsyncError(async (req, res) => {
  const match = /^([0-9a-f-]{36})\.(jpg|png|webp|gif|webm|ogg|m4a|mp3|wav)$/.exec(req.params.filename);
  if (!match) throw new ApiError(404, "Файл не найден");
  const filename = path.join(uploadDirectory, req.params.filename);
  try {
    await fs.access(filename);
  } catch {
    throw new ApiError(404, "Файл не найден");
  }
  const format = Object.values(formats).flatMap((group) => Object.values(group))
    .find((entry) => entry.extension === match[2]);
  const header = Buffer.alloc(12);
  const handle = await fs.open(filename, "r");
  try {
    await handle.read(header, 0, header.length, 0);
  } finally {
    await handle.close();
  }
  res.set("Content-Type", ["webm", "ogg", "m4a", "mp3", "wav"].includes(match[2])
    ? detectAudioFormat(header, format).mime
    : format.mime);
  res.set("X-Content-Type-Options", "nosniff");
  res.sendFile(filename);
});
