# Geeknerdz Website

## Overview

Geeknerdz Website is a small Node.js web app that serves the public site and accepts contact form submissions. Contact messages are stored locally as newline-delimited JSON so the site can run without an external database.

## Repository contents

Included in Git:

- `package.json` — Node.js package metadata and start script
- `server.js` — HTTP server, static file handler, health check, and contact endpoint
- `.env.example` — sample environment variables
- `.gitignore` — ignore rules for local secrets and runtime data
- `site/` — front-end assets served by the app
- `site-data/.gitkeep` — placeholder so the data directory exists in Git

## Files intentionally excluded from Git

These files and directories are intentionally excluded and must not be committed:

- `.env`
- `site-data/submissions.ndjson`
- `AGENTS.md`
- `memory/`
- `output/`
- `user_files/`
- `node_modules/`
- `package-lock.json`
- `npm-debug.log*`
- `.DS_Store`

`site-data/submissions.ndjson` is the local contact-form submission store and should be preserved if lead retention matters.

## Requirements

- Node.js 20 or newer
- npm

## Local development install

1. Install Node.js 20+.
2. Clone or unpack the repository.
3. Create your local environment file if needed:

   ```bash
   cp .env.example .env
   ```

4. Install dependencies if your setup uses them:

   ```bash
   npm install
   ```

5. Start the app:

   ```bash
   npm start
   ```

## Environment variables

The app expects these runtime variables:

```bash
HOST=0.0.0.0
PORT=3000
```

Optional:

```bash
SITE_DATA_DIR=site-data
```

## Start command

```bash
npm start
```

## Health check

The health endpoint is:

```bash
GET /api/health
```

Example:

```bash
curl http://127.0.0.1:3000/api/health
```

## Contact form endpoint

The contact form endpoint is:

```bash
POST /api/contact
```

The server accepts JSON or form-encoded requests. Required fields:

- `name`
- `email`
- `message`

## Local contact form storage

Submitted contact form entries are appended to:

```bash
site-data/submissions.ndjson
```

Back up `site-data/submissions.ndjson` if lead retention matters.

## Production deployment

Production deployment path:

```bash
/var/www/geeknerdz
```

This is the runtime working directory used by the deployed service.

## Systemd service

Service file:

```bash
/etc/systemd/system/geeknerdz.service
```

Recommended unit:

```ini
[Unit]
Description=Geeknerdz Website
After=network.target

[Service]
Type=simple
WorkingDirectory=/var/www/geeknerdz
ExecStart=/usr/bin/npm start
Restart=always
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

## Cloudflare Tunnel target

Cloudflare Tunnel should point to:

```bash
http://127.0.0.1:3000
```

## Troubleshooting

Check the service status:

```bash
sudo systemctl status geeknerdz --no-pager -l
```

Read recent logs:

```bash
sudo journalctl -u geeknerdz -n 100 --no-pager
```

Check the health endpoint:

```bash
curl http://127.0.0.1:3000/api/health
```

## Notes

- Do not commit `.env` or contact-form submissions.
- Do not expose tokens, passwords, keys, or other secrets in logs or documentation.
- Keep deployment and repository documentation in sync with the live server path and service settings.