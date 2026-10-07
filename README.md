# amada-plc-integration

Node proxy for reading tags from an **Amada** machine's HMI (Human-Machine
Interface) API.

It exposes a single `POST /tagbatch` endpoint that forwards tag-read requests
to the HMI's `tagbatch` endpoint and returns the response, with an extra
`VALID_DATA` tag appended to indicate whether the data is fresh.

## Actors

- **PLC**: the PLC connected to the Amada machine.
- **HMI API**: the HMI (Human-Machine Interface) API used by the webpage —
  this is where the data shown on the web page comes from.

## How it works

Requests to the HMI API require a valid `SID` session cookie. This server
fetches the HMI's root page and reads the `SID` from its `Set-Cookie`
header — no manual cookie management and no browser needed.

- The `SID` is refreshed at startup, and again whenever a tag request fails
  (the request is retried once with the fresh `SID`).
- A hardcoded fallback `SID` is used only if `SID` retrieval fails.
- The HMI API returns **503** specifically when it loses its connection to
  the PLC (responding with "max clients reached"). A successful `/tagbatch`
  response has `VALID_DATA=1` appended to its tags; a failed one returns
  `VALID_DATA=0`, plus `PLC_LOST=1` when the failure was a 503.

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

| Variable                        | Default              | Description                                                     |
| ------------------------------- | -------------------- | --------------------------------------------------------------- |
| `HMI_URL`                       | `http://192.168.1.1` | HMI root URL; also the base for the `/tagbatch` API             |
| `SID`                           | `e8f2963e28`         | Fallback `SID` used only if retrieval fails                     |
| `PORT`                          | `3001`               | Port the proxy listens on                                       |
| `MAX_REFRESH_SID_RETRIES`       | `1`                  | Max attempts to refresh the `SID` while the HMI API returns 503 |
| `RETRY_REFRESH_SID_RETRY_DELAY` | `500`                | Delay between `SID` refresh retries, in milliseconds            |

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

- `200` — the HMI's JSON payload, with `{ "name": "VALID_DATA", "value": 1 }`
  appended to its `tags`.
- `502` — a tags payload indicating the failure:
  ```json
  { "tags": [{ "name": "VALID_DATA", "value": 0 }] }
  ```
  If the underlying failure was a 503 (HMI lost its PLC connection), a
  `PLC_LOST` tag is also included:
  ```json
  {
    "tags": [
      { "name": "PLC_LOST", "value": 1 },
      { "name": "VALID_DATA", "value": 0 }
    ]
  }
  ```

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

## Deployment

The server runs as a `systemd` service named `amada-plc-integration`.

### Managing the service

Check if the service is running:

```bash
systemctl status amada-plc-integration
```

Tail the logs returned by the API:

```bash
journalctl -u amada-plc-integration -f
```

The service's `systemd` configuration lives at
`/etc/systemd/system/amada-plc-integration.service`, and can be edited with
`vim` or `nano`.

### Updating the service with new code

1. Upload the new code (usually just `server.js` and `package.json`) to
   `~/api/amada-plc-integration` on the server, using `scp` or FTP:

   ```bash
   scp -r /path/to/local/folder root@<remote_host>:~/api/amada-plc-integration
   ```

2. If `package.json` was modified, install the updated dependencies:

   ```bash
   npm install
   ```

3. Restart the service to pick up the new code:

   ```bash
   systemctl restart amada-plc-integration
   ```
