/**
 * Gaxios-compatible transport using Node's native https module.
 * Render's fetch/undici layer often hits ERR_STREAM_PREMATURE_CLOSE to Google
 * (oauth2 token + Sheets API); raw HTTPS avoids that path.
 */

const https = require("https");
const zlib = require("zlib");
const querystring = require("querystring");
const { URL } = require("url");

const DEFAULT_TIMEOUT_MS = Number(process.env.GOOGLE_REQUEST_TIMEOUT_MS || 60000);
const DEFAULT_RETRIES = Math.max(1, Number(process.env.GOOGLE_REQUEST_RETRIES || 4));

function isTransientGoogleError(err) {
  const msg = String(err?.message || err?.cause?.message || "").toLowerCase();
  const code = String(err?.code || err?.cause?.code || err?.status || "");
  return (
    /premature close|econnreset|etimedout|socket hang up|fetch failed|network|timeout|aborted|parse error/i.test(
      msg
    ) ||
    /ERR_STREAM_PREMATURE_CLOSE|ECONNRESET|ETIMEDOUT|UND_ERR_SOCKET|UND_ERR_CONNECT_TIMEOUT/i.test(
      code
    )
  );
}

function serializeBody(data, headers) {
  if (data === undefined || data === null) return null;
  const ct = String(headers["Content-Type"] || headers["content-type"] || "");
  if (typeof data === "string") return data;
  if (ct.includes("application/x-www-form-urlencoded")) {
    return querystring.stringify(data);
  }
  return JSON.stringify(data);
}

/** Gaxios merges params into URL before fetch; our transport must do the same. */
function buildRequestUrl(opts) {
  let url = String(opts.url || "");
  if (!url) throw new Error("URL is required.");
  const params = opts.params;
  if (params && typeof params === "object" && Object.keys(params).length > 0) {
    const serializer =
      typeof opts.paramsSerializer === "function"
        ? opts.paramsSerializer
        : (p) => querystring.stringify(p);
    let qs = serializer(params);
    if (qs.startsWith("?")) qs = qs.slice(1);
    if (qs) {
      url += url.includes("?") ? "&" : "?";
      url += qs;
    }
  }
  return url;
}

function decodeResponseBody(raw, contentEncoding) {
  const enc = String(contentEncoding || "")
    .toLowerCase()
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  if (enc.includes("gzip")) return zlib.gunzipSync(raw);
  if (enc.includes("deflate")) return zlib.inflateSync(raw);
  if (enc.includes("br")) return zlib.brotliDecompressSync(raw);
  // Some Google responses gzip without a reliable Content-Encoding header.
  if (raw.length >= 2 && raw[0] === 0x1f && raw[1] === 0x8b) {
    return zlib.gunzipSync(raw);
  }
  return raw;
}

function httpsRequestOnce(opts) {
  const timeout = opts.timeout || DEFAULT_TIMEOUT_MS;
  const url = new URL(buildRequestUrl(opts));
  const method = (opts.method || "GET").toUpperCase();
  const headers = { ...(opts.headers || {}) };
  const body = ["GET", "HEAD"].includes(method) ? null : serializeBody(opts.data, headers);

  if (body !== null && !headers["Content-Length"] && !headers["content-length"]) {
    headers["Content-Length"] = Buffer.byteLength(body);
  }

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname + url.search,
        method,
        headers,
        timeout,
        agent: false,
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          let raw = Buffer.concat(chunks);
          try {
            raw = decodeResponseBody(raw, res.headers["content-encoding"]);
          } catch (decompressErr) {
            reject(
              new Error(`Google HTTPS decompress failed (HTTP ${res.statusCode}): ${decompressErr.message}`)
            );
            return;
          }
          const text = raw.toString("utf8");
          let data = text;
          const responseType = opts.responseType || "json";
          if (responseType === "json" && text) {
            try {
              data = JSON.parse(text);
            } catch (_) {
              reject(
                new Error(
                  `Google HTTPS invalid JSON (HTTP ${res.statusCode}): ${text.slice(0, 200)}`
                )
              );
              return;
            }
          }
          const response = {
            config: opts,
            data,
            status: res.statusCode,
            statusText: res.statusMessage || "",
            headers: res.headers,
          };
          const validateStatus =
            opts.validateStatus || ((status) => status >= 200 && status < 300);
          if (!validateStatus(res.statusCode)) {
            let detail = data;
            if (typeof data === "string" && data.trim().startsWith("{")) {
              try {
                detail = JSON.parse(data);
              } catch (_) {
                /* use raw string below */
              }
            }
            const err = new Error(
              detail?.error?.message ||
                (typeof detail?.error === "string" ? detail.error : null) ||
                (typeof data === "string" && !data.trim().startsWith("{") ? data.trim().slice(0, 300) : null) ||
                `Request failed with status ${res.statusCode}`
            );
            err.response = response;
            err.status = res.statusCode;
            err.googleError = detail?.error || detail;
            reject(err);
            return;
          }
          resolve(response);
        });
      }
    );

    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("Google HTTPS request timeout"));
    });
    if (body) req.write(body);
    req.end();
  });
}

async function httpsRequestWithRetry(opts) {
  let lastErr;
  for (let attempt = 0; attempt < DEFAULT_RETRIES; attempt++) {
    try {
      return await httpsRequestOnce(opts);
    } catch (err) {
      lastErr = err;
      if (!isTransientGoogleError(err) || attempt >= DEFAULT_RETRIES - 1) {
        throw err;
      }
      const delayMs = 700 * 2 ** attempt;
      console.warn(
        `Google HTTPS transient error (attempt ${attempt + 1}/${DEFAULT_RETRIES}), retry in ${delayMs}ms:`,
        err.message
      );
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw lastErr;
}

class GoogleHttpsTransporter {
  configure(opts = {}) {
    opts.headers = opts.headers || {};
    if (!opts.headers["User-Agent"]) {
      opts.headers["User-Agent"] = "beantol-bot/google-https-transport";
    }
    return opts;
  }

  request(opts) {
    return httpsRequestWithRetry(this.configure(opts || {}));
  }
}

const sharedTransporter = new GoogleHttpsTransporter();

module.exports = {
  GoogleHttpsTransporter,
  getGoogleHttpsTransporter: () => sharedTransporter,
  httpsRequestWithRetry,
  isTransientGoogleError,
};
