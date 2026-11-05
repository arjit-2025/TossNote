# Tossnote

Self-hosted text, code and file sharing. Paste something, get a link and a QR code, and the link expires on its own.
No accounts, no plans, no rate limits, no ads.

## Features
- Share text or code with syntax highlighting (30+ languages, auto-detect)
- Expiry from 10 minutes to never; expired notes are deleted from disk
- Burn after reading (exactly one reader, even under concurrent opens)
- Password protection (scrypt-hashed) and max-view limits
- Optional end-to-end encryption: AES-256-GCM in the browser. The key lives only in the `#k=` part of the URL, so the server never sees plaintext, titles or file names
- File, image, video and audio attachments with inline previews (also encrypted when E2E is on)
- Edit after sharing; open viewers update live (Server-Sent Events)
- QR code for every link, custom links (`/my-note`), and a "My notes" list kept in your browser
- curl API for terminals and CI
- Strict CSP; no third-party scripts, CDNs or analytics

## Run
```bash
npm install
npm start          # http://localhost:3000
npm test           # API test suite
```

| Env var | Default | Meaning |
|---|---|---|
| `PORT` | `3000` | Listen port |
| `HOST` | `0.0.0.0` | Listen address |
| `DATA_DIR` | `./data` | Where notes are stored (one JSON file per note) |
| `MAX_BODY_MB` | `100` | Largest single upload; raise it as far as your server allows |
| `PUBLIC_URL` | (from request) | Base URL used in curl responses, e.g. `https://notes.example.com` |

Run it behind a TLS reverse proxy (Caddy or nginx) in production. Browsers only allow the encryption API (WebCrypto) on HTTPS or localhost.
Run one process per data directory; locking happens in memory.

## curl API
```bash
curl --data-binary @file.txt "https://host/api/raw?expiry=1d&syntax=python"
echo "secret" | curl --data-binary @- -H "X-Password: pw" "https://host/api/raw?burn=1"
curl -H "X-Password: pw" https://host/r/NOTE_ID
```
Options: `expiry` (`10m`, `2h`, `3d`, `1w`, `1y`, `never`), `burn=1`, `views=N`, `syntax`, `title`, `slug`.
The response body is the link, and the `X-Edit-Token` header holds the token for edits.

## JSON API
- `POST /api/pastes`: `{content, title, syntax, expiry, burn, maxViews, password, slug, encrypted, files:[{name,type,size,data(base64url)}]}` returns `{id, editToken, expiresAt}`
- `GET /api/pastes/:id`: public metadata; doesn't count a view
- `POST /api/pastes/:id/open`: `{password}` or `{viewToken}` returns the content (counts a view and applies burn/max-views)
- `PUT /api/pastes/:id`: header `X-Edit-Token`, body `{content}`
- `DELETE /api/pastes/:id`: header `X-Edit-Token`
- `GET /api/pastes/:id/events`: SSE stream (`update`, `gone`)
