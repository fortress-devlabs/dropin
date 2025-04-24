// --- server.js (v28.1 - Integrated Specific Dialer Logic [check_drop_id, validate_drop_code]) --- // MODIFIED Version Comment

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
// Optional: const crypto = require('crypto');

const app = express();
const server = http.createServer(app);

// Helper to format bytes for logging (Unchanged)
function formatBytes(bytes, decimals = 2) {
    if (!bytes || bytes === 0) return '0 Bytes';
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.max(0, Math.floor(Math.log(Math.abs(bytes)) / Math.log(k)));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

const io = new Server(server, {
    cors: {
        origin: '*', // Allow all origins for simplicity, restrict in production
        methods: ['GET', 'POST']
    },
    pingInterval: 20000,
    pingTimeout: 120000,
    maxHttpBufferSize: 1e8 // 100MB limit
});

// Serve static files if needed (Unchanged)
app.use(express.static('public'));
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: true, limit: '100mb' }));

// --- Application State ---

// 1. User/Socket Tracking (Combined Messenger, Dialer, Receiver)
const userSocketMap = new Map(); // socket.id -> { username?, roomId?, dropId?, context: 'messenger' | 'dialer' | 'receiver', callState: 'idle' | ..., currentCallPartnerId: string | null }

// 2. Drop ID Ownership & Lookup
// Maps a Drop ID to the *current socket.id* of the logged-in user (Messenger or Receiver).
const dropIdOwnerSocket = {
    // Populated dynamically on connection
};

// 3. 🔐 Drop Code Config (Static, from Adam/ChatGPT's snippet - Replace with DB later)
const dropCodeMap = {
  '0000': 'VELVET',
  '1234': 'HELLO123',
  // Add more DropIDs + codes as needed
};

// 4. 🔄 Track attempts per caller per DropID (From Adam/ChatGPT's snippet)
const callerAttempts = {}; // key: `${callerSocketId}_${targetDropId}` -> attemptCount

// --- Helper Functions ---
const updateUserState = (socketId, updates) => {
    const userData = userSocketMap.get(socketId);
    if (userData) {
        userSocketMap.set(socketId, { ...userData, ...updates });
         // console.log(`[State Update] ${socketId}:`, userSocketMap.get(socketId)); // Verbose
    } else {
        // Don't warn here, might be expected during disconnect cleanup
        // console.warn(`[State Update] User data not found for ${socketId} during update:`, updates);
    }
};

function findSocketIdForDropId(dropId) {
    return dropIdOwnerSocket[dropId] || null;
}
// --- End Helper Functions ---

// --- Socket.IO Connection Handling ---
io.on('connection', (socket) => {
    console.log(`[Socket] Connected: ${socket.id}`);
    const { username, sessionId, context, userDropId } = socket.handshake.query;
    // Determine context, default to 'messenger' if ambiguous
    const connectionContext = (context === 'dialer' || context === 'receiver') ? context : 'messenger';

    console.log(`Handshake Info -> Context: ${connectionContext}, User: ${username || 'N/A'}, Session: ${sessionId || 'N/A'}, DropID: ${userDropId || 'N/A'}, Socket: ${socket.id}`);

    // Initialize basic state for all connections
    userSocketMap.set(socket.id, {
        username: username || null,
        roomId: sessionId || null,
        dropId: userDropId || null, // Owned Drop ID
        context: connectionContext,
        callState: 'idle',
        currentCallPartnerId: null
    });

    // --- Context-Specific Connection Logic ---

    // ** MESSENGER USERS **
    if (connectionContext === 'messenger') {
        socket.username = username;
        socket.dropId = userDropId;

        // Map owner Drop ID
        if (userDropId && dropCodeMap.hasOwnProperty(userDropId)) {
            dropIdOwnerSocket[userDropId] = socket.id;
            console.log(`[Mapping] Drop ID ${userDropId} (Messenger) mapped to Socket ID ${socket.id}`);
        }

        // MESSENGER: join_chat_room Event (Logic unchanged from v28.0)
        socket.on('join_chat_room', (data) => {
             const { room, user } = data;
             if (!room || !user) { console.error("[Messenger] Join attempt invalid:", data); return; }
             const currentUserData = userSocketMap.get(socket.id);
             // Leave previous room logic
             if (currentUserData && currentUserData.roomId && currentUserData.roomId !== room) {
                 if (currentUserData.callState !== 'idle' && currentUserData.currentCallPartnerId) {
                     console.log(`[DICE/Messenger] User ${user} (${socket.id}) leaving room ${currentUserData.roomId} while in call state: ${currentUserData.callState}. Notifying partner.`);
                     const partnerSocket = io.sockets.sockets.get(currentUserData.currentCallPartnerId);
                     if (partnerSocket) {
                         io.to(currentUserData.currentCallPartnerId).emit('call_hungup', { hungupBySocketId: socket.id });
                         updateUserState(currentUserData.currentCallPartnerId, { callState: 'idle', currentCallPartnerId: null });
                     }
                 }
                 console.log(`[Messenger] User ${user} (${socket.id}) leaving previous room ${currentUserData.roomId}`);
                 socket.leave(currentUserData.roomId);
                 socket.to(currentUserData.roomId).emit('user_left_chat', { user: currentUserData.username, socketId: socket.id });
             }
             // Join new room and update state
             socket.join(room);
             socket.roomId = room;
             updateUserState(socket.id, { roomId: room, username: user, callState: 'idle', currentCallPartnerId: null });
             console.log(`[Messenger] User ${user} (${socket.id}) joined chat room ${room}`);
             // Notify others & send user list
             socket.to(room).emit('user_joined_chat', { user, socketId: socket.id });
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

        // MESSENGER: Standard Chat Events (Unchanged)
        socket.on('chat_message', (data) => { const { username, message, session } = data; const targetRoom = session || socket.roomId; if (!targetRoom || !username || message === undefined) { return; } socket.to(targetRoom).emit('chat_message', { username, message, senderSocketId: socket.id }); });
        socket.on('start_typing', (data) => { const targetRoom = data.session || socket.roomId; if (targetRoom && data.username) socket.to(targetRoom).emit('user_started_typing', { username: data.username, socketId: socket.id }); });
        socket.on('stop_typing', (data) => { const targetRoom = data.session || socket.roomId; if (targetRoom && data.username) socket.to(targetRoom).emit('user_stopped_typing', { username: data.username, socketId: socket.id }); });

        // MESSENGER: Media Drop Events (Unchanged)
        socket.on('video_drop', (data) => { const { username, session, videoBuffer } = data; const targetRoom = session || socket.roomId; if (!targetRoom || !username || !videoBuffer) { return; } let bufferToSend; let bufferSize = 0; if (videoBuffer instanceof ArrayBuffer) { bufferToSend = videoBuffer; bufferSize = videoBuffer.byteLength; } else if (videoBuffer instanceof Buffer) { bufferToSend = videoBuffer; bufferSize = videoBuffer.length; } else { return; } const SERVER_MAX_VIDEO_SIZE = 95 * 1024 * 1024; if (bufferSize > SERVER_MAX_VIDEO_SIZE) { socket.emit('video_drop_error', { reason: 'Video file too large.' }); return; } io.to(targetRoom).emit('video_drop', { username, videoBuffer: bufferToSend, senderSocketId: socket.id }); });
        socket.on('voice_drop', (data) => { const { username, session, audioBuffer } = data; const targetRoom = session || socket.roomId; if (!targetRoom || !username || !audioBuffer) { return; } let bufferToSend; let bufferSize = 0; if (audioBuffer instanceof ArrayBuffer) { bufferToSend = audioBuffer; bufferSize = audioBuffer.byteLength; } else if (audioBuffer instanceof Buffer) { bufferToSend = audioBuffer; bufferSize = audioBuffer.length; } else { return; } const SERVER_MAX_AUDIO_SIZE = 15 * 1024 * 1024; if (bufferSize > SERVER_MAX_AUDIO_SIZE) { socket.emit('voice_drop_error', { reason: 'Voice recording too large.' }); return; } io.to(targetRoom).emit('voice_drop', { username, audioBuffer: bufferToSend, senderSocketId: socket.id }); });

        // MESSENGER: D.I.C.E. Call Initiation (start_call) (Logic unchanged from v28.0)
        socket.on('start_call', (data) => {
            const { targetSocketId, callerName } = data;
            if (!targetSocketId || !callerName) { console.warn(`[DICE/Messenger] Invalid start_call data from ${socket.id}:`, data); return; }
            const callerData = userSocketMap.get(socket.id);
            const targetData = userSocketMap.get(targetSocketId);
            const targetSocket = io.sockets.sockets.get(targetSocketId);
            if (!callerData) { console.warn(`[DICE/Messenger] Caller ${socket.id} not found in map.`); return; }
            if (!targetData || !targetSocket) { console.log(`[DICE/Messenger] Target ${targetSocketId} not found/disconnected.`); socket.emit('call_target_unavailable', { targetSocketId }); return; }
            // Busy Check
            if (callerData.callState !== 'idle') { console.log(`[DICE/Messenger] Caller ${callerName} busy: ${callerData.callState}`); socket.emit('call_error', { reason: 'You are already busy.' }); return; }
            if (targetData.callState !== 'idle') { console.log(`[DICE/Messenger] Target ${targetData.username} busy: ${targetData.callState}`); socket.emit('call_target_busy', { targetSocketId, targetUsername: targetData.username }); return; }
            // Proceed
            const callId = `call_${socket.id}_${targetSocketId}_${Date.now()}`;
            console.log(`[DICE/Messenger] Call initiated by ${callerName} (${socket.id}) to ${targetData.username} (${targetSocketId}). callId: ${callId}`);
            updateUserState(socket.id, { callState: 'calling', currentCallPartnerId: targetSocketId });
            updateUserState(targetSocketId, { callState: 'receiving', currentCallPartnerId: socket.id });
            io.to(targetSocketId).emit('incoming_call', { callerName: callerName, callerSocketId: socket.id, callId: callId });
        });
    }

    // ** RECEIVER APP USERS (Standalone Answerer) **
    if (connectionContext === 'receiver') {
        socket.dropId = userDropId; // Store owned DropID

        // Map owner Drop ID (based on clarification)
        if (userDropId && dropCodeMap.hasOwnProperty(userDropId)) {
            dropIdOwnerSocket[userDropId] = socket.id;
            console.log(`[Mapping] Drop ID ${userDropId} (Receiver) mapped to Socket ID ${socket.id}`);
            // Update state to reflect this user is idle and owns the ID
             updateUserState(socket.id, { dropId: userDropId });
        } else if (userDropId) {
            console.warn(`[Receiver] User connected with Drop ID ${userDropId}, but it's not in the known dropCodeMap.`);
        } else {
             console.warn(`[Receiver] User connected without specifying a userDropId.`);
        }
        // Receivers primarily just wait for events relayed to them ('incoming_call', 'call_offer', etc.)
        // No specific event listeners needed here unless adding receiver-specific actions.
    }

    // ** DIALER USERS **
    if (connectionContext === 'dialer') {
        // Using the exact logic provided by Adam/ChatGPT for these events:

        // 🟢 1. Validate Drop ID (check_drop_id)
        socket.on('check_drop_id', ({ dropId }) => {
             console.log(`[Dialer] check_drop_id received for ${dropId} from ${socket.id}`);
             if (!dropId) return;

             const requiresCode = dropCodeMap.hasOwnProperty(dropId);
             const targetOwnerSocketId = findSocketIdForDropId(dropId); // Find current owner socket
             const targetOwnerData = targetOwnerSocketId ? userSocketMap.get(targetOwnerSocketId) : null;

             updateUserState(socket.id, { callState: 'checking_id', targetDropId: dropId }); // Update dialer state

             if (requiresCode && targetOwnerSocketId && targetOwnerData) {
                 // Drop ID needs code and owner is online
                  if (targetOwnerData.callState !== 'idle') {
                      // Owner is busy
                      console.log(`[Dialer] Target Drop ID owner ${targetOwnerSocketId} is busy: ${targetOwnerData.callState}`);
                      socket.emit('call_target_busy', { targetSocketId: targetOwnerSocketId, targetUsername: targetOwnerData.username });
                      updateUserState(socket.id, { callState: 'idle', targetDropId: null }); // Reset dialer
                  } else {
                     // Owner is available, inform dialer
                     socket.emit('drop_id_status', {
                         status: 'available',
                         dropId,
                         requiresCode: true, // Yes, code needed
                         displayName: targetOwnerData.username || `Drop ${dropId}`,
                         targetSocketId: targetOwnerSocketId // Send actual socket ID
                     });
                      // Update dialer state - store target, requires code
                     updateUserState(socket.id, {
                         requiresCode: true,
                         targetSocketId: targetOwnerSocketId,
                         targetDisplayName: targetOwnerData.username || `Drop ${dropId}`
                         // State will change on client based on this response
                     });
                 }
             } else if (requiresCode && !targetOwnerSocketId) {
                 // Requires code, but owner offline
                 console.log(`[Dialer] Target Drop ID owner ${dropId} is offline.`);
                 socket.emit('drop_id_status', { status: 'unavailable', dropId });
                 updateUserState(socket.id, { callState: 'idle', targetDropId: null }); // Reset dialer
             }
             // --- ADDED CASE: Public Drop ID (exists but NO code required) ---
             else if (!requiresCode && dropId === 'PUBLIC_ID_EXAMPLE') { // EXAMPLE - Replace with your logic for public IDs
                  console.log(`[Dialer] Public Drop ID ${dropId} found.`);
                  // Find owner, check if busy etc. (similar logic to above)
                  // const targetOwnerSocketId = findSocketIdForDropId(dropId);
                  // const targetOwnerData = ...
                  // if (targetOwnerSocketId && targetOwnerData && targetOwnerData.callState === 'idle') {
                     socket.emit('drop_id_status', {
                         status: 'available',
                         dropId,
                         requiresCode: false, // NO code needed
                         displayName: `Public Line ${dropId}`, // Example name
                         targetSocketId: 'SOCKET_ID_FOR_PUBLIC_LINE' // Example target
                     });
                      // Update dialer state
                     // } else { /* Handle busy/offline for public ID */ }
             }
              // --- END ADDED CASE ---
             else {
                 // Invalid Drop ID (not in map, not public)
                 console.log(`[Dialer] Drop ID ${dropId} is invalid.`);
                 socket.emit('drop_id_status', { status: 'invalid', dropId });
                 updateUserState(socket.id, { callState: 'idle', targetDropId: null }); // Reset dialer
             }
        });


        // 🔐 2. Validate Drop Code
        socket.on('validate_drop_code', ({ dropId, code, callerSocketId }) => { // Use callerSocketId from client data if needed
             const senderSocketId = socket.id; // Prefer server-side socket ID
             console.log(`[Dialer] validate_drop_code received for ${dropId} from ${senderSocketId}, code: ${code}`);
             if (!dropId || code === undefined || callerSocketId !== senderSocketId) { console.warn('[Dialer] Invalid validate_drop_code data'); return; }

             const correctCode = dropCodeMap[dropId];
             const key = `${senderSocketId}_${dropId}`;

             const callerData = userSocketMap.get(senderSocketId);
             if (!callerData || callerData.callState !== 'awaiting_code') {
                 console.warn(`[Dialer] Received validate_drop_code from ${senderSocketId} but state is ${callerData?.callState}`);
                 return;
             }

             updateUserState(senderSocketId, { callState: 'validating_code' }); // Update state

             if (!callerAttempts[key]) callerAttempts[key] = 0;
             callerAttempts[key]++;
             const attempt = callerAttempts[key];

             if (code === correctCode) {
                 console.log(`[Dialer] Code VALID for ${dropId} from ${senderSocketId}`);
                 socket.emit('drop_code_validation', { isValid: true, dropId });
                 delete callerAttempts[key]; // Reset attempts on success
                 // Update state - Ready to ring
                 updateUserState(senderSocketId, { callState: 'ringing' }); // Client will initiate WebRTC offer now
             } else {
                 console.log(`[Dialer] Code INVALID for ${dropId} from ${senderSocketId}. Attempt: ${attempt}`);
                 socket.emit('drop_code_validation', { isValid: false, dropId, attempt });

                 if (attempt >= 3) {
                     console.log(`[Dialer] Max attempts reached for ${senderSocketId} -> ${dropId}.`);
                     delete callerAttempts[key]; // Reset after final failure
                     updateUserState(senderSocketId, { callState: 'idle', targetDropId: null, targetSocketId: null }); // Reset state, client handles UI/disconnect
                 } else {
                      // Update state back to awaiting code
                     updateUserState(senderSocketId, { callState: 'awaiting_code' });
                 }
             }
        });

    } // End if (connectionContext === 'dialer')


    // --- SHARED EVENTS (Used by Messenger, Dialer, Receiver WebRTC) ---

    // --- REVISED hangup_call / call_rejected Logic --- (Unchanged from v28.0 - Handles both contexts)
    socket.on('hangup_call', (data) => {
        const { targetSocketId } = data; // The ID of the person they were talking to/calling
        const senderId = socket.id;
        const senderData = userSocketMap.get(senderId);
        if (!senderData) { console.warn(`[Hangup] Received from unknown user ${senderId}`); return; }
        const actualPartnerId = senderData.currentCallPartnerId;
        const notifiedTargetId = targetSocketId;
        console.log(`[Hangup] Initiated by ${senderData.username || senderId} (Context: ${senderData.context}). Client specified target: ${notifiedTargetId}. Actual partner: ${actualPartnerId}`);
        const partnerToNotifyId = actualPartnerId || notifiedTargetId;
        const senderPreviousState = senderData.callState;
        updateUserState(senderId, { callState: 'idle', currentCallPartnerId: null, targetDropId: null, targetSocketId: null });
        if (!partnerToNotifyId) { console.log(`[Hangup] No partner ID found for hangup from ${senderId}.`); return; }
        const partnerData = userSocketMap.get(partnerToNotifyId);
        const partnerSocket = io.sockets.sockets.get(partnerToNotifyId);
        updateUserState(partnerToNotifyId, { callState: 'idle', currentCallPartnerId: null }); // Reset partner state
        if (partnerSocket) {
            const partnerWasReceivingOrRinging = partnerData && (partnerData.callState === 'receiving' || partnerData.callState === 'ringing');
            const senderWasCallingOrRinging = senderPreviousState === 'calling' || senderPreviousState === 'ringing';

            if (partnerWasReceivingOrRinging) {
                console.log(`[Hangup] Call rejected/cancelled by ${senderId} before connection. Notifying ${partnerToNotifyId} with 'call_rejected'.`);
                io.to(partnerToNotifyId).emit('call_rejected', { rejectedBySocketId: senderId });
            } else if (senderWasCallingOrRinging) {
                 console.log(`[Hangup] Call cancelled by sender ${senderId} during ringing/calling. Notifying ${partnerToNotifyId} with 'call_hungup'.`);
                 io.to(partnerToNotifyId).emit('call_hungup', { hungupBySocketId: senderId });
            } else {
                console.log(`[Hangup] Normal hangup. Notifying ${partnerToNotifyId} with 'call_hungup'.`);
                io.to(partnerToNotifyId).emit('call_hungup', { hungupBySocketId: senderId });
            }
        } else { console.log(`[Hangup] Target partner ${partnerToNotifyId} not found/disconnected.`); }
        // Clean up dialer attempts
        if (senderData.context === 'dialer' && senderData.targetDropId) {
             const key = `${senderId}_${senderData.targetDropId}`;
             delete callerAttempts[key];
        }
    });

    // --- WebRTC Signaling Relays (Unchanged from v28.0 - Should work for all contexts) ---
    socket.on('call_offer', (data) => {
        const { targetSocketId, offer, callerId } = data;
        const senderId = socket.id;
        if (!targetSocketId || !offer) { console.warn(`[WebRTC] Invalid call_offer data from ${senderId}.`); return; }
        const senderData = userSocketMap.get(senderId);
        const targetData = userSocketMap.get(targetSocketId);
        const senderContext = senderData ? senderData.context : 'unknown';
        console.log(`[WebRTC] Relaying call_offer from ${senderId} (Context: ${senderContext}) to ${targetSocketId}`);
        if (!targetData) { console.log(`[WebRTC] Target ${targetSocketId} not found.`); socket.emit('call_target_unavailable', { targetSocketId }); if (senderData && (senderData.callState === 'calling' || senderData.callState === 'ringing')) { updateUserState(senderId, { callState: 'idle', currentCallPartnerId: null }); } return; }
        if (targetData.callState !== 'idle' && targetData.callState !== 'receiving' && targetData.callState !== 'ringing') { console.warn(`[WebRTC] Target ${targetSocketId} busy (${targetData.callState}).`); socket.emit('call_target_busy', { targetSocketId, targetUsername: targetData.username }); if (senderData && (senderData.callState === 'calling' || senderData.callState === 'ringing')) { updateUserState(senderId, { callState: 'idle', currentCallPartnerId: null }); } return; }
        // Update target state if idle/ringing (Dialer flow needs this)
        if (targetData.callState === 'idle' || targetData.callState === 'ringing') { updateUserState(targetSocketId, { callState: 'receiving', currentCallPartnerId: senderId }); }
        io.to(targetSocketId).emit('call_offer', { offer, callerSocketId: senderId, callerName: senderData ? senderData.username : null });
    });

    socket.on('call_answer', (data) => {
        const { targetSocketId, answer } = data; // target is original caller
        const responderId = socket.id;
        if (!targetSocketId || !answer) { console.warn(`[WebRTC] Invalid call_answer data from ${responderId}.`); return; }
        const responderData = userSocketMap.get(responderId);
        const targetData = userSocketMap.get(targetSocketId);
        if (!responderData || !targetData) { console.warn(`[WebRTC] User data not found for answer relay.`); return; }
        const validResponderStates = ['receiving', 'ringing'];
        const validTargetStates = ['calling', 'ringing'];
        if (!validResponderStates.includes(responderData.callState) || !validTargetStates.includes(targetData.callState)) { console.warn(`[WebRTC] call_answer state mismatch. Responder (${responderId}): ${responderData.callState}, Target (${targetSocketId}): ${targetData.callState}. Aborting.`); return; }
        console.log(`[WebRTC] Call connected between ${targetSocketId} and ${responderId}`);
        updateUserState(responderId, { callState: 'connected' });
        updateUserState(targetSocketId, { callState: 'connected' });
        io.to(targetSocketId).emit('call_answer', { answer, responderSocketId: responderId });
    });

    socket.on('ice_candidate', (data) => {
        const { targetSocketId, candidate } = data;
        if (!targetSocketId || !candidate) { return; }
        io.to(targetSocketId).emit('ice_candidate', { candidate, senderSocketId: socket.id });
    });
    // --- END SHARED EVENTS ---

    // --- Disconnect Handling --- (Unchanged from v28.0 - Cleans up based on context)
    socket.on('disconnect', () => {
        const disconnectedSocketId = socket.id;
        const userData = userSocketMap.get(disconnectedSocketId);
        if (!userData) { console.log(`[Socket] Disconnected: ${disconnectedSocketId} (No user data)`); return; }
        const { username, roomId, dropId, context, callState, currentCallPartnerId } = userData;
        console.log(`[Socket] Disconnected: ${disconnectedSocketId} (User: ${username || 'Dialer/Receiver'}, Context: ${context}, Room: ${roomId || 'N/A'}, DropID: ${dropId || 'N/A'}, State: ${callState})`);
        // Handle call disconnect
        if (callState !== 'idle' && currentCallPartnerId) {
            console.log(`[Disconnect] Notifying partner ${currentCallPartnerId}.`);
            const partnerSocket = io.sockets.sockets.get(currentCallPartnerId);
            if (partnerSocket) {
                updateUserState(currentCallPartnerId, { callState: 'idle', currentCallPartnerId: null });
                io.to(currentCallPartnerId).emit('call_hungup', { hungupBySocketId: disconnectedSocketId });
            } else {
                updateUserState(currentCallPartnerId, { callState: 'idle', currentCallPartnerId: null }); // Clean map anyway
            }
        }
        // Cleanup
        if ((context === 'messenger' || context === 'receiver') && dropId && dropIdOwnerSocket[dropId] === disconnectedSocketId) { delete dropIdOwnerSocket[dropId]; console.log(`[Mapping] Removed mapping for Drop ID ${dropId}`); }
        Object.keys(callerAttempts).forEach(key => { if (key.startsWith(`${disconnectedSocketId}_`)) { delete callerAttempts[key]; } });
        if (context === 'messenger' && roomId) { socket.to(roomId).emit('user_left_chat', { user: username || 'User', socketId: disconnectedSocketId }); }
        userSocketMap.delete(disconnectedSocketId);
        console.log(`[State] Removed user data for ${disconnectedSocketId}. Current users: ${userSocketMap.size}`);
    });

}); // End io.on('connection', ...)

// --- Routes & Server Start (Unchanged) ---
app.get('/c/:roomId', (req, res) => { res.redirect(`/index.html?session=${encodeURIComponent(req.params.roomId)}`); });
app.get('/', (req, res) => { res.redirect('/index.html'); });
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => { console.log(`🚀 Drop Server running on port ${PORT}`); });