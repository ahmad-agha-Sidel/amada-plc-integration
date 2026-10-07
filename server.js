const express = require("express");

// Prefix every console.log/console.error call with an ISO timestamp
const withTimestamp =
  (fn) =>
  (...args) =>
    fn(`[${new Date().toISOString()}]`, ...args);
console.log = withTimestamp(console.log.bind(console));
console.error = withTimestamp(console.error.bind(console));

// The URL of the web page
const HMI_URL = process.env.HMI_URL || "http://192.168.1.1";

// Fallback only if SID retrieval fails
let SID = process.env.SID || "e8f2963e28";

// The max retries in a request to reset the SID when it's invalid (defaults to 1 per API request)
const MAX_REFRESH_SID_RETRIES = Number(
  process.env.MAX_REFRESH_SID_RETRIES || 1,
);

// In milliseconds (ms)
const RETRY_REFRESH_SID_RETRY_DELAY = Number(
  process.env.RETRY_REFRESH_SID_RETRY_DELAY || 500,
);

// The tags sent from the HMI API (gotten from the PLC) that we can request
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

// Custom tags that will be sent by us (our API)
const PLC_LOST = "PLC_LOST";
const VALID_DATA = "VALID_DATA";

// Actors
// - PLC: The PLC connected to the Amada
// - HMI API: The HMI (Human-Machine Interface) API used by the webpage, this is where the data shown on the web page comes from

// Builds the error response. The HMI API returns 503 specifically when it
// loses its connection to the PLC (responding with "max clients reached"),
// so a 503 error response will contain PLC_LOST=true in addition to
// VALID_DATA=false tags. Any other status code is a different issue and will return only the VALID_DATA=false tag
const buildErrorResponse = (statusCode) => {
  return statusCode === 503
    ? {
        tags: [
          {
            name: PLC_LOST,
            value: 1,
          },
          {
            name: VALID_DATA,
            value: 0,
          },
        ],
      }
    : {
        // Regular (non-PLC lost) error (any other statusCode)
        tags: [
          {
            name: VALID_DATA,
            value: 0,
          },
        ],
      };
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Refresh SID by fetching the HMI web page and reading the SID from its cookies
const refreshSid = async () => {
  console.log("- Refreshing SID...");

  for (let attempt = 1; attempt <= MAX_REFRESH_SID_RETRIES; attempt++) {
    const response = await fetch(HMI_URL, { redirect: "manual" });
    const statusCode = response.status;
    console.log(
      `-- Refreshing SID, attempt ${attempt}/${MAX_REFRESH_SID_RETRIES}. Status code:`,
      statusCode,
    );

    // Keep retrying until we have a valid SID or we have reached the MAX_REFRESH_SID_RETRIES
    if (statusCode === 503 && attempt < MAX_REFRESH_SID_RETRIES) {
      // Uncomment this if you want delay between retries
      // await sleep(RETRY_REFRESH_SID_RETRY_DELAY);
      continue;
    }

    if (statusCode !== 200) {
      const error = new Error(`Refresh SID failed (status ${statusCode})`);
      error.statusCode = statusCode;
      throw error;
    }

    // Support for older Node.js versions to retrieve cookies
    const cookies =
      typeof response.headers.getSetCookie === "function"
        ? response.headers.getSetCookie()
        : [response.headers.get("set-cookie")].filter(Boolean);

    const match = cookies
      .map((cookie) => cookie.match(/SID=([^;]+)/i))
      .find(Boolean);

    if (!match) {
      throw new Error("SID cookie not found in HMI Set-Cookie header");
    }

    // Set the SID here
    SID = match[1];
    console.log("Using SID:", SID);
    return;
  }
};

async function fetchTags(tags) {
  const response = await fetch(`${HMI_URL}/tagbatch`, {
    method: "POST",
    headers: {
      Accept: "application/json, text/javascript, */*; q=0.01",
      "Accept-Language": "en-US,en;q=0.9",
      Connection: "keep-alive",
      "Content-Type": "application/json",
      Cookie: `SID=${SID}`,
      Origin: HMI_URL,
      Referer: HMI_URL,
      "X-Requested-With": "XMLHttpRequest",
    },
    body: JSON.stringify({ getTags: tags }),
  });

  if (response.status !== 200) {
    const error = new Error(
      `API fetch tags failed (status ${response.status})`,
    );
    error.statusCode = response.status;
    throw error;
  }

  // Return a valid response only on status code 200
  const result = await response.json();
  // Add the VALID_DATA custom tag
  result["tags"].push({
    name: VALID_DATA,
    value: 1,
  });
  return result;
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
      console.error(`Error: ${error.message} (status: ${error.statusCode})`);
      try {
        // Refresh SID at least once (or whatever is set on MAX_REFRESH_SID_RETRIES) when there's an error thrown from the fetchTags API
        await refreshSid();
        const result = await fetchTags(tags);
        res.json(result);
      } catch (finalError) {
        // Retry also failed, send the error payload to the client
        res.status(502).json(buildErrorResponse(finalError.statusCode));
      }
    }
  });

  return app;
}

if (require.main === module) {
  const port = process.env.PORT || 3001;

  createApp().listen(port, async () => {
    console.log(`Server started on http://localhost:${port}`);
    try {
      // Get SID on server start-up
      await refreshSid();
    } catch (err) {
      console.error("Initial SID refresh failed:", err.message);
      console.log("Using fallback SID:", SID);
    }
  });
}
