export function createApiClient({ serverUrl, token, getHeaders }) {
  return async function api(method, routePath, body) {
    const url = `${serverUrl}${routePath}`;
    const extraHeaders = typeof getHeaders === "function" ? (getHeaders() || {}) : {};
    const opts = {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        ...extraHeaders,
      },
      ...(method !== "GET" ? { body: JSON.stringify(body || {}) } : {}),
    };

    const res = await fetch(url, opts);
    if (!res.ok) {
      const rawText = String(await res.text().catch(() => "")).trim();
      let detail = rawText;
      if (rawText) {
        try {
          const payload = JSON.parse(rawText);
          detail = String(payload?.error || payload?.message || rawText).trim();
        } catch {
          detail = rawText;
        }
      }
      const error = new Error(`HTTP ${res.status} ${routePath}${detail ? `: ${detail}` : ""}`);
      error.status = res.status;
      error.detail = detail;
      throw error;
    }
    return res.json();
  };
}
