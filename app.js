// ============================================
// CONFIGURATION - Edit these defaults
// ============================================
const DEFAULT_ROOM_CONFIG = {
    roomName: 'Living Room',
    headerTempEntity: '',
    entities: [
        { id: 'light.living_room', label: 'Living Room' },
        { id: 'scene.good_night', label: 'Good Night' },
        { id: 'switch.coffee_machine', label: 'Coffee' }
    ],
    assistantCommands: [],
    gridColumns: 2,
    gridRows: 2
};

const DEFAULT_GLOBAL_CONFIG = {
    haUrl: 'http://homeassistant.local:8123',
    haToken: '',
    assistantEntity: '', // Google Assistant SDK entity
    disableBuiltInScreensaver: false,
    screensaverTimeout: 10, // seconds
    screensaverTimeFormat: '24h', // '24h' or '12h'
    hideVoiceMessages: false,
    deviceModel: 'pro',
    fontFamily: 'Inter'
};

// Split entities into pages by simulating the grid's row-major auto-placement
// (mirrors CSS Grid's sparse packing), so tiles with a configured width/height
// other than 1x1 are accounted for and a page never overflows its reserved rows.
function paginateEntities(items, gridColumns, gridRows) {
    const maxRows = gridRows * 2; // physical row-tracks per page (half-height units)
    const pages = [];
    let page = [];
    let occupied = new Set();
    let cursorRow = 0;
    let cursorCol = 0;

    const fits = (row, col, colSpan, rowSpan) => {
        if (col + colSpan > gridColumns || row + rowSpan > maxRows) return false;
        for (let r = row; r < row + rowSpan; r++) {
            for (let c = col; c < col + colSpan; c++) {
                if (occupied.has(`${r},${c}`)) return false;
            }
        }
        return true;
    };

    const place = (row, col, colSpan, rowSpan) => {
        for (let r = row; r < row + rowSpan; r++) {
            for (let c = col; c < col + colSpan; c++) {
                occupied.add(`${r},${c}`);
            }
        }
    };

    const findSlot = (startRow, startCol, colSpan, rowSpan) => {
        let row = startRow, col = startCol;
        while (row < maxRows) {
            if (fits(row, col, colSpan, rowSpan)) return { row, col };
            col++;
            if (col >= gridColumns) { col = 0; row++; }
        }
        return null;
    };

    for (const item of items) {
        const colSpan = Math.min(item.tileColSpan || 1, gridColumns);
        const rowSpan = item.tileHeight === 'half' ? 1 : 2;

        let slot = findSlot(cursorRow, cursorCol, colSpan, rowSpan);
        if (!slot) {
            if (page.length) pages.push(page);
            page = [];
            occupied = new Set();
            slot = findSlot(0, 0, colSpan, rowSpan) || { row: 0, col: 0 };
        }

        place(slot.row, slot.col, colSpan, rowSpan);
        page.push(item);
        cursorRow = slot.row;
        cursorCol = slot.col + colSpan;
        if (cursorCol >= gridColumns) { cursorCol = 0; cursorRow++; }
    }

    if (page.length) pages.push(page);
    return pages;
}

// ============================================
// STATE MANAGEMENT
// ============================================
let config = null;
let globalConfig = null;
let roomConfigs = [];
let entityStates = {};
let pollInterval = null;
let isConnected = false;
let currentPage = 0;
let touchStartX = 0;
let touchEndX = 0;
let inactivityTimer = null;
let screensaverClockInterval = null;
let lastNowPlayingText = '';
let lastAlbumArtUrl = '';
let nowPlayingFlipInterval = null;
let nowPlayingCurrentLine = 0;
let isSliderDragging = false;
const forecastCache = {};
const WEATHER_ICONS = {
    'clear-night': 'nightlight',
    'cloudy': 'cloud',
    'fog': 'foggy',
    'hail': 'weather_hail',
    'lightning': 'thunderstorm',
    'lightning-rainy': 'thunderstorm',
    'partlycloudy': 'partly_cloudy_day',
    'pouring': 'rainy_heavy',
    'rainy': 'rainy',
    'snowy': 'weather_snowy',
    'snowy-rainy': 'weather_mix',
    'sunny': 'sunny',
    'windy': 'air',
    'windy-variant': 'air',
    'exceptional': 'warning'
};

const WEATHER_CONDITION_LABELS = {
    'clear-night': 'Clear',
    'cloudy': 'Cloudy',
    'fog': 'Fog',
    'hail': 'Hail',
    'lightning': 'Lightning',
    'lightning-rainy': 'Lightning, Rainy',
    'partlycloudy': 'Partly Cloudy',
    'pouring': 'Pouring',
    'rainy': 'Rainy',
    'snowy': 'Snowy',
    'snowy-rainy': 'Snowy, Rainy',
    'sunny': 'Sunny',
    'windy': 'Windy',
    'windy-variant': 'Windy',
    'exceptional': 'Exceptional'
};

// Format a Home Assistant weather condition string for display (e.g. "partlycloudy" -> "Partly Cloudy")
function formatWeatherCondition(state) {
    if (!state) return 'Unknown';
    return WEATHER_CONDITION_LABELS[state] || state
        .replace(/-/g, ' ')
        .replace(/([a-z])([A-Z])/g, '$1 $2')
        .replace(/\b\w/g, c => c.toUpperCase());
}

async function loadConfig() {
    try {
        // Get device-specific identifier (use IP or generate unique ID)
        const deviceId = getDeviceId();
        
        const response = await fetch(`/config-api.php?path=active_room&device=${encodeURIComponent(deviceId)}`);
        const data = await response.json();
        
        if (data.roomName) {
            const roomResponse = await fetch(`/config-api.php?path=room&name=${encodeURIComponent(data.roomName)}`);
            const roomData = await roomResponse.json();
            
            const global = await loadGlobalConfig();
            return { ...global, ...roomData };
        }
        return null;
    } catch (error) {
        console.error('Failed to load config:', error);
        return null;
    }
}

function getDeviceId() {
    // Try to get a stored device ID from localStorage
    let deviceId = localStorage.getItem('nspanel_device_id');
    
    if (!deviceId) {
        // Generate a unique ID for this device
        deviceId = 'nspanel_' + Math.random().toString(36).substring(2, 15);
        localStorage.setItem('nspanel_device_id', deviceId);
        console.log('Generated new device ID:', deviceId);
    }
    
    return deviceId;
}

async function loadGlobalConfig() {
    try {
        const response = await fetch('/config-api.php?path=global');
        return await response.json();
    } catch (error) {
        console.error('Failed to load global config:', error);
        return { ...DEFAULT_GLOBAL_CONFIG };
    }
}

async function loadRoomConfigs() {
    try {
        const response = await fetch('/config-api.php?path=rooms');
        return await response.json();
    } catch (error) {
        console.error('Failed to load room configs:', error);
        return [];
    }
}

async function saveConfig() {
    try {
        const deviceId = getDeviceId();
        
        // Save active room name for this device
        await fetch(`/config-api.php?path=active_room&device=${encodeURIComponent(deviceId)}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ roomName: config.roomName })
        });
        
        // Save room config
        const roomConfig = {
            roomName: config.roomName,
            headerTempEntity: config.headerTempEntity,
            screensaverWeather: config.screensaverWeather,
            gridColumns: config.gridColumns,
            gridRows: config.gridRows,
            entities: config.entities,
            assistantCommands: config.assistantCommands || [],
            spotifyPlaylists: config.spotifyPlaylists || []
        };
        
        await fetch(`/config-api.php?path=room&name=${encodeURIComponent(config.roomName)}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(roomConfig)
        });
    } catch (error) {
        console.error('Failed to save config:', error);
    }
}

async function saveGlobalConfig() {
    try {
        await fetch('/config-api.php?path=global', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(globalConfig)
        });
    } catch (error) {
        console.error('Failed to save global config:', error);
    }
}

async function saveRoomConfigs() {
    try {
        await fetch('/config-api.php?path=rooms', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(roomConfigs)
        });
    } catch (error) {
        console.error('Failed to save room configs:', error);
    }
}

// ============================================
// HOME ASSISTANT API
// ============================================
async function callHA(endpoint, method = 'GET', body = null) {
    if (!globalConfig.haToken) {
        throw new Error('No access token configured');
    }

    const options = {
        method,
        headers: {
            'Authorization': `Bearer ${globalConfig.haToken}`,
            'Content-Type': 'application/json'
        }
    };

    if (body) {
        options.body = JSON.stringify(body);
    }

    const response = await fetch(`/api/${endpoint}`, options);
    
    if (!response.ok) {
        const errorText = await response.text().catch(() => 'Unknown error');
        console.error(`HA API error ${response.status}:`, errorText);
        throw new Error(`HA API error: ${response.status}`);
    }

    return response.json();
}

async function getStates() {
    try {
        const states = await callHA('states');
        const stateMap = {};
        
        states.forEach(state => {
            stateMap[state.entity_id] = state;
        });

        entityStates = stateMap;
        updateConnectionStatus(true);
        return stateMap;
    } catch (error) {
        console.error('Failed to get states:', error);
        updateConnectionStatus(false);
        return null;
    }
}

async function callService(domain, service, entityId) {
    try {
        await callHA(`services/${domain}/${service}`, 'POST', {
            entity_id: entityId
        });
        setTimeout(() => getStates().then(renderPages), 100);
    } catch (error) {
        console.error('Service call failed:', error);
        showError('Failed to control device');
    }
}

// ============================================
// UI RENDERING
// ============================================
function renderPages() {
    document.getElementById('loadingOverlay').classList.add('hidden');
    const wrapper = document.getElementById('pagesWrapper');
    const dotsContainer = document.getElementById('pageDots');
    wrapper.innerHTML = '';
    dotsContainer.innerHTML = '';

    // Filter out media players from regular entities
    const regularEntities = config.entities.filter(e => !e.id.startsWith('media_player.'));
    const mediaPlayers = config.entities.filter(e => e.id.startsWith('media_player.'));
    
    // Add assistant command tiles to regular entities
    const assistantCommandTiles = (config.assistantCommands || []).map(cmd => ({
        id: `assistant_command.${cmd.label.toLowerCase().replace(/\s+/g, '_')}`,
        label: cmd.label,
        command: cmd.command
    }));
    
    // Add Spotify playlist tiles to regular entities
    const spotifyPlaylistTiles = (config.spotifyPlaylists || []).map(playlist => ({
        id: `spotify_playlist.${playlist.label.toLowerCase().replace(/\s+/g, '_')}`,
        label: playlist.label,
        playlistUrl: playlist.playlistUrl,
        icon: playlist.icon || 'queue_music'
    }));
    
    const allRegularItems = [...regularEntities, ...assistantCommandTiles, ...spotifyPlaylistTiles];

    // Set grid layout
    const gridColumns = config.gridColumns || 2;
    const gridRows = config.gridRows || 2;
    const regularPages = paginateEntities(allRegularItems, gridColumns, gridRows);
    const totalPages = regularPages.length;

    // Create regular entity pages
    for (let i = 0; i < totalPages; i++) {
        const page = document.createElement('div');
        page.className = 'page';
        
        // Add now playing indicator to first page
        if (i === 0) {
            const nowPlaying = document.createElement('div');
            nowPlaying.className = 'now-playing-header';
            nowPlaying.id = 'nowPlayingHeader';
            nowPlaying.onclick = goToMediaPage;
            nowPlaying.innerHTML = `
                <img class="album-mini" id="nowPlayingAlbum" src="" alt="">
                <span class="now-playing-text" id="nowPlayingText">Now Playing</span>
                <span class="playing-icon">graphic_eq</span>
            `;
            page.appendChild(nowPlaying);
        }
        
        const grid = document.createElement('div');
        grid.className = 'grid';
        grid.style.gridTemplateColumns = `repeat(${gridColumns}, 1fr)`;
        grid.style.gridTemplateRows = `repeat(${gridRows * 2}, 1fr)`;

        for (const entity of regularPages[i]) {
            const state = entityStates[entity.id];
            const tile = createTile(entity, state);
            applyTileSize(tile, entity);
            grid.appendChild(tile);
        }

        page.appendChild(grid);
        wrapper.appendChild(page);

        // Create dot
        const dot = document.createElement('div');
        dot.className = 'dot' + (i === currentPage ? ' active' : '');
        dot.onclick = () => goToPage(i);
        dotsContainer.appendChild(dot);
    }

    // Create media player page if there are any media players
    if (mediaPlayers.length > 0) {
        const mediaPage = createMediaPlayerPage(mediaPlayers);
        wrapper.appendChild(mediaPage);

        // Create media page dot
        const mediaDot = document.createElement('div');
        mediaDot.className = 'dot media-page' + (currentPage === totalPages ? ' active' : '');
        mediaDot.onclick = () => goToPage(totalPages);
        dotsContainer.appendChild(mediaDot);
    }

    document.getElementById('roomName').textContent = config.roomName;
    updateHeaderTemp();
    updateNowPlayingIndicator(mediaPlayers);
    updatePagePosition();
}

function createMediaPlayerPage(mediaPlayers) {
    const page = document.createElement('div');
    page.className = 'page media-player-page';

    // Use the first playing media player, or just the first one
    let activePlayer = mediaPlayers.find(mp => {
        const state = entityStates[mp.id];
        return state && state.state === 'playing';
    });

    if (!activePlayer && mediaPlayers.length > 0) {
        activePlayer = mediaPlayers[0];
    }

    if (activePlayer) {
        const state = entityStates[activePlayer.id];
        const isPlaying = state && state.state === 'playing';

        // Add blurred album art background with crossfade
        if (state && state.attributes.entity_picture) {
            const imageUrl = getMediaImageUrl(state.attributes.entity_picture);
            
            // Check if we need to crossfade
            const existingBg = document.querySelector('.media-player-page .media-album-art');
            if (existingBg && lastAlbumArtUrl && lastAlbumArtUrl !== imageUrl) {
                // Crossfade: fade out old, fade in new
                existingBg.classList.add('fading-out');
                
                const newBg = document.createElement('div');
                newBg.className = 'media-album-art fading-in';
                newBg.style.backgroundImage = `url('${imageUrl}')`;
                page.appendChild(newBg);
                
                // Trigger fade in after a brief delay
                setTimeout(() => {
                    newBg.classList.remove('fading-in');
                    newBg.classList.add('visible');
                }, 50);
                
                // Remove old background after fade completes
                setTimeout(() => {
                    if (existingBg.parentNode) {
                        existingBg.remove();
                    }
                }, 850);
            } else {
                // First load or same image
                const albumArtBg = document.createElement('div');
                albumArtBg.className = 'media-album-art visible';
                albumArtBg.style.backgroundImage = `url('${imageUrl}')`;
                page.appendChild(albumArtBg);
            }
            
            lastAlbumArtUrl = imageUrl;
        }

        // Album art
        if (state && state.attributes.entity_picture) {
            const albumArt = document.createElement('img');
            albumArt.className = 'album-art-large';
            albumArt.src = getMediaImageUrl(state.attributes.entity_picture);
            albumArt.onerror = () => {
                albumArt.style.display = 'none';
            };
            page.appendChild(albumArt);
        }

        // Track info
        const trackInfo = document.createElement('div');
        trackInfo.className = 'track-info';

        const trackTitle = document.createElement('div');
        trackTitle.className = 'track-title';
        trackTitle.textContent = state && state.attributes.media_title ? state.attributes.media_title : activePlayer.label;

        const trackArtist = document.createElement('div');
        trackArtist.className = 'track-artist';
        trackArtist.textContent = state && state.attributes.media_artist ? state.attributes.media_artist : '';

        // Speaker name
        const speakerName = document.createElement('div');
        speakerName.className = 'track-speaker';
        speakerName.textContent = activePlayer.label;
        trackInfo.insertBefore(speakerName, trackInfo.firstChild);

        trackInfo.appendChild(trackTitle);
        if (trackArtist.textContent) {
            trackInfo.appendChild(trackArtist);
        }
        page.appendChild(trackInfo);

        // Progress bar
        const progressContainer = document.createElement('div');
        progressContainer.className = 'media-progress';
        const progressBar = document.createElement('div');
        progressBar.className = 'media-progress-bar';
        const duration = state && state.attributes.media_duration || 0;
        
        // Calculate actual position based on when it was last updated
        let position = state && state.attributes.media_position || 0;
        if (isPlaying && state.attributes.media_position_updated_at) {
            const updatedAt = new Date(state.attributes.media_position_updated_at).getTime();
            const elapsed = (Date.now() - updatedAt) / 1000;
            position = Math.min(position + elapsed, duration);
        }
        
        const progressPercent = duration > 0 ? (position / duration) * 100 : 0;
        progressBar.style.width = `${progressPercent}%`;
        progressContainer.appendChild(progressBar);

        const progressTimes = document.createElement('div');
        progressTimes.className = 'media-progress-times';
        const formatTime = (s) => {
            const m = Math.floor(s / 60);
            const sec = Math.floor(s % 60);
            return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
        };
        const remaining = duration > 0 ? duration - position : 0;
        progressTimes.innerHTML = `<span>${formatTime(position)}</span><span>-${formatTime(remaining)}</span>`;
        
        page.appendChild(progressContainer);
        page.appendChild(progressTimes);

        // Live progress update timer
        if (isPlaying && duration > 0) {
            const startPosition = position;
            const startTime = Date.now();
            const progressTimer = setInterval(() => {
                const elapsed = (Date.now() - startTime) / 1000;
                const currentPos = Math.min(startPosition + elapsed, duration);
                const pct = (currentPos / duration) * 100;
                progressBar.style.width = `${pct}%`;
                const rem = duration - currentPos;
                const timeSpans = progressTimes.querySelectorAll('span');
                if (timeSpans.length === 2) {
                    timeSpans[0].textContent = formatTime(currentPos);
                    timeSpans[1].textContent = `-${formatTime(rem)}`;
                }
                if (currentPos >= duration) clearInterval(progressTimer);
            }, 1000);
            // Clean up when page is removed
            const observer = new MutationObserver(() => {
                if (!document.contains(progressBar)) {
                    clearInterval(progressTimer);
                    observer.disconnect();
                }
            });
            observer.observe(document.body, { childList: true, subtree: true });
        }

        // Controls with shuffle and repeat
        const controls = document.createElement('div');
        controls.className = 'media-controls';

        const isShuffle = state && state.attributes.shuffle === true;
        const repeatMode = state && state.attributes.repeat || 'off';

        const shuffleBtn = document.createElement('button');
        shuffleBtn.className = 'media-btn secondary' + (isShuffle ? ' active' : '');
        shuffleBtn.textContent = 'shuffle';
        shuffleBtn.onclick = (e) => {
            e.stopPropagation();
            callHA(`services/media_player/shuffle_set`, 'POST', {
                entity_id: activePlayer.id,
                shuffle: !isShuffle
            }).catch(err => console.error('Shuffle failed:', err));
            setTimeout(() => getStates().then(renderPages), 500);
        };

        const prevBtn = document.createElement('button');
        prevBtn.className = 'media-btn';
        prevBtn.textContent = 'skip_previous';
        prevBtn.onclick = (e) => {
            e.stopPropagation();
            callService('media_player', 'media_previous_track', activePlayer.id);
        };

        const playPauseBtn = document.createElement('button');
        playPauseBtn.className = 'media-btn play-pause';
        playPauseBtn.textContent = isPlaying ? 'pause' : 'play_arrow';
        playPauseBtn.onclick = async (e) => {
            e.stopPropagation();
            
            // Check if idle with no media - start Spotify
            const hasMedia = state && (state.attributes.media_title || state.attributes.media_content_id);
            if (!isPlaying && !hasMedia && state && (state.state === 'idle' || state.state === 'off')) {
                console.log('Sending "play music on spotify" command to', activePlayer.id);
                try {
                    await callHA('services/google_assistant_sdk/send_text_command', 'POST', {
                        command: 'play music on spotify',
                        media_player: activePlayer.id
                    });
                    console.log('Command sent successfully');
                    setTimeout(() => getStates().then(renderPages), 2000);
                } catch (err) {
                    console.error('Failed to start Spotify:', err);
                    showError('Failed to start Spotify');
                }
                return;
            }
            
            callService('media_player', 'media_play_pause', activePlayer.id);
            setTimeout(() => getStates().then(renderPages), 1500);
        };

        const nextBtn = document.createElement('button');
        nextBtn.className = 'media-btn';
        nextBtn.textContent = 'skip_next';
        nextBtn.onclick = (e) => {
            e.stopPropagation();
            callService('media_player', 'media_next_track', activePlayer.id);
        };

        const repeatBtn = document.createElement('button');
        repeatBtn.className = 'media-btn secondary' + (repeatMode !== 'off' ? ' active' : '');
        repeatBtn.textContent = repeatMode === 'one' ? 'repeat_one' : 'repeat';
        repeatBtn.onclick = (e) => {
            e.stopPropagation();
            const nextMode = repeatMode === 'off' ? 'all' : repeatMode === 'all' ? 'one' : 'off';
            callHA(`services/media_player/repeat_set`, 'POST', {
                entity_id: activePlayer.id,
                repeat: nextMode
            }).catch(err => console.error('Repeat failed:', err));
            setTimeout(() => getStates().then(renderPages), 500);
        };

        controls.appendChild(shuffleBtn);
        controls.appendChild(prevBtn);
        controls.appendChild(playPauseBtn);
        controls.appendChild(nextBtn);
        controls.appendChild(repeatBtn);
        page.appendChild(controls);

        // Volume slider
        const volumeContainer = document.createElement('div');
        volumeContainer.className = 'media-volume';
        const volumeIcon = document.createElement('span');
        volumeIcon.className = 'media-volume-icon';
        const volumeLevel = state && state.attributes.volume_level !== undefined ? state.attributes.volume_level : 0.5;
        volumeIcon.textContent = volumeLevel === 0 ? 'volume_off' : volumeLevel < 0.5 ? 'volume_down' : 'volume_up';
        
        const volumeTrack = document.createElement('div');
        volumeTrack.className = 'media-volume-track';
        const volumeBar = document.createElement('div');
        volumeBar.className = 'media-volume-bar';
        volumeBar.style.width = `${Math.round(volumeLevel * 100)}%`;
        volumeTrack.appendChild(volumeBar);

        // Volume drag handling
        let isDraggingVolume = false;
        const updateVolume = (e) => {
            const rect = volumeTrack.getBoundingClientRect();
            const touch = e.touches ? e.touches[0] : e;
            let pct = (touch.clientX - rect.left) / rect.width;
            pct = Math.max(0, Math.min(1, pct));
            volumeBar.style.width = `${Math.round(pct * 100)}%`;
            return pct;
        };
        volumeTrack.addEventListener('touchstart', (e) => {
            isDraggingVolume = true;
            updateVolume(e);
            e.preventDefault();
        }, { passive: false });
        volumeTrack.addEventListener('touchmove', (e) => {
            if (isDraggingVolume) { updateVolume(e); e.preventDefault(); }
        }, { passive: false });
        volumeTrack.addEventListener('touchend', (e) => {
            if (isDraggingVolume) {
                const rect = volumeTrack.getBoundingClientRect();
                const touch = e.changedTouches[0];
                let pct = (touch.clientX - rect.left) / rect.width;
                pct = Math.max(0, Math.min(1, pct));
                callHA(`services/media_player/volume_set`, 'POST', {
                    entity_id: activePlayer.id,
                    volume_level: Math.round(pct * 100) / 100
                }).catch(err => console.error('Volume failed:', err));
                setTimeout(() => getStates().then(renderPages), 500);
            }
            isDraggingVolume = false;
        });
        volumeTrack.addEventListener('click', (e) => {
            const pct = updateVolume(e);
            callHA(`services/media_player/volume_set`, 'POST', {
                entity_id: activePlayer.id,
                volume_level: Math.round(pct * 100) / 100
            }).catch(err => console.error('Volume failed:', err));
            setTimeout(() => getStates().then(renderPages), 500);
        });

        volumeContainer.appendChild(volumeIcon);
        volumeContainer.appendChild(volumeTrack);
        page.appendChild(volumeContainer);
    }

    return page;
}

function updateNowPlayingIndicator(mediaPlayers) {
    const indicator = document.getElementById('nowPlayingHeader');
    if (!indicator) return;
    
    const albumImg = document.getElementById('nowPlayingAlbum');
    const text = document.getElementById('nowPlayingText');
    
    if (!albumImg || !text) return; // Elements not ready yet

    // Find first playing media player
    const playingPlayer = mediaPlayers.find(mp => {
        const state = entityStates[mp.id];
        return state && state.state === 'playing';
    });

    if (playingPlayer) {
        const state = entityStates[playingPlayer.id];
        
        const title = state.attributes.media_title || playingPlayer.label;
        const artist = state.attributes.media_artist || '';
        const displayKey = `${title}|${artist}`;
        
        // Always update album art (since page recreation resets it)
        if (state.attributes.entity_picture) {
            const imageUrl = getMediaImageUrl(state.attributes.entity_picture);
            if (albumImg.src !== imageUrl) {
                albumImg.src = imageUrl;
            }
            albumImg.style.display = 'block';
            albumImg.onerror = () => {
                albumImg.style.display = 'none';
            };
        } else {
            albumImg.style.display = 'none';
        }
        
        // Check if text needs initialization (shows "Now Playing")
        const needsInit = text.textContent === 'Now Playing' || text.innerHTML === 'Now Playing';
        
        // Update text if content changed or needs initialization
        if (displayKey !== lastNowPlayingText || needsInit) {
            lastNowPlayingText = displayKey;
            
            // Stop existing flip interval
            if (nowPlayingFlipInterval) {
                clearInterval(nowPlayingFlipInterval);
            }
            
            // Setup fade animation if we have both title and artist
            if (artist) {
                text.innerHTML = `<span>${title}</span>`;
                
                // Check if text needs scrolling
                setTimeout(() => {
                    const span = text.querySelector('span');
                    if (span && span.scrollWidth > 140) {
                        span.classList.remove('no-scroll');
                    } else {
                        span.classList.add('no-scroll');
                    }
                }, 10);
                
                nowPlayingCurrentLine = 0;
                
                // Start flip interval - fade between title and artist
                nowPlayingFlipInterval = setInterval(() => {
                    const span = text.querySelector('span');
                    if (!span) return;
                    
                    // Fade out
                    span.style.opacity = '0';
                    
                    // After fade out, change text and fade in
                    setTimeout(() => {
                        if (nowPlayingCurrentLine === 0) {
                            span.textContent = artist;
                            nowPlayingCurrentLine = 1;
                        } else {
                            span.textContent = title;
                            nowPlayingCurrentLine = 0;
                        }
                        
                        // Check if new text needs scrolling
                        span.style.opacity = '1';
                        setTimeout(() => {
                            if (span.scrollWidth > 140) {
                                span.classList.remove('no-scroll');
                                // Restart animation
                                span.style.animation = 'none';
                                setTimeout(() => {
                                    span.style.animation = '';
                                }, 10);
                            } else {
                                span.classList.add('no-scroll');
                            }
                        }, 10);
                    }, 300);
                }, 8000); // Switch every 8 seconds (time for scroll animation)
            } else {
                text.innerHTML = `<span>${title}</span>`;
                
                // Check if text needs scrolling
                setTimeout(() => {
                    const span = text.querySelector('span');
                    if (span && span.scrollWidth > 140) {
                        span.classList.remove('no-scroll');
                    } else {
                        span.classList.add('no-scroll');
                    }
                }, 10);
            }
        }
        
        // Show indicator
        indicator.classList.add('show');
    } else {
        lastNowPlayingText = '';
        if (nowPlayingFlipInterval) {
            clearInterval(nowPlayingFlipInterval);
            nowPlayingFlipInterval = null;
        }
        indicator.classList.remove('show');
    }
}

function goToMediaPage() {
    const regularEntities = config.entities.filter(e => !e.id.startsWith('media_player.'));
    const assistantCommandTiles = (config.assistantCommands || []).map(cmd => ({
        id: `assistant_command.${cmd.label.toLowerCase().replace(/\s+/g, '_')}`,
        label: cmd.label,
        command: cmd.command
    }));
    const spotifyPlaylistTiles = (config.spotifyPlaylists || []).map(playlist => ({
        id: `spotify_playlist.${playlist.label.toLowerCase().replace(/\s+/g, '_')}`,
        label: playlist.label,
        playlistUrl: playlist.playlistUrl,
        icon: playlist.icon || 'queue_music'
    }));
    const allRegularItems = [...regularEntities, ...assistantCommandTiles, ...spotifyPlaylistTiles];
    const gridColumns = config.gridColumns || 2;
    const gridRows = config.gridRows || 2;
    const totalRegularPages = paginateEntities(allRegularItems, gridColumns, gridRows).length;
    goToPage(totalRegularPages);
}

function updateHeaderTemp() {
    const headerTemp = document.getElementById('headerTemp');
    const headerTempValue = document.getElementById('headerTempValue');

    if (!config.headerTempEntity) {
        headerTemp.style.display = 'none';
        return;
    }

    const state = entityStates[config.headerTempEntity];
    if (!state || state.state === 'unavailable') {
        headerTemp.style.display = 'none';
        return;
    }

    headerTemp.style.display = 'flex';
    const domain = config.headerTempEntity.split('.')[0];

    if (domain === 'climate') {
        const currentTemp = state.attributes.current_temperature;
        const targetTemp = state.attributes.temperature;
        const unit = state.attributes.unit_of_measurement || '°C';
        
        if (currentTemp !== undefined) {
            // Show current temp with decimal if it has one
            const displayCurrent = currentTemp % 1 === 0 ? Math.round(currentTemp) : currentTemp;
            
            // Only show target if it's different from current
            if (targetTemp !== undefined && targetTemp !== currentTemp) {
                const displayTarget = targetTemp % 1 === 0 ? Math.round(targetTemp) : targetTemp;
                headerTempValue.textContent = `${displayCurrent}${unit} → ${displayTarget}${unit}`;
            } else {
                headerTempValue.textContent = `${displayCurrent}${unit}`;
            }
        }
    } else if (domain === 'sensor') {
        const value = parseFloat(state.state);
        if (!isNaN(value)) {
            const unit = state.attributes.unit_of_measurement || '°C';
            const displayValue = value % 1 === 0 ? Math.round(value) : value;
            headerTempValue.textContent = `${displayValue}${unit}`;
        }
    }
}

function openHeaderClimateModal() {
    if (!config.headerTempEntity) return;
    
    const domain = config.headerTempEntity.split('.')[0];
    if (domain === 'climate') {
        openClimateModal(config.headerTempEntity);
    }
}

function applyTileSize(tile, entity) {
    if (entity.tileColSpan && entity.tileColSpan > 1) {
        tile.style.gridColumn = `span ${entity.tileColSpan}`;
    }
    if (entity.tileHeight === 'half') tile.classList.add('tile-half-height');
}

function createTile(entity, state) {
    const tile = document.createElement('div');
    tile.className = 'tile';

    const domain = entity.id.split('.')[0];
    
    // Handle assistant command tiles
    if (domain === 'assistant_command') {
        return createAssistantCommandTile(entity);
    }
    
    // Handle Spotify playlist tiles
    if (domain === 'spotify_playlist') {
        return createSpotifyPlaylistTile(entity);
    }

    // Handle clock tiles
    if (domain === 'clock') {
        return createClockTile(entity);
    }

    // Handle different entity types
    if (domain === 'climate') {
        return createClimateTile(entity, state);
    } else if (domain === 'sensor' && state && state.attributes.unit_of_measurement) {
        return createSensorTile(entity, state);
    } else if (domain === 'media_player') {
        return createMediaPlayerTile(entity, state);
    } else if (domain === 'light' && state && state.attributes.supported_color_modes) {
        return createLightTile(entity, state);
    } else if (domain === 'weather') {
        return createWeatherTile(entity, state);
    } else if (domain === 'cover') {
        return createCoverTile(entity, state);
    }

    const stateValue = state ? state.state : null;
    const isOn = stateValue === 'on' || stateValue === 'playing' || stateValue === 'unlocked';
    const isUnavailable = !state || stateValue === 'unavailable';

    tile.classList.add(domain);
    if (isOn) {
        tile.classList.add('on');
    }

    if (isUnavailable) {
        tile.classList.add('unavailable');
    } else if (entity.disableAction) {
        tile.classList.add('no-action');
    }

    // Add icon
    const icon = document.createElement('div');
    icon.className = 'tile-icon';
    icon.textContent = entity.icon || getEntityIcon(domain, entity.id);

    // Add content wrapper
    const content = document.createElement('div');
    content.className = 'tile-content';

    const label = document.createElement('div');
    label.className = 'tile-label';
    label.textContent = entity.label;

    content.appendChild(label);
    
    // Only add state text if hideState is not true
    if (!entity.hideState) {
        const stateText = document.createElement('div');
        stateText.className = 'tile-state';
        stateText.textContent = stateValue ? stateValue.toUpperCase() : 'UNKNOWN';
        content.appendChild(stateText);
    }

    tile.appendChild(icon);
    tile.appendChild(content);

    if (!isUnavailable && !entity.disableAction) {
        tile.onclick = () => handleTileClick(entity.id, domain);
    }

    return tile;
}

function createAssistantCommandTile(entity) {
    const tile = document.createElement('div');
    tile.className = 'tile assistant-command';

    // Add icon - Google Assistant icon
    const icon = document.createElement('div');
    icon.className = 'tile-icon';
    icon.textContent = 'assistant';

    // Add content wrapper
    const content = document.createElement('div');
    content.className = 'tile-content';

    const label = document.createElement('div');
    label.className = 'tile-label';
    label.textContent = entity.label;

    content.appendChild(label);

    tile.appendChild(icon);
    tile.appendChild(content);

    tile.onclick = () => sendAssistantCommand(entity.command);

    return tile;
}

function createSpotifyPlaylistTile(entity) {
    const tile = document.createElement('div');
    tile.className = 'tile spotify-playlist';

    // Add icon - Spotify playlist icon
    const icon = document.createElement('div');
    icon.className = 'tile-icon';
    icon.textContent = entity.icon || 'queue_music';

    // Add content wrapper
    const content = document.createElement('div');
    content.className = 'tile-content';

    const label = document.createElement('div');
    label.className = 'tile-label';
    label.textContent = entity.label;

    content.appendChild(label);

    tile.appendChild(icon);
    tile.appendChild(content);

    tile.onclick = () => playSpotifyPlaylistOnRoomDevice(entity.playlistUrl);

    return tile;
}

function createClockTile(entity) {
    const tile = document.createElement('div');
    tile.className = 'tile clock no-tap';

    const now = new Date();

    const timeDisplay = document.createElement('div');
    timeDisplay.className = 'clock-time';
    timeDisplay.textContent = formatClockTime(now, entity.clockTimeFormat);
    tile.appendChild(timeDisplay);

    if (!entity.hideClockDate) {
        const dateDisplay = document.createElement('div');
        dateDisplay.className = 'clock-date';
        dateDisplay.textContent = now.toLocaleDateString('en', { weekday: 'short', month: 'short', day: 'numeric' });
        tile.appendChild(dateDisplay);
    }

    return tile;
}

async function playSpotifyPlaylistOnRoomDevice(playlistUrl) {
    // Find media players in this room
    const mediaPlayers = config.entities.filter(e => e.id.startsWith('media_player.'));
    
    if (mediaPlayers.length === 0) {
        showError('No media player configured in this room.');
        return;
    }

    // Find Spotify entity and Cast/other devices
    const spotifyEntity = mediaPlayers.find(mp => mp.id.includes('spotify'));
    const castDevices = mediaPlayers.filter(mp => !mp.id.includes('spotify'));
    const targetDevice = castDevices.length > 0 ? castDevices[0] : mediaPlayers[0];
    
    console.log('Playing Spotify playlist:', {
        playlistUrl,
        spotifyEntity: spotifyEntity?.id,
        targetDevice: targetDevice.id,
        targetLabel: targetDevice.label
    });

    try {
        // Convert URL to Spotify URI if needed
        let contentId = playlistUrl;
        if (playlistUrl.includes('open.spotify.com')) {
            const match = playlistUrl.match(/playlist\/([a-zA-Z0-9]+)/);
            if (match) {
                contentId = `spotify:playlist:${match[1]}`;
                console.log('Converted URL to URI:', contentId);
            }
        }
        
        // If target is a Spotify entity, play directly
        if (targetDevice.id.includes('spotify')) {
            const payload = {
                entity_id: targetDevice.id,
                media_content_type: 'playlist',
                media_content_id: contentId
            };
            
            console.log('Playing directly on Spotify entity:', payload);
            await callHA('services/media_player/play_media', 'POST', payload);
            showError(`Playing on ${targetDevice.label}...`);
            setTimeout(() => getStates().then(renderPages), 2000);
            return;
        }
        
        // For Cast devices, use direct play_media with music type
        console.log('Playing on Cast device with music type...');
        const payload = {
            entity_id: targetDevice.id,
            media_content_type: 'music',
            media_content_id: contentId
        };
        
        console.log('Payload:', payload);
        await callHA('services/media_player/play_media', 'POST', payload);
        showError(`Playing on ${targetDevice.label}...`);
        setTimeout(() => getStates().then(renderPages), 2000);
        
    } catch (error) {
        console.error('Failed to play Spotify playlist:', error);
        showError(`Failed: ${error.message || 'Check Spotify integration'}`);
    }
}

async function sendAssistantCommand(command) {
    // Find the first media player in this room
    const mediaPlayers = config.entities.filter(e => e.id.startsWith('media_player.'));
    
    if (mediaPlayers.length === 0) {
        showError('No media player configured in this room.');
        return;
    }

    const targetMediaPlayer = mediaPlayers[0].id;

    try {
        // Use Google Assistant SDK send_text_command service
        await callHA('services/google_assistant_sdk/send_text_command', 'POST', {
            command: command,
            media_player: targetMediaPlayer
        });
        
        showError(`Sent to ${mediaPlayers[0].label}: "${command}"`);
        setTimeout(() => getStates().then(renderPages), 1000);
    } catch (error) {
        console.error('Failed to send assistant command:', error);
        showError(`Failed: ${error.message || 'Check Google Assistant SDK integration'}`);
    }
}

function createLightTile(entity, state) {
    const tile = document.createElement('div');
    tile.className = 'tile light';

    const stateValue = state ? state.state : null;
    const isOn = stateValue === 'on';
    const isUnavailable = !state || stateValue === 'unavailable';
    const isDimmable = !entity.disableDimming && !entity.disableAction &&
        state.attributes.supported_color_modes &&
        state.attributes.supported_color_modes.some(mode => mode !== 'onoff');

    if (isOn) {
        tile.classList.add('on');
    }

    if (isUnavailable) {
        tile.classList.add('unavailable');
    } else if (entity.disableAction) {
        tile.classList.add('no-action');
    }

    if (isDimmable && !isUnavailable) {
        tile.classList.add('has-slider');
    }

    // Add icon
    const icon = document.createElement('div');
    icon.className = 'tile-icon';
    icon.textContent = entity.icon || 'lightbulb';

    // Add content wrapper
    const content = document.createElement('div');
    content.className = 'tile-content';

    const label = document.createElement('div');
    label.className = 'tile-label';
    label.textContent = entity.label;

    const stateText = document.createElement('div');
    stateText.className = 'tile-state';
    
    if (isOn && state.attributes.brightness !== undefined) {
        const brightnessPercent = Math.round((state.attributes.brightness / 255) * 100);
        stateText.textContent = `${brightnessPercent}%`;
    } else {
        stateText.textContent = stateValue ? stateValue.toUpperCase() : 'UNKNOWN';
    }

    content.appendChild(label);
    content.appendChild(stateText);

    tile.appendChild(icon);
    tile.appendChild(content);

    // Add brightness progress bar for dimmable lights
    if (isDimmable && !isUnavailable) {
        const progressContainer = document.createElement('div');
        progressContainer.className = 'brightness-slider-container';
        
        const progressBar = document.createElement('div');
        progressBar.className = 'brightness-progress';
        const currentPercent = isOn && state.attributes.brightness !== undefined 
            ? Math.round((state.attributes.brightness / 255) * 100) 
            : 0;
        progressBar.style.height = `${currentPercent}%`;
        
        progressContainer.appendChild(progressBar);
        tile.appendChild(progressContainer);

        // Swipe gesture handling for brightness (vertical)
        let swipeStartY = 0;
        let swipeStartBrightness = 0;
        let isSwiping = false;

        tile.addEventListener('touchstart', (e) => {
            swipeStartY = e.touches[0].clientY;
            swipeStartBrightness = isOn && state.attributes.brightness !== undefined 
                ? state.attributes.brightness 
                : 0;
            isSwiping = false;
            isSliderDragging = true;
        }, { passive: true });

        tile.addEventListener('touchmove', (e) => {
            const deltaY = e.touches[0].clientY - swipeStartY;
            
            // If moved more than 10px, it's a swipe
            if (Math.abs(deltaY) > 10) {
                isSwiping = true;
                e.preventDefault();
                
                // Calculate new brightness based on swipe distance (inverted: up = brighter)
                // Tile height is ~100px, so full swipe = 100% brightness change
                const tileHeight = tile.offsetHeight;
                const brightnessChange = -(deltaY / tileHeight) * 255;
                let newBrightness = Math.round(swipeStartBrightness + brightnessChange);
                newBrightness = Math.max(0, Math.min(255, newBrightness));
                
                // Update visual feedback
                const percent = Math.round((newBrightness / 255) * 100);
                stateText.textContent = `${percent}%`;
                progressBar.style.height = `${percent}%`;
            }
        }, { passive: false });

        tile.addEventListener('touchend', (e) => {
            if (isSwiping) {
                const deltaY = e.changedTouches[0].clientY - swipeStartY;
                const tileHeight = tile.offsetHeight;
                const brightnessChange = -(deltaY / tileHeight) * 255;
                let newBrightness = Math.round(swipeStartBrightness + brightnessChange);
                newBrightness = Math.max(0, Math.min(255, newBrightness));

                setBrightness(entity.id, newBrightness);
                e.preventDefault(); // block synthetic click after a swipe
            }

            isSliderDragging = false;
            isSwiping = false;
        }, { passive: false });

        tile.onclick = () => handleTileClick(entity.id, 'light');
    } else if (!isUnavailable && !entity.disableAction) {
        tile.onclick = () => handleTileClick(entity.id, 'light');
    }

    return tile;
}

async function setBrightness(entityId, brightness) {
    try {
        if (brightness === 0) {
            await callHA('services/light/turn_off', 'POST', {
                entity_id: entityId
            });
        } else {
            await callHA('services/light/turn_on', 'POST', {
                entity_id: entityId,
                brightness: brightness
            });
        }
        setTimeout(() => getStates().then(renderPages), 100);
    } catch (error) {
        console.error('Failed to set brightness:', error);
        showError('Failed to set brightness');
    }
}

function createCoverTile(entity, state) {
    const tile = document.createElement('div');
    tile.className = 'tile cover';

    const stateValue = state ? state.state : null;
    const isOpen = stateValue === 'open';
    const isUnavailable = !state || stateValue === 'unavailable';
    const supportsPosition = state && state.attributes.current_position !== undefined;

    if (isOpen) {
        tile.classList.add('on');
    }

    if (isUnavailable) {
        tile.classList.add('unavailable');
    } else if (entity.disableAction) {
        tile.classList.add('no-action');
    }

    if (supportsPosition && !isUnavailable && !entity.disableAction) {
        tile.classList.add('has-slider');
    }

    // Add icon
    const icon = document.createElement('div');
    icon.className = 'tile-icon';
    icon.textContent = entity.icon || 'blinds';

    // Add content wrapper
    const content = document.createElement('div');
    content.className = 'tile-content';

    const label = document.createElement('div');
    label.className = 'tile-label';
    label.textContent = entity.label;

    const stateText = document.createElement('div');
    stateText.className = 'tile-state';
    
    if (!entity.hideState) {
        if (supportsPosition && state.attributes.current_position !== undefined) {
            const position = Math.round(state.attributes.current_position);
            stateText.textContent = `${position}%`;
        } else {
            stateText.textContent = stateValue ? stateValue.toUpperCase() : 'UNKNOWN';
        }
        content.appendChild(stateText);
    }

    content.insertBefore(label, content.firstChild);

    tile.appendChild(icon);
    tile.appendChild(content);

    // Add position progress bar for covers with position support
    if (supportsPosition && !isUnavailable && !entity.disableAction) {
        const progressContainer = document.createElement('div');
        progressContainer.className = 'brightness-slider-container';
        
        const progressBar = document.createElement('div');
        progressBar.className = 'brightness-progress';
        const currentPercent = state.attributes.current_position !== undefined 
            ? Math.round(state.attributes.current_position) 
            : 0;
        progressBar.style.height = `${currentPercent}%`;
        
        progressContainer.appendChild(progressBar);
        tile.appendChild(progressContainer);

        // Swipe gesture handling for position
        let swipeStartX = 0;
        // Swipe gesture handling for position (vertical)
        let swipeStartY = 0;
        let swipeStartPosition = 0;
        let isSwiping = false;

        tile.addEventListener('touchstart', (e) => {
            swipeStartY = e.touches[0].clientY;
            swipeStartPosition = state.attributes.current_position !== undefined 
                ? state.attributes.current_position 
                : 0;
            isSwiping = false;
            isSliderDragging = true;
        }, { passive: true });

        tile.addEventListener('touchmove', (e) => {
            const deltaY = e.touches[0].clientY - swipeStartY;
            
            // If moved more than 10px, it's a swipe
            if (Math.abs(deltaY) > 10) {
                isSwiping = true;
                e.preventDefault();
                
                // Calculate new position based on swipe distance (inverted: up = open)
                const tileHeight = tile.offsetHeight;
                const positionChange = -(deltaY / tileHeight) * 100;
                let newPosition = Math.round(swipeStartPosition + positionChange);
                newPosition = Math.max(0, Math.min(100, newPosition));
                
                // Update visual feedback
                stateText.textContent = `${newPosition}%`;
                progressBar.style.height = `${newPosition}%`;
            }
        }, { passive: false });

        tile.addEventListener('touchend', (e) => {
            if (isSwiping) {
                const deltaY = e.changedTouches[0].clientY - swipeStartY;
                const tileHeight = tile.offsetHeight;
                const positionChange = -(deltaY / tileHeight) * 100;
                let newPosition = Math.round(swipeStartPosition + positionChange);
                newPosition = Math.max(0, Math.min(100, newPosition));

                setCoverPosition(entity.id, newPosition);
                e.preventDefault(); // block synthetic click after a swipe
            }

            isSliderDragging = false;
            isSwiping = false;
        }, { passive: false });

        tile.onclick = () => handleTileClick(entity.id, 'cover');
    } else if (!isUnavailable && !entity.disableAction) {
        tile.onclick = () => handleTileClick(entity.id, 'cover');
    }

    return tile;
}

async function setCoverPosition(entityId, position) {
    try {
        await callHA('services/cover/set_cover_position', 'POST', {
            entity_id: entityId,
            position: position
        });
        setTimeout(() => getStates().then(renderPages), 100);
    } catch (error) {
        console.error('Failed to set cover position:', error);
        showError('Failed to set cover position');
    }
}

function getEntityIcon(domain, entityId) {
    // Map domains to Material Symbols icons
    const iconMap = {
        'light': 'lightbulb',
        'switch': 'power_settings_new',
        'scene': 'palette',
        'script': 'play_circle',
        'media_player': 'play_circle',
        'fan': 'mode_fan',
        'cover': 'blinds',
        'lock': 'lock',
        'climate': 'thermostat',
        'sensor': 'sensors',
        'group': 'workspaces',
        'input_boolean': 'toggle_on',
        'automation': 'settings_suggest',
        'weather': 'partly_cloudy_day'
    };

    return iconMap[domain] || 'toggle_on';
}

function createClimateTile(entity, state) {
    const tile = document.createElement('div');
    tile.className = 'tile climate';

    const isUnavailable = !state || state.state === 'unavailable';
    
    if (state && state.state === 'heat') {
        tile.classList.add('heating');
    } else if (state && state.state === 'cool') {
        tile.classList.add('cooling');
    }

    if (isUnavailable) {
        tile.classList.add('unavailable');
    } else if (entity.disableAction) {
        tile.classList.add('no-action');
    }

    const label = document.createElement('div');
    label.className = 'tile-label';
    label.textContent = entity.label;

    const tempDisplay = document.createElement('div');
    tempDisplay.className = 'temp-display';

    if (state && state.attributes.current_temperature !== undefined) {
        const currentTemp = Math.round(state.attributes.current_temperature);
        const targetTemp = state.attributes.temperature ? Math.round(state.attributes.temperature) : null;
        const unit = state.attributes.unit_of_measurement || '°C';
        
        tempDisplay.innerHTML = `${currentTemp}<span class="temp-unit">${unit}</span>`;
        
        tile.appendChild(label);
        tile.appendChild(tempDisplay);

        if (targetTemp && targetTemp !== currentTemp) {
            const modeText = document.createElement('div');
            modeText.className = 'climate-mode';
            modeText.textContent = `Target: ${targetTemp}${unit}`;
            tile.appendChild(modeText);
        }
    } else {
        tempDisplay.textContent = '—';
        tile.appendChild(label);
        tile.appendChild(tempDisplay);
    }

    // Open climate modal on click
    if (!isUnavailable && !entity.disableAction) {
        tile.onclick = () => openClimateModal(entity.id);
    }

    return tile;
}

function createSensorTile(entity, state) {
    const tile = document.createElement('div');
    tile.className = 'tile sensor no-tap';

    const isUnavailable = !state || state.state === 'unavailable';
    
    if (isUnavailable) {
        tile.classList.add('unavailable');
    }

    const label = document.createElement('div');
    label.className = 'tile-label';
    label.textContent = entity.label;

    const tempDisplay = document.createElement('div');
    tempDisplay.className = 'temp-display';
    
    if (state && state.state !== 'unavailable' && state.state !== 'unknown') {
        const value = parseFloat(state.state);
        const decimals = entity.decimals !== undefined ? entity.decimals : 0;
        const displayValue = isNaN(value) ? state.state : value.toFixed(decimals);
        const unit = state.attributes.unit_of_measurement || '';

        tempDisplay.innerHTML = `${displayValue}<span class="temp-unit">${unit}</span>`;
    } else {
        tempDisplay.textContent = '—';
    }

    tile.appendChild(label);
    tile.appendChild(tempDisplay);

    return tile;
}

function createWeatherTile(entity, state) {
    const tile = document.createElement('div');
    tile.className = 'tile weather';

    const isUnavailable = !state || state.state === 'unavailable';
    if (isUnavailable) tile.classList.add('unavailable');
    if (entity.tileColSpan > 1) tile.classList.add('full-row');

    if (!entity.hideWeatherIcon) {
        const icon = document.createElement('div');
        icon.className = 'tile-icon weather-icon';
        icon.textContent = WEATHER_ICONS[state?.state] || 'cloud';
        tile.appendChild(icon);
    }

    const content = document.createElement('div');
    content.className = 'tile-content';

    if (!entity.hideWeatherName) {
        const label = document.createElement('div');
        label.className = 'tile-label';
        label.textContent = entity.label;
        content.appendChild(label);
    }

    const tempDisplay = document.createElement('div');
    tempDisplay.className = 'weather-temp';
    if (state && state.attributes.temperature !== undefined) {
        const temp = Math.round(state.attributes.temperature);
        const unit = state.attributes.temperature_unit || '°C';
        tempDisplay.textContent = `${temp}${unit}`;
    } else {
        tempDisplay.textContent = '—';
    }

    const condition = document.createElement('div');
    condition.className = 'weather-condition';
    condition.textContent = state?.state ? formatWeatherCondition(state.state).toUpperCase() : 'UNKNOWN';

    content.appendChild(tempDisplay);
    content.appendChild(condition);
    tile.appendChild(content);

    if (entity.showInlineForecast && entity.tileHeight !== 'half') {
        tile.dataset.entityId = entity.id;
        const tileForecastType = entity.tileForecastType || 'daily';
        const cached = forecastCache[entity.id];
        if (cached?.type === tileForecastType && cached.data.length > 0) {
            renderInlineForecastStrip(tile, cached.data, tileForecastType);
        } else {
            fetchInlineForecast(entity.id, tileForecastType);
        }
    }

    if (!isUnavailable && !entity.hideWeatherForecast && !entity.disableAction) {
        tile.onclick = () => openWeatherForecast(entity.id);
        tile.style.cursor = 'pointer';
    } else if (!isUnavailable && entity.disableAction) {
        tile.classList.add('no-action');
    }

    return tile;
}

function createMediaPlayerTile(entity, state) {
    const tile = document.createElement('div');
    tile.className = 'tile media_player';

    const isUnavailable = !state || state.state === 'unavailable';
    const isPlaying = state && (state.state === 'playing');
    
    if (isPlaying) {
        tile.classList.add('playing');
    }

    if (isUnavailable) {
        tile.classList.add('unavailable');
    } else if (entity.disableAction) {
        tile.classList.add('no-action');
    }

    // Add album art background if available
    if (state && state.attributes.entity_picture) {
        const albumArtBg = document.createElement('div');
        albumArtBg.className = 'media-album-art';
        const imageUrl = getMediaImageUrl(state.attributes.entity_picture);
        albumArtBg.style.backgroundImage = `url('${imageUrl}')`;
        tile.appendChild(albumArtBg);
    }

    // Add album art thumbnail if available
    if (state && state.attributes.entity_picture) {
        const albumThumb = document.createElement('img');
        albumThumb.className = 'media-album-thumb';
        albumThumb.src = getMediaImageUrl(state.attributes.entity_picture);
        albumThumb.onerror = () => {
            albumThumb.style.display = 'none';
            // Show icon as fallback
            const icon = document.createElement('div');
            icon.className = 'tile-icon';
            icon.textContent = isPlaying ? 'play_circle' : 'speaker';
            tile.insertBefore(icon, tile.firstChild.nextSibling);
        };
        tile.appendChild(albumThumb);
    } else {
        // Add icon if no album art
        const icon = document.createElement('div');
        icon.className = 'tile-icon';
        icon.textContent = isPlaying ? 'play_circle' : 'speaker';
        tile.appendChild(icon);
    }

    // Add content wrapper
    const content = document.createElement('div');
    content.className = 'tile-content';

    const label = document.createElement('div');
    label.className = 'tile-label';
    label.textContent = entity.label;

    const stateText = document.createElement('div');
    stateText.className = 'tile-state';
    stateText.textContent = state ? state.state : 'Unknown';

    content.appendChild(label);
    content.appendChild(stateText);

    // Show media info if playing
    if (isPlaying && state.attributes.media_title) {
        const mediaInfo = document.createElement('div');
        mediaInfo.className = 'media-info';
        const artist = state.attributes.media_artist ? `${state.attributes.media_artist}` : '';
        mediaInfo.textContent = artist || state.attributes.media_title;
        content.appendChild(mediaInfo);
    }

    tile.appendChild(content);

    // Add media controls
    if (!isUnavailable && !entity.disableAction) {
        const controls = document.createElement('div');
        controls.className = 'media-controls';

        const prevBtn = document.createElement('button');
        prevBtn.className = 'media-btn';
        prevBtn.textContent = 'skip_previous';
        prevBtn.onclick = (e) => {
            e.stopPropagation();
            callService('media_player', 'media_previous_track', entity.id);
        };

        const playPauseBtn = document.createElement('button');
        playPauseBtn.className = 'media-btn play-pause';
        playPauseBtn.textContent = isPlaying ? 'pause' : 'play_arrow';
        playPauseBtn.onclick = (e) => {
            e.stopPropagation();
            callService('media_player', 'media_play_pause', entity.id);
        };

        const nextBtn = document.createElement('button');
        nextBtn.className = 'media-btn';
        nextBtn.textContent = 'skip_next';
        nextBtn.onclick = (e) => {
            e.stopPropagation();
            callService('media_player', 'media_next_track', entity.id);
        };

        controls.appendChild(prevBtn);
        controls.appendChild(playPauseBtn);
        controls.appendChild(nextBtn);
        tile.appendChild(controls);

        // Click to go to media page
        tile.onclick = () => goToMediaPage();
    }

    return tile;
}

function getMediaImageUrl(entityPicture) {
    // Check if it's already a full URL (starts with http:// or https://)
    if (entityPicture.startsWith('http://') || entityPicture.startsWith('https://')) {
        return entityPicture;
    }
    // Otherwise, prepend the HA URL
    return `${globalConfig.haUrl}${entityPicture}`;
}

async function playSpotifyPlaylist(entityId, playlistUrl) {
    try {
        await callHA('services/media_player/play_media', 'POST', {
            entity_id: entityId,
            media_content_type: 'playlist',
            media_content_id: playlistUrl
        });
        showError('Playing Spotify playlist...');
        setTimeout(() => getStates().then(renderPages), 1500);
    } catch (error) {
        console.error('Failed to play Spotify playlist:', error);
        showError('Failed to play playlist. Make sure Spotify is configured.');
    }
}

async function adjustTemperature(entityId, delta) {
    const state = entityStates[entityId];
    if (!state || !state.attributes.temperature) return;
    
    // Verify this is a climate entity
    const domain = entityId.split('.')[0];
    if (domain !== 'climate') {
        console.error('adjustTemperature called on non-climate entity:', entityId);
        return;
    }

    const currentTemp = state.attributes.temperature;
    const targetTempStep = state.attributes.target_temp_step || 0.5; // Default to 0.5 degree steps
    const newTemp = currentTemp + (delta * targetTempStep); // Increment by step size
    const minTemp = state.attributes.min_temp || 10;
    const maxTemp = state.attributes.max_temp || 30;

    if (newTemp >= minTemp && newTemp <= maxTemp) {
        try {
            await callHA('services/climate/set_temperature', 'POST', {
                entity_id: entityId,
                temperature: newTemp
            });
            setTimeout(() => getStates().then(renderPages), 100);
        } catch (error) {
            console.error('Failed to set temperature:', error);
            showError('Failed to set temperature');
        }
    }
}

function handleTileClick(entityId, domain) {
    let service;

    switch (domain) {
        case 'light':
            service = 'toggle';
            break;
        case 'switch':
            service = 'toggle';
            break;
        case 'scene':
            service = 'turn_on';
            break;
        case 'script':
            service = 'turn_on';
            break;
        case 'media_player':
            service = 'media_play_pause';
            break;
        case 'fan':
            service = 'toggle';
            break;
        case 'cover':
            service = 'toggle';
            break;
        case 'lock':
            service = entityStates[entityId]?.state === 'locked' ? 'unlock' : 'lock';
            break;
        case 'group':
            // Groups use homeassistant domain for toggle
            callService('homeassistant', 'toggle', entityId);
            return;
        case 'input_boolean':
            service = 'toggle';
            break;
        case 'automation':
            service = 'trigger';
            break;
        default:
            service = 'toggle';
    }

    callService(domain, service, entityId);
}

function updateConnectionStatus(connected) {
    isConnected = connected;
    const indicator = document.getElementById('statusIndicator');
    indicator.className = 'status-indicator ' + (connected ? 'connected' : 'error');
}

function showError(message) {
    const errorDiv = document.getElementById('errorToast');
    if (!errorDiv) {
        console.log(message);
        return;
    }
    errorDiv.textContent = message;
    errorDiv.classList.add('show');
    setTimeout(() => errorDiv.classList.remove('show'), 3000);
}

// ============================================
// PAGE NAVIGATION
// ============================================
function goToPage(pageIndex) {
    const regularEntities = config.entities.filter(e => !e.id.startsWith('media_player.'));
    const mediaPlayers = config.entities.filter(e => e.id.startsWith('media_player.'));
    const assistantCommandTiles = (config.assistantCommands || []).map(cmd => ({
        id: `assistant_command.${cmd.label.toLowerCase().replace(/\s+/g, '_')}`,
        label: cmd.label,
        command: cmd.command
    }));
    const spotifyPlaylistTiles = (config.spotifyPlaylists || []).map(playlist => ({
        id: `spotify_playlist.${playlist.label.toLowerCase().replace(/\s+/g, '_')}`,
        label: playlist.label,
        playlistUrl: playlist.playlistUrl,
        icon: playlist.icon || 'queue_music'
    }));
    const allRegularItems = [...regularEntities, ...assistantCommandTiles, ...spotifyPlaylistTiles];
    const totalRegularPages = paginateEntities(allRegularItems, config.gridColumns || 2, config.gridRows || 2).length;
    const totalPages = totalRegularPages + (mediaPlayers.length > 0 ? 1 : 0);
    
    currentPage = Math.max(0, Math.min(pageIndex, totalPages - 1));
    updatePagePosition();
    updateDots();
    
    // Update now playing indicator visibility
    updateNowPlayingIndicator(mediaPlayers);
}

function updatePagePosition() {
    const wrapper = document.getElementById('pagesWrapper');
    wrapper.style.transform = `translateX(-${currentPage * 100}%)`;
}

function updateDots() {
    const dots = document.querySelectorAll('.dot');
    dots.forEach((dot, index) => {
        dot.className = 'dot' + (index === currentPage ? ' active' : '');
    });
}

function nextPage() {
    const regularEntities = config.entities.filter(e => !e.id.startsWith('media_player.'));
    const mediaPlayers = config.entities.filter(e => e.id.startsWith('media_player.'));
    const assistantCommandTiles = (config.assistantCommands || []).map(cmd => ({
        id: `assistant_command.${cmd.label.toLowerCase().replace(/\s+/g, '_')}`,
        label: cmd.label,
        command: cmd.command
    }));
    const spotifyPlaylistTiles = (config.spotifyPlaylists || []).map(playlist => ({
        id: `spotify_playlist.${playlist.label.toLowerCase().replace(/\s+/g, '_')}`,
        label: playlist.label,
        playlistUrl: playlist.playlistUrl,
        icon: playlist.icon || 'queue_music'
    }));
    const allRegularItems = [...regularEntities, ...assistantCommandTiles, ...spotifyPlaylistTiles];
    const totalRegularPages = paginateEntities(allRegularItems, config.gridColumns || 2, config.gridRows || 2).length;
    const totalPages = totalRegularPages + (mediaPlayers.length > 0 ? 1 : 0);
    
    if (currentPage < totalPages - 1) {
        goToPage(currentPage + 1);
    }
}

function prevPage() {
    if (currentPage > 0) {
        goToPage(currentPage - 1);
    }
}

// ============================================
// TOUCH HANDLING
// ============================================
function setupTouchHandlers() {
    const container = document.getElementById('pagesWrapper');
    let longPressTimer = null;

    container.addEventListener('touchstart', (e) => {
        if (e.target.classList.contains('brightness-slider')) return;
        touchStartX = e.touches[0].clientX;
        longPressTimer = setTimeout(() => { openAdmin(); }, 2000);
    }, { passive: true });

    container.addEventListener('touchmove', () => {
        if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
    }, { passive: true });

    container.addEventListener('touchend', (e) => {
        if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
        if (e.target.classList.contains('brightness-slider') || isSliderDragging) return;
        touchEndX = e.changedTouches[0].clientX;
        handleSwipe();
    }, { passive: true });
}

function handleSwipe() {
    const swipeThreshold = 50;
    const diff = touchStartX - touchEndX;

    if (Math.abs(diff) > swipeThreshold) {
        if (diff > 0) {
            nextPage();
        } else {
            prevPage();
        }
    }
}

// ============================================
// SCREENSAVER
// ============================================
// SCREENSAVER
// ============================================
function resetInactivityTimer() {
    if (inactivityTimer) {
        clearTimeout(inactivityTimer);
    }
    const timeout = (globalConfig?.screensaverTimeout || 10) * 1000; // Convert seconds to milliseconds
    inactivityTimer = setTimeout(enterScreensaver, timeout);
}

function enterScreensaver() {
    document.getElementById('screensaver').classList.add('active');
    updateScreensaverClock();
    screensaverClockInterval = setInterval(updateScreensaverClock, 1000);
}

function exitScreensaver() {
    document.getElementById('screensaver').classList.remove('active');
    if (screensaverClockInterval) {
        clearInterval(screensaverClockInterval);
    }
    resetInactivityTimer();
}

function formatClockTime(date, formatOverride) {
    const format = formatOverride || globalConfig?.screensaverTimeFormat;
    const minutes = String(date.getMinutes()).padStart(2, '0');
    if (format === '12h') {
        const hours12 = date.getHours() % 12 || 12;
        const ampm = date.getHours() < 12 ? 'AM' : 'PM';
        return `${hours12}:${minutes} ${ampm}`;
    }
    const hours = String(date.getHours()).padStart(2, '0');
    return `${hours}:${minutes}`;
}

function updateScreensaverClock() {
    const now = new Date();

    // Time
    document.getElementById('screensaverTime').textContent = formatClockTime(now);

    // Date
    const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    const dayName = days[now.getDay()];
    const monthName = months[now.getMonth()];
    const date = now.getDate();
    document.getElementById('screensaverDate').textContent = `${dayName}, ${monthName} ${date}`;
    
    // Room name (hide in standalone screensaver mode)
    const roomElement = document.getElementById('screensaverRoom');
    if (config.roomName === 'Screensaver') {
        roomElement.style.display = 'none';
    } else {
        roomElement.textContent = config.roomName;
        roomElement.style.display = 'block';
    }
    
    // Temperature
    const tempElement = document.getElementById('screensaverTemp');
    if (config.headerTempEntity && entityStates[config.headerTempEntity]) {
        const state = entityStates[config.headerTempEntity];
        const domain = config.headerTempEntity.split('.')[0];
        
        if (domain === 'climate' && state.attributes.current_temperature !== undefined) {
            const temp = Math.round(state.attributes.current_temperature);
            const unit = state.attributes.unit_of_measurement || '°C';
            tempElement.textContent = `${temp}${unit}`;
            tempElement.style.display = 'block';
        } else if (domain === 'sensor') {
            const value = parseFloat(state.state);
            if (!isNaN(value)) {
                const unit = state.attributes.unit_of_measurement || '°C';
                tempElement.textContent = `${Math.round(value)}${unit}`;
                tempElement.style.display = 'block';
            }
        } else {
            tempElement.style.display = 'none';
        }
    } else {
        tempElement.style.display = 'none';
    }
    
    // Weather
    const weatherElement = document.getElementById('screensaverWeather');
    const weatherIcon = document.getElementById('screensaverWeatherIcon');
    const weatherTemp = document.getElementById('screensaverWeatherTemp');
    const weatherCondition = document.getElementById('screensaverWeatherCondition');
    
    if (config.screensaverWeather && entityStates[config.screensaverWeather]) {
        const weatherState = entityStates[config.screensaverWeather];
        
        weatherIcon.textContent = WEATHER_ICONS[weatherState.state] || 'cloud';
        
        // Show weather temperature
        if (weatherState.attributes.temperature !== undefined) {
            const temp = Math.round(weatherState.attributes.temperature);
            const unit = weatherState.attributes.temperature_unit || '°C';
            weatherTemp.textContent = `${temp}${unit}`;
        }
        
        weatherCondition.textContent = formatWeatherCondition(weatherState.state);
        weatherElement.style.display = 'flex';
    } else {
        weatherElement.style.display = 'none';
    }
}

function setupInactivityDetection() {
    const events = ['mousedown', 'mousemove', 'keypress', 'scroll', 'touchstart', 'click'];
    
    events.forEach(event => {
        document.addEventListener(event, () => {
            if (!document.getElementById('screensaver').classList.contains('active')) {
                resetInactivityTimer();
            }
        }, true);
    });
    
    resetInactivityTimer();
}

// ============================================
// ADMIN PANEL
// ============================================
function openAdmin() {
    const panel = document.getElementById('adminPanel');
    panel.classList.add('active');

    // Show room selector if HA is already configured, initial setup only if not
    if (config || (globalConfig && globalConfig.haToken)) {
        showRoomManager();
    } else if (globalConfig && globalConfig.haToken && roomConfigs.length > 0) {
        // Global config exists and rooms are configured, just need to pick a room
        showRoomManager();
    } else if (globalConfig && globalConfig.haToken) {
        // Have credentials but no rooms yet, skip to room creation
        showRoomEditor('new');
    } else {
        // Truly first time, need HA URL and token
        showInitialSetup();
    }
}

function showInitialSetup() {
    const panel = document.getElementById('adminPanel');
    panel.innerHTML = `
        <div class="admin-header">
            <div class="admin-title">Initial Setup</div>
        </div>

        <div class="error-message" id="errorMessage"></div>

        <div class="form-group">
            <label class="form-label">Home Assistant URL</label>
            <input type="text" class="form-input" id="haUrlInput" placeholder="http://homeassistant.local:8123" value="${globalConfig.haUrl}">
            <small style="color: #888; font-size: 12px;">Include http:// or https://</small>
        </div>

        <div class="form-group">
            <label class="form-label">Long-Lived Access Token</label>
            <input type="password" class="form-input" id="haTokenInput" placeholder="Your HA token" value="${globalConfig.haToken}">
            <small style="color: #888; font-size: 12px;">Create in HA: Profile → Security → Long-Lived Access Tokens</small>
        </div>

        <button class="save-btn" onclick="saveGlobalAndContinue()">Continue to Room Setup</button>
    `;
}

function showRoomManager() {
    setAdminParam('rooms');
    const panel = document.getElementById('adminPanel');
    const hasRooms = roomConfigs.length > 0;
    const activeIdx = config ? roomConfigs.findIndex(r => r.roomName === config.roomName) : -1;

    panel.innerHTML = `
        <div class="admin-header">
            <div class="admin-title">Room Configuration</div>
            <button class="close-btn" onclick="closeAdmin()">Close</button>
        </div>

        <div class="error-message" id="errorMessage"></div>

        ${!config && hasRooms ? `
        <div style="background: rgba(99, 179, 237, 0.15); border: 1px solid rgba(99, 179, 237, 0.4); border-radius: 8px; padding: 12px 16px; margin-bottom: 16px; color: rgba(255,255,255,0.85); font-size: 13px;">
            Select a room for this panel to get started.
        </div>` : ''}

        <div class="form-group">
            <label class="form-label">Room</label>
            <select class="form-input" id="roomSelect" onchange="updateRoomManagerButtons()">
                <option value="">-- Select a room --</option>
                ${roomConfigs.map((room, idx) => `<option value="${idx}" ${idx === activeIdx ? 'selected' : ''}>${room.roomName}${idx === activeIdx ? ' (active)' : ''}</option>`).join('')}
            </select>
        </div>

        <div style="display: flex; gap: 8px; margin-bottom: 8px;">
            <button class="add-btn" style="flex: 1; margin-top: 0;" id="loadRoomBtn" onclick="loadSelectedRoom()" ${!hasRooms ? 'disabled' : ''}>Set Active</button>
            <button class="add-btn" style="flex: 1; margin-top: 0;" id="editRoomBtn" onclick="editSelectedRoom()" ${!hasRooms ? 'disabled' : ''}>Edit</button>
            <button class="remove-btn" style="flex: 1;" id="deleteRoomBtn" onclick="deleteSelectedRoom()" ${!hasRooms ? 'disabled' : ''}>Delete</button>
        </div>

        <button class="add-btn" style="width: 100%; margin-bottom: 24px;" onclick="showRoomEditor('new')">+ New Room</button>

        <div style="border-top: 1px solid rgba(255, 255, 255, 0.1); padding-top: 20px; margin-top: 4px;">
            <button class="save-btn" style="background: linear-gradient(135deg, #666 0%, #444 100%);" onclick="showGlobalSettings()">Global Settings</button>
        </div>
    `;
}

function updateRoomManagerButtons() {
    const idx = parseInt(document.getElementById('roomSelect').value);
    const hasSelection = !isNaN(idx) && idx >= 0;
    document.getElementById('loadRoomBtn').disabled = !hasSelection;
    document.getElementById('editRoomBtn').disabled = !hasSelection;
    document.getElementById('deleteRoomBtn').disabled = !hasSelection;
}

function editSelectedRoom() {
    const idx = parseInt(document.getElementById('roomSelect').value);
    if (isNaN(idx) || !roomConfigs[idx]) return;
    showRoomEditor('edit', idx);
}

function showGlobalSettings() {
    setAdminParam('settings');
    const panel = document.getElementById('adminPanel');
    panel.innerHTML = `
        <div class="admin-header">
            <div class="admin-title">Global Settings</div>
            <button class="close-btn" onclick="showRoomManager()">Back</button>
        </div>

        <div class="error-message" id="errorMessage"></div>

        <div class="settings-section">
            <div class="settings-section-title">Home Assistant</div>
            <div class="form-group">
                <label class="form-label">URL</label>
                <input type="text" class="form-input" id="haUrlInput" placeholder="http://homeassistant.local:8123" value="${globalConfig.haUrl}">
                <small style="color: #888; font-size: 12px;">Include http:// or https://</small>
            </div>
            <div class="form-group">
                <label class="form-label">Long-Lived Access Token</label>
                <input type="password" class="form-input" id="haTokenInput" placeholder="Your HA token" value="${globalConfig.haToken}">
                <small style="color: #888; font-size: 12px;">Create in HA: Profile → Security → Long-Lived Access Tokens</small>
            </div>
            <div class="form-group">
                <label class="form-label">Google Assistant Entity (Optional)</label>
                <input type="text" class="form-input" id="assistantEntityInput" placeholder="conversation.google_assistant" value="${globalConfig.assistantEntity || ''}">
                <small style="color: #888; font-size: 12px;">For voice command tiles. Use conversation agent ID from HA.</small>
            </div>
        </div>

        <div class="settings-section">
            <div class="settings-section-title">Device</div>
            <div class="form-group">
                <label class="form-label">Model</label>
                <select class="form-input" id="deviceModelInput">
                    <option value="pro" ${(globalConfig.deviceModel || 'pro') === 'pro' ? 'selected' : ''}>NSPanel Pro (480×480)</option>
                    <option value="pro120" ${globalConfig.deviceModel === 'pro120' ? 'selected' : ''}>NSPanel Pro 120 (480×890)</option>
                </select>
            </div>
            <div class="form-group">
                <label class="form-label">Font Family</label>
                <select class="form-input" id="fontFamilyInput">
                    ${Object.keys(FONT_OPTIONS).map(name =>
                        `<option value="${name}" ${(globalConfig.fontFamily || 'Inter') === name ? 'selected' : ''}>${name}</option>`
                    ).join('')}
                </select>
            </div>
            <div class="form-group">
                <label class="form-label">Header</label>
                <select class="form-input" id="headerDisplayInput">
                    <option value="full" ${!globalConfig.hideRoomName && !globalConfig.hideHeader ? 'selected' : ''}>Full</option>
                    <option value="no-name" ${globalConfig.hideRoomName && !globalConfig.hideHeader ? 'selected' : ''}>Hide room name</option>
                    <option value="hidden" ${globalConfig.hideHeader ? 'selected' : ''}>Hidden</option>
                </select>
            </div>
        </div>

        <div class="settings-section">
            <div class="settings-section-title">Screensaver</div>
            <div class="form-group">
                <label class="form-label">Timeout (seconds)</label>
                <input type="number" class="form-input" id="screensaverTimeoutInput" placeholder="10" min="5" max="300" value="${globalConfig.screensaverTimeout || 10}">
                <small style="color: #888; font-size: 12px;">Time of inactivity before screensaver activates (5–300 seconds)</small>
            </div>
            <div class="form-group">
                <label class="form-label">Time Format</label>
                <select class="form-input" id="screensaverTimeFormatInput">
                    <option value="24h" ${(globalConfig.screensaverTimeFormat || '24h') === '24h' ? 'selected' : ''}>24-hour</option>
                    <option value="12h" ${globalConfig.screensaverTimeFormat === '12h' ? 'selected' : ''}>12-hour (AM/PM)</option>
                </select>
                <small style="color: #888; font-size: 12px;">Also used by clock tiles</small>
            </div>
            <div class="form-group">
                <label class="form-label">Temperature Entity (Optional)</label>
                <input type="text" class="form-input" id="screensaverTempEntityInput" placeholder="sensor.outdoor_temperature" value="${globalConfig.screensaverTempEntity || ''}">
                <small style="color: #888; font-size: 12px;">Sensor shown on screensaver</small>
            </div>
            <div class="form-group">
                <label class="form-label">Weather Entity (Optional)</label>
                <input type="text" class="form-input" id="screensaverWeatherEntityInput" placeholder="weather.home" value="${globalConfig.screensaverWeather || ''}">
                <small style="color: #888; font-size: 12px;">Weather entity shown on screensaver</small>
            </div>
            <div class="form-group">
                <label style="display: flex; align-items: center; gap: 8px; cursor: pointer;">
                    <input type="checkbox" id="disableScreensaverInput" ${globalConfig.disableBuiltInScreensaver ? 'checked' : ''} style="width: 20px; height: 20px; cursor: pointer;">
                    <span class="form-label" style="margin: 0;">Disable Built-in Screensaver</span>
                </label>
                <small style="color: #888; font-size: 12px; display: block; margin-top: 4px;">
                    Use if you prefer Fully Kiosk's screensaver instead.<br>
                    <strong>Standalone URL:</strong> <code style="background: rgba(255,255,255,0.1); padding: 2px 6px; border-radius: 4px;">${window.location.origin}/?screensaver=true</code>
                </small>
            </div>
        </div>

        <div class="settings-section">
            <div class="settings-section-title">Features</div>
            <div class="form-group">
                <label style="display: flex; align-items: center; gap: 8px; cursor: pointer;">
                    <input type="checkbox" id="hideVoiceMessagesInput" ${globalConfig.hideVoiceMessages ? 'checked' : ''} style="width: 20px; height: 20px; cursor: pointer;">
                    <span class="form-label" style="margin: 0;">Hide Voice Messages</span>
                </label>
                <small style="color: #888; font-size: 12px; display: block; margin-top: 4px;">Hides the phone button from the header</small>
            </div>
            <div class="form-group">
                <label class="form-label">Test Sound</label>
                <button class="add-btn" style="margin-top: 0;" onclick="testSound()">Play Test Sound</button>
                <small style="color: #888; font-size: 12px; display: block; margin-top: 4px;">Place a sound.mp3 in the root directory to test audio playback</small>
            </div>
        </div>

        <button class="save-btn" onclick="saveGlobalSettings()">Save Global Settings</button>
    `;
}

let roomEditorSnapshot = null;

function getRoomEditorCurrentState() {
    return {
        roomName: document.getElementById('roomNameInput')?.value.trim() || '',
        headerTempEntity: document.getElementById('headerTempEntityInput')?.value.trim() || '',
        screensaverWeather: document.getElementById('screensaverWeatherInput')?.value.trim() || '',
        gridColumns: parseInt(document.getElementById('gridColumnsInput')?.value) || 2,
        gridRows: parseInt(document.getElementById('gridRowsInput')?.value) || 2,
        entities: window.editingRoomData?.entities || [],
        assistantCommands: window.editingRoomData?.assistantCommands || [],
        spotifyPlaylists: window.editingRoomData?.spotifyPlaylists || [],
    };
}

function backFromRoomEditor() {
    if (roomEditorSnapshot !== null) {
        const current = JSON.stringify(getRoomEditorCurrentState());
        if (current !== roomEditorSnapshot) {
            if (!confirm('You have unsaved changes. Discard them?')) return;
        }
    }
    roomEditorSnapshot = null;
    showRoomManager();
}

function showRoomEditor(mode, roomIdx) {
    const roomName = roomIdx !== undefined && roomConfigs[roomIdx] ? roomConfigs[roomIdx].roomName : undefined;
    setAdminParam('editor', { mode, room: roomName });
    const isEdit = mode === 'edit';
    window.editingRoomIdx = isEdit && roomIdx !== undefined ? roomIdx : null;
    const roomData = isEdit && roomIdx !== undefined && roomConfigs[roomIdx]
        ? roomConfigs[roomIdx]
        : (isEdit && config ? config : { ...DEFAULT_ROOM_CONFIG });
    
    const panel = document.getElementById('adminPanel');
    panel.innerHTML = `
        <div class="admin-header">
            <div class="admin-title">${isEdit ? 'Edit' : 'New'} Room</div>
            <button class="close-btn" onclick="backFromRoomEditor()">Back</button>
        </div>

        <div class="error-message" id="errorMessage"></div>

        <div class="form-group">
            <label class="form-label">Room Name</label>
            <input type="text" class="form-input" id="roomNameInput" placeholder="Living Room" value="${roomData.roomName}">
        </div>

        <div class="form-group">
            <label class="form-label">Grid Layout</label>
            <div style="display: flex; gap: 12px;">
                <div style="flex: 1;">
                    <label class="form-label" style="font-size: 10px; margin-bottom: 4px;">Columns</label>
                    <select class="form-input" id="gridColumnsInput">
                        <option value="1" ${(roomData.gridColumns || 2) === 1 ? 'selected' : ''}>1</option>
                        <option value="2" ${(roomData.gridColumns || 2) === 2 ? 'selected' : ''}>2</option>
                        <option value="3" ${(roomData.gridColumns || 2) === 3 ? 'selected' : ''}>3</option>
                        <option value="4" ${(roomData.gridColumns || 2) === 4 ? 'selected' : ''}>4</option>
                    </select>
                </div>
                <div style="flex: 1;">
                    <label class="form-label" style="font-size: 10px; margin-bottom: 4px;">Rows</label>
                    <select class="form-input" id="gridRowsInput">
                        <option value="1" ${(roomData.gridRows || 2) === 1 ? 'selected' : ''}>1</option>
                        <option value="2" ${(roomData.gridRows || 2) === 2 ? 'selected' : ''}>2</option>
                        <option value="3" ${(roomData.gridRows || 2) === 3 ? 'selected' : ''}>3</option>
                        <option value="4" ${(roomData.gridRows || 2) === 4 ? 'selected' : ''}>4</option>
                        <option value="5" ${(roomData.gridRows || 2) === 5 ? 'selected' : ''}>5</option>
                        <option value="6" ${(roomData.gridRows || 2) === 6 ? 'selected' : ''}>6</option>
                    </select>
                </div>
            </div>
            <small style="color: #888; font-size: 12px;">Tiles per page: ${(roomData.gridColumns || 2) * (roomData.gridRows || 2)}</small>
        </div>

        <div class="form-group">
            <label class="form-label">Header Temperature Entity (Optional)</label>
            <input type="text" class="form-input" id="headerTempEntityInput" placeholder="climate.bedroom or sensor.bedroom_temperature" value="${roomData.headerTempEntity || ''}">
            <small style="color: #888; font-size: 12px;">Shows temperature in header with controls for climate entities</small>
        </div>

        <div class="form-group">
            <label class="form-label">Screensaver Weather Entity (Optional)</label>
            <input type="text" class="form-input" id="screensaverWeatherInput" placeholder="weather.home" value="${roomData.screensaverWeather || ''}">
            <small style="color: #888; font-size: 12px;">Shows weather on screensaver</small>
        </div>

        <div class="form-group">
            <label class="form-label">Entities</label>
            <div class="entity-list" id="entityList"></div>
            <button class="add-btn" onclick="openEntityModal(null)">+ Add Entity</button>
        </div>

        <div class="form-group">
            <label class="form-label">Google Assistant Commands (Optional)</label>
            <small style="color: #888; font-size: 12px; display: block; margin-bottom: 8px;">Create tiles that send voice commands to Google Assistant</small>
            <div class="entity-list" id="commandList"></div>
            <div style="display: flex; gap: 8px; margin-top: 12px;">
                <input type="text" class="form-input" id="newCommandLabel" placeholder="Play Jazz" style="flex: 1;">
                <input type="text" class="form-input" id="newCommandText" placeholder="play jazz music" style="flex: 1;">
            </div>
            <button class="add-btn" onclick="addAssistantCommand()">+ Add Command</button>
        </div>

        <div class="form-group">
            <label class="form-label">Spotify Playlists (Optional)</label>
            <small style="color: #888; font-size: 12px; display: block; margin-bottom: 8px;">Create tiles that play Spotify playlists on this room's media player</small>
            <div class="entity-list" id="playlistList"></div>
            <div style="display: flex; flex-direction: column; gap: 8px; margin-top: 12px;">
                <input type="text" class="form-input" id="newPlaylistLabel" placeholder="Chill Vibes">
                <input type="text" class="form-input" id="newPlaylistUrl" placeholder="https://open.spotify.com/playlist/... or spotify:playlist:...">
                <div style="display: flex; gap: 8px; align-items: center;">
                    <label class="form-label" style="margin: 0; min-width: 40px;">Icon:</label>
                    <button onclick="openPlaylistIconPicker()" id="playlistIconPickerButton" style="background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.15); color: rgba(255,255,255,0.7); padding: 12px 20px; border-radius: 8px; cursor: pointer; font-family: 'Material Symbols Outlined'; font-size: 24px; display: flex; align-items: center; gap: 8px; flex: 1;">
                        <span id="selectedPlaylistIconPreview">queue_music</span>
                        <span id="selectedPlaylistIconName" style="font-family: 'Inter', sans-serif; font-size: 12px; color: rgba(255,255,255,0.5);">queue_music</span>
                    </button>
                    <input type="hidden" id="newPlaylistIcon" value="queue_music">
                </div>
            </div>
            <button class="add-btn" onclick="addSpotifyPlaylist()">+ Add Playlist</button>
        </div>

        <button class="save-btn" onclick="saveRoom('${mode}')">${isEdit ? 'Update' : 'Create'} Room</button>
    `;

    // Populate entity list
    const list = document.getElementById('entityList');
    roomData.entities.forEach((entity, index) => {
        const item = document.createElement('div');
        item.className = 'entity-item';
        const displayLabel = entity.label || (entity.id.startsWith('clock.') ? 'Clock' : entity.id);
        item.innerHTML = `
            <div style="display: flex; gap: 8px; align-items: center;">
                <div style="display: flex; flex-direction: column; gap: 4px;">
                    <button class="reorder-btn" onclick="moveEntityUp(${index})" ${index === 0 ? 'disabled' : ''}>arrow_upward</button>
                    <button class="reorder-btn" onclick="moveEntityDown(${index})" ${index === roomData.entities.length - 1 ? 'disabled' : ''}>arrow_downward</button>
                </div>
                <div>
                    <strong>${displayLabel}</strong><br>
                    <small style="color: #888;">${entity.id}</small>
                </div>
            </div>
            <div style="display: flex; gap: 8px;">
                <button class="edit-btn" onclick="openEntityModal(${index})">edit</button>
                <button class="remove-btn" onclick="removeEntity(${index})">Remove</button>
            </div>
        `;
        list.appendChild(item);
    });

    // Populate assistant commands list
    const commandList = document.getElementById('commandList');
    if (roomData.assistantCommands && roomData.assistantCommands.length > 0) {
        roomData.assistantCommands.forEach((cmd, index) => {
            const item = document.createElement('div');
            item.className = 'entity-item';
            item.innerHTML = `
                <div style="display: flex; gap: 8px; align-items: center;">
                    <div style="display: flex; flex-direction: column; gap: 4px;">
                        <button class="reorder-btn" onclick="moveCommandUp(${index})" ${index === 0 ? 'disabled' : ''}>arrow_upward</button>
                        <button class="reorder-btn" onclick="moveCommandDown(${index})" ${index === roomData.assistantCommands.length - 1 ? 'disabled' : ''}>arrow_downward</button>
                    </div>
                    <div>
                        <strong>${cmd.label}</strong><br>
                        <small style="color: #888;">"${cmd.command}"</small>
                    </div>
                </div>
                <div style="display: flex; gap: 8px;">
                    <button class="edit-btn" onclick="editAssistantCommand(${index})">edit</button>
                    <button class="remove-btn" onclick="removeAssistantCommand(${index})">Remove</button>
                </div>
            `;
            commandList.appendChild(item);
        });
    }

    // Populate Spotify playlists list
    const playlistList = document.getElementById('playlistList');
    if (roomData.spotifyPlaylists && roomData.spotifyPlaylists.length > 0) {
        roomData.spotifyPlaylists.forEach((playlist, index) => {
            const item = document.createElement('div');
            item.className = 'entity-item';
            const iconDisplay = playlist.icon ? `<span style="font-family: 'Material Symbols Outlined'; font-size: 14px; color: #1ed760; margin-right: 4px;">${playlist.icon}</span>` : '';
            item.innerHTML = `
                <div style="display: flex; gap: 8px; align-items: center;">
                    <div style="display: flex; flex-direction: column; gap: 4px;">
                        <button class="reorder-btn" onclick="movePlaylistUp(${index})" ${index === 0 ? 'disabled' : ''}>arrow_upward</button>
                        <button class="reorder-btn" onclick="movePlaylistDown(${index})" ${index === roomData.spotifyPlaylists.length - 1 ? 'disabled' : ''}>arrow_downward</button>
                    </div>
                    <div>
                        <div>${iconDisplay}<strong>${playlist.label}</strong></div>
                        <small style="color: #888;">${playlist.playlistUrl.substring(0, 50)}...</small>
                    </div>
                </div>
                <div style="display: flex; gap: 8px;">
                    <button class="edit-btn" onclick="editSpotifyPlaylist(${index})">edit</button>
                    <button class="remove-btn" onclick="removeSpotifyPlaylist(${index})">Remove</button>
                </div>
            `;
            playlistList.appendChild(item);
        });
    }

    // Store current editing data
    window.editingRoomData = roomData;
    editingEntityIndex = null;
    roomEditorSnapshot = JSON.stringify({
        roomName: roomData.roomName || '',
        headerTempEntity: roomData.headerTempEntity || '',
        screensaverWeather: roomData.screensaverWeather || '',
        gridColumns: roomData.gridColumns || 2,
        gridRows: roomData.gridRows || 2,
        entities: roomData.entities || [],
        assistantCommands: roomData.assistantCommands || [],
        spotifyPlaylists: roomData.spotifyPlaylists || [],
    });
}

async function loadSelectedRoom() {
    const select = document.getElementById('roomSelect');
    const idx = parseInt(select.value);
    
    if (isNaN(idx) || idx < 0) return;
    
    const roomConfig = roomConfigs[idx];
    config = { ...globalConfig, ...roomConfig };
    await saveConfig();
    
    closeAdmin();
    await init();
}

async function saveGlobalAndContinue() {
    globalConfig.haUrl = document.getElementById('haUrlInput').value.trim().replace(/\/$/, '');
    globalConfig.haToken = document.getElementById('haTokenInput').value.trim();

    if (!globalConfig.haUrl || !globalConfig.haToken) {
        showError('Please fill in all required fields');
        return;
    }

    await saveGlobalConfig();
    
    // Test connection
    const states = await getStates();
    if (!states) {
        showError('Failed to connect to Home Assistant. Check your URL and token.');
        return;
    }

    showRoomEditor('new');
}

async function saveGlobalSettings() {
    globalConfig.haUrl = document.getElementById('haUrlInput').value.trim().replace(/\/$/, '');
    globalConfig.haToken = document.getElementById('haTokenInput').value.trim();
    globalConfig.assistantEntity = document.getElementById('assistantEntityInput').value.trim();
    globalConfig.fontFamily = document.getElementById('fontFamilyInput').value;
    globalConfig.deviceModel = document.getElementById('deviceModelInput').value;
    globalConfig.hideVoiceMessages = document.getElementById('hideVoiceMessagesInput').checked;
    globalConfig.disableBuiltInScreensaver = document.getElementById('disableScreensaverInput').checked;
    const headerDisplay = document.getElementById('headerDisplayInput').value;
    globalConfig.hideRoomName = headerDisplay === 'no-name';
    globalConfig.hideHeader = headerDisplay === 'hidden';
    globalConfig.screensaverTimeout = parseInt(document.getElementById('screensaverTimeoutInput').value) || 10;
    globalConfig.screensaverTimeFormat = document.getElementById('screensaverTimeFormatInput').value;
    globalConfig.screensaverTempEntity = document.getElementById('screensaverTempEntityInput').value.trim();
    globalConfig.screensaverWeather = document.getElementById('screensaverWeatherEntityInput').value.trim();

    // Validate timeout range
    if (globalConfig.screensaverTimeout < 5) globalConfig.screensaverTimeout = 5;
    if (globalConfig.screensaverTimeout > 300) globalConfig.screensaverTimeout = 300;

    if (!globalConfig.haUrl || !globalConfig.haToken) {
        showError('Please fill in all required fields');
        return;
    }

    await saveGlobalConfig();
    
    // Update current config
    if (config) {
        config.haUrl = globalConfig.haUrl;
        config.haToken = globalConfig.haToken;
        config.assistantEntity = globalConfig.assistantEntity;
        config.disableBuiltInScreensaver = globalConfig.disableBuiltInScreensaver;
        config.screensaverTimeout = globalConfig.screensaverTimeout;
    }

    applyFontFamily();
    applyDeviceModel();
    applyVoiceMessageVisibility();
    applyHeaderVisibility();

    // Test connection
    const states = await getStates();
    if (!states) {
        showError('Failed to connect to Home Assistant. Check your URL and token.');
        return;
    }

    showRoomManager();
}

async function saveRoom(mode) {
    const roomName = document.getElementById('roomNameInput').value.trim();
    const headerTempEntity = document.getElementById('headerTempEntityInput').value.trim();
    const screensaverWeather = document.getElementById('screensaverWeatherInput').value.trim();
    const gridColumns = parseInt(document.getElementById('gridColumnsInput').value) || 2;
    const gridRows = parseInt(document.getElementById('gridRowsInput').value) || 2;

    if (!roomName) {
        showError('Please enter a room name');
        return;
    }

    if (!window.editingRoomData || !window.editingRoomData.entities || window.editingRoomData.entities.length === 0) {
        showError('Please add at least one entity');
        return;
    }

    const roomConfig = {
        roomName,
        headerTempEntity,
        screensaverWeather,
        gridColumns,
        gridRows,
        entities: window.editingRoomData.entities,
        assistantCommands: window.editingRoomData.assistantCommands || [],
        spotifyPlaylists: window.editingRoomData.spotifyPlaylists || []
    };

    if (mode === 'new') {
        // Check for duplicate room name
        if (roomConfigs.some(r => r.roomName === roomName)) {
            showError('A room with this name already exists');
            return;
        }
        roomConfigs.push(roomConfig);
    } else {
        // Update existing room by index, fall back to name match
        const idx = window.editingRoomIdx !== null && window.editingRoomIdx !== undefined
            ? window.editingRoomIdx
            : roomConfigs.findIndex(r => r.roomName === (config ? config.roomName : roomName));
        if (idx >= 0) {
            roomConfigs[idx] = roomConfig;
        }
    }

    await saveRoomConfigs();

    roomEditorSnapshot = null;

    // Set as active room
    config = { ...globalConfig, ...roomConfig };
    await saveConfig();

    closeAdmin();
    
    const states = await getStates();
    if (states) {
        renderPages();
        startPolling();
    }
}

async function deleteSelectedRoom() {
    const idx = parseInt(document.getElementById('roomSelect').value);
    if (isNaN(idx) || !roomConfigs[idx]) return;
    const room = roomConfigs[idx];
    if (!confirm(`Delete room "${room.roomName}"?`)) return;

    try {
        await fetch(`/config-api.php?path=room&name=${encodeURIComponent(room.roomName)}`, {
            method: 'DELETE'
        });

        roomConfigs = await loadRoomConfigs();

        // Clear active room if it was the deleted one
        if (config && config.roomName === room.roomName) config = null;

        showRoomManager();
    } catch (error) {
        console.error('Failed to delete room:', error);
        showError('Failed to delete room');
    }
}

function setAdminParam(view, extra = {}) {
    const params = new URLSearchParams(window.location.search);
    params.set('admin', view);
    Object.entries(extra).forEach(([k, v]) => { if (v !== undefined) params.set(k, v); });
    ['mode', 'room'].forEach(k => { if (!(k in extra) || extra[k] === undefined) params.delete(k); });
    history.replaceState(null, '', '?' + params.toString());
}

function clearAdminParam() {
    const params = new URLSearchParams(window.location.search);
    params.delete('admin');
    params.delete('mode');
    params.delete('room');
    const qs = params.toString();
    history.replaceState(null, '', qs ? '?' + qs : window.location.pathname);
}

function closeAdmin() {
    document.getElementById('adminPanel').classList.remove('active');
    clearAdminParam();
}

let editingEntityIndex = null;

function updateEntityFormForDomain() {
    const domain = document.getElementById('newEntityDomain').value;
    const isClock = domain === 'clock';
    document.getElementById('entityOptEntityId').style.display = isClock ? 'none' : 'flex';
    document.getElementById('entityOptLabel').style.display = isClock ? 'none' : 'flex';
    document.getElementById('entityOptIcon').style.display = isClock ? 'none' : 'flex';
    document.getElementById('entityOptHideState').style.display = (domain === 'weather' || isClock) ? 'none' : 'block';
    document.getElementById('entityOptDisableAction').style.display = isClock ? 'none' : 'block';
    document.getElementById('entityOptLight').style.display = domain === 'light' ? 'block' : 'none';
    document.getElementById('entityOptSensor').style.display = domain === 'sensor' ? 'flex' : 'none';
    document.getElementById('entityOptWeather').style.display = domain === 'weather' ? 'flex' : 'none';
    document.getElementById('entityOptClock').style.display = isClock ? 'flex' : 'none';

    // Inline forecast needs vertical room, so it's unavailable on half-height tiles
    const isHalfHeight = document.getElementById('newEntityTileHeight').value === 'half';
    const inlineForecastCheckbox = document.getElementById('newEntityShowInlineForecast');
    inlineForecastCheckbox.disabled = isHalfHeight;
    if (isHalfHeight) inlineForecastCheckbox.checked = false;
    const inlineForecastLabel = inlineForecastCheckbox.closest('label');
    inlineForecastLabel.style.opacity = isHalfHeight ? '0.4' : '1';
    inlineForecastLabel.style.cursor = isHalfHeight ? 'default' : 'pointer';

    const tileForecastTypeSelect = document.getElementById('newEntityTileForecastType');
    tileForecastTypeSelect.disabled = isHalfHeight;
    tileForecastTypeSelect.style.opacity = isHalfHeight ? '0.4' : '1';
}

function openEntityModal(index) {
    editingEntityIndex = index;
    document.getElementById('entityEditorTitle').textContent = index === null ? 'Add Entity' : 'Edit Entity';

    if (index !== null && window.editingRoomData?.entities[index]) {
        const entity = window.editingRoomData.entities[index];
        const dotIndex = entity.id.indexOf('.');
        const domain = dotIndex !== -1 ? entity.id.substring(0, dotIndex) : 'light';
        const rawId = dotIndex !== -1 ? entity.id.substring(dotIndex + 1) : entity.id;

        document.getElementById('newEntityDomain').value = domain;
        document.getElementById('newEntityId').value = rawId;
        document.getElementById('newEntityLabel').value = entity.label || '';
        document.getElementById('newEntityIcon').value = entity.icon || '';
        document.getElementById('selectedIconPreview').textContent = entity.icon || 'search';
        document.getElementById('selectedIconName').textContent = entity.icon || 'Choose icon';
        document.getElementById('newEntityHideState').checked = entity.hideState || false;
        document.getElementById('newEntityDisableAction').checked = entity.disableAction || false;
        document.getElementById('newEntityDisableDimming').checked = entity.disableDimming || false;
        document.getElementById('newEntityDecimals').value = entity.decimals !== undefined ? entity.decimals : '';
        document.getElementById('newEntityHideWeatherName').checked = entity.hideWeatherName || false;
        document.getElementById('newEntityHideWeatherIcon').checked = entity.hideWeatherIcon || false;
        document.getElementById('newEntityHideWeatherForecast').checked = entity.hideWeatherForecast || false;
        document.getElementById('newEntityShowInlineForecast').checked = entity.showInlineForecast || false;
        document.getElementById('newEntityModalForecastType').value = entity.modalForecastType || 'hourly';
        document.getElementById('newEntityTileForecastType').value = entity.tileForecastType || 'daily';
        document.getElementById('newEntityTileHeight').value = entity.tileHeight || 'normal';
        document.getElementById('newEntityHideClockDate').checked = entity.hideClockDate || false;
        document.getElementById('newEntityClockFormat').value = entity.clockTimeFormat || '';
    } else {
        document.getElementById('newEntityDomain').value = 'light';
        document.getElementById('newEntityId').value = '';
        document.getElementById('newEntityLabel').value = '';
        document.getElementById('newEntityIcon').value = '';
        document.getElementById('selectedIconPreview').textContent = 'search';
        document.getElementById('selectedIconName').textContent = 'Choose icon';
        document.getElementById('newEntityHideState').checked = false;
        document.getElementById('newEntityDisableAction').checked = false;
        document.getElementById('newEntityDisableDimming').checked = false;
        document.getElementById('newEntityDecimals').value = '';
        document.getElementById('newEntityHideWeatherName').checked = false;
        document.getElementById('newEntityHideWeatherIcon').checked = false;
        document.getElementById('newEntityHideWeatherForecast').checked = false;
        document.getElementById('newEntityShowInlineForecast').checked = false;
        document.getElementById('newEntityModalForecastType').value = 'hourly';
        document.getElementById('newEntityTileForecastType').value = 'daily';
        document.getElementById('newEntityTileHeight').value = 'normal';
        document.getElementById('newEntityHideClockDate').checked = false;
        document.getElementById('newEntityClockFormat').value = '';
    }

    // Populate width options based on current room column count
    const gridCols = parseInt(document.getElementById('gridColumnsInput')?.value) || window.editingRoomData?.gridColumns || 2;
    const tileWidthSelect = document.getElementById('newEntityTileWidth');
    tileWidthSelect.innerHTML = '';
    for (let c = 1; c <= gridCols; c++) {
        const opt = document.createElement('option');
        opt.value = c;
        opt.textContent = c === 1 ? '1 col' : c === gridCols ? `${c} cols (full width)` : `${c} cols`;
        tileWidthSelect.appendChild(opt);
    }
    const savedColSpan = (editingEntityIndex !== null && window.editingRoomData?.entities[editingEntityIndex]?.tileColSpan) || 1;
    tileWidthSelect.value = Math.min(savedColSpan, gridCols);

    updateEntityFormForDomain();
    document.getElementById('entityEditorModal').classList.add('active');
    setTimeout(() => document.getElementById('newEntityLabel').focus(), 50);
}

function closeEntityModal(event) {
    if (event && !event.currentTarget.id === 'entityEditorModal') return;
    document.getElementById('entityEditorModal').classList.remove('active');
    editingEntityIndex = null;
}

function saveEntityModal() {
    const domain = document.getElementById('newEntityDomain').value;
    let rawId = document.getElementById('newEntityId').value.trim();
    const label = document.getElementById('newEntityLabel').value.trim();
    const icon = document.getElementById('newEntityIcon').value.trim();
    const hideState = document.getElementById('newEntityHideState').checked;

    if (domain === 'clock') {
        if (!rawId) rawId = `clock_${Date.now()}`;
    } else if (!rawId || !label) {
        showError('Please enter both entity ID and label');
        return;
    }
    if (rawId.includes('.')) {
        showError('Enter only the ID without the domain (e.g. "living_room", not "light.living_room")');
        return;
    }

    if (!window.editingRoomData) window.editingRoomData = { entities: [] };

    const entity = { id: `${domain}.${rawId}` };
    if (label) entity.label = label;
    if (icon) entity.icon = icon;
    if (hideState) entity.hideState = true;
    if (document.getElementById('newEntityDisableAction').checked) entity.disableAction = true;
    if (domain === 'light' && document.getElementById('newEntityDisableDimming').checked) entity.disableDimming = true;
    if (domain === 'sensor') {
        const decimalsRaw = document.getElementById('newEntityDecimals').value;
        if (decimalsRaw !== '') entity.decimals = parseInt(decimalsRaw);
    }
    if (domain === 'clock') {
        if (document.getElementById('newEntityHideClockDate').checked) entity.hideClockDate = true;
        const clockFormat = document.getElementById('newEntityClockFormat').value;
        if (clockFormat) entity.clockTimeFormat = clockFormat;
    }
    if (domain === 'weather') {
        if (document.getElementById('newEntityHideWeatherName').checked) entity.hideWeatherName = true;
        if (document.getElementById('newEntityHideWeatherIcon').checked) entity.hideWeatherIcon = true;
        if (document.getElementById('newEntityHideWeatherForecast').checked) entity.hideWeatherForecast = true;
        if (document.getElementById('newEntityShowInlineForecast').checked) entity.showInlineForecast = true;
        const modalForecastType = document.getElementById('newEntityModalForecastType').value;
        if (modalForecastType && modalForecastType !== 'hourly') entity.modalForecastType = modalForecastType;
        const tileForecastType = document.getElementById('newEntityTileForecastType').value;
        if (tileForecastType && tileForecastType !== 'daily') entity.tileForecastType = tileForecastType;
    }

    const tileColSpan = parseInt(document.getElementById('newEntityTileWidth').value);
    const tileHeight = document.getElementById('newEntityTileHeight').value;
    if (tileColSpan && tileColSpan > 1) entity.tileColSpan = tileColSpan;
    if (tileHeight && tileHeight !== 'normal') entity.tileHeight = tileHeight;
    if (tileHeight === 'half') {
        delete entity.showInlineForecast;
        delete entity.tileForecastType;
    }

    if (editingEntityIndex !== null) {
        window.editingRoomData.entities.splice(editingEntityIndex, 1, entity);
    } else {
        window.editingRoomData.entities.push(entity);
    }

    document.getElementById('entityEditorModal').classList.remove('active');
    editingEntityIndex = null;
    refreshEntityList();
}

function removeEntity(index) {
    if (window.editingRoomData && window.editingRoomData.entities) {
        window.editingRoomData.entities.splice(index, 1);
        refreshEntityList();
    }
}

function refreshEntityList() {
    const list = document.getElementById('entityList');
    list.innerHTML = '';
    window.editingRoomData.entities.forEach((entity, idx) => {
        const item = document.createElement('div');
        item.className = 'entity-item';

        const iconText = entity.icon ? `<span style="font-family: 'Material Symbols Outlined'; font-size: 14px; color: #42a5f5; margin-right: 4px;">${entity.icon}</span>` : '';
        const hideStateText = entity.hideState ? '<span style="font-size: 10px; color: #888; margin-left: 8px;">[Hidden]</span>' : '';
        const displayLabel = entity.label || (entity.id.startsWith('clock.') ? 'Clock' : entity.id);

        item.innerHTML = `
            <div style="display: flex; gap: 8px; align-items: center;">
                <div style="display: flex; flex-direction: column; gap: 4px;">
                    <button class="reorder-btn" onclick="moveEntityUp(${idx})" ${idx === 0 ? 'disabled' : ''}>arrow_upward</button>
                    <button class="reorder-btn" onclick="moveEntityDown(${idx})" ${idx === window.editingRoomData.entities.length - 1 ? 'disabled' : ''}>arrow_downward</button>
                </div>
                <div>
                    <div>${iconText}<strong>${displayLabel}</strong>${hideStateText}</div>
                    <small style="color: #888;">${entity.id}</small>
                </div>
            </div>
            <div style="display: flex; gap: 8px;">
                <button class="edit-btn" onclick="openEntityModal(${idx})">edit</button>
                <button class="remove-btn" onclick="removeEntity(${idx})">Remove</button>
            </div>
        `;
        list.appendChild(item);
    });
}

function moveEntityUp(index) {
    if (index === 0 || !window.editingRoomData) return;
    const entities = window.editingRoomData.entities;
    [entities[index - 1], entities[index]] = [entities[index], entities[index - 1]];
    refreshEntityList();
}

function moveEntityDown(index) {
    if (!window.editingRoomData) return;
    const entities = window.editingRoomData.entities;
    if (index >= entities.length - 1) return;
    [entities[index], entities[index + 1]] = [entities[index + 1], entities[index]];
    refreshEntityList();
}

function addAssistantCommand() {
    const label = document.getElementById('newCommandLabel').value.trim();
    const command = document.getElementById('newCommandText').value.trim();

    if (!label || !command) {
        showError('Please enter both label and command text');
        return;
    }

    if (!window.editingRoomData) {
        window.editingRoomData = { entities: [], assistantCommands: [] };
    }

    if (!window.editingRoomData.assistantCommands) {
        window.editingRoomData.assistantCommands = [];
    }

    window.editingRoomData.assistantCommands.push({ label, command });
    document.getElementById('newCommandLabel').value = '';
    document.getElementById('newCommandText').value = '';
    
    refreshCommandList();
}

function editAssistantCommand(index) {
    if (!window.editingRoomData || !window.editingRoomData.assistantCommands[index]) return;
    
    const cmd = window.editingRoomData.assistantCommands[index];
    document.getElementById('newCommandLabel').value = cmd.label;
    document.getElementById('newCommandText').value = cmd.command;
    
    // Remove the command so it can be re-added with new values
    window.editingRoomData.assistantCommands.splice(index, 1);
    refreshCommandList();
    
    // Focus on label input
    document.getElementById('newCommandLabel').focus();
}

function removeAssistantCommand(index) {
    if (window.editingRoomData && window.editingRoomData.assistantCommands) {
        window.editingRoomData.assistantCommands.splice(index, 1);
        refreshCommandList();
    }
}

function refreshCommandList() {
    const list = document.getElementById('commandList');
    list.innerHTML = '';
    if (window.editingRoomData.assistantCommands) {
        window.editingRoomData.assistantCommands.forEach((cmd, idx) => {
            const item = document.createElement('div');
            item.className = 'entity-item';
            item.innerHTML = `
                <div style="display: flex; gap: 8px; align-items: center;">
                    <div style="display: flex; flex-direction: column; gap: 4px;">
                        <button class="reorder-btn" onclick="moveCommandUp(${idx})" ${idx === 0 ? 'disabled' : ''}>arrow_upward</button>
                        <button class="reorder-btn" onclick="moveCommandDown(${idx})" ${idx === window.editingRoomData.assistantCommands.length - 1 ? 'disabled' : ''}>arrow_downward</button>
                    </div>
                    <div>
                        <strong>${cmd.label}</strong><br>
                        <small style="color: #888;">"${cmd.command}"</small>
                    </div>
                </div>
                <div style="display: flex; gap: 8px;">
                    <button class="edit-btn" onclick="editAssistantCommand(${idx})">edit</button>
                    <button class="remove-btn" onclick="removeAssistantCommand(${idx})">Remove</button>
                </div>
            `;
            list.appendChild(item);
        });
    }
}

function moveCommandUp(index) {
    if (index === 0 || !window.editingRoomData) return;
    const commands = window.editingRoomData.assistantCommands;
    [commands[index - 1], commands[index]] = [commands[index], commands[index - 1]];
    refreshCommandList();
}

function moveCommandDown(index) {
    if (!window.editingRoomData) return;
    const commands = window.editingRoomData.assistantCommands;
    if (index >= commands.length - 1) return;
    [commands[index], commands[index + 1]] = [commands[index + 1], commands[index]];
    refreshCommandList();
}

// Spotify Playlist Management
function addSpotifyPlaylist() {
    const label = document.getElementById('newPlaylistLabel').value.trim();
    const playlistUrl = document.getElementById('newPlaylistUrl').value.trim();
    const icon = document.getElementById('newPlaylistIcon').value.trim() || 'queue_music';

    if (!label || !playlistUrl) {
        showError('Please enter both label and playlist URL');
        return;
    }

    if (!window.editingRoomData) {
        window.editingRoomData = { entities: [], assistantCommands: [], spotifyPlaylists: [] };
    }

    if (!window.editingRoomData.spotifyPlaylists) {
        window.editingRoomData.spotifyPlaylists = [];
    }

    window.editingRoomData.spotifyPlaylists.push({ label, playlistUrl, icon });
    document.getElementById('newPlaylistLabel').value = '';
    document.getElementById('newPlaylistUrl').value = '';
    document.getElementById('newPlaylistIcon').value = 'queue_music';
    document.getElementById('selectedPlaylistIconPreview').textContent = 'queue_music';
    document.getElementById('selectedPlaylistIconName').textContent = 'queue_music';
    
    refreshPlaylistList();
}

function editSpotifyPlaylist(index) {
    if (!window.editingRoomData || !window.editingRoomData.spotifyPlaylists[index]) return;
    
    const playlist = window.editingRoomData.spotifyPlaylists[index];
    document.getElementById('newPlaylistLabel').value = playlist.label;
    document.getElementById('newPlaylistUrl').value = playlist.playlistUrl;
    document.getElementById('newPlaylistIcon').value = playlist.icon || 'queue_music';
    document.getElementById('selectedPlaylistIconPreview').textContent = playlist.icon || 'queue_music';
    document.getElementById('selectedPlaylistIconName').textContent = playlist.icon || 'queue_music';
    
    // Remove the playlist so it can be re-added with new values
    window.editingRoomData.spotifyPlaylists.splice(index, 1);
    refreshPlaylistList();
    
    // Focus on label input
    document.getElementById('newPlaylistLabel').focus();
}

function removeSpotifyPlaylist(index) {
    if (window.editingRoomData && window.editingRoomData.spotifyPlaylists) {
        window.editingRoomData.spotifyPlaylists.splice(index, 1);
        refreshPlaylistList();
    }
}

function refreshPlaylistList() {
    const list = document.getElementById('playlistList');
    list.innerHTML = '';
    if (window.editingRoomData.spotifyPlaylists) {
        window.editingRoomData.spotifyPlaylists.forEach((playlist, idx) => {
            const item = document.createElement('div');
            item.className = 'entity-item';
            const iconDisplay = playlist.icon ? `<span style="font-family: 'Material Symbols Outlined'; font-size: 14px; color: #1ed760; margin-right: 4px;">${playlist.icon}</span>` : '';
            item.innerHTML = `
                <div style="display: flex; gap: 8px; align-items: center;">
                    <div style="display: flex; flex-direction: column; gap: 4px;">
                        <button class="reorder-btn" onclick="movePlaylistUp(${idx})" ${idx === 0 ? 'disabled' : ''}>arrow_upward</button>
                        <button class="reorder-btn" onclick="movePlaylistDown(${idx})" ${idx === window.editingRoomData.spotifyPlaylists.length - 1 ? 'disabled' : ''}>arrow_downward</button>
                    </div>
                    <div>
                        <div>${iconDisplay}<strong>${playlist.label}</strong></div>
                        <small style="color: #888;">${playlist.playlistUrl.substring(0, 50)}...</small>
                    </div>
                </div>
                <div style="display: flex; gap: 8px;">
                    <button class="edit-btn" onclick="editSpotifyPlaylist(${idx})">edit</button>
                    <button class="remove-btn" onclick="removeSpotifyPlaylist(${idx})">Remove</button>
                </div>
            `;
            list.appendChild(item);
        });
    }
}

function movePlaylistUp(index) {
    if (index === 0 || !window.editingRoomData) return;
    const playlists = window.editingRoomData.spotifyPlaylists;
    [playlists[index - 1], playlists[index]] = [playlists[index], playlists[index - 1]];
    refreshPlaylistList();
}

function movePlaylistDown(index) {
    if (!window.editingRoomData) return;
    const playlists = window.editingRoomData.spotifyPlaylists;
    if (index >= playlists.length - 1) return;
    [playlists[index], playlists[index + 1]] = [playlists[index + 1], playlists[index]];
    refreshPlaylistList();
}

function openPlaylistIconPicker() {
    window.playlistIconPickerMode = true;
    openIconPicker();
}

// ============================================
// CLIMATE CONTROL MODAL
// ============================================
let currentClimateEntity = null;

function openClimateModal(entityId) {
    currentClimateEntity = entityId;
    const state = entityStates[entityId];
    
    if (!state) return;
    
    const modal = document.getElementById('climateModal');
    const entity = config.entities.find(e => e.id === entityId);
    
    // Update modal title
    document.getElementById('climateModalTitle').textContent = entity ? entity.label : 'Climate Control';
    
    // Update current temperature
    const currentTemp = state.attributes.current_temperature;
    const unit = state.attributes.unit_of_measurement || '°C';
    const displayCurrent = currentTemp % 1 === 0 ? Math.round(currentTemp) : currentTemp;
    document.getElementById('climateCurrentTemp').textContent = `${displayCurrent}${unit}`;
    
    // Update target temperature
    const targetTemp = state.attributes.temperature || currentTemp;
    const displayTarget = targetTemp % 1 === 0 ? Math.round(targetTemp) : targetTemp;
    document.getElementById('climateTargetTemp').textContent = `${displayTarget}${unit}`;
    
    // Update mode selector
    const modeSelector = document.getElementById('climateModeSelector');
    modeSelector.innerHTML = '';
    
    const hvacModes = state.attributes.hvac_modes || ['off', 'heat', 'cool', 'auto'];
    const currentMode = state.state;
    
    hvacModes.forEach(mode => {
        const btn = document.createElement('button');
        btn.className = 'climate-mode-btn';
        btn.textContent = mode === 'heat_cool' ? 'heat/cool' : mode;
        
        if (mode === currentMode) {
            btn.classList.add('active', mode);
        }
        
        btn.onclick = () => setClimateMode(entityId, mode);
        modeSelector.appendChild(btn);
    });
    
    modal.classList.add('active');
}

function openHeaderClimateModal() {
    if (config.headerTempEntity) {
        const domain = config.headerTempEntity.split('.')[0];
        if (domain === 'climate') {
            openClimateModal(config.headerTempEntity);
        }
    }
}

function closeClimateModal(event) {
    if (event && event.target !== event.currentTarget) return;
    document.getElementById('climateModal').classList.remove('active');
    currentClimateEntity = null;
}

async function adjustModalTemperature(delta) {
    if (!currentClimateEntity) return;
    
    await adjustTemperature(currentClimateEntity, delta);
    
    // Update modal display
    setTimeout(() => {
        const state = entityStates[currentClimateEntity];
        if (state) {
            const targetTemp = state.attributes.temperature;
            const unit = state.attributes.unit_of_measurement || '°C';
            const displayTarget = targetTemp % 1 === 0 ? Math.round(targetTemp) : targetTemp;
            document.getElementById('climateTargetTemp').textContent = `${displayTarget}${unit}`;
        }
    }, 200);
}

async function setClimateMode(entityId, mode) {
    try {
        await callHA('services/climate/set_hvac_mode', 'POST', {
            entity_id: entityId,
            hvac_mode: mode
        });
        
        setTimeout(() => {
            getStates().then(() => {
                renderPages();
                // Refresh modal if still open
                if (currentClimateEntity === entityId) {
                    openClimateModal(entityId);
                }
            });
        }, 100);
    } catch (error) {
        console.error('Failed to set climate mode:', error);
        showError('Failed to set mode');
    }
}

// ============================================
// WEATHER FORECAST MODAL
// ============================================
function renderInlineForecastStrip(tile, forecast, forecastType = 'daily') {
    const existing = tile.querySelector('.weather-forecast-strip');
    if (existing) existing.remove();
    const strip = document.createElement('div');
    strip.className = 'weather-forecast-strip';
    forecast.slice(0, 4).forEach(period => {
        const dt = new Date(period.datetime);
        const label = forecastType === 'hourly'
            ? dt.toLocaleTimeString('en', { hour: 'numeric' })
            : dt.toLocaleDateString('en', { weekday: 'short' });
        const icon = WEATHER_ICONS[period.condition] || 'cloud';
        const temp = period.temperature !== undefined ? `${Math.round(period.temperature)}°` : '—';
        const item = document.createElement('div');
        item.className = 'weather-forecast-item';
        item.innerHTML = `
            <span class="material-symbols-outlined weather-forecast-icon">${icon}</span>
            <span class="weather-forecast-day">${label}</span>
            <span class="weather-forecast-temp">${temp}</span>
        `;
        strip.appendChild(item);
    });
    tile.appendChild(strip);
}

async function fetchInlineForecast(entityId, forecastType = 'daily') {
    try {
        const response = await callHA('services/weather/get_forecasts?return_response=true', 'POST', {
            entity_id: entityId,
            type: forecastType
        });
        let data = [];
        if (response.service_response?.[entityId]?.forecast) data = response.service_response[entityId].forecast;
        else if (response[entityId]?.forecast) data = response[entityId].forecast;
        else if (response.forecast) data = response.forecast;
        else if (Array.isArray(response)) data = response;

        if (data.length > 0) {
            forecastCache[entityId] = { type: forecastType, data };
            const liveTile = document.querySelector(`[data-entity-id="${entityId}"]`);
            if (liveTile) renderInlineForecastStrip(liveTile, data, forecastType);
        }
    } catch (e) {
        // Forecast unavailable — strip stays hidden
    }
}

async function openWeatherForecast(entityId) {
    const state = entityStates[entityId];
    if (!state) return;
    
    const modal = document.getElementById('weatherModal');
    const entity = config.entities.find(e => e.id === entityId);
    
    // Update modal title
    document.getElementById('weatherModalTitle').textContent = entity ? entity.label : 'Weather';
    
    // Update current weather
    const currentWeather = document.getElementById('weatherCurrent');
    const temp = state.attributes.temperature;
    const unit = state.attributes.temperature_unit || '°C';
    const condition = formatWeatherCondition(state.state);
    const icon = WEATHER_ICONS[state.state] || 'cloud';
    
    currentWeather.innerHTML = `
        <div class="weather-current-icon">${icon}</div>
        <div class="weather-current-info">
            <div class="weather-current-temp">${Math.round(temp)}${unit}</div>
            <div class="weather-current-condition">${condition}</div>
        </div>
    `;
    
    // Update forecast list
    const forecastList = document.getElementById('weatherForecastList');
    forecastList.innerHTML = '<div style="text-align: center; padding: 20px; color: rgba(255, 255, 255, 0.5);">Loading forecast...</div>';
    
    modal.classList.add('active');

    const modalForecastType = entity?.modalForecastType || 'hourly';

    // Fetch forecast data using weather.get_forecasts service
    try {
        const forecastResponse = await callHA('services/weather/get_forecasts?return_response=true', 'POST', {
            entity_id: entityId,
            type: modalForecastType
        });
        
        console.log('Forecast response:', forecastResponse);
        
        // The response format is: { service_response: { "weather.entity_id": { "forecast": [...] } } }
        let forecastData = [];
        
        if (forecastResponse.service_response?.[entityId]?.forecast) {
            forecastData = forecastResponse.service_response[entityId].forecast;
        } else if (forecastResponse[entityId]?.forecast) {
            forecastData = forecastResponse[entityId].forecast;
        } else if (forecastResponse.forecast) {
            forecastData = forecastResponse.forecast;
        } else if (Array.isArray(forecastResponse)) {
            forecastData = forecastResponse;
        } else {
            // Fallback to state attributes
            forecastData = state.attributes.forecast || [];
        }
        
        console.log('Parsed forecast data:', forecastData);
        
        forecastList.innerHTML = '';
        
        if (forecastData.length === 0) {
            forecastList.innerHTML = `
                <div style="text-align: center; padding: 20px; color: rgba(255, 255, 255, 0.5); font-size: 14px;">
                    No forecast data available.<br>
                    <small style="font-size: 12px; margin-top: 8px; display: block;">
                        Make sure your weather integration provides forecast data.
                    </small>
                </div>
            `;
        } else {
            // Show next 5 forecast periods (reduced from 6 to fit without scrollbar)
            forecastData.slice(0, 5).forEach(item => {
                const forecastItem = document.createElement('div');
                forecastItem.className = 'weather-forecast-item';

                // Format datetime
                const date = new Date(item.datetime);
                const now = new Date();
                const isToday = date.toDateString() === now.toDateString();
                const isTomorrow = date.toDateString() === new Date(now.getTime() + 86400000).toDateString();
                const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

                let timeStr;
                if (modalForecastType === 'daily') {
                    timeStr = isToday ? 'Today' : isTomorrow ? 'Tomorrow' : days[date.getDay()];
                } else if (isToday) {
                    timeStr = `Today ${date.getHours()}:00`;
                } else if (isTomorrow) {
                    timeStr = `Tomorrow ${date.getHours()}:00`;
                } else {
                    timeStr = `${days[date.getDay()]} ${date.getHours()}:00`;
                }

                const forecastIcon = WEATHER_ICONS[item.condition] || 'cloud';
                const forecastTemp = modalForecastType === 'daily' && item.templow !== undefined
                    ? `${Math.round(item.temperature)}° / ${Math.round(item.templow)}°`
                    : `${Math.round(item.temperature)}${unit}`;

                forecastItem.innerHTML = `
                    <div class="weather-forecast-time">${timeStr}</div>
                    <div class="weather-forecast-icon">${forecastIcon}</div>
                    <div class="weather-forecast-temp">${forecastTemp}</div>
                `;
                
                forecastList.appendChild(forecastItem);
            });
        }
    } catch (error) {
        console.error('Failed to fetch forecast:', error);
        forecastList.innerHTML = `
            <div style="text-align: center; padding: 20px; color: rgba(255, 255, 255, 0.5); font-size: 14px;">
                Failed to load forecast data.<br>
                <small style="font-size: 12px; margin-top: 8px; display: block;">
                    ${error.message || 'Unknown error'}
                </small>
            </div>
        `;
    }
}

function closeWeatherModal(event) {
    if (event && event.target !== event.currentTarget) return;
    document.getElementById('weatherModal').classList.remove('active');
}

// ============================================
// POLLING
// ============================================
function startPolling() {
    if (pollInterval) {
        clearInterval(pollInterval);
    }

    pollInterval = setInterval(async () => {
        await getStates();
        // Don't re-render if user is dragging a slider
        if (!isSliderDragging) {
            renderPages();
        }
    }, 2000);
}

// ============================================
// INITIALIZATION
// ============================================

window.addEventListener('beforeunload', (e) => {
    if (roomEditorSnapshot === null) return;
    const current = JSON.stringify(getRoomEditorCurrentState());
    if (current !== roomEditorSnapshot) {
        e.preventDefault();
        e.returnValue = '';
    }
});

async function init() {
    setupTouchHandlers();
    
    // Check if screensaver mode is requested via URL
    const urlParams = new URLSearchParams(window.location.search);
    const hashParams = window.location.hash;
    const isScreensaverMode = urlParams.get('screensaver') === 'true' || hashParams === '#screensaver';

    if (urlParams.get('debug') === 'true') {
        document.getElementById('debugEditBtn').style.display = 'flex';
        document.getElementById('debugSettingsBtn').style.display = 'flex';
    }
    
    if (isScreensaverMode) {
        // Screensaver-only mode - works without room config
        document.querySelector('.container').style.display = 'none';
        
        // Load global config for HA connection
        globalConfig = await loadGlobalConfig();
        
        if (!globalConfig || !globalConfig.haToken) {
            document.getElementById('screensaver').innerHTML = '<div style="display: flex; align-items: center; justify-content: center; height: 100vh; color: white; font-family: Inter; font-size: 18px;">Please configure Home Assistant connection first<br><br>Visit the main dashboard to set up</div>';
            document.getElementById('screensaver').classList.add('active');
            return;
        }
        
        // Create a minimal config for screensaver
        config = {
            roomName: 'Screensaver',
            headerTempEntity: globalConfig.screensaverTempEntity || '',
            screensaverWeather: globalConfig.screensaverWeather || '',
            entities: []
        };
        
        await getStates();
        
        // Show screensaver immediately and keep it visible
        document.getElementById('screensaver').classList.add('active');
        document.getElementById('screensaver').style.cursor = 'default';
        updateScreensaverClock();
        screensaverClockInterval = setInterval(updateScreensaverClock, 1000);
        
        // Update states periodically
        setInterval(async () => {
            await getStates();
            updateScreensaverClock();
        }, 30000); // Update every 30 seconds
        
        return;
    }
    
    // Load configuration for normal mode
    config = await loadConfig();
    globalConfig = await loadGlobalConfig();
    roomConfigs = await loadRoomConfigs();
    
    applyFontFamily();
    applyDeviceModel();
    applyVoiceMessageVisibility();
    applyHeaderVisibility();

    // Override active room from URL param (enables shareable room URLs)
    const adminView = urlParams.get('admin');
    const roomParam = urlParams.get('room');
    if (roomParam && !adminView) {
        const idx = roomConfigs.findIndex(r => r.roomName === roomParam);
        if (idx >= 0) config = { ...globalConfig, ...roomConfigs[idx] };
    }

    // Restore admin view from URL params on reload
    if (adminView && (config || globalConfig.haToken)) {
        document.getElementById('adminPanel').classList.add('active');
        if (adminView === 'settings') {
            showGlobalSettings();
        } else if (adminView === 'editor') {
            const editorMode = urlParams.get('mode') || 'edit';
            const editorRoomParam = urlParams.get('room');
            const editorRoomIdx = editorRoomParam ? roomConfigs.findIndex(r => r.roomName === editorRoomParam) : -1;
            showRoomEditor(editorMode, editorRoomIdx >= 0 ? editorRoomIdx : undefined);
        } else {
            showRoomManager();
        }
        return;
    }

    // Set frontend room param so reload returns to the same room
    if (config) {
        const params = new URLSearchParams(window.location.search);
        params.set('room', config.roomName);
        history.replaceState(null, '', '?' + params.toString());
    }

    // Normal mode - setup inactivity screensaver only if not disabled
    if (!globalConfig.disableBuiltInScreensaver) {
        setupInactivityDetection();
        // Add click handler to exit screensaver in normal mode
        document.getElementById('screensaver').onclick = exitScreensaver;
    }

    if (!config || !globalConfig.haToken) {
        openAdmin();
        return;
    }

    const states = await getStates();
    if (states) {
        renderPages();
        startPolling();
    } else {
        showError('Cannot connect to Home Assistant');
        setTimeout(openAdmin, 2000);
    }
}

// Start the app
init();


// ============================================
// ICON PICKER
// ============================================
const COMMON_ICONS = [
    'lightbulb', 'power', 'power_settings_new', 'toggle_on', 'toggle_off',
    'blinds', 'curtains', 'window', 'door_front', 'door_open',
    'thermostat', 'ac_unit', 'heat', 'mode_fan', 'air',
    'lock', 'lock_open', 'garage', 'garage_home', 'meeting_room',
    'sensors', 'device_thermostat', 'water_drop', 'opacity', 'bolt',
    'play_circle', 'pause_circle', 'stop_circle', 'skip_next', 'skip_previous',
    'volume_up', 'volume_down', 'volume_off', 'speaker', 'tv',
    'light', 'wb_incandescent', 'wb_sunny', 'brightness_high', 'brightness_low',
    'home', 'bed', 'chair', 'kitchen', 'bathroom',
    'weekend', 'nights_stay', 'wb_twilight', 'dark_mode', 'brightness_4',
    'alarm', 'schedule', 'timer', 'hourglass_empty', 'notifications',
    'security', 'shield', 'verified', 'warning', 'error',
    'check_circle', 'cancel', 'info', 'help', 'settings',
    'palette', 'color_lens', 'gradient', 'invert_colors', 'format_paint',
    'music_note', 'headphones', 'radio', 'podcasts', 'mic',
    'camera', 'videocam', 'photo_camera', 'image', 'movie',
    'cloud', 'wb_cloudy', 'nights_stay', 'rainy', 'thunderstorm',
    'sunny', 'nightlight', 'foggy', 'ac_unit', 'severe_cold',
    'local_fire_department', 'whatshot', 'fireplace', 'outdoor_grill', 'propane_tank',
    'water', 'waves', 'pool', 'hot_tub', 'shower',
    'coffee', 'restaurant', 'local_cafe', 'local_bar', 'local_pizza',
    'directions_car', 'garage_home', 'ev_station', 'local_gas_station', 'two_wheeler',
    'pets', 'cruelty_free', 'eco', 'energy_savings_leaf', 'recycling',
    'workspaces', 'dashboard', 'grid_view', 'view_module', 'apps',
    'outlet', 'power_input', 'electrical_services', 'cable', 'router',
    'wifi', 'bluetooth', 'cast', 'devices', 'phone_android',
    'computer', 'laptop', 'tablet', 'watch', 'headset',
    'videogame_asset', 'sports_esports', 'toys', 'celebration', 'cake'
];

function openIconPicker() {
    const modal = document.getElementById('iconPickerModal');
    const searchInput = document.getElementById('iconSearchInput');
    const customInput = document.getElementById('iconCustomInput');
    const customPreview = document.getElementById('iconCustomPreview');

    renderIconGrid(COMMON_ICONS);

    searchInput.value = '';
    searchInput.oninput = (e) => {
        const query = e.target.value.toLowerCase();
        renderIconGrid(query ? COMMON_ICONS.filter(icon => icon.includes(query)) : COMMON_ICONS);
    };

    customInput.value = '';
    customPreview.textContent = '';
    customInput.oninput = (e) => {
        customPreview.textContent = e.target.value.trim();
    };
    customInput.onkeydown = (e) => {
        if (e.key === 'Enter') selectCustomIcon();
    };

    modal.classList.add('active');
    setTimeout(() => searchInput.focus(), 50);
}

function selectCustomIcon() {
    const name = document.getElementById('iconCustomInput').value.trim();
    if (name) selectIcon(name);
}

function renderIconGrid(icons) {
    const grid = document.getElementById('iconGrid');
    grid.innerHTML = '';
    
    if (icons.length === 0) {
        grid.innerHTML = '<div style="grid-column: 1 / -1; text-align: center; padding: 20px; color: rgba(255,255,255,0.5);">No icons found</div>';
        return;
    }
    
    icons.forEach(icon => {
        const item = document.createElement('div');
        item.className = 'icon-item';
        item.innerHTML = `
            <div class="icon-item-icon">${icon}</div>
            <div class="icon-item-name">${icon}</div>
        `;
        item.onclick = () => selectIcon(icon);
        grid.appendChild(item);
    });
}

function selectIcon(iconName) {
    if (window.playlistIconPickerMode) {
        // Playlist icon picker
        document.getElementById('newPlaylistIcon').value = iconName;
        document.getElementById('selectedPlaylistIconPreview').textContent = iconName;
        document.getElementById('selectedPlaylistIconName').textContent = iconName;
        window.playlistIconPickerMode = false;
    } else {
        // Entity icon picker
        document.getElementById('newEntityIcon').value = iconName;
        document.getElementById('selectedIconPreview').textContent = iconName;
        document.getElementById('selectedIconName').textContent = iconName;
    }
    closeIconPicker();
}

function closeIconPicker(event) {
    if (event && event.target !== event.currentTarget) return;
    document.getElementById('iconPickerModal').classList.remove('active');
}


// ============================================
// TEST SOUND
// ============================================
function testSound() {
    const audio = new Audio('/sound.mp3');
    audio.play().then(() => {
        showError('Playing test sound...');
    }).catch(error => {
        console.error('Failed to play sound:', error);
        showError('Failed to play sound. Make sure sound.mp3 exists in the root directory.');
    });
}


// ============================================
// VOICE MESSAGES
// ============================================
let voiceMessages = [];
let isRecording = false;
let mediaRecorder = null;
let recordingChunks = [];
let recordingTimer = null;
let recordingSeconds = 0;

async function loadVoiceMessages() {
    try {
        const response = await fetch('/config-api.php?path=voice_messages');
        const data = await response.json();
        voiceMessages = data || [];
        updatePhoneBadge();
    } catch (error) {
        console.error('Failed to load voice messages:', error);
        voiceMessages = [];
    }
}

const FONT_OPTIONS = {
    'Inter':   { url: 'Inter:wght@200;300;400;500;600;700', stack: "'Inter', sans-serif" },
    'Roboto':  { url: 'Roboto:wght@300;400;500;700', stack: "'Roboto', sans-serif" },
    'Nunito':  { url: 'Nunito:wght@300;400;500;600;700', stack: "'Nunito', sans-serif" },
    'DM Sans': { url: 'DM+Sans:wght@300;400;500;600;700', stack: "'DM Sans', sans-serif" },
    'Outfit':  { url: 'Outfit:wght@300;400;500;600;700', stack: "'Outfit', sans-serif" },
    'Poppins': { url: 'Poppins:wght@300;400;500;600;700', stack: "'Poppins', sans-serif" },
};

function applyFontFamily() {
    const name = globalConfig.fontFamily || 'Inter';
    const font = FONT_OPTIONS[name] || FONT_OPTIONS['Inter'];

    let link = document.getElementById('dynamicFontLink');
    if (!link) {
        link = document.createElement('link');
        link.id = 'dynamicFontLink';
        link.rel = 'stylesheet';
        document.head.appendChild(link);
    }
    link.href = `https://fonts.googleapis.com/css2?family=${font.url}&display=swap`;

    document.documentElement.style.setProperty('--font-body', font.stack);
}

function applyDeviceModel() {
    document.querySelector('.container').classList.toggle('pro120', globalConfig.deviceModel === 'pro120');
}

function applyVoiceMessageVisibility() {
    document.getElementById('phoneBtn').style.display =
        globalConfig.hideVoiceMessages ? 'none' : '';
}

function applyHeaderVisibility() {
    const header = document.querySelector('.header');
    const roomName = document.getElementById('roomName');
    if (!header) return;
    if (globalConfig.hideHeader) {
        header.style.display = 'none';
    } else {
        header.style.display = '';
        // opacity:0 keeps the tap target alive so openAdmin() still works
        if (roomName) roomName.style.opacity = globalConfig.hideRoomName ? '0' : '';
    }
}

function updatePhoneBadge() {
    const badge = document.getElementById('phoneBadge');
    const unreadCount = voiceMessages.filter(m => m.toRoom === config.roomName && !m.read).length;
    
    if (unreadCount > 0) {
        badge.textContent = unreadCount;
        badge.style.display = 'block';
    } else {
        badge.style.display = 'none';
    }
}

async function openVoiceMessageModal() {
    const modal = document.getElementById('voiceMessageModal');
    const content = document.getElementById('voiceMessageContent');
    
    await loadVoiceMessages();
    
    // Filter messages for this room
    const myMessages = voiceMessages.filter(m => m.toRoom === config.roomName);
    
    // Get other rooms
    const otherRooms = roomConfigs.filter(r => r.roomName !== config.roomName);
    
    content.innerHTML = `
        ${myMessages.length > 0 ? `
            <div class="voice-message-list">
                ${myMessages.map((msg, idx) => `
                    <div class="voice-message-item ${!msg.read ? 'unread' : ''}">
                        <button class="voice-message-play" onclick="playVoiceMessage(${idx})">play_arrow</button>
                        <div class="voice-message-info">
                            <div class="voice-message-from">${msg.fromRoom}</div>
                            <div class="voice-message-time">${formatMessageTime(msg.timestamp)}</div>
                        </div>
                        <button class="voice-message-delete" onclick="deleteVoiceMessage(${idx})">delete</button>
                    </div>
                `).join('')}
            </div>
        ` : '<div style="text-align: center; padding: 20px; color: rgba(255,255,255,0.5); font-size: 13px;">No messages</div>'}
        
        <div class="voice-record-section">
            <div class="voice-room-buttons">
                ${otherRooms.map(r => `
                    <button class="voice-room-btn" onclick="selectVoiceTarget('${r.roomName}')">
                        ${r.roomName}
                    </button>
                `).join('')}
                <button class="voice-room-btn broadcast" onclick="selectVoiceTarget('__ALL__')">
                    All Rooms
                </button>
            </div>
            <div id="recordingTimer" class="voice-record-timer" style="display: none;">0:00</div>
            <button class="voice-record-btn" id="recordBtn" onclick="toggleRecording()" disabled>
                <span class="material-symbols-outlined">mic</span>
                <span>Select room to record</span>
            </button>
        </div>
    `;
    
    modal.classList.add('active');
    
    // Mark messages as read
    myMessages.forEach(msg => msg.read = true);
    await saveVoiceMessages();
    updatePhoneBadge();
}

let selectedVoiceTarget = null;

function selectVoiceTarget(target) {
    selectedVoiceTarget = target;
    
    // Update button states
    document.querySelectorAll('.voice-room-btn').forEach(btn => {
        btn.classList.remove('selected');
    });
    event.target.classList.add('selected');
    
    // Enable record button
    const recordBtn = document.getElementById('recordBtn');
    recordBtn.disabled = false;
    
    if (target === '__ALL__') {
        recordBtn.innerHTML = '<span class="material-symbols-outlined">mic</span><span>Record for All Rooms</span>';
    } else {
        recordBtn.innerHTML = `<span class="material-symbols-outlined">mic</span><span>Record for ${target}</span>`;
    }
}

function closeVoiceMessageModal(event) {
    if (event && event.target !== event.currentTarget) return;
    if (isRecording) stopRecording();
    document.getElementById('voiceMessageModal').classList.remove('active');
}

async function toggleRecording() {
    if (isRecording) {
        await stopRecording();
    } else {
        await startRecording();
    }
}

async function startRecording() {
    if (!selectedVoiceTarget) {
        showError('Please select a room first');
        return;
    }
    
    // Check if microphone is available
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        showError('Microphone not supported on this device');
        return;
    }
    
    try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        mediaRecorder = new MediaRecorder(stream);
        recordingChunks = [];
        recordingSeconds = 0;
        
        mediaRecorder.ondataavailable = (e) => {
            if (e.data.size > 0) {
                recordingChunks.push(e.data);
            }
        };
        
        mediaRecorder.onstop = async () => {
            const blob = new Blob(recordingChunks, { type: 'audio/webm' });
            await sendVoiceMessage(blob, selectedVoiceTarget);
            stream.getTracks().forEach(track => track.stop());
        };
        
        mediaRecorder.start();
        isRecording = true;
        
        const btn = document.getElementById('recordBtn');
        btn.classList.add('recording');
        btn.innerHTML = '<span class="material-symbols-outlined">stop</span><span>Stop Recording</span>';
        
        document.getElementById('recordingTimer').style.display = 'block';
        
        recordingTimer = setInterval(() => {
            recordingSeconds++;
            const mins = Math.floor(recordingSeconds / 60);
            const secs = recordingSeconds % 60;
            document.getElementById('recordingTimer').textContent = `${mins}:${secs.toString().padStart(2, '0')}`;
            
            if (recordingSeconds >= 30) {
                stopRecording();
            }
        }, 1000);
        
    } catch (error) {
        console.error('Failed to start recording:', error);
        let errorMsg = 'Failed to access microphone. ';
        
        if (error.name === 'NotAllowedError' || error.name === 'PermissionDeniedError') {
            errorMsg += 'Enable microphone in Fully Kiosk: Settings → Web Content Settings → Advanced Web Settings → Allow Microphone Access';
        } else if (error.name === 'NotFoundError') {
            errorMsg += 'No microphone found on this device.';
        } else if (error.name === 'NotSupportedError') {
            errorMsg += 'HTTPS required. Access via https://your-ip:8443';
        } else {
            errorMsg += error.message;
        }
        
        showError(errorMsg);
    }
}

async function stopRecording() {
    if (!mediaRecorder || !isRecording) return;
    
    isRecording = false;
    clearInterval(recordingTimer);
    
    const btn = document.getElementById('recordBtn');
    btn.classList.remove('recording');
    btn.innerHTML = '<span class="material-symbols-outlined">mic</span><span>Hold to Record</span>';
    
    document.getElementById('recordingTimer').style.display = 'none';
    
    mediaRecorder.stop();
}

async function sendVoiceMessage(audioBlob, toRoom) {
    try {
        // Convert blob to base64
        const reader = new FileReader();
        reader.readAsDataURL(audioBlob);
        
        reader.onloadend = async () => {
            const base64Audio = reader.result;
            
            // Handle broadcast to all rooms
            if (toRoom === '__ALL__') {
                const otherRooms = roomConfigs.filter(r => r.roomName !== config.roomName);
                
                otherRooms.forEach(room => {
                    const message = {
                        fromRoom: config.roomName,
                        toRoom: room.roomName,
                        audioData: base64Audio,
                        timestamp: Date.now(),
                        read: false
                    };
                    voiceMessages.push(message);
                });
                
                await saveVoiceMessages();
                showError(`Voice message broadcast to ${otherRooms.length} rooms`);
            } else {
                const message = {
                    fromRoom: config.roomName,
                    toRoom: toRoom,
                    audioData: base64Audio,
                    timestamp: Date.now(),
                    read: false
                };
                
                voiceMessages.push(message);
                await saveVoiceMessages();
                showError(`Voice message sent to ${toRoom}`);
            }
            
            selectedVoiceTarget = null;
            openVoiceMessageModal(); // Refresh
        };
    } catch (error) {
        console.error('Failed to send voice message:', error);
        showError('Failed to send voice message');
    }
}

async function saveVoiceMessages() {
    try {
        await fetch('/config-api.php?path=voice_messages', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(voiceMessages)
        });
    } catch (error) {
        console.error('Failed to save voice messages:', error);
    }
}

async function playVoiceMessage(index) {
    const myMessages = voiceMessages.filter(m => m.toRoom === config.roomName);
    const message = myMessages[index];
    
    if (!message) return;
    
    try {
        const audio = new Audio(message.audioData);
        await audio.play();
    } catch (error) {
        console.error('Failed to play message:', error);
        showError('Failed to play message');
    }
}

async function deleteVoiceMessage(index) {
    const myMessages = voiceMessages.filter(m => m.toRoom === config.roomName);
    const message = myMessages[index];
    
    if (!message) return;
    
    const globalIndex = voiceMessages.indexOf(message);
    voiceMessages.splice(globalIndex, 1);
    
    await saveVoiceMessages();
    openVoiceMessageModal(); // Refresh
}

function formatMessageTime(timestamp) {
    const date = new Date(timestamp);
    const now = new Date();
    const diff = now - date;
    
    if (diff < 60000) return 'Just now';
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
    
    return date.toLocaleDateString();
}

// Check for new messages periodically
setInterval(async () => {
    if (config && config.roomName) {
        await loadVoiceMessages();
        
        // Auto-play unread messages
        const unreadMessages = voiceMessages.filter(m => m.toRoom === config.roomName && !m.read);
        
        if (unreadMessages.length > 0) {
            // Play notification sound
            try {
                const notifSound = new Audio('/sound.mp3');
                await notifSound.play();
            } catch (e) {
                console.log('Could not play notification sound');
            }
            
            // Auto-play the first unread message
            const message = unreadMessages[0];
            try {
                const audio = new Audio(message.audioData);
                await audio.play();
                
                // Mark as read
                message.read = true;
                await saveVoiceMessages();
                updatePhoneBadge();
            } catch (error) {
                console.error('Failed to auto-play message:', error);
            }
        }
    }
}, 5000); // Check every 5 seconds
