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

const recordButton = document.getElementById("record");
const recordingsContainer = document.getElementById("recordings");

const micMonitorSlider = document.getElementById("mic-monitor-volume");
const remoteVolumeSlider = document.getElementById("remote-volume");
const muteRemoteCheckbox = document.getElementById("mute-remote");

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
let micMonitorGain = null;
let recordDestination = null;

const peerConnections = new Map();        // userId -> RTCPeerConnection
const remoteGains = new Map();            // userId -> GainNode
const remoteAudioElements = new Map();    // userId -> <audio>

let mediaRecorder = null;
let recordedChunks = [];

// Metronome
let metronomeTimer = null;
let metronomeRunning = false;
let metronomeIsShared = false;
let metronomeBpm = 120;

// ========= HELPERS =========
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
        localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
        console.log("🎙️ Microphone access granted");

        if (!audioContext) {
            audioContext = new (window.AudioContext || window.webkitAudioContext)();
        }
        await audioContext.resume();

        localSource = audioContext.createMediaStreamSource(localStream);

        micMonitorGain = audioContext.createGain();
        micMonitorGain.gain.value = micMonitorSlider.value / 100;

        recordDestination = audioContext.createMediaStreamDestination();

        localSource.connect(micMonitorGain);
        micMonitorGain.connect(audioContext.destination);
        localSource.connect(recordDestination);

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
    // Minimal, robust remote playback: HTMLAudioElement only.
    try {
        const audio = document.createElement("audio");
        audio.srcObject = stream;
        audio.autoplay = true;
        audio.playsInline = true;
        audio.muted = false;

        const baseVolume = muteRemoteCheckbox.checked
            ? 0
            : (remoteVolumeSlider.value / 100);

        audio.volume = baseVolume;
        audio.style.display = "none";

        document.body.appendChild(audio);
        remoteAudioElements.set(userId, audio);

        updateAudioStatus();
        
        console.log("Created HTMLAudioElement for remote user (simple mode):", userId);

        // Explicitly try to start playback and log if it fails
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

    const osc = audioContext.createOscillator();
    const gain = audioContext.createGain();
    gain.gain.value = vol;

    osc.frequency.value = 1000;
    osc.connect(gain);
    gain.connect(audioContext.destination);

    osc.start();
    osc.stop(audioContext.currentTime + 0.05);

    beatIndicator.style.backgroundColor = "#39393F";
    setTimeout(() => {
        beatIndicator.style.backgroundColor = "transparent";
    }, 80);
}

function startLocalMetronome(bpm) {
    stopLocalMetronome();
    metronomeRunning = true;
    metronomeBpm = bpm;
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
    beatIndicator.style.backgroundColor = "transparent";
}

function handleRemoteMetronome(msg) {
    const { running, bpm } = msg;
    if (!shareMetronomeCheckbox.checked) {
        return;
    }
    if (running) {
        startLocalMetronome(bpm);
    } else {
        stopLocalMetronome();
    }
}

// ========= RECORDING =========
function startRecording() {
    if (!recordDestination) {
        alert("Audio graph not ready yet.");
        return;
    }
    if (mediaRecorder && mediaRecorder.state === "recording") return;

    recordedChunks = [];
    mediaRecorder = new MediaRecorder(recordDestination.stream);
    mediaRecorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) {
            recordedChunks.push(event.data);
        }
    };
    mediaRecorder.onstop = () => {
        const blob = new Blob(recordedChunks, { type: "audio/webm" });
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        const now = new Date();
        const stamp = now.toISOString().replace(/[:.]/g, "-");
        link.href = url;
        link.download = `rehearsal-${stamp}.webm`;
        link.textContent = "Download recording";
        link.style.display = "block";

        recordingsContainer.innerHTML = "";
        recordingsContainer.appendChild(link);
    };

    mediaRecorder.start();
    recordButton.textContent = "Stop Recording";
}

function stopRecording() {
    if (mediaRecorder && mediaRecorder.state === "recording") {
        mediaRecorder.stop();
        recordButton.textContent = "Start Recording";
    }
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
                startTime: Date.now()
            }));
        }
    } else {
        startLocalMetronome(bpm);
        if (socket && socket.readyState === WebSocket.OPEN && currentRoomId && shareMetronomeCheckbox.checked) {
            socket.send(JSON.stringify({
                type: "metronome",
                roomId: currentRoomId,
                running: true,
                bpm,
                startTime: Date.now()
            }));
        }
    }
});

recordButton.addEventListener("click", () => {
    if (!mediaRecorder || mediaRecorder.state !== "recording") {
        startRecording();
    } else {
        stopRecording();
    }
});

micMonitorSlider.addEventListener("input", () => {
    if (micMonitorGain) {
        micMonitorGain.gain.value = micMonitorSlider.value / 100;
    }
});

remoteVolumeSlider.addEventListener("input", () => {
    const value = muteRemoteCheckbox.checked ? 0 : (remoteVolumeSlider.value / 100);

    remoteAudioElements.forEach((audio) => {
        audio.volume = value;
    });
});

muteRemoteCheckbox.addEventListener("change", () => {
    const value = muteRemoteCheckbox.checked ? 0 : (remoteVolumeSlider.value / 100);

    remoteAudioElements.forEach((audio) => {
        audio.volume = value;
    });
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
// End of script.js