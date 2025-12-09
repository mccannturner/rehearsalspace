// ========= SPLASH =========
console.log("Rehearsal Space script loaded");
const splash = document.getElementById("splash");
function hideSplash() {
    if (!splash) return;
    splash.classList.add("splash-hide");
    setTimeout(() => {
        if (splash && splash.parentNode) {
            splash.parentNode.removeChild(splash);
        }
    }, 500);
}
window.addEventListener("load", () => {
    setTimeout(hideSplash, 1200);
});

// ========= DOM ELEMENTS =========
const roomInput = document.getElementById("room");
const startButton = document.getElementById("start");
const roomStatus = document.getElementById("room-status");
const userList = document.getElementById("user-list");
const latencyDisplay = document.getElementById("latency-display");
const latencyStats = document.getElementById("latency-stats");

const audioStatusPill = document.getElementById("audio-status-pill");
const audioStatusDot = document.getElementById("audio-status-dot");
const audioStatusText = document.getElementById("audio-status-text");

const inviteLinkInput = document.getElementById("invite-link");
const inviteCopyButton = document.getElementById("invite-copy");
const inviteCopiedLabel = document.getElementById("invite-copied");

const chatMessages = document.getElementById("chat-messages");
const chatInput = document.getElementById("chat-input");
const chatSend = document.getElementById("chat-send");

const bpmInput = document.getElementById("bpm");
const metronomeButton = document.getElementById("metronome");
const shareMetronomeCheckbox = document.getElementById("share-metronome");
const beatIndicator = document.getElementById("beat-indicator");
const metronomeVolumeSlider = document.getElementById("metronome-volume");
const timeSignatureSelect = document.getElementById("time-signature");

const recordButton = document.getElementById("record");
const recordingsContainer = document.getElementById("recordings");
const takeLabelInput = document.getElementById("take-label");

const backingStatus = document.getElementById("backing-status");
const useBackingCheckbox = document.getElementById("use-backing");

const remoteVolumeSlider = document.getElementById("remote-volume");
const muteRemoteCheckbox = document.getElementById("mute-remote");
const userMixerContainer = document.getElementById("user-mixer");

const recordingsListContainer = document.getElementById("recordings-list");
const recordingBanner = document.getElementById("recording-banner");

// ========= SIGNALING / ROOM STATE =========
const serverUrl =
    (window.location.protocol === "https:" ? "wss://" : "ws://") +
    window.location.host;

let socket = null;
let currentRoomId = null;
let myUserId = null;
let usersInRoom = [];

let pingIntervalId = null;
let latencySamples = [];

// ========= WEBRTC / AUDIO STATE =========
let localStream = null;
let audioContext = null;
let localSource = null;
let recordDestination = null;

const peerConnections = new Map();        // userId -> RTCPeerConnection
const remoteGains = new Map();            // userId -> GainNode (unused in simple mode)
const remoteAudioElements = new Map();    // userId -> <audio>
const userGains = new Map();              // userId -> 0..1 per-user volume

let mediaRecorder = null;
let recordedChunks = [];

// Backing track state
let backingTrackConfig = null;      // { title, audioDataUrl, bpm, roomId }
let backingAudioElement = null;
let backingSourceNode = null;
let backingConnected = false;

// Metronome
let metronomeTimer = null;
let metronomeRunning = false;
let metronomeIsShared = false;
let metronomeBpm = 120;
let metronomeBeatsPerBar = 4;
let metronomeCurrentBeat = 0;

// ========= RECORDING SESSION STATE =========
const SessionState = {
    IDLE: "idle",
    COUNT_IN: "count_in",
    RECORDING: "recording",
    SAVING: "saving"
};

let sessionState = SessionState.IDLE;
let recorderId = null;

// ========= HELPERS =========
function isMe(userId) {
    return userId && myUserId && userId === myUserId;
}

function updateRecordingButtonForState() {
    if (!recordButton) return;

    const iAmRecorder = isMe(recorderId);

    if (sessionState === SessionState.IDLE) {
        recordButton.disabled = false;
        recordButton.textContent = "Start Recording";
    } else if (sessionState === SessionState.COUNT_IN) {
        if (iAmRecorder) {
            recordButton.disabled = false; // you can still click to stop/cancel if you wire that later
            recordButton.textContent = "Count-in… (record armed)";
        } else {
            recordButton.disabled = true;
            recordButton.textContent = "Recording will start…";
        }
    } else if (sessionState === SessionState.RECORDING) {
        if (iAmRecorder) {
            recordButton.disabled = false;
            recordButton.textContent = "Stop Recording";
        } else {
            recordButton.disabled = true;
            recordButton.textContent = "Recording in progress";
        }
    } else if (sessionState === SessionState.SAVING) {
        recordButton.disabled = true;
        recordButton.textContent = iAmRecorder ? "Saving take…" : "Saving recording…";
    }
}

function setMixerLocked(locked) {
    if (remoteVolumeSlider) remoteVolumeSlider.disabled = locked;
    if (muteRemoteCheckbox) muteRemoteCheckbox.disabled = locked;

    if (userMixerContainer) {
        const sliders = userMixerContainer.querySelectorAll('input[type="range"]');
        sliders.forEach((slider) => {
            slider.disabled = locked;
        });
    }

    const mixerCard = document.querySelector(".card-mixer");
    if (mixerCard) {
        mixerCard.classList.toggle("card-locked", locked);
    }
}

function setMetronomeLocked(locked) {
    if (bpmInput) bpmInput.disabled = locked;
    if (timeSignatureSelect) timeSignatureSelect.disabled = locked;
    if (metronomeButton) metronomeButton.disabled = locked;
    if (metronomeVolumeSlider) metronomeVolumeSlider.disabled = locked;
    if (shareMetronomeCheckbox) shareMetronomeCheckbox.disabled = locked;

    // The metronome lives inside the "Metronome" tab panel
    const metronomePanel = document.querySelector('.tab-panel[data-tab="metronome"]');
    if (metronomePanel) {
        metronomePanel.classList.toggle("card-locked", locked);
    }
}

function setBackingLocked(locked) {
    if (useBackingCheckbox) useBackingCheckbox.disabled = locked;

    const recordingCard = document.querySelector(".card-recording");
    if (recordingCard) {
        recordingCard.classList.toggle("card-locked", locked);
    }
}

function applyLockStateForSession() {
    const locked = (
        sessionState === SessionState.COUNT_IN ||
        sessionState === SessionState.RECORDING ||
        sessionState === SessionState.SAVING
    );

    setMixerLocked(locked);
    setMetronomeLocked(locked);
    setBackingLocked(locked);
}

function createRandomUserId() {
    return "user-" + Math.random().toString(36).slice(2, 10);
}

function updateRoomStatus() {
    if (!currentRoomId) {
        roomStatus.textContent = "Not in a room";
    } else {
        roomStatus.textContent = `In room: ${currentRoomId}`;
    }
    updateAudioStatus();
    updateInviteLink();
}

function updateUserList() {
    if (!userList) return;

    userList.innerHTML = "";

    if (!usersInRoom.length) {
        const li = document.createElement("li");
        li.textContent = "No one here yet.";
        userList.appendChild(li);
        return;
    }

    // Put "You" first, then bandmates
    const sorted = [...usersInRoom];
    sorted.sort((a, b) => {
        if (a === myUserId) return -1;
        if (b === myUserId) return 1;
        return 0;
    });

    let bandmateNumber = 1;

    sorted.forEach((uid) => {
        const li = document.createElement("li");

        if (uid === myUserId) {
            li.textContent = "You";
        } else {
            li.textContent = `Bandmate ${bandmateNumber++}`;
        }

        userList.appendChild(li);
    });

    // Keep mixer UI in sync
    updateUserMixerUI();
}

function updateUserMixerUI() {
    if (!userMixerContainer) return;

    userMixerContainer.innerHTML = "";

    usersInRoom.forEach((uid) => {
        if (uid === myUserId) return; // don’t mix yourself here

        const row = document.createElement("div");
        row.className = "slider-row";

        const label = document.createElement("label");
        label.className = "small-label";
        label.textContent = uid;

        const slider = document.createElement("input");
        slider.type = "range";
        slider.min = "0";
        slider.max = "100";

        const gain = userGains.has(uid) ? userGains.get(uid) : 1;
        slider.value = Math.round(gain * 100);

        slider.addEventListener("input", () => {
            const value = parseInt(slider.value, 10) || 0;
            userGains.set(uid, value / 100);
            applyVolumes();
        });

        row.appendChild(label);
        row.appendChild(slider);
        userMixerContainer.appendChild(row);
    });
}

function updateLatencyDisplay(latencyMs) {
    if (!latencyDisplay) return;

    if (latencyMs == null) {
        latencyDisplay.textContent = "Latency: -- (waiting for other users)";
        return;
    }

    let quality, color;
    if (latencyMs < 40) {
        quality = "Good";
        color = "green";
    } else if (latencyMs < 80) {
        quality = "OK";
        color = "orange";
    } else {
        quality = "Poor";
        color = "red";
    }

    latencyDisplay.innerHTML =
        `<span class="latency-dot" style="background-color:${color};"></span>` +
        `${latencyMs} ms — ${quality}`;
}

function updateLatencyStats() {
    if (!latencyStats) return;

    if (!latencySamples.length) {
        latencyStats.textContent = "Avg: -- ms · Min: -- · Max: -- · Jitter: -- ms (0 samples)";
        return;
    }

    let sum = 0;
    let min = Infinity;
    let max = -Infinity;

    for (const v of latencySamples) {
        sum += v;
        if (v < min) min = v;
        if (v > max) max = v;
    }

    const avg = sum / latencySamples.length;

    // Jitter = avg absolute deviation from the mean
    let devSum = 0;
    for (const v of latencySamples) {
        devSum += Math.abs(v - avg);
    }
    const jitter = devSum / latencySamples.length;

    latencyStats.textContent =
        `Avg: ${avg.toFixed(1)} ms · Min: ${min} · Max: ${max} · ` +
        `Jitter: ${jitter.toFixed(1)} ms (${latencySamples.length} samples)`;
}

// ========= RECORDINGS STORAGE =========

const RECORDINGS_KEY = "rehearsalSpaceRecordings";

function getRecordingsStore() {
    try {
        const raw = localStorage.getItem(RECORDINGS_KEY);
        if (!raw) return [];

        const data = JSON.parse(raw);
        return Array.isArray(data) ? data : [];
    } catch (e) {
        console.warn("getRecordingsStore: failed to parse localStorage:", e);
        return [];
    }
}

function saveRecordingsStore(list) {
    try {
        localStorage.setItem(RECORDINGS_KEY, JSON.stringify(list));
    } catch (e) {
        console.warn("saveRecordingsStore: failed to write localStorage:", e);
    }
}

function saveRecordingToStore(roomName, bpmValue, label, timestampMs, audioDataUrl) {
    const recordings = getRecordingsStore();

    recordings.push({
        roomId: roomName || "Untitled room",
        bpm: bpmValue || null,
        label: label || "",
        timestamp: timestampMs || Date.now(),
        audioDataUrl: audioDataUrl || null
    });

    saveRecordingsStore(recordings);
    console.log("Saved recording:", {
        roomId: roomName,
        bpm: bpmValue,
        label,
        timestamp: timestampMs
    });
}

function loadRecordingsList() {
    if (!recordingsListContainer) return;

    recordingsListContainer.innerHTML = "";

    const recordings = getRecordingsStore();

    if (!recordings.length) {
        const empty = document.createElement("div");
        empty.className = "small-label";
        empty.textContent = "No recordings saved yet. Record something to see it here.";
        recordingsListContainer.appendChild(empty);
        return;
    }

    // Newest first
    recordings.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

    recordings.forEach((rec, index) => {
        const row = document.createElement("div");
        row.className = "section-row";
        row.style.justifyContent = "space-between";
        row.style.alignItems = "center";
        row.style.flexWrap = "wrap";

        const info = document.createElement("div");
        info.style.display = "flex";
        info.style.flexDirection = "column";

        const title = document.createElement("div");
        title.style.fontSize = "13px";
        title.style.fontWeight = "500";

        const label = rec.label && rec.label.trim()
            ? rec.label.trim()
            : `Take ${recordings.length - index}`;
        title.textContent = label;

        const meta = document.createElement("div");
        meta.className = "small-label";

        const roomName = rec.roomId || "Unknown room";
        const bpm = rec.bpm ? `${rec.bpm} BPM` : "BPM unknown";

        const date = rec.timestamp ? new Date(rec.timestamp) : null;
        const dateStr = date
            ? date.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
            : "Time unknown";

        meta.textContent = `${roomName} • ${bpm} • ${dateStr}`;

        info.appendChild(title);
        info.appendChild(meta);

        const actions = document.createElement("div");
        actions.style.display = "flex";
        actions.style.gap = "6px";
        actions.style.marginTop = "4px";

        // Play button
        const playBtn = document.createElement("button");
        playBtn.type = "button";
        playBtn.className = "secondary";
        playBtn.textContent = "Play";

        playBtn.addEventListener("click", () => {
            if (!rec.audioDataUrl) {
                alert("This recording has no audio data stored.");
                return;
            }
            try {
                const audio = new Audio(rec.audioDataUrl);
                audio.play().catch((err) => {
                    console.warn("Playback failed:", err);
                });
            } catch (e) {
                console.warn("Could not play recording:", e);
            }
        });

        // Use as backing button
        const useBtn = document.createElement("button");
        useBtn.type = "button";
        useBtn.textContent = "Use as backing";

        useBtn.addEventListener("click", () => {
            if (!rec.audioDataUrl) {
                alert("This recording has no audio data stored.");
                return;
            }

            backingTrackConfig = {
                title: label,
                audioDataUrl: rec.audioDataUrl,
                bpm: rec.bpm || null,
                roomId: rec.roomId || null
            };

            console.log("Backing track set from recordings list:", backingTrackConfig);
            updateBackingUI();

            const recordingCard = document.querySelector(".card-recording");
            if (recordingCard) {
                recordingCard.scrollIntoView({ behavior: "smooth", block: "start" });
            }
        });

        // Delete button
        const deleteBtn = document.createElement("button");
        deleteBtn.type = "button";
        deleteBtn.className = "secondary";
        deleteBtn.textContent = "Delete";

        deleteBtn.addEventListener("click", () => {
            const ok = confirm(`Delete "${label}"? This cannot be undone.`);
            if (!ok) return;

            try {
                const current = getRecordingsStore();

                const filtered = current.filter((r) => {
                    const sameTimestamp = r.timestamp === rec.timestamp;
                    const sameRoom = (r.roomId || "") === (rec.roomId || "");
                    const sameLabel = (r.label || "") === (rec.label || "");
                    return !(sameTimestamp && sameRoom && sameLabel);
                });

                saveRecordingsStore(filtered);

                if (
                    backingTrackConfig &&
                    backingTrackConfig.audioDataUrl &&
                    rec.audioDataUrl &&
                    backingTrackConfig.audioDataUrl === rec.audioDataUrl
                ) {
                    backingTrackConfig = null;
                    updateBackingUI();
                }

                loadRecordingsList();
            } catch (e) {
                console.warn("Failed to delete recording:", e);
                alert("Could not delete this recording. Check the console for details.");
            }
        });

        actions.appendChild(playBtn);
        actions.appendChild(useBtn);
        actions.appendChild(deleteBtn);

        row.appendChild(info);
        row.appendChild(actions);

        recordingsListContainer.appendChild(row);
    });
}

function updateInviteLink() {
    if (!inviteLinkInput || !inviteCopyButton || !inviteCopiedLabel) return;

    if (!currentRoomId) {
        inviteLinkInput.value = "";
        inviteLinkInput.placeholder = "Join a room to get an invite link";
        inviteCopyButton.disabled = true;
        inviteCopiedLabel.style.display = "none";
        return;
    }

    const url = new URL(window.location.href);
    url.searchParams.set("room", currentRoomId);

    inviteLinkInput.value = url.toString();
    inviteCopyButton.disabled = false;
}

function updateAudioStatus() {
    if (!audioStatusPill || !audioStatusDot || !audioStatusText) return;

    const inRoom = !!currentRoomId;

    const hasLocal =
        !!(localStream &&
           localStream.getAudioTracks().some(
               (t) => t.enabled && t.readyState === "live"
           ));

    const hasRemote = remoteAudioElements.size > 0;

    let text = "Not in room";
    let pillBg = "#EEE9E0";      // neutral
    let dotColor = "#C0C0C7";    // neutral grey

    if (!inRoom) {
        text = "Not in room";
    } else if (!hasLocal) {
        text = "Mic not sending";
        pillBg = "#FDECEA";      // pale red
        dotColor = "#D64545";    // red
    } else if (hasLocal && !hasRemote) {
        text = "Live: waiting for others";
        pillBg = "#E7F3FF";      // pale blue
        dotColor = "#2E6DD8";    // blue
    } else if (hasLocal && hasRemote) {
        text = "Live: sending & receiving";
        pillBg = "#E4F7E7";      // pale green
        dotColor = "#2ECC71";    // green
    }

    audioStatusPill.style.backgroundColor = pillBg;
    audioStatusDot.style.backgroundColor = dotColor;
    audioStatusText.textContent = text;
}

function applyVolumes() {
    if (!remoteVolumeSlider || !muteRemoteCheckbox) return;

    const master = muteRemoteCheckbox.checked ? 0 : (remoteVolumeSlider.value / 100);

    remoteAudioElements.forEach((audio, userId) => {
        const gain = userGains.has(userId) ? userGains.get(userId) : 1;
        audio.volume = master * gain;
    });
}

function updateBackingUI() {
    if (!backingStatus) return;

    if (!backingTrackConfig) {
        backingStatus.textContent = "No backing track loaded.";
        if (useBackingCheckbox) useBackingCheckbox.checked = false;
    } else {
        backingStatus.textContent =
            "Backing loaded: " + (backingTrackConfig.title || "Untitled recording");
        if (useBackingCheckbox && !useBackingCheckbox.checked) {
            useBackingCheckbox.checked = true;
        }
    }
}

// ========= RECORDING HELPERS =========
function setSessionState(newState, opts = {}) {
    sessionState = newState;

    if (opts.recorderId !== undefined) {
        recorderId = opts.recorderId;
    }

    console.log("SessionState →", sessionState, "recorderId →", recorderId);

    updateRecordingButtonForState();
    applyLockStateForSession();
    updateRecordingBanner();
}

function updateRecordingBanner() {
    if (!recordingBanner) return;

    const iAmRecorder = recorderId === myUserId;
    let text = "";
    let cls = "recording-banner";

    if (sessionState === SessionState.IDLE) {
        text = "Session idle. Ready to record.";
        cls += " recording-banner-idle";
    } else if (sessionState === SessionState.COUNT_IN) {
        text = iAmRecorder
            ? "Count-in… your take is about to start."
            : "Count-in… a bandmate is about to start a take.";
        cls += " recording-banner-armed";
    } else if (sessionState === SessionState.RECORDING) {
        text = iAmRecorder
            ? "Recording in progress (you are recording)."
            : "Recording in progress (bandmate is recording).";
        cls += " recording-banner-live";
    } else if (sessionState === SessionState.SAVING) {
        text = iAmRecorder
            ? "Saving your take…"
            : "Saving the latest take…";
        cls += " recording-banner-saving";
    }

    recordingBanner.className = cls;
    recordingBanner.innerHTML = `<span class="recording-dot"></span>${text}`;
}

function broadcastRecordingState() {
  if (!socket || socket.readyState !== WebSocket.OPEN || !currentRoomId) return;
  socket.send(JSON.stringify({
    type: "recording-state",
    roomId: currentRoomId,
    state: sessionState,
    recorderId: recorderId,
    timestamp: Date.now(),
  }));
}

function setRecordingUIIdle() {
  if (recordButton) {
    recordButton.textContent = "Start Recording";
    recordButton.disabled = false;
  }

  // unlock mixer
  if (remoteVolumeSlider) remoteVolumeSlider.disabled = false;
  if (muteRemoteCheckbox) muteRemoteCheckbox.disabled = false;

  // per-user sliders
  if (userMixerContainer) {
    Array.from(userMixerContainer.querySelectorAll('input[type="range"]'))
      .forEach(slider => slider.disabled = false);
  }

  // optional: clear any banners
  // updateRecordingBanner("Session Active · Saved ✅");
}

function setRecordingUICountIn(recId) {
  if (recordButton) {
    recordButton.textContent = recId === myUserId ? "Recording… (tap to stop)" : "Recording…";
    recordButton.disabled = (recId !== myUserId);
  }

  // lock mixer
  lockMixerSliders();

  // updateRecordingBanner(`Recording starting — ${recId === myUserId ? "You" : recId}`);
}

function setRecordingUIRecording(recId) {
  if (recordButton) {
    recordButton.textContent = recId === myUserId ? "Stop Recording" : "Recording…";
    recordButton.disabled = (recId !== myUserId);
  }
  lockMixerSliders();
  // updateRecordingBanner(`Recording in progress — ${recId === myUserId ? "You" : recId}`);
}

function setRecordingUISaving() {
  if (recordButton) {
    recordButton.textContent = "Saving…";
    recordButton.disabled = true;
  }
  lockMixerSliders();
  // updateRecordingBanner("Saving recording…");
}

function lockMixerSliders() {
  if (remoteVolumeSlider) remoteVolumeSlider.disabled = true;
  if (muteRemoteCheckbox) muteRemoteCheckbox.disabled = true;

  if (userMixerContainer) {
    Array.from(userMixerContainer.querySelectorAll('input[type="range"]'))
      .forEach(slider => slider.disabled = true);
  }
}

// ========= SOCKET HANDLING =========
function ensureSocket() {
    if (socket && socket.readyState === WebSocket.OPEN) {
        return socket;
    }

    socket = new WebSocket(serverUrl);

    socket.onopen = () => {
        console.log("✅ Connected to signaling server");
        if (currentRoomId && myUserId) {
            sendJoinMessage(currentRoomId);
        }
    };

    socket.onmessage = (event) => {
        let msg;
        try {
            msg = JSON.parse(event.data);
        } catch (err) {
            console.error("Failed to parse signaling message", err);
            return;
        }

        const { type } = msg;

        if (type === "room-users") {
            usersInRoom = msg.users || [];
            console.log("Room users:", usersInRoom);
            updateUserList();
        } else if (type === "user-joined") {
            const { userId } = msg;
            console.log("User joined:", userId);
            if (!usersInRoom.includes(userId)) {
                usersInRoom.push(userId);
                updateUserList();
            }
            if (userId !== myUserId) {
                createPeerConnection(userId, true);
            }
        } else if (type === "user-left") {
            const { userId } = msg;
            console.log("User left:", userId);
            usersInRoom = usersInRoom.filter((u) => u !== userId);
            updateUserList();
            teardownPeer(userId);
        } else if (type === "signal") {
            handleSignalMessage(msg);
        } else if (type === "chat") {
            appendChatMessage(msg.userId, msg.text, msg.timestamp);
        } else if (type === "metronome") {
            handleRemoteMetronome(msg);
        } else if (type === "pong") {
            const { clientTime } = msg;
            const now = Date.now();
            const rtt = now - clientTime;
            const latencyMs = Math.round(rtt / 2);

            updateLatencyDisplay(latencyMs);
            latencySamples.push(latencyMs);
            if (latencySamples.length > 50) {
                latencySamples.shift();
            }
            updateLatencyStats();
        } else if (type === "recording-state") {
             const { state, recorderId: recId } = msg;
            setSessionState(state, { recorderId: recId });
        }   
    };

    socket.onclose = () => {
        console.log("⚠️ Signaling socket closed");
    };

    socket.onerror = (err) => {
        console.error("WebSocket error:", err);
    };

    return socket;
}

function sendJoinMessage(roomId) {
    if (!socket || socket.readyState !== WebSocket.OPEN) {
        console.warn("Tried to send JOIN before socket open");
        return;
    }
    if (!myUserId) {
        myUserId = createRandomUserId();
    }
    const msg = {
        type: "join",
        roomId,
        userId: myUserId
    };
    console.log("🚪 Sending JOIN message:", msg);
    socket.send(JSON.stringify(msg));

    // Reset latency for this session
    latencySamples = [];
    updateLatencyStats();
    updateLatencyDisplay(null);

    // Start latency pings
    if (pingIntervalId) clearInterval(pingIntervalId);
    pingIntervalId = setInterval(() => {
        if (!socket || socket.readyState !== WebSocket.OPEN) return;
        socket.send(JSON.stringify({
            type: "ping",
            clientTime: Date.now()
        }));
    }, 2000);
}

// ========= AUDIO / WEBRTC =========
async function getLocalStream() {
    if (localStream) return localStream;

    try {
        localStream = await navigator.mediaDevices.getUserMedia({
            audio: {
                echoCancellation: false,
                noiseSuppression: false,
                autoGainControl: false
            },
            video: false
        });
        console.log("🎙️ Microphone access granted");

        if (!audioContext) {
            audioContext = new (window.AudioContext || window.webkitAudioContext)();
        }
        await audioContext.resume();

        localSource = audioContext.createMediaStreamSource(localStream);

        // ✅ NEW: refresh audio status now that mic is live
        updateAudioStatus();

        return localStream;
    } catch (err) {
        console.error("Microphone access failed:", err);
        alert("Microphone access failed: " + err.message);
        throw err;
    }
}

function createPeerConnection(remoteUserId, isInitiator) {
    if (peerConnections.has(remoteUserId)) {
        return peerConnections.get(remoteUserId);
    }

    // ICE with Google STUN + Twilio TURN
    const pc = new RTCPeerConnection({
        iceServers: [
            // Public Google STUN
            { urls: "stun:stun.l.google.com:19302" },

            // Twilio TURN (replace with your real Twilio values)
            {
                urls: [
                    "turn:global.turn.twilio.com:3478?transport=udp",
                    "turn:global.turn.twilio.com:3478?transport=tcp",
                    "turns:global.turn.twilio.com:443?transport=tcp"
                ],
                username: "dc2d2894d5a9023620c467b0e71cfa6a35457e6679785ed6ae9856fe5bdfa269",
                credential: "tE2DajzSJwnsSbc123"
            }
        ]
    });

    pc.remoteUserId = remoteUserId;

    pc.onicecandidate = (event) => {
        if (event.candidate && socket && socket.readyState === WebSocket.OPEN) {
            const msg = {
                type: "signal",
                roomId: currentRoomId,
                targetUserId: remoteUserId,
                fromUserId: myUserId,
                data: {
                    type: "candidate",
                    candidate: event.candidate
                }
            };
            socket.send(JSON.stringify(msg));
        }
    };

    pc.ontrack = (event) => {
        const [stream] = event.streams;
        console.log("Received remote stream from", remoteUserId, stream);
        handleRemoteStream(remoteUserId, stream);
    };

    if (localStream) {
        localStream.getTracks().forEach((track) => {
            pc.addTrack(track, localStream);
        });
    }

    peerConnections.set(remoteUserId, pc);

    if (isInitiator) {
        negotiateOffer(pc, remoteUserId);
    }

    return pc;
}

async function negotiateOffer(pc, remoteUserId) {
    try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        const msg = {
            type: "signal",
            roomId: currentRoomId,
            targetUserId: remoteUserId,
            fromUserId: myUserId,
            data: {
                type: "offer",
                sdp: offer.sdp
            }
        };
        socket.send(JSON.stringify(msg));
    } catch (err) {
        console.error("Error creating offer:", err);
    }
}

async function handleSignalMessage(msg) {
    const { fromUserId, data } = msg;
    let pc = peerConnections.get(fromUserId);
    if (!pc) {
        pc = createPeerConnection(fromUserId, false);
    }

    if (data.type === "offer") {
        try {
            await pc.setRemoteDescription(new RTCSessionDescription({ type: "offer", sdp: data.sdp }));
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            const reply = {
                type: "signal",
                roomId: currentRoomId,
                targetUserId: fromUserId,
                fromUserId: myUserId,
                data: {
                    type: "answer",
                    sdp: answer.sdp
                }
            };
            socket.send(JSON.stringify(reply));
        } catch (err) {
            console.error("Error handling offer:", err);
        }
    } else if (data.type === "answer") {
        try {
            await pc.setRemoteDescription(new RTCSessionDescription({ type: "answer", sdp: data.sdp }));
        } catch (err) {
            console.error("Error handling answer:", err);
        }
    } else if (data.type === "candidate") {
        try {
            await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
        } catch (err) {
            console.error("Error adding ICE candidate:", err);
        }
    }
}

function handleRemoteStream(userId, stream) {
    try {
        const audio = document.createElement("audio");
        audio.srcObject = stream;
        audio.autoplay = true;
        audio.playsInline = true;
        audio.muted = false;

        audio.style.display = "none";

        document.body.appendChild(audio);
        remoteAudioElements.set(userId, audio);

        console.log("Created HTMLAudioElement for remote user (simple mode):", userId);

        if (!userGains.has(userId)) {
            userGains.set(userId, 1);
        }
        applyVolumes();
        updateUserMixerUI();

        const playPromise = audio.play();
        if (playPromise !== undefined) {
            playPromise
                .then(() => {
                    console.log("Remote audio is playing for user:", userId);
                })
                .catch((err) => {
                    console.warn("Remote audio play was blocked or failed:", err);
                });
        }
        updateAudioStatus();
    } catch (e) {
        console.warn("Could not create HTMLAudioElement for remote stream", e);
    }
}

function teardownPeer(userId) {
    const pc = peerConnections.get(userId);
    if (pc) {
        pc.close();
        peerConnections.delete(userId);
    }

    const gain = remoteGains.get(userId);
    if (gain) {
        try {
            gain.disconnect();
        } catch (e) {}
        remoteGains.delete(userId);
    }

    const audio = remoteAudioElements.get(userId);
    if (audio) {
        try {
            audio.pause();
            audio.srcObject = null;
            if (audio.parentNode) {
                audio.parentNode.removeChild(audio);
            }
        } catch (e) {}
        remoteAudioElements.delete(userId);
    }
    updateAudioStatus();
    userGains.delete(userId);
    updateUserMixerUI();
}

// ========= CHAT =========
function appendChatMessage(fromUserId, text, timestamp) {
    if (!chatMessages) return;
    const div = document.createElement("div");
    const date = timestamp ? new Date(timestamp) : new Date();
    const timeStr = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    const isMe = fromUserId === myUserId;

    div.textContent = `[${timeStr}] ${isMe ? "You" : fromUserId}: ${text}`;
    chatMessages.appendChild(div);
    chatMessages.scrollTop = chatMessages.scrollHeight;
}

function sendChat() {
    const text = chatInput.value.trim();
    if (!text || !socket || socket.readyState !== WebSocket.OPEN || !currentRoomId || !myUserId) return;

    const msg = {
        type: "chat",
        roomId: currentRoomId,
        userId: myUserId,
        text,
        timestamp: Date.now()
    };
    socket.send(JSON.stringify(msg));
    chatInput.value = "";
}

// ========= METRONOME =========
function metronomeTick() {
    if (!audioContext) return;
    const vol = metronomeVolumeSlider.value / 100;

    // Advance beat in bar
    if (!metronomeBeatsPerBar || metronomeBeatsPerBar < 1) {
        metronomeBeatsPerBar = 4;
    }
    metronomeCurrentBeat = (metronomeCurrentBeat % metronomeBeatsPerBar) + 1;
    const isDownbeat = (metronomeCurrentBeat === 1);

    const osc = audioContext.createOscillator();
    const gain = audioContext.createGain();

    // Slightly louder + higher pitch on beat 1
    gain.gain.value = vol * (isDownbeat ? 1.0 : 0.7);
    osc.frequency.value = isDownbeat ? 1500 : 1000;

    osc.connect(gain);
    gain.connect(audioContext.destination);

    osc.start();
    osc.stop(audioContext.currentTime + 0.05);

    // Visual accent: darker dot on beat 1, lighter on others
    beatIndicator.style.backgroundColor = isDownbeat ? "#39393F" : "#B0B0B8";
    setTimeout(() => {
        beatIndicator.style.backgroundColor = "transparent";
    }, 80);
}

function startLocalMetronome(bpm, beatsPerBar) {
    stopLocalMetronome();

    metronomeRunning = true;
    metronomeBpm = bpm;
    metronomeBeatsPerBar = beatsPerBar || 4;
    metronomeCurrentBeat = 0; // reset bar

    const intervalMs = 60000 / bpm;
    metronomeTimer = setInterval(metronomeTick, intervalMs);
    metronomeButton.textContent = "Stop Metronome";
}

function stopLocalMetronome() {
    metronomeRunning = false;
    if (metronomeTimer) {
        clearInterval(metronomeTimer);
        metronomeTimer = null;
    }
    metronomeButton.textContent = "Start Metronome";
    metronomeCurrentBeat = 0;
    beatIndicator.style.backgroundColor = "transparent";
}

function handleRemoteMetronome(msg) {
    const { running, bpm, timeSignature } = msg;
    if (!shareMetronomeCheckbox.checked) {
        return;
    }
    const beatsPerBar = parseInt(timeSignature, 10) || 4;

    // Update UI selector to match incoming time signature
    if (timeSignatureSelect) {
        timeSignatureSelect.value = String(beatsPerBar);
    }

    if (running) {
        startLocalMetronome(bpm, beatsPerBar);
    } else {
        stopLocalMetronome();
    }
}

function debugBeep(label) {
    console.log("debugBeep:", label, "audioContext state:", audioContext && audioContext.state);

    if (!audioContext) {
        audioContext = new (window.AudioContext || window.webkitAudioContext)();
    }

    // Try to resume; don't await, just fire and forget
    if (audioContext.state === "suspended" && audioContext.resume) {
        audioContext.resume();
    }

    const ctx = audioContext;
    if (!ctx) return;

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    gain.gain.value = 0.5;
    osc.frequency.value = 880; // simple beep

    osc.connect(gain);
    gain.connect(ctx.destination);

    const t = ctx.currentTime + 0.02; // tiny buffer
    osc.start(t);
    osc.stop(t + 0.08);
}

function simpleCountIn(bpmVal, beatsPerBar, onComplete) {
    const beatMs = 60000 / bpmVal;
    let beat = 0;

    function nextBeat() {
        // If we left COUNT_IN (user cancelled / error), stop the sequence
        if (sessionState !== SessionState.COUNT_IN) {
            console.log("simpleCountIn: aborted, state =", sessionState);
            return;
        }

        beat += 1;
        console.log("simpleCountIn: beat", beat, "of", beatsPerBar);

        // 🔊 Use the same working beep we just proved works
        debugBeep("count-in beat " + beat);

        if (beat >= beatsPerBar) {
            // Slight pad before starting recording
            if (typeof onComplete === "function") {
                setTimeout(() => onComplete(), 80);
            }
        } else {
            setTimeout(nextBeat, beatMs);
        }
    }

    // Start immediately
    nextBeat();
}

// ========= RECORDING =========

// High-level entry point when it's time to actually start recording
function startRecordingFlow() {
    // State → RECORDING so UI shows proper button + locks
    setSessionState(SessionState.RECORDING, { recorderId: myUserId });
    startRecording(); // low-level MediaRecorder setup + start
}

function startRecording() {
    if (!audioContext || !localSource) {
        alert("Audio graph not ready yet.");
        return;
    }
    if (mediaRecorder && mediaRecorder.state === "recording") return;

    // Create a fresh recordDestination
    recordDestination = audioContext.createMediaStreamDestination();
    localSource.connect(recordDestination);

    recordedChunks = [];
    mediaRecorder = new MediaRecorder(recordDestination.stream);

    mediaRecorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) {
            recordedChunks.push(event.data);
        }
    };

    mediaRecorder.onstop = () => {
        handleRecordingFinished();
    };

    // 🔑 KEY FIX: Start MediaRecorder FIRST, THEN start backing track
    mediaRecorder.start();
    console.log("⏺️ MediaRecorder started");

    // ==== Backing track: play & route into recording ====
    if (
        backingTrackConfig &&
        backingTrackConfig.audioDataUrl &&
        useBackingCheckbox &&
        useBackingCheckbox.checked
    ) {
        if (!backingAudioElement) {
            backingAudioElement = new Audio();
            backingAudioElement.src = backingTrackConfig.audioDataUrl;
            backingAudioElement.preload = "auto";
        } else {
            backingAudioElement.currentTime = 0;
        }

        if (!backingConnected) {
            try {
                backingSourceNode = audioContext.createMediaElementSource(backingAudioElement);
                backingSourceNode.connect(audioContext.destination);
                backingSourceNode.connect(recordDestination);
                backingConnected = true;
            } catch (e) {
                console.warn("Could not connect backing track source (maybe already connected):", e);
                backingConnected = true;
            }
        }

        // Small delay to ensure MediaRecorder is truly recording before backing starts
        setTimeout(() => {
            const playPromise = backingAudioElement.play();
            if (playPromise && playPromise.catch) {
                playPromise.catch((err) => {
                    console.warn("Backing track playback failed:", err);
                });
            }
            console.log("🎵 Backing track started");
        }, 150); // 150ms delay - adjust if needed
    }
}

function stopRecording() {
    if (mediaRecorder && mediaRecorder.state === "recording") {
        mediaRecorder.stop();  // triggers handleRecordingFinished()
    }

    if (backingAudioElement && !backingAudioElement.paused) {
        backingAudioElement.pause();
    }
    console.log("⏹️ MediaRecorder stopped");
}

function handleRecordingFinished() {
    const blob = new Blob(recordedChunks, { type: "audio/webm" });
    const url = URL.createObjectURL(blob);

    const now = new Date();
    const datePart = now.toISOString().slice(0, 10); // YYYY-MM-DD
    const timePart = now.toTimeString().slice(0, 5).replace(":", "-"); // HH-MM

    const roomName = currentRoomId || "Untitled-room";
    const bpmValue = parseInt(bpmInput.value, 10) || 120;
    const label = (takeLabelInput && takeLabelInput.value.trim()) || "";

    let title = `${roomName} – ${bpmValue} BPM`;
    if (label) {
        title += ` – ${label}`;
    }
    title += ` – ${datePart} ${timePart}`;

    const filenameSafe = title.replace(/[^\w\- ()]/g, "_");

    // Create download link
    const link = document.createElement("a");
    link.href = url;
    link.download = `${filenameSafe}.webm`;
    link.textContent = "⬇️ Download this take";
    link.style.display = "block";
    link.style.marginBottom = "8px";

    // Create "Save as backing track" button
    const saveBtn = document.createElement("button");
    saveBtn.textContent = "Save as backing track";
    saveBtn.className = "secondary";
    saveBtn.style.marginBottom = "8px";
    
    saveBtn.addEventListener("click", () => {
        const reader = new FileReader();
        reader.onloadend = () => {
            const audioDataUrl = reader.result;
            try {
                saveRecordingToStore(roomName, bpmValue, label, now.getTime(), audioDataUrl);
                alert("Saved! You can now find this in the Recordings tab and use it as backing.");
                loadRecordingsList(); // Refresh the recordings list
            } catch (e) {
                alert("Storage is full! You may need to delete some old recordings from the Recordings tab.");
                console.error("Save failed:", e);
            }
        };
        reader.readAsDataURL(blob);
    });

    recordingsContainer.innerHTML = "";
    recordingsContainer.appendChild(link);
    recordingsContainer.appendChild(saveBtn);

    if (takeLabelInput) {
        takeLabelInput.value = "";
    }

    // Back to idle
    setSessionState(SessionState.IDLE, { recorderId: null });
}

// ========= UI EVENT HANDLERS =========
startButton.addEventListener("click", async () => {
    console.log("Join Room button clicked");
    const roomId = roomInput.value.trim();
    if (!roomId) {
        alert("Please enter a room name.");
        return;
    }

    currentRoomId = roomId;
    if (!myUserId) {
        myUserId = createRandomUserId();
    }

    updateRoomStatus();

    await getLocalStream();

    const ws = ensureSocket();
    if (ws.readyState === WebSocket.OPEN) {
        sendJoinMessage(roomId);
    } else {
        ws.addEventListener("open", function handleOpen() {
            ws.removeEventListener("open", handleOpen);
            sendJoinMessage(roomId);
        });
    }
});

chatSend.addEventListener("click", sendChat);
chatInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
        sendChat();
    }
});

metronomeButton.addEventListener("click", () => {
    const bpm = parseInt(bpmInput.value, 10) || 120;
    const beatsPerBar = parseInt(timeSignatureSelect && timeSignatureSelect.value, 10) || 4;

    if (!audioContext) {
        audioContext = new (window.AudioContext || window.webkitAudioContext)();
        audioContext.resume();
    }

    if (metronomeRunning) {
        stopLocalMetronome();
        if (socket && socket.readyState === WebSocket.OPEN && currentRoomId && shareMetronomeCheckbox.checked) {
            socket.send(JSON.stringify({
                type: "metronome",
                roomId: currentRoomId,
                running: false,
                bpm,
                timeSignature: beatsPerBar,
                startTime: Date.now()
            }));
        }
    } else {
        startLocalMetronome(bpm, beatsPerBar);
        if (socket && socket.readyState === WebSocket.OPEN && currentRoomId && shareMetronomeCheckbox.checked) {
            socket.send(JSON.stringify({
                type: "metronome",
                roomId: currentRoomId,
                running: true,
                bpm,
                timeSignature: beatsPerBar,
                startTime: Date.now()
            }));
        }
    }
});

recordButton.addEventListener("click", async () => {
    // 1) Make sure AudioContext exists & is resumed
    if (!audioContext) {
        audioContext = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (audioContext.state === "suspended" && audioContext.resume) {
        try {
            await audioContext.resume();
        } catch (e) {
            console.warn("AudioContext resume failed in record click:", e);
        }
    }

    // 2) Handle by session state
    if (sessionState === SessionState.IDLE) {
        // Start a new recording flow (count-in → recording)
        beginRecordFlow();
    } else if (
        sessionState === SessionState.COUNT_IN ||
        sessionState === SessionState.RECORDING
    ) {
        // Allow the recorder to stop/cancel
        if (recorderId === myUserId) {
            stopRecordingFlow();
        }
    } else if (sessionState === SessionState.SAVING) {
        // Do nothing; saving in progress
        console.log("Ignoring record click during SAVING state");
    }
});

// ========= TABS =========
const tabBar = document.getElementById("tab-bar");
const tabButtons = tabBar ? tabBar.querySelectorAll("button[data-tab-target]") : [];
const tabPanels = document.querySelectorAll(".tab-panel[data-tab]");

tabButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
        const target = btn.getAttribute("data-tab-target");

        // update button active state
        tabButtons.forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");

        // show the matching panel
        tabPanels.forEach((panel) => {
            const panelTab = panel.getAttribute("data-tab");
            panel.classList.toggle("active", panelTab === target);
        });

        // If we switched to the Recordings tab, refresh the list
        if (target === "recordings") {
            loadRecordingsList();
        }
    });
});

async function beginRecordFlow() {
    try {
        await getLocalStream();

        if (!audioContext) {
            audioContext = new (window.AudioContext || window.webkitAudioContext)();
        }
        if (audioContext.state === "suspended" && audioContext.resume) {
            await audioContext.resume();
        }

        const bpmVal = parseInt(bpmInput && bpmInput.value, 10) || 120;
        const beatsPerBar = parseInt(timeSignatureSelect && timeSignatureSelect.value, 10) || 4;

        console.log("beginRecordFlow: bpm =", bpmVal, "beatsPerBar =", beatsPerBar);

        // 👉 Arm recording: COUNT_IN state, recorderId = me
        setSessionState(SessionState.COUNT_IN, { recorderId: myUserId });

        simpleCountIn(bpmVal, beatsPerBar, () => {
            // Only start if we're still in COUNT_IN and I'm still the recorder
            if (sessionState === SessionState.COUNT_IN && recorderId === myUserId) {
                console.log("beginRecordFlow: count-in complete, starting recording");
                startRecordingFlow();
            } else {
                console.log("beginRecordFlow: count-in complete but state/recorder changed; not recording");
            }
        });

    } catch (e) {
        console.error("Could not start recording:", e);
        setSessionState(SessionState.IDLE, { recorderId: null });
    }
}

function stopRecordingFlow() {
    // Move to SAVING state *immediately* so UI locks, even if MediaRecorder is still finishing
    setSessionState(SessionState.SAVING, { recorderId: recorderId || myUserId });

    // Actually stop the MediaRecorder / backing playback
    stopRecording();
}

remoteVolumeSlider.addEventListener("input", () => {
    applyVolumes();
});

muteRemoteCheckbox.addEventListener("change", () => {
    applyVolumes();
});

if (inviteCopyButton) {
    inviteCopyButton.addEventListener("click", async () => {
        if (!inviteLinkInput.value) return;

        inviteCopiedLabel.style.display = "none";

        const text = inviteLinkInput.value;

        try {
            if (navigator.clipboard && navigator.clipboard.writeText) {
                await navigator.clipboard.writeText(text);
            } else {
                // Fallback for older browsers
                inviteLinkInput.select();
                document.execCommand("copy");
                inviteLinkInput.blur();
            }

            inviteCopiedLabel.style.display = "block";
            setTimeout(() => {
                inviteCopiedLabel.style.display = "none";
            }, 2000);
        } catch (err) {
            console.warn("Copy failed", err);
            alert("Could not copy the link. You can copy it manually.");
        }
    });
}

// Check URL for ?room=... and pre-fill the room name
const urlParams = new URLSearchParams(window.location.search);
const initialRoom = urlParams.get("room");
if (initialRoom) {
    roomInput.value = initialRoom;
    roomStatus.textContent = `Ready to join: ${initialRoom}`;
}

// Initial
updateRoomStatus();
updateLatencyDisplay(null);
updateLatencyStats();
updateAudioStatus();

// Preload recordings list once (so it's ready the first time user clicks the tab)
loadRecordingsList();

// Initialize recording banner
updateRecordingBanner()