// --- server.js (v27.4 - Adding D.I.C.E. WebRTC Signaling Relays) --- // MODIFIED Version Comment

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

// --- Keep track of users, rooms, and call state ---
const userSocketMap = new Map(); // socket.id -> { username, roomId, callState: 'idle' | 'calling' | 'receiving' | 'connected', currentCallPartnerId: string | null }

io.on('connection', (socket) => {
    console.log('User connected:', socket.id);
    const { username, sessionId } = socket.handshake.query;
    socket.username = username; // Store username on socket for easy access
    console.log(`Handshake Info -> User: ${username}, Session: ${sessionId}`);

    // Helper function to safely update user map state
    const updateUserState = (socketId, updates) => {
        const userData = userSocketMap.get(socketId);
        if (userData) {
            userSocketMap.set(socketId, { ...userData, ...updates });
            // console.log(`[State Update] ${socketId}:`, userSocketMap.get(socketId)); // Verbose state logging
        } else {
            console.warn(`[State Update] User data not found for ${socketId} during update:`, updates);
        }
    };

    socket.on('join_chat_room', (data) => {
        const { room, user } = data;
        if (!room || !user) { console.error("Join attempt invalid:", data); return; }

        // Leave previous room if any
        const currentUserData = userSocketMap.get(socket.id);
        if (currentUserData && currentUserData.roomId && currentUserData.roomId !== room) {
            // --- Handle potential call state reset when leaving a room ---
            // If user was in a call, notify partner and reset states before leaving
            if (currentUserData.callState !== 'idle' && currentUserData.currentCallPartnerId) {
                console.log(`[DICE] User ${user} (${socket.id}) leaving room while in call state: ${currentUserData.callState}. Notifying partner.`);
                const partnerSocket = io.sockets.sockets.get(currentUserData.currentCallPartnerId);
                if (partnerSocket) {
                    io.to(currentUserData.currentCallPartnerId).emit('call_hungup', { hungupBySocketId: socket.id });
                    updateUserState(currentUserData.currentCallPartnerId, { callState: 'idle', currentCallPartnerId: null });
                }
            }
            // Reset own state before leaving
            updateUserState(socket.id, { callState: 'idle', currentCallPartnerId: null });
            // --- End call state handling on room leave ---

            console.log(`User ${user} (${socket.id}) leaving previous room ${currentUserData.roomId}`);
            socket.leave(currentUserData.roomId);
             socket.to(currentUserData.roomId).emit('user_left_chat', { user: currentUserData.username, socketId: socket.id });
        }

        // Join the new room
        socket.join(room);
        socket.roomId = room;
        socket.username = user;

        // Update map with initial/reset state
        userSocketMap.set(socket.id, {
            username: user,
            roomId: room,
            callState: 'idle', // Initialize call state
            currentCallPartnerId: null // Initialize partner ID
         });
        console.log(`User ${user} (${socket.id}) joined chat room ${room}`);
        console.log(`[State Init] ${socket.id}:`, userSocketMap.get(socket.id));


        // Notify others in the new room
        socket.to(room).emit('user_joined_chat', { user, socketId: socket.id });

        // Send list of existing users in this room
        const clientsInRoom = Array.from(io.sockets.adapter.rooms.get(room) || []);
        const users = {};
        clientsInRoom.forEach(id => {
            const clientSocket = io.sockets.sockets.get(id);
            if (clientSocket && clientSocket.id !== socket.id) {
                const userData = userSocketMap.get(clientSocket.id);
                 users[clientSocket.id] = userData ? userData.username : "Unknown"; // Send only username for privacy/simplicity
            }
        });
        socket.emit('session_users', users);
    });

    // --- Standard Chat Events --- (Unchanged)
    socket.on('chat_message', (data) => { const { username, message, session } = data; const targetRoom = session || socket.roomId; if (!targetRoom || !username || message === undefined) { console.warn("Invalid chat message:", data); return; } socket.to(targetRoom).emit('chat_message', { username, message, senderSocketId: socket.id }); });
    socket.on('start_typing', (data) => { const targetRoom = data.session || socket.roomId; if (targetRoom && data.username) socket.to(targetRoom).emit('user_started_typing', { username: data.username, socketId: socket.id }); });
    socket.on('stop_typing', (data) => { const targetRoom = data.session || socket.roomId; if (targetRoom && data.username) socket.to(targetRoom).emit('user_stopped_typing', { username: data.username, socketId: socket.id }); });

    // --- Media Drop Events --- (Unchanged)
    socket.on('video_drop', (data) => { const { username, session, videoBuffer } = data; const targetRoom = session || socket.roomId; if (!targetRoom || !username || !videoBuffer) { return; } let bufferToSend; let bufferSize = 0; if (videoBuffer instanceof ArrayBuffer) { bufferToSend = videoBuffer; bufferSize = videoBuffer.byteLength; } else if (videoBuffer instanceof Buffer) { bufferToSend = videoBuffer; bufferSize = videoBuffer.length; } else { return; } const SERVER_MAX_VIDEO_SIZE = 95 * 1024 * 1024; if (bufferSize > SERVER_MAX_VIDEO_SIZE) { socket.emit('video_drop_error', { reason: 'Video file too large.' }); return; } io.to(targetRoom).emit('video_drop', { username, videoBuffer: bufferToSend, senderSocketId: socket.id }); });
    socket.on('voice_drop', (data) => { const { username, session, audioBuffer } = data; const targetRoom = session || socket.roomId; if (!targetRoom || !username || !audioBuffer) { return; } let bufferToSend; let bufferSize = 0; if (audioBuffer instanceof ArrayBuffer) { bufferToSend = audioBuffer; bufferSize = audioBuffer.byteLength; } else if (audioBuffer instanceof Buffer) { bufferToSend = audioBuffer; bufferSize = audioBuffer.length; } else { return; } const SERVER_MAX_AUDIO_SIZE = 15 * 1024 * 1024; if (bufferSize > SERVER_MAX_AUDIO_SIZE) { socket.emit('voice_drop_error', { reason: 'Voice recording too large.' }); return; } io.to(targetRoom).emit('voice_drop', { username, audioBuffer: bufferToSend, senderSocketId: socket.id }); });

    // --- D.I.C.E. (Drop In Call Engine) Signaling ---

    socket.on('start_call', (data) => {
        const { targetSocketId, callerName } = data;
        if (!targetSocketId || !callerName) {
             console.warn(`[DICE] Invalid start_call data from ${socket.id}:`, data);
             return;
        }

        const callerData = userSocketMap.get(socket.id);
        const targetData = userSocketMap.get(targetSocketId);
        const targetSocket = io.sockets.sockets.get(targetSocketId); // Get socket object too

        // Check if caller or target exists in our map
        if (!callerData) {
            console.warn(`[DICE] Caller ${socket.id} not found in user map during start_call.`);
            // Maybe emit an error back to caller?
            return;
        }
         if (!targetData || !targetSocket) {
            console.log(`[DICE] Target user ${targetSocketId} not found or disconnected.`);
            socket.emit('call_target_unavailable', { targetSocketId });
            return;
        }

        // --- BUSY CHECK ---
        if (callerData.callState !== 'idle') {
            console.log(`[DICE] Caller ${callerName} (${socket.id}) tried to call while already in state: ${callerData.callState}`);
            socket.emit('call_error', { reason: 'You are already in a call activity.' }); // Inform caller they are busy
            return;
        }
        if (targetData.callState !== 'idle') {
            console.log(`[DICE] Target user ${targetData.username} (${targetSocketId}) is busy. State: ${targetData.callState}`);
            socket.emit('call_target_busy', { targetSocketId, targetUsername: targetData.username }); // Inform caller target is busy
            return;
        }
        // --- END BUSY CHECK ---

        // Proceed if both are idle
        const callId = `call_${socket.id}_${targetSocketId}_${Date.now()}`;
        console.log(`[DICE] Call initiated by ${callerName} (${socket.id}) to ${targetSocketId}. callId: ${callId}`);

        // --- Update States ---
        updateUserState(socket.id, { callState: 'calling', currentCallPartnerId: targetSocketId });
        updateUserState(targetSocketId, { callState: 'receiving', currentCallPartnerId: socket.id });
        // --- End Update States ---

        // Emit 'incoming_call' to the target with the callId
        io.to(targetSocketId).emit('incoming_call', {
            callerName: callerName,
            callerSocketId: socket.id,
            callId: callId
        });
    });

    socket.on('hangup_call', (data) => {
        const { targetSocketId } = data; // The ID of the *other* person they *think* they were talking to
        const senderId = socket.id;
        const senderData = userSocketMap.get(senderId);

        if (!senderData) {
             console.warn(`[DICE] Hangup received from unknown user ${senderId}`);
             return; // Unknown sender
        }

        const actualPartnerId = senderData.currentCallPartnerId;
        const notifiedTargetId = targetSocketId; // Who the client *told* us to notify

        console.log(`[DICE] Hangup initiated by ${senderData.username || senderId}. Client specified target: ${notifiedTargetId}. Actual partner: ${actualPartnerId}`);

        // Reset sender's state regardless
        updateUserState(senderId, { callState: 'idle', currentCallPartnerId: null });

        // Determine the correct partner to notify and reset state for
        const partnerToNotifyId = actualPartnerId || notifiedTargetId; // Prioritize actual partner if known, fallback to client's target

        if (!partnerToNotifyId) {
             console.log(`[DICE] No partner ID found for hangup from ${senderId}.`);
             return; // No one to notify
        }

        // Reset partner's state
         updateUserState(partnerToNotifyId, { callState: 'idle', currentCallPartnerId: null });

        // Notify the partner (if they exist and are connected)
        const partnerSocket = io.sockets.sockets.get(partnerToNotifyId);
        if (partnerSocket) {
            console.log(`[DICE] Notifying ${partnerToNotifyId} about hangup from ${senderId}`);
            io.to(partnerToNotifyId).emit('call_hungup', { hungupBySocketId: senderId });
        } else {
             console.log(`[DICE] Target ${partnerToNotifyId} not found/disconnected for hangup notification from ${senderId}`);
        }
    });

    // --- D.I.C.E. WebRTC Signaling Relays ---

    socket.on('call_offer', (data) => {
        const { targetSocketId, offer, callerName } = data;
        if (!targetSocketId || !offer) {
             console.warn(`[DICE] Invalid call_offer data from ${socket.id}. Target: ${targetSocketId}, Offer: ${!!offer}`);
             return;
        }
        // Optional: Add state check? e.g., target should be 'receiving'
        const targetData = userSocketMap.get(targetSocketId);
        if (targetData && targetData.callState !== 'receiving') {
            console.warn(`[DICE] Relaying call_offer to ${targetSocketId}, but their state is ${targetData.callState} (expected 'receiving').`);
            // Allow relay anyway, client logic should handle unexpected offers.
        }

        const targetSocket = io.sockets.sockets.get(targetSocketId);
        if (!targetSocket) {
            console.log(`[DICE] Target ${targetSocketId} not found for call_offer relay from ${socket.id}`);
            // Notify sender that target is gone?
            socket.emit('call_target_unavailable', { targetSocketId });
            updateUserState(socket.id, { callState: 'idle', currentCallPartnerId: null }); // Reset sender state
            return;
        }
        console.log(`[DICE] Relaying call offer from ${callerName || socket.username || socket.id} to ${targetSocketId}`);
        io.to(targetSocketId).emit('call_offer', { offer, callerSocketId: socket.id, callerName: callerName || socket.username });
    });

    socket.on('call_answer', (data) => {
        const { targetSocketId, answer } = data; // targetSocketId is the *original caller*
        const responderId = socket.id;

        if (!targetSocketId || !answer) {
             console.warn(`[DICE] Invalid call_answer data from ${responderId}. Target: ${targetSocketId}, Answer: ${!!answer}`);
             return;
        }

        const responderData = userSocketMap.get(responderId);
        const targetData = userSocketMap.get(targetSocketId);

        // Basic validation and state check
        if (!responderData || !targetData) {
             console.warn(`[DICE] User data not found for answer relay. Responder: ${!!responderData}, Target: ${!!targetData}`);
             return;
        }
        // Check if states are appropriate (responder was 'receiving', target was 'calling')
        if (responderData.callState !== 'receiving' || targetData.callState !== 'calling') {
            console.warn(`[DICE] call_answer state mismatch. Responder (${responderId}): ${responderData.callState}, Target (${targetSocketId}): ${targetData.callState}. Relaying anyway.`);
            // Allow relay, let clients sort it out? Or reject here? For now, relay.
        }

         // --- Update States to 'connected' ---
         updateUserState(responderId, { callState: 'connected' });
         updateUserState(targetSocketId, { callState: 'connected' });
         // --- End Update States ---

         const targetSocket = io.sockets.sockets.get(targetSocketId);
         if (!targetSocket) {
             console.log(`[DICE] Target ${targetSocketId} not found for call_answer relay from ${responderId}`);
             // Notify responder that target is gone?
             socket.emit('call_target_unavailable', { targetSocketId });
             // Reset responder state since call failed
             updateUserState(responderId, { callState: 'idle', currentCallPartnerId: null });
             // Also reset original target's state in map if they existed
             updateUserState(targetSocketId, { callState: 'idle', currentCallPartnerId: null });
             return;
         }

        console.log(`[DICE] Relaying call answer from ${responderId} to ${targetSocketId}`);
        io.to(targetSocketId).emit('call_answer', { answer, responderSocketId: responderId });
    });

    socket.on('ice_candidate', (data) => {
        const { targetSocketId, candidate } = data;
        if (!targetSocketId || !candidate) {
             console.warn(`[DICE] Invalid ice_candidate data from ${socket.id}. Target: ${targetSocketId}, Candidate: ${!!candidate}`);
             return;
         }
         // Optional: Check if sender and target are actually in a call together?
         const senderData = userSocketMap.get(socket.id);
         if (senderData && senderData.currentCallPartnerId !== targetSocketId) {
              console.warn(`[DICE] ICE candidate relay attempt from ${socket.id} to ${targetSocketId}, but they are not registered partners.`);
              // Don't relay if they aren't partners? Or allow it? For now, allow.
         }

          const targetSocket = io.sockets.sockets.get(targetSocketId);
          if (!targetSocket) {
             // Normal occurrence if partner disconnects during ICE, don't log spam
             // console.log(`[DICE] Target ${targetSocketId} not found for ice_candidate relay from ${socket.id}`);
             return;
         }
        // console.log(`[DICE] Relaying ICE candidate from ${socket.id} to ${targetSocketId}`); // Too verbose
        io.to(targetSocketId).emit('ice_candidate', { candidate, senderSocketId: socket.id });
    });
    // --- END D.I.C.E. Relays ---


    // --- Error listeners from client --- (Unchanged)
    socket.on('video_drop_error', (data) => { console.error(`Client ${socket.id} video error:`, data.reason); });
    socket.on('voice_drop_error', (data) => { console.error(`Client ${socket.id} voice error:`, data.reason); });
    socket.on('image_drop_error', (data) => { console.error(`Client ${socket.id} image error:`, data.reason); });


    socket.on('disconnect', () => {
        const userData = userSocketMap.get(socket.id); // Get data *before* deleting
        const username = userData ? userData.username : socket.username || 'Unknown';
        const roomId = userData ? userData.roomId : socket.roomId;
        const userCallState = userData ? userData.callState : 'idle';
        const userPartnerId = userData ? userData.currentCallPartnerId : null;

        console.log(`User disconnected: ${socket.id} (User: ${username}, Room: ${roomId || 'N/A'}, State: ${userCallState})`);

        // --- Handle disconnect during call ---
        if (userCallState !== 'idle' && userPartnerId) {
            console.log(`[DICE] User ${username} (${socket.id}) disconnected during call with ${userPartnerId}. Notifying partner.`);
            const partnerSocket = io.sockets.sockets.get(userPartnerId);
            if (partnerSocket) {
                // Reset partner's state in the map
                updateUserState(userPartnerId, { callState: 'idle', currentCallPartnerId: null });
                // Notify partner client
                io.to(userPartnerId).emit('call_hungup', { hungupBySocketId: socket.id });
            } else {
                 console.log(`[DICE] Partner ${userPartnerId} not found during disconnect cleanup for ${socket.id}.`);
            }
        }
        // --- End handle disconnect during call ---

        userSocketMap.delete(socket.id); // Remove user from map *after* getting partner info

        if (roomId) {
            // Notify room about user leaving (standard chat notification)
            console.log(`Notifying room ${roomId} that ${username} left`);
            socket.to(roomId).emit('user_left_chat', { user: username, socketId: socket.id });
        }
    });

}); // End io.on('connection', ...)

// --- Routes & Server Start (Unchanged) ---
app.get('/c/:roomId', (req, res) => { res.redirect(`/index.html?session=${encodeURIComponent(req.params.roomId)}`); });
app.get('/', (req, res) => { res.redirect('/index.html'); });
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => { console.log(`Server running on port ${PORT}`); });