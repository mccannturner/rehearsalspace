const express = require("express");
const path = require("path");
const http = require("http");
const { WebSocketServer } = require("ws");

const app = express();

// Serve pages first

// Homepage (marketing)
app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "landing.html"));
});

// App UI
app.get("/app", (req, res) => {
    res.sendFile(path.join(__dirname, "index.html"));
});

// Band Workspace
app.get("/band", (req, res) => {
    res.sendFile(path.join(__dirname, "band.html"));
});

// Optional: favicon route
app.get("/favicon.ico", (req, res) => {
    res.sendFile(path.join(__dirname, "assets", "rehearsal-space-1024.png"));
});

// Serve static files (script.js, assets, etc.) AFTER routes
app.use(express.static(__dirname));

// Create a single HTTP server for both HTTP + WebSocket
const server = http.createServer(app);

// ====== WEBSOCKET SIGNALING SERVER ON SAME PORT ======
const wss = new WebSocketServer({ server });

// roomId -> Map(userId -> ws)
const rooms = new Map();

function getOrCreateRoom(roomId) {
    if (!rooms.has(roomId)) {
        rooms.set(roomId, new Map());
    }
    return rooms.get(roomId);
}

function broadcastToRoom(roomId, messageObj, exceptUserId = null) {
    const room = rooms.get(roomId);
    if (!room) return;
    const messageStr = JSON.stringify(messageObj);
    for (const [uid, socket] of room.entries()) {
        if (socket.readyState === socket.OPEN && uid !== exceptUserId) {
            socket.send(messageStr);
        }
    }
}

wss.on("connection", (ws) => {
    console.log("🔌 New WebSocket connection");
    ws.userId = null;
    ws.roomId = null;

    ws.on("message", (data) => {
        let msg;
        try {
            msg = JSON.parse(data.toString());
        } catch (err) {
            console.error("Failed to parse message", err);
            return;
        }

        console.log("📩 Received message:", msg);
        
        const { type } = msg;

        // Client should send {type: "join", roomId, userId}
// Client should send {type: "join", roomId, userId, nickname}
        if (type === "join") {
            const { roomId, userId, nickname } = msg;
            ws.userId = userId;
            ws.roomId = roomId;
            ws.nickname = nickname || "Anonymous"; // Store nickname on the socket

            const room = getOrCreateRoom(roomId);
            room.set(userId, ws);

            // Send back current user list with nicknames to the joining client
            const users = Array.from(room.values()).map(socket => ({
                userId: socket.userId,
                nickname: socket.nickname
            }));
            
            ws.send(JSON.stringify({
                type: "room-users",
                roomId,
                users
            }));

            // Let others know someone joined (with their nickname)
            broadcastToRoom(roomId, {
                type: "user-joined",
                roomId,
                userId,
                nickname: ws.nickname
            }, userId);

            return;
        }

        // WebRTC signaling: {type: "signal", targetUserId, fromUserId, data}
        if (type === "signal") {
            const { roomId, targetUserId, fromUserId, data: signalData } = msg;
            const room = rooms.get(roomId);
            if (!room) return;
            const targetSocket = room.get(targetUserId);
            if (targetSocket && targetSocket.readyState === targetSocket.OPEN) {
                targetSocket.send(JSON.stringify({
                    type: "signal",
                    fromUserId,
                    data: signalData
                }));
            }
            return;
        }

        // Chat: {type: "chat", roomId, userId, text, timestamp}
        if (type === "chat") {
            const { roomId, userId, text, timestamp } = msg;
            broadcastToRoom(roomId, {
                type: "chat",
                roomId,
                userId,
                text,
                timestamp
            });
            return;
        }

        // Shared metronome: {type: "metronome", roomId, running, bpm, timeSignature, startTime}
        if (type === "metronome") {
            const { roomId, running, bpm, timeSignature, startTime } = msg;
            broadcastToRoom(roomId, {
                type: "metronome",
                roomId,
                running,
                bpm,
                timeSignature,
                startTime
            }, ws.userId);
            return;
        }

// Recording state sync: {type: "recording-state", roomId, state, recorderId, timestamp}
        if (type === "recording-state") {
            const { roomId, state, recorderId, timestamp } = msg;
            broadcastToRoom(roomId, {
                type: "recording-state",
                roomId,
                state,
                recorderId,
                timestamp
            }, ws.userId);
            return;
        }

        // Latency ping: {type: "ping", clientTime}
        if (type === "ping") {
            const { clientTime } = msg;
            ws.send(JSON.stringify({
                type: "pong",
                clientTime,
                serverTime: Date.now()
            }));
            return;
        }
    });

    ws.on("close", () => {
        const { roomId, userId } = ws;
        if (!roomId || !userId) return;
        const room = rooms.get(roomId);
        if (!room) return;
        room.delete(userId);
        if (room.size === 0) {
            rooms.delete(roomId);
        } else {
            broadcastToRoom(roomId, {
                type: "user-left",
                roomId,
                userId
            });
        }
    });
});

const PORT = process.env.PORT || 3000;

// Start the combined server
server.listen(PORT, () => {
    console.log(`Rehearsal Space server (HTTP + WS) running on port ${PORT}`);
});