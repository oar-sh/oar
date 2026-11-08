/**
 * A fake of the OpenAI API for image sessions, for tests/image-session.spec.mjs.
 *
 * An in-process HTTP server on a loopback port, the relay pointed at it as its
 * OpenAI Base URL (Settings → Providers → OpenAI, `baseUrl` of
 * POST /api/settings/openai). It answers:
 *
 *  - `GET /models`: the list the relay's model discovery reads
 *    (`{ object: "list", data: [{ id }] }`);
 *  - `POST /images/generations` (a JSON body) and `POST /images/edits`
 *    (multipart/form-data, the images as `image[]` parts): with `stream`
 *    true a `text/event-stream` of `partial_images` partial images, then the
 *    completed one (`image_generation.*` for generations, `image_edit.*` for
 *    edits), `delayMs` apart; without it one JSON reply
 *    `{ data: [{ b64_json }], usage }`.
 *
 * Every image is a real PNG of the size asked for ("auto": 1024x1024), one
 * solid colour per kind (FAKE_IMAGE_COLOURS), so a test can tell a partial
 * from the final image by its pixels. The output format is always PNG (the
 * reply says so), whatever was asked.
 *
 * Every request is recorded in `seen` (method, path, whether the key was the
 * fake's, the Idempotency-Key, and for image requests the fields the relay
 * sent and the image parts it attached). A key the fake does not know gets
 * a 401. `failNext()` answers the next image requests with an error status
 * (the relay's one retry), `hangNext()` never answers them (a timeout).
 *
 * The key is invented: it has the OpenAI prefix and stays too short to read
 * as a real key (scripts/hygiene-patterns.mjs). The model ids are samples.
 */

import http from "node:http";
import zlib from "node:zlib";

export const FAKE_OPENAI_KEY = "sk-e2e-images-0000";

// What GET /models lists, in this order. The relay keeps the ids that look
// like OpenAI models (dall-e-3 is not one of them) and puts its own default
// model (gpt-4o) first.
export const FAKE_OPENAI_MODELS = Object.freeze(["gpt-image-2.5-flare", "gpt-image-2", "dall-e-3", "gpt-4o"]);

// The size an "auto" (or missing) size is answered with.
export const FAKE_AUTO_SIZE = Object.freeze({ width: 1024, height: 1024 });

// One colour per kind of image: partial 0, partial 1 (and 2), the final one.
export const FAKE_IMAGE_COLOURS = Object.freeze({
  partials: Object.freeze([
    Object.freeze([214, 92, 64]),
    Object.freeze([96, 168, 88]),
    Object.freeze([226, 190, 70]),
  ]),
  final: Object.freeze([52, 96, 196]),
});

// What a completed image reports as its usage (numbers only, as OpenAI's).
export const FAKE_IMAGE_USAGE = Object.freeze({
  total_tokens: 1300,
  input_tokens: 50,
  output_tokens: 1250,
  input_tokens_details: Object.freeze({ text_tokens: 50, image_tokens: 0 }),
});

// ------------------------------------------------------------------ PNGs --

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([head, body, crc]);
}

/** A solid-colour 8-bit RGB PNG of `width` x `height`. */
export function solidPng(width, height, [red, green, blue]) {
  const stride = width * 3 + 1;
  const row = Buffer.alloc(stride);
  for (let x = 0; x < width; x += 1) {
    row[1 + x * 3] = red;
    row[2 + x * 3] = green;
    row[3 + x * 3] = blue;
  }
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) row.copy(raw, y * stride);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", zlib.deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

/** `{ width, height }` of PNG bytes, or null for anything else. */
export function readPngSize(bytes) {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes || []);
  if (buffer.length < 24 || buffer.readUInt32BE(0) !== 0x89504e47 || buffer.toString("ascii", 12, 16) !== "IHDR") return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

const pngCache = new Map();

function cachedPngBase64(width, height, colour) {
  const key = `${width}x${height}:${colour.join(",")}`;
  if (!pngCache.has(key)) {
    // A handful of distinct images per run: the cache never grows past them.
    if (pngCache.size > 32) pngCache.clear();
    pngCache.set(key, solidPng(width, height, colour).toString("base64"));
  }
  return pngCache.get(key);
}

function parseSize(value) {
  const match = /^(\d{1,5})x(\d{1,5})$/i.exec(String(value || "").trim());
  if (!match) return { ...FAKE_AUTO_SIZE };
  return { width: Number(match[1]), height: Number(match[2]) };
}

// --------------------------------------------------------------- server --

function sendJson(res, status, body) {
  if (res.writableEnded || res.destroyed) return;
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function openAIError(res, status, message, type, code = null) {
  sendJson(res, status, { error: { message, type, param: null, code } });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function toBoolean(value) {
  if (typeof value === "boolean") return value;
  if (value === undefined || value === null) return null;
  return String(value).trim().toLowerCase() === "true";
}

function toNumberOrNull(value) {
  if (value === undefined || value === null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/**
 * The fields and image parts of an image request: a JSON body for
 * generations, multipart for edits (parsed with the platform's own
 * FormData reader, no dependency).
 */
async function readImageRequest(req, body) {
  const contentType = String(req.headers["content-type"] || "");
  if (contentType.toLowerCase().startsWith("multipart/form-data")) {
    const form = await new Response(body, { headers: { "content-type": contentType } }).formData();
    const fields = {};
    const images = [];
    for (const [key, value] of form.entries()) {
      if (typeof value === "string") {
        fields[key] = value;
        continue;
      }
      const bytes = Buffer.from(await value.arrayBuffer());
      images.push({ field: key, name: value.name || "", type: value.type || "", bytes: bytes.length, png: readPngSize(bytes) });
    }
    return { encoding: "multipart", fields, images };
  }
  let fields = {};
  try {
    const parsed = JSON.parse(body.toString("utf8") || "{}");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) fields = parsed;
  } catch {
    fields = {};
  }
  return { encoding: "json", fields, images: [] };
}

/**
 * Starts the fake. `delayMs` is the pause before each event of a stream (the
 * first one too), so a browser has time to show each preview;
 * `keys` the keys it answers; `models` replaces the model list;
 * `failFirst` answers the first image requests with 503.
 * Resolves `{ baseUrl, seen, imageRequests(path?), failNext(), hangNext(), close() }`.
 */
export function startFakeOpenAIImages({
  delayMs = 400,
  keys = [FAKE_OPENAI_KEY],
  models = FAKE_OPENAI_MODELS,
  failFirst = 0,
} = {}) {
  const seen = [];
  const known = new Set(keys);
  const failures = [];
  for (let index = 0; index < failFirst; index += 1) failures.push({ status: 503 });
  let hangs = 0;
  const timers = new Set();

  const wait = (ms, res) => new Promise((resolve) => {
    if (!(ms > 0)) {
      resolve(!res.destroyed);
      return;
    }
    const timer = setTimeout(() => {
      timers.delete(timer);
      resolve(!res.destroyed);
    }, ms);
    timers.add(timer);
  });

  async function answerImageRequest(req, res, entry, kind) {
    const { fields, images } = entry;
    const { width, height } = parseSize(fields.size);
    const count = Math.max(1, Math.min(4, Math.trunc(Number(fields.n) || 1)));
    const quality = String(fields.quality || "auto");
    const background = String(fields.background || "auto");
    const meta = {
      size: `${width}x${height}`,
      quality: quality === "auto" ? "medium" : quality,
      output_format: "png",
      background: background === "auto" ? "opaque" : background,
    };
    if (!entry.stream) {
      sendJson(res, 200, {
        created: Math.floor(Date.now() / 1000),
        data: Array.from({ length: count }, () => ({ b64_json: cachedPngBase64(width, height, FAKE_IMAGE_COLOURS.final) })),
        usage: FAKE_IMAGE_USAGE,
        ...meta,
      });
      return;
    }
    const partials = Math.max(0, Math.min(3, Math.trunc(entry.partialImages ?? 0)));
    res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", connection: "keep-alive" });
    const write = (type, payload) => {
      if (res.destroyed || res.writableEnded) return false;
      res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`);
      return true;
    };
    for (let image = 0; image < count; image += 1) {
      for (let partial = 0; partial < partials; partial += 1) {
        if (!(await wait(delayMs, res))) return;
        const colour = FAKE_IMAGE_COLOURS.partials[partial % FAKE_IMAGE_COLOURS.partials.length];
        if (!write(`${kind}.partial_image`, {
          b64_json: cachedPngBase64(width, height, colour),
          partial_image_index: partial,
          created_at: Math.floor(Date.now() / 1000),
          ...meta,
        })) return;
        entry.events.push(`${kind}.partial_image`);
      }
      if (!(await wait(delayMs, res))) return;
      if (!write(`${kind}.completed`, {
        b64_json: cachedPngBase64(width, height, FAKE_IMAGE_COLOURS.final),
        created_at: Math.floor(Date.now() / 1000),
        usage: FAKE_IMAGE_USAGE,
        ...meta,
      })) return;
      entry.events.push(`${kind}.completed`);
    }
    res.end();
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const authorization = String(req.headers.authorization || "");
    const entry = {
      method: req.method,
      path: url.pathname,
      knownKey: known.has(authorization.replace(/^Bearer\s+/i, "")),
      idempotencyKey: String(req.headers["idempotency-key"] || ""),
      at: Date.now(),
      status: null,
    };
    seen.push(entry);
    try {
      const body = await readBody(req);
      if (!entry.knownKey) {
        entry.status = 401;
        openAIError(res, 401, "Incorrect API key provided.", "invalid_request_error", "invalid_api_key");
        return;
      }
      if (req.method === "GET" && url.pathname === "/models") {
        entry.status = 200;
        sendJson(res, 200, {
          object: "list",
          data: models.map((id) => ({ id, object: "model", created: 1767225600, owned_by: "system" })),
        });
        return;
      }
      const kind = url.pathname === "/images/generations"
        ? "image_generation"
        : (url.pathname === "/images/edits" ? "image_edit" : "");
      if (req.method !== "POST" || !kind) {
        entry.status = 404;
        openAIError(res, 404, `Unknown request URL: ${req.method} ${url.pathname}.`, "invalid_request_error", "unknown_url");
        return;
      }
      const parsed = await readImageRequest(req, body);
      Object.assign(entry, {
        encoding: parsed.encoding,
        fields: parsed.fields,
        model: String(parsed.fields.model || ""),
        prompt: String(parsed.fields.prompt || ""),
        size: parsed.fields.size === undefined ? null : String(parsed.fields.size),
        quality: parsed.fields.quality === undefined ? null : String(parsed.fields.quality),
        n: toNumberOrNull(parsed.fields.n),
        outputFormat: parsed.fields.output_format === undefined ? null : String(parsed.fields.output_format),
        background: parsed.fields.background === undefined ? null : String(parsed.fields.background),
        stream: toBoolean(parsed.fields.stream) === true,
        partialImages: toNumberOrNull(parsed.fields.partial_images),
        images: parsed.images,
        imageParts: parsed.images.filter((image) => image.field === "image[]").length,
        events: [],
      });
      if (hangs > 0) {
        hangs -= 1;
        entry.status = "hung";
        return;
      }
      const failure = failures.shift();
      if (failure) {
        entry.status = failure.status;
        openAIError(res, failure.status, "The server is overloaded. Please try again later.", "server_error");
        return;
      }
      entry.status = 200;
      await answerImageRequest(req, res, entry, kind);
    } catch (error) {
      entry.status = 500;
      entry.error = String(error?.message || error);
      if (!res.headersSent) openAIError(res, 500, "The fake failed to read the request.", "server_error");
      else res.destroy();
    }
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({
      server,
      seen,
      baseUrl: `http://127.0.0.1:${server.address().port}`,
      /** The image requests (generations and edits), or those to one path. */
      imageRequests: (path = "") => seen.filter((entry) => (
        entry.method === "POST" && (path ? entry.path === path : entry.path.startsWith("/images/"))
      )),
      /** The next `count` image requests are answered with `status`. */
      failNext: ({ status = 503, count = 1 } = {}) => {
        for (let index = 0; index < count; index += 1) failures.push({ status });
      },
      /** The next `count` image requests get no answer at all. */
      hangNext: ({ count = 1 } = {}) => {
        hangs += count;
      },
      close: () => {
        for (const timer of timers) clearTimeout(timer);
        timers.clear();
        server.closeAllConnections?.();
        return new Promise((done) => server.close(done));
      },
    }));
  });
}
