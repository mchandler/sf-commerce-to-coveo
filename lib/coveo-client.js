'use strict';

const PUSH_API_PATH = '/push/v1';
const MAX_FILE_BYTES = 256 * 1024 * 1024; // 256 MB Coveo hard cap per file container

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class CoveoError extends Error {
  constructor(status, body, url, errorCode) {
    super(`Coveo HTTP ${status}${errorCode ? ` (${errorCode})` : ''} from ${url}`);
    this.status = status;
    this.body = body;
    this.url = url;
    this.errorCode = errorCode;
  }
}

function backoffDelay(attempt) {
  return Math.min(60000, 2000 * Math.pow(2, attempt));
}

// Parses Retry-After; returns ms to wait, or null if not present.
function parseRetryAfter(headerValue) {
  if (!headerValue) return null;
  const seconds = Number(headerValue);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);
  const dateMs = Date.parse(headerValue);
  if (!Number.isNaN(dateMs)) return Math.max(0, dateMs - Date.now());
  return null;
}

async function safeText(res) {
  try { return await res.text(); } catch (_) { return ''; }
}

function parseCoveoErrorBody(text) {
  if (!text) return { errorCode: null, message: null };
  try {
    const j = JSON.parse(text);
    return { errorCode: j.errorCode || null, message: j.message || null };
  } catch (_) {
    return { errorCode: null, message: null };
  }
}

// Factory for a Coveo API client bound to an org + source + api key + region host.
function createCoveoClient({ baseUrl, orgId, sourceId, apiKey }, options = {}) {
  const maxAttempts = options.maxAttempts ?? 6;
  const sourcePath = `${PUSH_API_PATH}/organizations/${encodeURIComponent(orgId)}/sources/${encodeURIComponent(sourceId)}`;
  const orgPath = `${PUSH_API_PATH}/organizations/${encodeURIComponent(orgId)}`;

  async function request(method, urlOrPath, { body, headers, isAbsolute } = {}) {
    const url = isAbsolute ? urlOrPath : `${baseUrl}${urlOrPath}`;

    let attempt = 0;
    while (true) {
      let res;
      try {
        res = await fetch(url, { method, headers, body });
      } catch (netErr) {
        if (attempt >= 3) throw new Error(`Network error after ${attempt} retries: ${netErr.message}`);
        const wait = backoffDelay(attempt);
        console.warn(`  Network error (${netErr.message}); retrying in ${wait}ms...`);
        await sleep(wait);
        attempt++;
        continue;
      }

      // Transient: 429 (respect Retry-After) and 5xx.
      if (res.status === 429 || res.status >= 500) {
        if (attempt >= maxAttempts) {
          const text = await safeText(res);
          const { errorCode } = parseCoveoErrorBody(text);
          throw new CoveoError(res.status, text, url, errorCode);
        }
        const retryAfter = parseRetryAfter(res.headers.get('retry-after'));
        const wait = retryAfter != null ? retryAfter : backoffDelay(attempt);
        console.warn(`  Coveo HTTP ${res.status}; retrying in ${wait}ms (attempt ${attempt + 1}/${maxAttempts})...`);
        await sleep(wait);
        attempt++;
        continue;
      }

      if (!res.ok) {
        // Fail-fast on 4xx (bad request, auth, not found, payload too large).
        const text = await safeText(res);
        const { errorCode } = parseCoveoErrorBody(text);
        throw new CoveoError(res.status, text, url, errorCode);
      }

      if (res.status === 204) return { status: res.status, body: null };
      const text = await res.text();
      if (!text) return { status: res.status, body: null };
      try {
        return { status: res.status, body: JSON.parse(text) };
      } catch (_) {
        return { status: res.status, body: text };
      }
    }
  }

  function jsonHeaders() {
    return {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
  }

  // POST /push/v1/organizations/{orgId}/files — returns uploadUri + fileId + requiredHeaders
  async function createFileContainer() {
    const { body } = await request('POST', `${orgPath}/files?useVirtualHostedStyleUrl=true`, {
      headers: jsonHeaders(),
      body: JSON.stringify({}),
    });
    return body;
  }

  // POST /push/v1/organizations/{orgId}/sources/{sourceId}/stream/open
  async function streamOpen() {
    const { body } = await request('POST', `${sourcePath}/stream/open`, {
      headers: jsonHeaders(),
    });
    return body;
  }

  // POST /push/v1/organizations/{orgId}/sources/{sourceId}/stream/{streamId}/chunk
  async function streamChunk(streamId) {
    const { body } = await request(
      'POST',
      `${sourcePath}/stream/${encodeURIComponent(streamId)}/chunk`,
      { headers: jsonHeaders() },
    );
    return body;
  }

  // POST /push/v1/organizations/{orgId}/sources/{sourceId}/stream/{streamId}/close
  async function streamClose(streamId) {
    const { body } = await request(
      'POST',
      `${sourcePath}/stream/${encodeURIComponent(streamId)}/close`,
      { headers: jsonHeaders() },
    );
    return body;
  }

  // PUT /push/v1/organizations/{orgId}/sources/{sourceId}/stream/update?fileId={fileId}
  async function streamUpdate(fileId) {
    const { body } = await request(
      'PUT',
      `${sourcePath}/stream/update?fileId=${encodeURIComponent(fileId)}`,
      { headers: jsonHeaders() },
    );
    return body;
  }

  // POST /push/v1/organizations/{orgId}/sources/{sourceId}/status?statusType=REBUILD|IDLE
  async function setSourceStatus(statusType) {
    const { body } = await request(
      'POST',
      `${sourcePath}/status?statusType=${encodeURIComponent(statusType)}`,
      { headers: { Authorization: `Bearer ${apiKey}` } },
    );
    return body;
  }

  // Uploads a Buffer to the pre-signed S3 URL returned by Coveo.
  // requiredHeaders come from the file-container / stream-open response and
  // MUST be echoed back verbatim (AES256 + application/octet-stream).
  async function putToS3(uploadUri, requiredHeaders, contents) {
    await request('PUT', uploadUri, {
      isAbsolute: true,
      headers: requiredHeaders,
      body: contents,
    });
  }

  return {
    createFileContainer,
    streamOpen,
    streamChunk,
    streamClose,
    streamUpdate,
    setSourceStatus,
    putToS3,
  };
}

module.exports = { createCoveoClient, CoveoError, MAX_FILE_BYTES };
