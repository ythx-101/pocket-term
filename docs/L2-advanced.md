# L2 Advanced — Custom Domain + Cloudflare Access + herdr

> This is a **documentation-only tier**. No install script.
> Templates below use placeholder values — adapt to your environment.

L2 reproduces a production setup (like `term.example.com` — the maintainer's
own installation) with all secrets and private paths replaced by `example.com` placeholders.

## Architecture

```
Internet
  │
  ▼
Cloudflare DNS (your-domain.com)
  │
  ├─► Cloudflare Access (email / OIDC gate)
  │     │
  │     ▼
  │   Named Cloudflare Tunnel (cloudflared)
  │     │
  │     ▼
  └─► nginx (TLS termination, reverse proxy)
        │
        ├─► 127.0.0.1:7681  (ttyd + herdr, Basic auth)
        │
        └─► 127.0.0.1:7698  (/up upload, Basic auth)
```

## Prerequisites

- A domain with DNS managed by Cloudflare
- Cloudflare Access (free tier covers up to 50 users)
- `cloudflared` installed and authenticated (`cloudflared tunnel login`)
- nginx installed
- ttyd 1.6.3 installed
- herdr installed (for multi-agent terminal multiplexing — optional)

## Step 1: Cloudflare Tunnel

```bash
# Create a named tunnel (one-time)
cloudflared tunnel create pocket-term

# Configure tunnel
cat > ~/.cloudflared/config.yml << 'EOF'
tunnel: <TUNNEL-UUID>
credentials-file: /home/<USER>/.cloudflared/<TUNNEL-UUID>.json

ingress:
  - hostname: term.example.com
    service: http://127.0.0.1:8080
  - service: http_status:404
EOF

# Install as systemd service
sudo cloudflared service install
systemctl start cloudflared
```

**Verify:**
```bash
cloudflared tunnel list          # tunnel shows as "healthy"
cloudflared tunnel info <NAME>   # active connections > 0
```

## Step 2: Cloudflare Access

1. In Cloudflare Dashboard → Zero Trust → Access → Applications:
   - Add application: `term.example.com` (self-hosted)
   - Policy: Allow emails from your domain
   - Session duration: 24h (or as needed)

2. No additional `cloudflared` config needed — Access policies are applied at the edge.

**Verify:**
```bash
curl -s -o /dev/null -w '%{http_code}' https://term.example.com
# Expect: 302 (redirect to Cloudflare Access login) — NOT 401 (Basic auth)
```

## Step 3: nginx Reverse Proxy

```nginx
# /etc/nginx/sites-available/pocket-term
server {
    listen 127.0.0.1:8080;
    server_name term.example.com;

    # Cloudflare edge → nginx over cloudflared tunnel
    # CF Access already handled auth at the edge

    location / {
        proxy_pass http://127.0.0.1:7681;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_read_timeout 86400s;
        proxy_send_timeout 86400s;
    }

    location /up {
        proxy_pass http://127.0.0.1:7698;
        proxy_set_header Host $host;
        client_max_body_size 25m;
    }
}
```

**Verify:**
```bash
nginx -t                          # syntax OK
systemctl reload nginx
curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8080/
# Expect: 401 (ttyd Basic auth — CF Access not applied to localhost)
```

## Step 4: herdr Multi-Agent Terminal

[herdr](https://github.com/earendil-works/herdr) is a terminal multiplexer
designed for coding agents. In this setup, it provides:

- Multiple named terminal tabs (one per agent)
- Session persistence across reconnects
- WebSocket-friendly output buffering

```bash
# Launch script (replaces the default $SHELL command)
cat > /usr/local/bin/pocket-term-herdr-launch.sh << 'EOF'
#!/bin/sh
exec herdr
EOF
chmod +x /usr/local/bin/pocket-term-herdr-launch.sh
```

Update your launch script to use herdr instead of `$SHELL`:
```bash
# In launch-ttyd.sh, change:
#   "$SHELL"
# to:
#   /usr/local/bin/pocket-term-herdr-launch.sh
```

## Step 5: systemd Units

Two service units — same two-profile sandbox pattern as L1:

```ini
# /etc/systemd/system/pocket-term.service
[Unit]
Description=pocket-term ttyd (herdr)
After=network.target cloudflared.service

[Service]
Type=simple
User=<USER>
ExecStart=/home/<USER>/.local/share/pocket-term/launch.sh
Restart=always
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
UMask=0077

[Install]
WantedBy=multi-user.target
```

```ini
# /etc/systemd/system/pocket-term-upload.service
[Unit]
Description=pocket-term upload sink
After=network.target

[Service]
Type=simple
User=<USER>
ExecStart=/usr/bin/python3 /home/<USER>/.local/share/pocket-term/upload-server.py \
  --upload-dir /srv/term-uploads \
  --port 7698 \
  --credentials /home/<USER>/.local/share/pocket-term/credentials
Restart=always
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
UMask=0077
ProtectSystem=strict
# tmpfs, not true/read-only: hides the rest of $HOME behind an empty,
# ephemeral mount while BindReadOnlyPaths still punches the credentials
# file through. `ProtectHome=true` makes BindReadOnlyPaths on a path under
# $HOME fail outright ("No such file or directory") because the bind target
# can't be created inside an already-inaccessible tree — see the L1
# scripts/templates/pocket-term-upload.service.tmpl and docs/test-evidence.md
# for the systemd-run proof. /srv/term-uploads is outside $HOME so it isn't
# affected either way, but still needs an explicit exception:
ProtectHome=tmpfs
BindPaths=/srv/term-uploads
BindReadOnlyPaths=/home/<USER>/.local/share/pocket-term/credentials

[Install]
WantedBy=multi-user.target
```

**Enable and start:**
```bash
systemctl daemon-reload
systemctl enable pocket-term pocket-term-upload
systemctl start pocket-term pocket-term-upload
journalctl -u pocket-term -f   # watch logs
```

## Uninstall L2

```bash
systemctl stop pocket-term pocket-term-upload
systemctl disable pocket-term pocket-term-upload
rm /etc/systemd/system/pocket-term.service
rm /etc/systemd/system/pocket-term-upload.service
systemctl daemon-reload

cloudflared tunnel delete pocket-term
rm -rf ~/.local/share/pocket-term
```

Then remove the Cloudflare Access application and DNS record from the dashboard.
