# Quick Start

## 1. Configure Home Assistant URL

`HA_URL` must be set with a scheme (`http://` or `https://`). Pick one compose file:

- `docker-compose.simple.yml` — standalone, HTTP only on port 8080
- `docker-compose.yml` — adds HTTPS (8443) and reverse-proxy/Let's Encrypt labels

Edit the `HA_URL` line in whichever file you use:

```yaml
environment:
  - HA_URL=http://homeassistant.local:8123
```

## 2. Create an empty custom.css

Required even if you don't plan to customize styling yet — the compose files mount it directly, and Docker won't start if the source file is missing:

```bash
touch custom.css
```

## 3. Start the container

```bash
docker-compose -f docker-compose.simple.yml up -d --build
```

## 4. Open the dashboard

- `http://your-server-ip:8080`
- `https://your-server-ip:8443` (only with `docker-compose.yml`)

## 5. First-run setup

You'll be prompted for your Home Assistant URL and a long-lived access token (Home Assistant → your profile → Security → Long-Lived Access Tokens). Then create your first room:

1. Name the room and set a grid size (columns × rows)
2. Add entities (`light.kitchen`, `climate.living_room`, etc.)
3. Save

Any other panel pointed at the same server can now select that room from the room list — no need to repeat setup.

## Next steps

- Long-press anywhere on the dashboard (or visit `?debug=true`) to reopen the editor later
- See [README.md](README.md) for the full entity/option reference, theming via `custom.css`, voice messages, and Fully Kiosk Browser setup
