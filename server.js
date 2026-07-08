const express = require("express");

const TARGET_URL = process.env.TARGET_URL || "http://192.168.1.1/tagbatch";
const HMI_URL = process.env.HMI_URL || "http://192.168.1.1/";
const ORIGIN = process.env.ORIGIN || "http://192.168.1.1";
const REFERER = process.env.REFERER || "http://192.168.1.1/";

// Fallback only if browser SID retrieval fails
const FALLBACK_SID_COOKIE = process.env.SID_COOKIE || "SID=e8f2963e28";

let SID_COOKIE = FALLBACK_SID_COOKIE;

// The HMI caps concurrent clients; when full it returns 503. Retry with backoff
// instead of failing, since slots free up as other clients disconnect.
const MAX_HMI_RETRIES = Number(process.env.MAX_HMI_RETRIES || 500);
const HMI_RETRY_DELAY_MS = Number(process.env.HMI_RETRY_DELAY_MS || 2000);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// The HMI returns 503 specifically when it is at its client cap. Any other
// non-200 is a different problem, so only 503 gets the "max clients" message.
function hmiStatusError(status) {
  return status === 503
    ? new Error(
        "Service Unavailable - Maximum number of active clients reached",
      )
    : new Error(`HMI did not return 200 (got ${status})`);
}

const DEFAULT_TAGS = [
  "HMI_LineName",
  "IN_NcAutoRunning",
  "IN_NcZorigin",
  "IN_NcAlarm",
  "NC_CurrentMcode",
  "MachineMode",
  "MachineState",
  "OP_ApoStatus",
];

/**
 * Fetch the HMI root page and read the SID from its Set-Cookie header.
 * Retries with backoff while the HMI is at its client cap (503).
 */
async function refreshSid() {
  console.log("Refreshing Amada SID...");

  for (let attempt = 1; attempt <= MAX_HMI_RETRIES; attempt++) {
    const response = await fetch(HMI_URL, { redirect: "manual" });
    const status = response.status;
    console.log(
      `HMI GET attempt ${attempt}/${MAX_HMI_RETRIES} status:`,
      status,
    );

    if (status === 503 && attempt < MAX_HMI_RETRIES) {
      await sleep(HMI_RETRY_DELAY_MS);
      continue;
    }

    if (status !== 200) {
      throw hmiStatusError(status);
    }

    // Prefer getSetCookie() (keeps cookies split); fall back to the combined header.
    const setCookies =
      typeof response.headers.getSetCookie === "function"
        ? response.headers.getSetCookie()
        : [response.headers.get("set-cookie")].filter(Boolean);

    const match = setCookies
      .map((cookie) => cookie.match(/SID=([^;]+)/i))
      .find(Boolean);

    if (!match) {
      throw new Error("SID cookie not found in HMI Set-Cookie header");
    }

    SID_COOKIE = `SID=${match[1]}`;
    console.log("Using SID:", SID_COOKIE);
    return;
  }
}

/**
 * Forwards tags to the HMI tagbatch endpoint. On a 503 the HMI is at its client
 * cap (not a stale SID), so we wait for a free slot and retry rather than
 * refreshing. Any other non-200 is thrown so the caller can refresh the SID.
 */
async function fetchTags(tags) {
  for (let attempt = 1; ; attempt++) {
    const response = await fetch(TARGET_URL, {
      method: "POST",
      headers: {
        Accept: "application/json, text/javascript, */*; q=0.01",
        "Accept-Language": "en-US,en;q=0.9",
        Connection: "keep-alive",
        "Content-Type": "application/json",
        Cookie: SID_COOKIE,
        Origin: ORIGIN,
        Referer: REFERER,
        "X-Requested-With": "XMLHttpRequest",
      },
      body: JSON.stringify({ getTags: tags }),
    });

    if (response.status === 200) {
      return response.json();
    }

    if (response.status === 503 && attempt < MAX_HMI_RETRIES) {
      console.warn(
        `HMI busy (503), retry ${attempt}/${MAX_HMI_RETRIES} in ${HMI_RETRY_DELAY_MS}ms`,
      );
      await sleep(HMI_RETRY_DELAY_MS);
      continue;
    }

    // Any other non-200 (or an exhausted 503 when MAX_HMI_RETRIES is reached) is a failure the caller handles
    const error = hmiStatusError(response.status);
    error.status = response.status;
    throw error;
  }
}

function createApp() {
  const app = express();
  app.use(express.json());

  app.post("/tagbatch", async (req, res) => {
    const body = req.body || {};

    const tags =
      Array.isArray(body.getTags) && body.getTags.length > 0
        ? body.getTags
        : DEFAULT_TAGS;

    try {
      const result = await fetchTags(tags);
      res.json(result);
    } catch (error) {
      console.error(error.message);
      try {
        // A non-503 failure may mean a stale SID — refresh it and retry once
        await refreshSid();
        const result = await fetchTags(tags);
        res.json(result);
      } catch (retryError) {
        res.status(502).json({
          error: retryError.message,
        });
      }
    }
  });

  return app;
}

module.exports = {
  createApp,
  fetchTags,
  refreshSid,
  DEFAULT_TAGS,
};

if (require.main === module) {
  const port = process.env.PORT || 3001;

  createApp().listen(port, async () => {
    console.log(`Server started on http://localhost:${port}`);
    try {
      // Get SID on server start-up
      await refreshSid();
    } catch (err) {
      console.error("Initial SID refresh failed:", err.message);
      console.log("Using fallback SID:", SID_COOKIE);
    }
  });
}
