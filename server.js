// --- server.js (v27.3 - Adding D.I.C.E. WebRTC Signaling Relays) --- // MODIFIED Version Comment

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
// Optional: Use crypto for truly unique IDs if needed later
// const crypto = require('crypto');

const app = express();
const server = http.createServer(app);

// Helper to format bytes for logging
function formatBytes(bytes, decimals = 2) {
    if (!bytes || bytes === 0) return '0 Bytes'; // Handle null/zero bytes
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.max(0, Math.floor(Math.log(Math.abs(bytes)) / Math.log(k)));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}


const io = new Server(server, {
    cors: {
        origin: '*',
    },
    pingInterval: 20000,
    pingTimeout: 120000,
    maxHttpBufferSize: 1e8 // 100MB limit
});

app.use(express.static('public'));
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: true, limit: '100mb' }));

// --- Keep track of users and their associated rooms ---
const userSocketMap = new Map(); // socket.id -> { username, roomId }

io.on('connection', (socket) => {
    console.log('User connected:', socket.id);
    const { username, sessionId } = socket.handshake.query;
    socket.username = username; // Store username on socket for easy access
    console.log(`Handshake Info -> User: ${username}, Session: ${sessionId}`);

    socket.on('join_chat_room', (data) => {
        const { room, user } = data;
        if (!room || !user) { console.error("Join attempt invalid:", data); return; }

        // Leave previous room if any
        const currentUserData = userSocketMap.get(socket.id);
        if (currentUserData && currentUserData.roomId && currentUserData.roomId !== room) {
            console.log(`User ${user} (${socket.id}) leaving previous room ${currentUserData.roomId}`);
            socket.leave(currentUserData.roomId);
             socket.to(currentUserData.roomId).emit('user_left_chat', { user: currentUserData.username, socketId: socket.id });
        }

        // Join the new room
        socket.join(room);
        socket.roomId = room;
        socket.username = user;

        // Update map
        userSocketMap.set(socket.id, { username: user, roomId: room });
        console.log(`User ${user} (${socket.id}) joined chat room ${room}`);

        // Notify others in the new room
        socket.to(room).emit('user_joined_chat', { user, socketId: socket.id });

        // Send list of existing users in this room
        const clientsInRoom = Array.from(io.sockets.adapter.rooms.get(room) || []);
        const users = {};
        clientsInRoom.forEach(id => {
            const clientSocket = io.sockets.sockets.get(id);
            if (clientSocket && clientSocket.id !== socket.id) {
                const userData = userSocketMap.get(clientSocket.id);
                 users[clientSocket.id] = userData ? userData.username : "Unknown";
            }
        });
        socket.emit('session_users', users);
    });

    // --- Standard Chat Events ---
    socket.on('chat_message', (data) => { const { username, message, session } = data; const targetRoom = session || socket.roomId; if (!targetRoom || !username || message === undefined) { console.warn("Invalid chat message:", data); return; } socket.to(targetRoom).emit('chat_message', { username, message, senderSocketId: socket.id }); });
    socket.on('start_typing', (data) => { const targetRoom = data.session || socket.roomId; if (targetRoom && data.username) socket.to(targetRoom).emit('user_started_typing', { username: data.username, socketId: socket.id }); });
    socket.on('stop_typing', (data) => { const targetRoom = data.session || socket.roomId; if (targetRoom && data.username) socket.to(targetRoom).emit('user_stopped_typing', { username: data.username, socketId: socket.id }); });

    // --- Media Drop Events ---
    socket.on('video_drop', (data) => { const { username, session, videoBuffer } = data; const targetRoom = session || socket.roomId; if (!targetRoom || !username || !videoBuffer) { return; } let bufferToSend; let bufferSize = 0; if (videoBuffer instanceof ArrayBuffer) { bufferToSend = videoBuffer; bufferSize = videoBuffer.byteLength; } else if (videoBuffer instanceof Buffer) { bufferToSend = videoBuffer; bufferSize = videoBuffer.length; } else { return; } const SERVER_MAX_VIDEO_SIZE = 95 * 1024 * 1024; if (bufferSize > SERVER_MAX_VIDEO_SIZE) { socket.emit('video_drop_error', { reason: 'Video file too large.' }); return; } io.to(targetRoom).emit('video_drop', { username, videoBuffer: bufferToSend, senderSocketId: socket.id }); });
    socket.on('voice_drop', (data) => { const { username, session, audioBuffer } = data; const targetRoom = session || socket.roomId; if (!targetRoom || !username || !audioBuffer) { return; } let bufferToSend; let bufferSize = 0; if (audioBuffer instanceof ArrayBuffer) { bufferToSend = audioBuffer; bufferSize = audioBuffer.byteLength; } else if (audioBuffer instanceof Buffer) { bufferToSend = audioBuffer; bufferSize = audioBuffer.length; } else { return; } const SERVER_MAX_AUDIO_SIZE = 15 * 1024 * 1024; if (bufferSize > SERVER_MAX_AUDIO_SIZE) { socket.emit('voice_drop_error', { reason: 'Voice recording too large.' }); return; } io.to(targetRoom).emit('voice_drop', { username, audioBuffer: bufferToSend, senderSocketId: socket.id }); });

    // --- D.I.C.E. (Drop In Call Engine) Signaling ---
    // Basic Call Setup/Teardown
    socket.on('start_call', (data) => { const { targetSocketId, callerName } = data; if (!targetSocketId || !callerName) { console.warn(`[DICE] Invalid start_call data from ${socket.id}:`, data); return; } const targetSocket = io.sockets.sockets.get(targetSocketId); if (!targetSocket) { console.log(`[DICE] Target user ${targetSocketId} not found for call from ${callerName} (${socket.id})`); socket.emit('call_target_unavailable', { targetSocketId }); return; } console.log(`[DICE] Call initiated by ${callerName} (${socket.id}) to ${targetSocketId}`); io.to(targetSocketId).emit('incoming_call', { callerName, callerSocketId: socket.id }); });
    socket.on('accept_call', (data) => { const { callerSocketId } = data; if (!callerSocketId) { console.warn(`[DICE] Invalid accept_call data from ${socket.id}:`, data); return; } const callerSocket = io.sockets.sockets.get(callerSocketId); if (!callerSocket) { console.log(`[DICE] Original caller ${callerSocketId} not found`); return; } console.log(`[DICE] Call accepted by ${socket.username || socket.id}, notifying caller ${callerSocketId}`); io.to(callerSocketId).emit('call_accepted', { responderSocketId: socket.id, responderName: socket.username }); });
    socket.on('decline_call', (data) => { const { callerSocketId } = data; if (!callerSocketId) { console.warn(`[DICE] Invalid decline_call data from ${socket.id}:`, data); return; } const callerSocket = io.sockets.sockets.get(callerSocketId); if (!callerSocket) { console.log(`[DICE] Original caller ${callerSocketId} not found`); return; } console.log(`[DICE] Call declined by ${socket.username || socket.id}, notifying caller ${callerSocketId}`); io.to(callerSocketId).emit('call_declined', { responderSocketId: socket.id, responderName: socket.username }); });
    socket.on('hangup_call', (data) => { const { targetSocketId } = data; if (!targetSocketId) { console.warn(`[DICE] Invalid hangup_call data from ${socket.id}:`, data); return; } const targetSocket = io.sockets.sockets.get(targetSocketId); if (!targetSocket) { console.log(`[DICE] Target ${targetSocketId} not found for hangup call from ${socket.id}`); return; } console.log(`[DICE] Hangup initiated by ${socket.username || socket.id}, notifying ${targetSocketId}`); io.to(targetSocketId).emit('call_hungup', { hungupBySocketId: socket.id }); });

    // --- D.I.C.E. WebRTC Signaling Relays --- // NEW SECTION
    socket.on('call_offer', (data) => {
        const { targetSocketId, offer, callerName } = data;
        // Basic validation
        if (!targetSocketId || !offer) {
             console.warn(`[DICE] Invalid call_offer data from ${socket.id}. Target: ${targetSocketId}, Offer: ${!!offer}`);
             return;
         }
        // Find target socket before emitting
        const targetSocket = io.sockets.sockets.get(targetSocketId);
        if (!targetSocket) {
            console.log(`[DICE] Target ${targetSocketId} not found for call_offer relay from ${socket.id}`);
            // Optionally notify the sender that the target is gone?
            return;
        }
        console.log(`[DICE] Relaying call offer from ${callerName || socket.id} to ${targetSocketId}`);
        io.to(targetSocketId).emit('call_offer', { offer, callerSocketId: socket.id, callerName: callerName || socket.username }); // Pass necessary info
    });

    socket.on('call_answer', (data) => {
        const { targetSocketId, answer } = data;
         // Basic validation
         if (!targetSocketId || !answer) {
             console.warn(`[DICE] Invalid call_answer data from ${socket.id}. Target: ${targetSocketId}, Answer: ${!!answer}`);
             return;
         }
         // Find target socket before emitting
         const targetSocket = io.sockets.sockets.get(targetSocketId);
         if (!targetSocket) {
             console.log(`[DICE] Target ${targetSocketId} not found for call_answer relay from ${socket.id}`);
             return;
         }
        console.log(`[DICE] Relaying call answer from ${socket.id} to ${targetSocketId}`);
        io.to(targetSocketId).emit('call_answer', { answer, responderSocketId: socket.id });
    });

    socket.on('ice_candidate', (data) => {
        const { targetSocketId, candidate } = data;
         // Basic validation
         if (!targetSocketId || !candidate) {
             console.warn(`[DICE] Invalid ice_candidate data from ${socket.id}. Target: ${targetSocketId}, Candidate: ${!!candidate}`);
             return;
         }
          // Find target socket before emitting
         const targetSocket = io.sockets.sockets.get(targetSocketId);
         if (!targetSocket) {
             // Don't log every time, can happen normally if user disconnects during ICE
             // console.log(`[DICE] Target ${targetSocketId} not found for ice_candidate relay from ${socket.id}`);
             return;
         }
        // console.log(`[DICE] Relaying ICE candidate from ${socket.id} to ${targetSocketId}`); // Usually too verbose
        io.to(targetSocketId).emit('ice_candidate', { candidate, senderSocketId: socket.id });
    });
    // --- END D.I.C.E. ---


    // --- Error listeners from client ---
    socket.on('video_drop_error', (data) => { console.error(`Client ${socket.id} video error:`, data.reason); });
    socket.on('voice_drop_error', (data) => { console.error(`Client ${socket.id} voice error:`, data.reason); });
    socket.on('image_drop_error', (data) => { console.error(`Client ${socket.id} image error:`, data.reason); });


    socket.on('disconnect', () => {
        const userData = userSocketMap.get(socket.id);
        const username = userData ? userData.username : socket.username || 'Unknown';
        const roomId = userData ? userData.roomId : socket.roomId;

        console.log(`User disconnected: ${socket.id} (User: ${username}, Room: ${roomId || 'N/A'})`);
        userSocketMap.delete(socket.id); // Remove user from map

        if (roomId) {
            console.log(`Notifying room ${roomId} that ${username} left`);
            socket.to(roomId).emit('user_left_chat', { user: username, socketId: socket.id });
            // TODO: Handle disconnect during an active call more robustly
            // e.g., find call partner via a separate map and emit 'call_hungup'
        }
    });

}); // End io.on('connection', ...)

// --- Routes & Server Start (Unchanged) ---
app.get('/c/:roomId', (req, res) => { res.redirect(`/index.html?session=${encodeURIComponent(req.params.roomId)}`); });
app.get('/', (req, res) => { res.redirect('/index.html'); });
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => { console.log(`Server running on port ${PORT}`); });