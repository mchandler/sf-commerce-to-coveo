'use strict';

const API_VERSION = 'v64.0';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class HttpError extends Error {
  constructor(status, body, url) {
    super(`HTTP ${status} from ${url}`);
    this.status = status;
    this.body = body;
    this.url = url;
  }
}

function backoffDelay(attempt) {
  return Math.min(60000, 2000 * Math.pow(2, attempt));
}

function createClient(session, options = {}) {
  const maxAttempts = options.maxAttempts ?? 6;

  async function request(method, urlPath, body) {
    const sess = await session.get();
    const url = `${sess.instanceUrl}${urlPath}`;

    let attempt = 0;
    let refreshedOnce = false;

    while (true) {
      let res;
      try {
        res = await fetch(url, {
          method,
          headers: {
            'Authorization': `Bearer ${(await session.get()).accessToken}`,
            'Content-Type': 'application/json',
            'Accept': 'application/json',
          },
          body: body == null ? undefined : JSON.stringify(body),
        });
      } catch (netErr) {
        if (attempt >= 3) throw new Error(`Network error after ${attempt} retries: ${netErr.message}`);
        const wait = backoffDelay(attempt);
        console.warn(`  Network error (${netErr.message}); retrying in ${wait}ms...`);
        await sleep(wait);
        attempt++;
        continue;
      }

      if (res.status === 401 && !refreshedOnce) {
        refreshedOnce = true;
        console.warn('  401 Unauthorized — refreshing SF CLI session...');
        await session.refresh();
        continue;
      }

      if (res.status === 429 || res.status >= 500) {
        if (attempt >= maxAttempts) {
          const text = await safeText(res);
          throw new HttpError(res.status, text, url);
        }
        const wait = backoffDelay(attempt);
        console.warn(`  HTTP ${res.status}; retrying in ${wait}ms (attempt ${attempt + 1}/${maxAttempts})...`);
        await sleep(wait);
        attempt++;
        continue;
      }

      if (!res.ok) {
        const text = await safeText(res);
        throw new HttpError(res.status, text, url);
      }

      if (res.status === 204) return null;
      const text = await res.text();
      if (!text) return null;
      try {
        return JSON.parse(text);
      } catch (_) {
        return text;
      }
    }
  }

  async function safeText(res) {
    try { return await res.text(); } catch (_) { return ''; }
  }

  async function queryAll(soql) {
    const out = [];
    let urlPath = `/services/data/${API_VERSION}/query?q=${encodeURIComponent(soql)}`;
    while (urlPath) {
      const res = await request('GET', urlPath);
      out.push(...(res.records || []));
      urlPath = res.nextRecordsUrl || null;
    }
    return out;
  }

  return {
    get: (urlPath) => request('GET', urlPath),
    post: (urlPath, body) => request('POST', urlPath, body),
    queryAll,
  };
}

module.exports = { createClient, HttpError, API_VERSION, sleep };
