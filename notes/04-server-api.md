# 04 — Server API reference (`server/`)

`server/` is a **copy of the running fan-made TSTO private server**
(bodnjenie14/TSTO, v0.10-era) — the one the patched game client in this
project talks to. It is reference material for how a real TSTO client
boots and saves; treat it as read-only ground truth for the wire
protocol. Source map below, then the full endpoint table.

## Source layout

```
server/config.json                    gameplay config (GameplayConfig → name/value strings)
server/tsto_original.apk              unpatched APK (patched via windows_gui_patcher.py)
server/source/server/
  main.cpp, tsto_server.cpp/hpp       process entry; TSTOServer (root, direction,
                                      lobby time, geo-age, prog reg code, friends,
                                      currency, plugin events)
  dispatcher/dispatcher.cpp           *** the entire route table (start here) ***
  networking/server_startup.cpp       evpp HTTP server init (GamePort, default 80),
                                      auto-update, Discord RPC
  file_server/                        /static/ DLC file downloads + dashboard assets
  headers/                            response Content-Type helpers (json/xml/protobuf)
  tsto/
    auth/auth.cpp          /connect/* + checkToken; token/code generation
    device/device.cpp      getAnonUid / getDeviceID / validateDeviceID / devices
    user/user.cpp          /mh/users, /mh/userstats, personas
    game/game.cpp          gameplayconfig + protoClientConfig
    land/land.cpp          *** protoland GET/PUT/POST, currency, extraland,
                           townOperations, deleteToken; town file load/save ***
    events/events.cpp      hardcoded event list + dashboard event-time APIs
    tracking/tracking.cpp  telemetry endpoints (log/metrics/clienttelemetry/core)
    dashboard/dashboard.cpp  admin web panel endpoints
    database/database.cpp  SQLite (tsto_users.db) user/token store
  protobufs/*.proto          wire schemas: LandData, WholeLandTokenData,
                             ClientConfigData, GameplayConfigData, AuthData,
                             GetFriendData, PurchaseData, OffersData,
                             ClientLog/Metrics/Telemetry, MatchmakingData, …
server/webpanel/                 static dashboard assets served from /
server/tools/, payloads/         dev tooling, sample protobuf payloads
```

Key facts:

- **One process, one HTTP server, one port** (`GamePort` in
  `server-config.json`, default **80**; evpp/libevent). Game API, DLC
  static files, and the admin dashboard all share it. The DLC server on a
  second port is in the code but commented out ("for now dlc on same port
  as game").
- **Not multi-user in the real sense.** One global `Session` singleton
  ("the current town"). Switching towns = re-login with a different
  email (README documents the "town switching system"). Concurrency is
  per-IP event-loop hashing only.
- **Persistence:**
  - Town saves: `towns/{email}.pb` — protobuf `WholeLandData`, raw bytes
    (parser retries at +0x0C offset for the "TSTO backup" wrapper).
    `towns/mytown.pb` = legacy/anonymous town.
  - Donut balances: `towns/currency.txt` (anonymous) or
    `towns/currency_{email}.txt` — a plain integer.
  - `tsto_users.db` (SQLite): `users(email PK NOCASE, user_id TEXT,
    access_token TEXT, mayhem_id INT, access_code TEXT)` + indexes on
    user_id / access_token / mayhem_id / access_code.
- **Auth is faked end-to-end:** tokens look like EA's
  (`AT0:2.0:3.0:86400:<32 rand>:<user_id>:<5 rand>`, codes `AC…`) but are
  random strings validated only against SQLite; the `id_token` JWT is
  unsigned. Bad logins don't fail — they create anonymous users
  (`anonymous_xxx@temp.com`).
- **Donut economy:** client reports currency deltas via
  `extraLandUpdate` (server applies ± to the currency file) and reads the
  balance back via `protocurrency`. Initial balance from
  `Server/InitialDonutAmount` (default 1000), editable in dashboard.
- **Events:** `events.cpp` holds a hardcoded epoch→event-name table
  (every historical TSTO event). Dashboard `/api/events/set` picks the
  active event; `/mh/games/lobby/time` returns event start + elapsed real
  time so client countdowns tick correctly.
- Config: gameplay = `config.json` (served to game as protobuf, editable
  via dashboard); runtime = `server-config.json` (GamePort, ServerIP,
  AutoDetectIP, InitialDonutAmount, EnableAutoUpdate, EnableDiscord).

## Game-facing endpoints

All relative to `http://<server>:<GamePort>`. "proto" = protobuf bytes
(`application/x-protobuf`), schema in `source/server/protobufs/`.

### Bootstrap / discovery

| Method | Path | Response |
|---|---|---|
| GET | `/` | JSON `{"status":"operational","server":"TSTO-Server"}` |
| GET | `/probe` | 200, empty body |
| GET/POST | `/director/api/{android,ios}/getDirectionByPackage` (and `getDirectionByBundle`) | JSON "director" bootstrap: `bundleId` (`com.ea.game.simpsons4_row` / `com.ea.simpsonssocial.inc2`), `clientId` (`simpsons4-{platform}-client`), `clientSecret`, `hwId:2363`, `mayhemGameCode:"bg_gameserver_plugin"`, `pollIntervals`, and `serverData[]` of `{key,value}` redirecting ~30 EA service URLs (nexus, antelope, synergy, mayhem, akamai, …) to the local server |
| GET | `/mh/games/lobby/time` | XML `<Time><epochMilliseconds>…</epochMilliseconds></Time>` — event-adjusted time |

### Device registration

| Method | Path | Response |
|---|---|---|
| any | `/user/api/android/getAnonUid`, `/user/api/iphone/getAnonUid` | JSON `{resultCode:0, serverApiVersion:"1.0.0", uid:<11-digit random>}` |
| any | `/user/api/android/getDeviceID`, `/user/api/iphone/getDeviceID` | JSON `{deviceId, resultCode, serverApiVersion}` |
| any | `/user/api/android/validateDeviceID`, `/user/api/iphone/validateDeviceID` | JSON `{deviceId, resultCode, serverApiVersion}` |
| POST | `/games/{hwId}/devices` | JSON `{deviceId, resultCode, serverApiVersion}` (body logged, ignored) |

### Auth (EA Connect-style OAuth shape)

Typical order: `connect/auth` → `connect/token` → `connect/tokeninfo` →
`checkToken` → `mh/users` → game data.

| Method | Path | Notes / response |
|---|---|---|
| GET | `/connect/auth` | Query: `client_id`, `authenticator_login_type`, … `mobile_ea_account` → JSON `{code, lvl_token}`; anything else → anonymous: creates `anonymous_xxx@temp.com` row, returns `{code}` (the 40-char access code) |
| GET | `/connect/token` | Query: `code` (+`client_id`). Looks up access_code → user; returns `{access_token(AT0:…), token_type:"Bearer", expires_in:4242, refresh_token(RT0:…), id_token(forged JWT)}` |
| GET | `/connect/tokeninfo` | Token via query `access_token`, `Authorization: Bearer`, JSON body, or form body. Valid → JSON `{client_id, scope, expires_in:4242, pid_id, user_id, persona_id, pid_type:"AUTHENTICATOR_ANONYMOUS"}` (+ `is_underage`/`authenticators`/`stopProcess`/`telemetry_id` if `x-check-underage`/`x-include-*` headers set); invalid → 400/401 JSON errors |
| GET | `/proxy/identity/geoagerequirements` | JSON `{geoAgeRequirements:{minLegalRegAge:13, minAgeWithConsent:"3", minLegalContactAge:13, country:"US"}}` |
| POST | `/proxy/identity/progreg/code` | Body `{"email": …}` + `Authorization: Bearer <token>`. The "log in with email" step: converts anonymous account to named (email-keyed town), loads/creates the town, returns `{code(AC…), user_id, mayhem_id}` |
| GET | `/proxy/identity/pids/me/personas/…`, `/proxy/identity/pids/…/personas` | JSON persona object(s) (displayName, namespaceName, status ACTIVE, …) |
| GET | `/mh/games/bg_gameserver_plugin/checkToken/{user_id}/protoWholeLandToken/` | Validates `mh_auth_params` (or `nucleus_token`) header vs DB; proto `TokenData{sessionkey, expirationdate:0}` |
| POST | `/mh/games/bg_gameserver_plugin/deleteToken/{mayhem_id}/protoWholeLandToken/…` | proto `DeleteTokenRequest{token}`; requires `mh_uid == mayhem_id` (else 404) + auth header (else 400); clears session token; proto `DeleteTokenResponse{result:"0"|"1"}` |

### User info

| Method | Path | Response |
|---|---|---|
| GET | `/mh/users` | proto `UsersResponseMessage{user{userid, telemetryid}, token{sessionkey}}` |
| GET | `/mh/userstats` | **409 Conflict, empty body — by design** |

### Game config

| Method | Path | Response |
|---|---|---|
| GET | `/mh/gameplayconfig` | proto `GameplayConfigResponse` — every `config.json` `GameplayConfig` entry as `{name,value}` items. (POST, or GET from a browser-ish client, switches to JSON read/write mode.) |
| GET/POST | `/api/config/game` | Same handler: GET → `config.json` as JSON; POST → saves body to `config.json`, returns `{"status":"success"}` |
| GET | `/mh/games/bg_gameserver_plugin/protoClientConfig/` | proto `ClientConfigResponse` — ~100 **hardcoded** client settings (min/current versions 4.69.0, save intervals, feature flags, app-store URLs, `ServerVersion:"local"`, …) |

### Land / town save (core gameplay)

Path shape: `/mh/games/bg_gameserver_plugin/protoland/{land_id}/…`.
Requests are expected to carry `mh_uid` (must equal `{land_id}` or → 403)
and `mh_auth_params` (required for POST).

| Method | Path | Notes / response |
|---|---|---|
| GET | `…/protoland/{land_id}/…` | Loads current town (creates blank one if missing); proto `WholeLandData` |
| PUT | `…/protoland/{land_id}/…` | Body = proto `WholeLandData` → saved to `towns/*.pb`; echoed back as proto. Empty body → blank town |
| POST | `…/protoland/{land_id}/…` | Body = proto `WholeLandData`, gzip if `Content-Encoding: gzip`; saved; XML `<WholeLandUpdateResponse/>` |
| POST | `…/extraLandUpdate/{land_id}/protoland/…` | Body = proto `ExtraLandMessage{currency_delta[]}` — **donuts earned/spent**; server applies deltas to the currency file; proto `ExtraLandResponse{processedcurrencydelta[]}` |
| GET | `…/protocurrency/{land_id}/…` | proto `CurrencyData{id, vctotalpurchased:0, vctotalawarded, vcbalance, createdat, updatedat}` |
| GET | `…/townOperations/` | proto town operations |
| GET | `…/friendData…` | proto `GetFriendDataResponse` — **empty friend list** (no friends feature) |
| GET | `…/event/…` and `…/event/{land_id}/protoland/…` | proto `EventsMessage` — **empty** (no live event pushes) |

### Telemetry (fire-and-forget)

| Method | Path | Response |
|---|---|---|
| POST | `/tracking/api/core/logEvent` | JSON `{"status":"ok"}` |
| POST | `…/bg_gameserver_plugin/trackinglog/…` | parses proto `ClientLogMessage`; XML `<Resources><URI>OK</URI></Resources>` |
| POST | `…/bg_gameserver_plugin/trackingmetrics/…` | parses proto `ClientMetricsMessage`; XML OK |
| POST | `/mh/clienttelemetry/…` | parses proto `ClientTelemetryMessage`; XML OK |
| POST | `/pinEvents` | JSON `{"status":"ok"}` (body may be gzip) |

### DLC files

| Method | Path | Notes |
|---|---|---|
| GET | `/static/…` | Serves files from the server's `static/` dir (the DLC/content mirror); same port as the game API |

Unmatched URIs → JSON 404 `{"status":"error","message":"Unknown endpoint"}`
(logged); handler exceptions → JSON 500.

## Dashboard (admin, browser only — same port)

`/dashboard` (HTML) plus:

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/dashboard/data` | status/config summary for the panel |
| GET | `/api/get-user-save` | read a town `.pb` (for editing) |
| POST | `/api/save-user-save` | write a town `.pb` |
| GET | `/list_users` | list users |
| GET/POST | `/edit_user_currency` | change a user's donut balance |
| GET/POST | `/api/browseDirectory` | browse server filesystem |
| POST | `/api/server/restart`, `/api/server/stop` | control the process |
| POST | `/api/forceSaveProtoland` | force-save the current town |
| POST | `/api/updateDlcDirectory`, `/api/updateServerIp`, `/api/updateServerPort` | runtime reconfig |
| POST | `/api/events/set` | choose the active event |
| POST/GET | `/api/events/adjust_time`, `/api/events/reset_time`, `/api/events/get_time` | event clock control |
| GET/POST | `/update_initial_donuts` | set `InitialDonutAmount` |
| POST | `/upload_town_file` | import a town save |
| — | `/dashboard/*`, `/images/*`, `/town_operations.html(.js)`, `/game_config`, `/tsto-styles.css`, `/proto/client_config.js`, `/proto/gameplay_config.js`, `/dashboard.html` | dashboard static assets |

## Typical game boot sequence (as implied by the handlers)

```
/director/api/…/getDirectionByPackage      (bootstrap URLs → point at this server)
/user/api/{platform}/getAnonUid            (or getDeviceID / validateDeviceID)
/games/{hwId}/devices                      (register device)
/connect/auth  →  /connect/token  →  /connect/tokeninfo   (EA Connect-shaped OAuth)
   …or "Play Anonymously": /connect/auth (anonymous) …
/proxy/identity/progreg/code               (optional: log in with an email)
…/checkToken/{user_id}/protoWholeLandToken/
/mh/users
/mh/games/bg_gameserver_plugin/protoClientConfig/
/mh/gameplayconfig  (+ /api/config/game only for the web panel)
…/protoland/{land_id}/…  GET (load)  →  PUT/POST (save)
  …/protocurrency/… · …/extraLandUpdate/… · …/townOperations/
/mh/games/lobby/time · …/event/… · …/friendData
telemetry: trackinglog / trackingmetrics / clienttelemetry / logEvent / pinEvents
```

## Gotchas worth knowing

- `/mh/userstats` **always 409** — that's intentional, not a bug.
- `checkToken` responds with the *session's* `sessionkey` regardless of
  whether the presented token validates (validation only logs).
- `protoland` identity check compares the `mh_uid` header to the
  `{land_id}` in the path; mismatch → 403. Anonymous play (no `mh_uid`)
  is allowed and uses `towns/mytown.pb`.
- `connect/tokeninfo` re-initializes the global session on every call
  ("hacky fix to restart if delete token not called") — another reminder
  that the server is single-tenant.
- `handle_plugin_event` / `handle_plugin_event_protoland` return an empty
  `EventsMessage` — live-event push is not implemented.
- Donut files are plain text and written non-atomically (`ofstream`
  truncates) — a crash mid-write can zero a balance.
- The dashboard has no authentication of its own — anyone who can reach
  the port can read/edit saves, change the IP/port, or stop the server.
