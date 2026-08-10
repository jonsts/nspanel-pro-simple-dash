# NSPanel Dashboard

A modern, touch-friendly Home Assistant dashboard built for NSPanel displays (480×480, and 480×890 for the NSPanel Pro 120). All configuration is done in-browser and stored server-side, so any panel can pick up any room with no rebuild or file editing required.

## Features

- 🎨 Gradient design with selectable Google Fonts, fully themeable via CSS variables
- 📱 Multi-room support — configure once, select per panel
- 🧩 Per-room grid layout (1–4 columns × 1–6 rows) with swipeable pages
- 🌡️ Climate control modal with target temperature and HVAC mode buttons
- 🎵 Full media player page (album art background, transport controls, volume, shuffle/repeat) plus Google Assistant voice commands and Spotify playlist tiles
- 🌦️ Weather tiles with inline forecast strip and a tap-to-open forecast modal
- 🔒 Lock tiles with color-coded locked/unlocked state
- 🗣️ Inter-room voice messages (record and broadcast audio between panels)
- 🌙 Screensaver with clock, date, temperature, and weather
- 🛠️ In-browser entity editor (icon picker, per-entity display options) — no JSON editing needed
- 🔗 URL params for permalinks, debug access, and standalone screensaver mode
- 🖌️ `custom.css` override file so you can restyle without touching the repo

## Quick Start

1. **First time setup** — build and start the container:
   ```bash
   touch custom.css   # required even if empty — see Customization
   docker-compose -f docker-compose.simple.yml up -d --build
   ```

   > **Important:** The container proxies requests to Home Assistant and needs the
   > `HA_URL` environment variable set in the compose file. It **must** include
   > the scheme (`http://` or `https://`), for example:
   > ```yaml
   > environment:
   >   - HA_URL=http://homeassistant.local:8123
   > ```
   > If `HA_URL` is missing or has no scheme, nginx fails to start with
   > `invalid URL prefix in /etc/nginx/nginx.conf`.

   Use `docker-compose.yml` instead if you're running behind a reverse proxy (nginx-proxy / Let's Encrypt labels included); use `docker-compose.simple.yml` for a standalone HTTP-only deployment.

2. **Access the dashboard**:
   - HTTP: `http://your-server-ip:8080`
   - HTTPS: `https://your-server-ip:8443` (only with `docker-compose.yml`; required for voice messages on most browsers)

3. **Configure**:
   - On first load you'll be prompted for your Home Assistant URL and a long-lived access token
   - Create a room, set its grid size, and add entities
   - Save — the room is now selectable from any panel pointed at this server

## Local Development (no Docker)

```bash
HA_URL=http://homeassistant.local:8123 node serve.js
```

`serve.js` is a self-contained Node server that serves the static files, proxies `/api/*` to Home Assistant, and implements the same config API the PHP backend provides (data is written to `./data/`). Defaults to port 8080; override with `PORT=...`.

## Editing the Dashboard Files

- `index.html` — markup, including the entity/room editor modals
- `styles.css` — all styling and the design-token `:root` block
- `app.js` — all client logic
- `api.php` / `serve.js` — server-side config storage (PHP for Docker, Node for local dev)

Thanks to the volume mounts in the compose files, you can edit `index.html`, `styles.css`, `app.js`, or `api.php` and just refresh the browser — no rebuild needed. You only need `docker-compose up -d --build` again if you change `Dockerfile`, `nginx.conf.template`, `docker-entrypoint.sh`, or the compose file itself.

## Storage

**All configuration is stored server-side** in the `simpledash-data` Docker volume (or `./data/` for local dev):

- `global_config.json` — Home Assistant URL/token, device model, font, header/screensaver settings
- `room_configs.json` — every room's layout and entities
- `active_room_*.txt` — which room each device last selected
- `voice_messages.json` — recorded inter-room voice messages

**Backup:**
```bash
docker cp simpledash:/data ./backup
```

**Restore:**
```bash
docker cp ./backup/. simpledash:/data
```

## Configuring Rooms & Entities

Open the editor by long-pressing (~2s) anywhere on the dashboard, or by visiting `?debug=true` (see [URL Parameters](#url-parameters)) for visible edit/settings buttons.

### Room Settings

- **Room name**
- **Grid columns/rows** — controls entities per page and tile sizing
- **Header temperature entity** — a `climate` or `sensor` shown in the header with quick controls
- **Screensaver weather entity** — room-specific weather shown on the screensaver
- **Entities** — add, edit, reorder, remove
- **Assistant commands** — custom voice command tiles (sent via `google_assistant_sdk` to the first media player in the room)
- **Spotify playlists** — tiles that start a given playlist on the room's media player

Leaving the room editor with unsaved changes prompts a confirmation before discarding.

### Supported Entity Domains

| Domain | Behavior |
|---|---|
| `light` | Toggle; swipe up/down on the tile to adjust brightness (unless dimming is disabled) |
| `switch`, `input_boolean`, `group`, `fan` | Toggle |
| `lock` | Toggle lock/unlock; red when locked, green when unlocked |
| `cover` | Toggle; swipe to set position if the entity supports it |
| `climate` | Opens a modal with current/target temperature and HVAC mode buttons |
| `scene`, `script`, `automation` | Trigger/activate |
| `sensor` | Read-only value with unit, optional fixed decimal places |
| `weather` | Current condition tile; tap opens a forecast modal; optional inline forecast strip |
| `media_player` | Tap to play/pause, transport buttons on the tile, full dedicated media page; long-press (800ms) for a Google Assistant voice command prompt |

### Per-Entity Options (entity editor)

- **Icon** — pick from a curated list or type any Material Symbol name
- **Hide state text** — suppress the state label under the icon
- **Disable action** — make the tile display-only (no tap/swipe interaction)
- **Disable dimming** (`light` only) — toggle-only, no brightness swipe
- **Decimals** (`sensor` only) — 0–3 fixed decimal places
- **Hide weather name / icon / forecast** (`weather` only)
- **Full-width row layout** (`weather` only) — icon-left, content-right instead of a square tile
- **Popup forecast type** (`weather` only) — daily or hourly periods in the tap-to-open forecast modal (default hourly)
- **Show inline forecast strip** (`weather` only) — adds a forecast row below the tile
- **Tile forecast type** (`weather` only) — daily or hourly periods in the inline strip (default daily)

### Global Settings

- Home Assistant URL & long-lived access token
- Device model — NSPanel Pro (480×480) or NSPanel Pro 120 (480×890)
- Font family — Inter, Roboto, Nunito, DM Sans, Outfit, or Poppins
- Header display — full / room name hidden / fully hidden
- Screensaver timeout (5–300s) and whether to disable the built-in screensaver (e.g. if you use Fully Kiosk's own screensaver instead)
- Hide voice messages — removes the phone/message button from the header

### Media Player Voice Commands

Long-press a media player tile to send a free-text command to Google Assistant:

- "Play jazz music"
- "Set volume to 50%"
- "Next song"

Requires the [Google Assistant SDK](https://www.home-assistant.io/integrations/google_assistant_sdk/) integration in Home Assistant (configured per-room via the **assistant entity** setting); falls back to TTS if unavailable.

### Voice Messages

Tap the phone icon in the header to record a short (max 30s) audio message and send it to another room, or broadcast to all rooms. Unread messages are highlighted and auto-play with a notification sound when you land on a room that has one waiting.

### Screensaver

- Activates after the configured timeout (default 10s) of inactivity
- Shows the time, date, room name, header temperature, and room weather
- Tap anywhere to dismiss
- `?screensaver=true` runs it standalone (no room required) — useful for a dedicated screensaver-only panel

## URL Parameters

| Param | Effect |
|---|---|
| `?room=RoomName` | Load a specific room directly |
| `?admin=rooms\|settings\|editor` | Open the editor straight to that view |
| `?mode=new\|edit&room=RoomName` | Open the room editor in a specific mode |
| `?debug=true` | Show persistent edit/settings buttons instead of relying on long-press |
| `?screensaver=true` | Standalone screensaver mode |

## Customization

### Theming with `custom.css`

Tokens are defined in `styles.css`'s `:root` block and re-declared (commented, as a starting point) in `custom.css.example`. To override any of them without touching the tracked files:

```bash
cp custom.css.example custom.css
```

`custom.css` is gitignored and loaded after `styles.css`, so anything you set there wins. It's required to exist for the Docker volume mount to work — an empty file is fine if you have nothing to override yet.

Available tokens:

```css
:root {
    --font-body: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif;

    --bg:            linear-gradient(135deg, #0f0f0f 0%, #1a1a1a 100%);
    --gradient-text: linear-gradient(135deg, #fff 0%, #aaa 100%);

    --tile-radius:     16px;
    --tile-padding:    16px;
    --tile-icon-size:  28px;
    --tile-label-size: 14px;
    --tile-state-size: 10px;

    --tile-on-bg:      linear-gradient(135deg, rgba(66, 165, 245, 0.15) 0%, rgba(33, 150, 243, 0.05) 100%);
    --tile-climate-bg: linear-gradient(135deg, rgba(33, 150, 243, 0.15) 0%, rgba(33, 150, 243, 0.05) 100%);
    --tile-heating-bg: linear-gradient(135deg, rgba(255, 87, 34, 0.2) 0%, rgba(255, 87, 34, 0.1) 100%);
    --tile-cooling-bg: linear-gradient(135deg, rgba(3, 169, 244, 0.2) 0%, rgba(3, 169, 244, 0.1) 100%);
    --tile-sensor-bg:  linear-gradient(135deg, rgba(156, 39, 176, 0.15) 0%, rgba(156, 39, 176, 0.05) 100%);
    --tile-spotify-bg: linear-gradient(135deg, rgba(30, 215, 96, 0.15) 0%, rgba(29, 185, 84, 0.05) 100%);
}
```

Font family can also be changed from Global Settings without touching CSS at all.

### Entities Per Page

Edit `app.js`:

```javascript
const ENTITIES_PER_PAGE = 4; // overridden per-room by grid columns × rows once a room is configured
```

## Fully Kiosk Browser Setup

For NSPanel devices running Fully Kiosk Browser:

### Basic Setup
1. Set URL to `https://your-server-ip:8443`
2. Enable kiosk mode

### SSL Certificate (Required for Voice Messages)
Since the dashboard uses a self-signed certificate, you need to configure Fully Kiosk to accept it:

1. **Open Fully Kiosk Settings** (3-finger tap or web interface at `http://panel-ip:2323`)
2. Go to **Settings** → **Web Content Settings** → **Advanced Web Settings**
3. Enable these options:
   - ✅ **Ignore SSL Errors**
   - ✅ **Allow Mixed Content**
4. **Restart Fully Kiosk**

### Voice Message Support (Optional)
To enable microphone access for voice messages:

1. In **Settings** → **Web Content Settings** → **Advanced Web Settings**
2. Enable:
   - ✅ **Allow Microphone Access**
   - ✅ **Enable getUserMedia**
   - ✅ **Allow Camera Access** (sometimes required)
3. **Restart Fully Kiosk**

**Note:** Some NSPanel hardware may not have an accessible microphone. In this case, you can still receive voice messages from other devices, but cannot record them on the panel.

## File Structure

```
.
├── index.html                  # HTML structure, including editor modals
├── styles.css                  # All CSS styles and design tokens
├── custom.css.example          # Starting point for custom.css overrides (custom.css itself is gitignored)
├── app.js                      # All client-side JavaScript
├── api.php                     # Server-side config API (Docker/nginx+PHP)
├── serve.js                    # Local dev server (Node, no Docker required)
├── docker-compose.yml          # Compose config with reverse-proxy/Let's Encrypt labels
├── docker-compose.simple.yml   # Standalone HTTP-only compose config
├── Dockerfile                  # Docker image definition (PHP-FPM + nginx)
├── nginx.conf.template         # Nginx config template (HA_URL substituted at startup)
└── docker-entrypoint.sh        # Container startup script
```

## Troubleshooting

### Dashboard not loading
- Check that the container is running: `docker ps`
- Check logs: `docker logs simpledash`

### Can't connect to Home Assistant
- Verify your HA URL is correct (include `http://` or `https://`)
- Check that your long-lived access token is valid
- Ensure nginx can reach your HA instance

### Changes not appearing
- Hard refresh your browser (Ctrl+F5)
- Check file permissions on mounted volumes
- Verify files are saved correctly

### custom.css not applying
- Make sure the file exists at the repo root (`touch custom.css` if empty) — the compose files mount it directly, and Docker will fail to start if the source path doesn't exist
- Hard refresh after editing

### Lost room configuration
- Room configs are stored server-side in `/data` inside the container
- Backup with: `docker cp simpledash:/data ./backup`
- Restore with: `docker cp ./backup/. simpledash:/data`
- Configs persist across browser sessions and devices

### Room not showing in the room list
- Make sure you saved the room after creating it
- Check the browser console for errors
- Try refreshing the page

## License

MIT
