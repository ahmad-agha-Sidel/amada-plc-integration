# amada-plc-integration

Node proxy for reading tags from an **Amada** machine's HMI.

It exposes a single `POST /tagbatch` endpoint that forwards tag-read requests to
the machine's HMI `tagbatch` endpoint and returns the response.

## How it works

Requests to the HMI require a valid `SID` session cookie. This server fetches
the HMI root page and reads the `SID` the HMI issues in its `Set-Cookie` header —
no manual cookie management and no browser needed.

- The `SID` is refreshed at startup, and again whenever a tag request fails
  (the request is retried once with the fresh `SID`).
- A hardcoded fallback `SID` is used only if `SID` retrieval fails.
- The HMI caps concurrent clients and returns **503** when full. On a 503 the
  server waits and retries (rather than refreshing the `SID`), since a 503 means
  the HMI is busy, not that the session is stale.

## Requirements

- Node.js 18+ (uses the global `fetch` and `Headers.getSetCookie()`)

## Install & run

```bash
npm install
npm start
```

The server listens on port **3001** by default (override with `PORT`).

## Configuration

All configuration is via environment variables:

| Variable             | Default                       | Description                                           |
| -------------------- | ----------------------------- | ----------------------------------------------------- |
| `TARGET_URL`         | `http://192.168.1.1/tagbatch` | HMI tagbatch endpoint the tags are forwarded to       |
| `HMI_URL`            | `http://192.168.1.1/`         | HMI root page used to obtain the `SID`                |
| `ORIGIN`             | `http://192.168.1.1`          | `Origin` header sent to the HMI                       |
| `REFERER`            | `http://192.168.1.1/`         | `Referer` header sent to the HMI                      |
| `SID_COOKIE`         | `SID=e8f2963e28`              | Fallback `SID` used only if retrieval fails           |
| `PORT`               | `3001`                        | Port the proxy listens on                             |
| `MAX_HMI_RETRIES`    | `500`                         | Max retries while the HMI returns 503 (at client cap) |
| `HMI_RETRY_DELAY_MS` | `2000`                        | Delay between retries, in milliseconds                |

## API

### `POST /tagbatch`

Request body:

```json
{
  "getTags": ["HMI_LineName", "IN_NcAutoRunning", "IN_NcZorigin"]
}
```

Omit the body (or send an empty `getTags`) to fall back to the default tag set.

**Example — bash / Git Bash:**

```bash
curl -X POST http://localhost:3001/tagbatch \
  -H "Content-Type: application/json" \
  -d '{"getTags":["HMI_LineName","IN_NcAutoRunning","IN_NcZorigin"]}'
```

**Responses:**

- `200` — JSON payload returned by the HMI.
- `502` — `{ "error": "<message>" }` if the HMI could not be reached even after
  refreshing the `SID`. When the HMI is at its client cap the message is
  `Service Unavailable - Maximum number of active clients reached`.

### Default tags

Used when `getTags` is omitted or empty:

```
HMI_LineName
IN_NcAutoRunning
IN_NcZorigin
IN_NcAlarm
NC_CurrentMcode
MachineMode
MachineState
OP_ApoStatus
```
