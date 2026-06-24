/**
 * Chat completions via Node's native https module.
 * Render's fetch/undici layer often hits ERR_STREAM_PREMATURE_CLOSE to OpenAI;
 * raw HTTPS avoids that path entirely.
 */

const https = require("https");

const DEFAULT_TIMEOUT_MS = Number(process.env.OPENAI_TIMEOUT_MS || 90000);
const DEFAULT_RETRIES = Math.max(1, Number(process.env.OPENAI_REQUEST_RETRIES || 4));

function isTransientError(err) {
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

function chatCompletionViaHttps(apiKey, { model, messages, maxTokens = 500, timeoutMs }) {
  const timeout = timeoutMs || DEFAULT_TIMEOUT_MS;
  const body = JSON.stringify({
    model,
    messages,
    max_tokens: maxTokens,
  });

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: "api.openai.com",
        port: 443,
        path: "/v1/chat/completions",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
          "Content-Length": Buffer.byteLength(body),
        },
        timeout,
        agent: false,
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let data;
          try {
            data = JSON.parse(text);
          } catch (parseErr) {
            reject(
              new Error(
                `OpenAI HTTPS invalid JSON (HTTP ${res.statusCode}): ${text.slice(0, 200)}`
              )
            );
            return;
          }
          if (res.statusCode >= 400) {
            const err = new Error(data.error?.message || text.slice(0, 200));
            err.status = res.statusCode;
            err.code = data.error?.code || null;
            reject(err);
            return;
          }
          resolve(data);
        });
      }
    );

    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("OpenAI HTTPS request timeout"));
    });
    req.write(body);
    req.end();
  });
}

/**
 * @returns {Promise<{ completion: object, transport: 'https' }>}
 */
async function requestChatCompletion(apiKey, { model, messages, maxTokens = 500, timeoutMs } = {}) {
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is missing");
  }

  let lastErr;
  for (let attempt = 0; attempt < DEFAULT_RETRIES; attempt++) {
    try {
      const completion = await chatCompletionViaHttps(apiKey, {
        model,
        messages,
        maxTokens,
        timeoutMs,
      });
      return { completion, transport: "https" };
    } catch (err) {
      lastErr = err;
      if (!isTransientError(err) || attempt >= DEFAULT_RETRIES - 1) {
        throw err;
      }
      const delayMs = 700 * 2 ** attempt;
      console.warn(
        `OpenAI HTTPS transient error (attempt ${attempt + 1}/${DEFAULT_RETRIES}), retry in ${delayMs}ms:`,
        err.message
      );
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw lastErr;
}

module.exports = {
  requestChatCompletion,
  isTransientError,
};
