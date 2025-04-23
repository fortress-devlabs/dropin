// --- server.js (v28.0 - Integrated Drop Phone Dialer Logic [Velvet Rope]) --- // MODIFIED Version Comment

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

// 1. User/Socket Tracking (Combined Messenger & Dialer)
// Stores info about connected sockets. Differentiates between logged-in Messenger users and anonymous Dialer callers.
const userSocketMap = new Map(); // socket.id -> { username?, roomId?, dropId?, context: 'messenger' | 'dialer', callState: 'idle' | 'checking_id' | 'awaiting_code' | 'validating_code' | 'calling' | 'receiving' | 'ringing' | 'connected', currentCallPartnerId: string | null }

// 2. Drop ID Ownership & Lookup
// Maps a Drop ID (like '0000') to the *current socket.id* of the logged-in Messenger user who owns it.
// CRITICAL: This needs to be updated dynamically when users connect/disconnect via Messenger.
const dropIdOwnerSocket = {
    // Example: '0000': 'socketIdOfKunleMessengerSession'
    // This should be populated when Kunle logs into Messenger with DropID 0000
};

// 3. Drop Code Configuration (Static for now, move to DB later)
const dropCodeMap = {
  '0000': 'VELVET', // Kunle's Drop ID
  '1234': 'HELLO123',
  // Add more as needed
};

// 4. Dialer Attempt Tracking (Temporary state for anonymous callers)
const callerAttempts = {}; // key: `${callerSocketId}_${targetDropId}` -> attemptCount

// --- Helper Functions ---
const updateUserState = (socketId, updates) => {
    const userData = userSocketMap.get(socketId);
    if (userData) {
        userSocketMap.set(socketId, { ...userData, ...updates });
        // console.log(`[State Update] ${socketId}:`, userSocketMap.get(socketId)); // Verbose state logging
    } else {
        console.warn(`[State Update] User data not found for ${socketId} during update:`, updates);
    }
};

// Function to find the socket ID currently associated with a Drop ID
function findSocketIdForDropId(dropId) {
    // V1: Simple lookup in dropIdOwnerSocket map
    return dropIdOwnerSocket[dropId] || null;

    // V2 (More Robust): Iterate userSocketMap if needed
    // for (const [socketId, userData] of userSocketMap.entries()) {
    //     if (userData.context === 'messenger' && userData.dropId === dropId) {
    //         return socketId;
    //     }
    // }
    // return null;
}

// --- Socket.IO Connection Handling ---
io.on('connection', (socket) => {
    console.log(`[Socket] Connected: ${socket.id}`);
    // Determine context: Messenger user or Dialer user?
    const { username, sessionId, context, userDropId } = socket.handshake.query;
    const connectionContext = context === 'dialer' ? 'dialer' : 'messenger'; // Default to messenger if context not provided

    console.log(`Handshake Info -> Context: ${connectionContext}, User: ${username || 'N/A'}, Session: ${sessionId || 'N/A'}, DropID: ${userDropId || 'N/A'}, Socket: ${socket.id}`);

    // Initialize basic state for all connections
    userSocketMap.set(socket.id, {
        username: username || null, // Null for anonymous dialer
        roomId: sessionId || null, // Null for dialer
        dropId: userDropId || null, // The Drop ID this user *owns* (if applicable)
        context: connectionContext,
        callState: 'idle',
        currentCallPartnerId: null
    });

    // ** SPECIFIC LOGIC FOR MESSENGER USERS **
    if (connectionContext === 'messenger') {
        socket.username = username; // Store on socket for convenience (original pattern)
        socket.dropId = userDropId; // Store owned DropID

        // If this user owns a Drop ID, map it to their current socket ID
        if (userDropId && dropCodeMap.hasOwnProperty(userDropId)) { // Check if it's a known Drop ID needing mapping
            dropIdOwnerSocket[userDropId] = socket.id;
            console.log(`[Mapping] Drop ID ${userDropId} mapped to Socket ID ${socket.id}`);
        }

        // --- MESSENGER: join_chat_room Event ---
        socket.on('join_chat_room', (data) => {
            const { room, user } = data;
            if (!room || !user) { console.error("[Messenger] Join attempt invalid:", data); return; }

            const currentUserData = userSocketMap.get(socket.id);
            // Leave previous room logic (slightly adapted)
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
            socket.roomId = room; // Keep on socket for chat convenience
            updateUserState(socket.id, {
                roomId: room,
                username: user, // Ensure username is updated if changed
                callState: 'idle', // Reset call state on joining new room
                currentCallPartnerId: null
            });
            console.log(`[Messenger] User ${user} (${socket.id}) joined chat room ${room}`);

            // Notify others & send user list (Unchanged from original)
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

        // --- MESSENGER: Standard Chat Events --- (Unchanged)
        socket.on('chat_message', (data) => { const { username, message, session } = data; const targetRoom = session || socket.roomId; if (!targetRoom || !username || message === undefined) { console.warn("[Messenger] Invalid chat message:", data); return; } socket.to(targetRoom).emit('chat_message', { username, message, senderSocketId: socket.id }); });
        socket.on('start_typing', (data) => { const targetRoom = data.session || socket.roomId; if (targetRoom && data.username) socket.to(targetRoom).emit('user_started_typing', { username: data.username, socketId: socket.id }); });
        socket.on('stop_typing', (data) => { const targetRoom = data.session || socket.roomId; if (targetRoom && data.username) socket.to(targetRoom).emit('user_stopped_typing', { username: data.username, socketId: socket.id }); });

        // --- MESSENGER: Media Drop Events --- (Unchanged)
        socket.on('video_drop', (data) => { const { username, session, videoBuffer } = data; const targetRoom = session || socket.roomId; if (!targetRoom || !username || !videoBuffer) { return; } let bufferToSend; let bufferSize = 0; if (videoBuffer instanceof ArrayBuffer) { bufferToSend = videoBuffer; bufferSize = videoBuffer.byteLength; } else if (videoBuffer instanceof Buffer) { bufferToSend = videoBuffer; bufferSize = videoBuffer.length; } else { return; } const SERVER_MAX_VIDEO_SIZE = 95 * 1024 * 1024; if (bufferSize > SERVER_MAX_VIDEO_SIZE) { socket.emit('video_drop_error', { reason: 'Video file too large.' }); return; } io.to(targetRoom).emit('video_drop', { username, videoBuffer: bufferToSend, senderSocketId: socket.id }); });
        socket.on('voice_drop', (data) => { const { username, session, audioBuffer } = data; const targetRoom = session || socket.roomId; if (!targetRoom || !username || !audioBuffer) { return; } let bufferToSend; let bufferSize = 0; if (audioBuffer instanceof ArrayBuffer) { bufferToSend = audioBuffer; bufferSize = audioBuffer.byteLength; } else if (audioBuffer instanceof Buffer) { bufferToSend = audioBuffer; bufferSize = audioBuffer.length; } else { return; } const SERVER_MAX_AUDIO_SIZE = 15 * 1024 * 1024; if (bufferSize > SERVER_MAX_AUDIO_SIZE) { socket.emit('voice_drop_error', { reason: 'Voice recording too large.' }); return; } io.to(targetRoom).emit('voice_drop', { username, audioBuffer: bufferToSend, senderSocketId: socket.id }); });

        // --- MESSENGER: D.I.C.E. Call Initiation (start_call) --- (Largely Unchanged, uses userSocketMap)
        socket.on('start_call', (data) => {
            const { targetSocketId, callerName } = data;
            if (!targetSocketId || !callerName) { console.warn(`[DICE/Messenger] Invalid start_call data from ${socket.id}:`, data); return; }

            const callerData = userSocketMap.get(socket.id);
            const targetData = userSocketMap.get(targetSocketId);
            const targetSocket = io.sockets.sockets.get(targetSocketId);

            if (!callerData) { console.warn(`[DICE/Messenger] Caller ${socket.id} not found in map.`); return; }
            if (!targetData || !targetSocket) { console.log(`[DICE/Messenger] Target ${targetSocketId} not found/disconnected.`); socket.emit('call_target_unavailable', { targetSocketId }); return; }

            // Busy Check (using userSocketMap state)
            if (callerData.callState !== 'idle') { console.log(`[DICE/Messenger] Caller ${callerName} busy: ${callerData.callState}`); socket.emit('call_error', { reason: 'You are already busy.' }); return; }
            if (targetData.callState !== 'idle') { console.log(`[DICE/Messenger] Target ${targetData.username} busy: ${targetData.callState}`); socket.emit('call_target_busy', { targetSocketId, targetUsername: targetData.username }); return; }

            // Proceed
            const callId = `call_${socket.id}_${targetSocketId}_${Date.now()}`;
            console.log(`[DICE/Messenger] Call initiated by ${callerName} (${socket.id}) to ${targetData.username} (${targetSocketId}). callId: ${callId}`);
            updateUserState(socket.id, { callState: 'calling', currentCallPartnerId: targetSocketId });
            updateUserState(targetSocketId, { callState: 'receiving', currentCallPartnerId: socket.id });
            io.to(targetSocketId).emit('incoming_call', { callerName: callerName, callerSocketId: socket.id, callId: callId });
        });
    } // End if (connectionContext === 'messenger')

    // ** SPECIFIC LOGIC FOR DIALER USERS **
    if (connectionContext === 'dialer') {

        // --- DIALER: check_drop_id Event ---
        socket.on('check_drop_id', ({ dropId }) => {
            console.log(`[Dialer] check_drop_id received for ${dropId} from ${socket.id}`);
            if (!dropId) return;

            // Check if Drop ID requires a code
            const requiresCode = dropCodeMap.hasOwnProperty(dropId);
            const correctCode = dropCodeMap[dropId]; // Needed for validation later, but presence implies requirement

            // Find the *current socket* owning this Drop ID
            const targetOwnerSocketId = findSocketIdForDropId(dropId);
            const targetOwnerData = targetOwnerSocketId ? userSocketMap.get(targetOwnerSocketId) : null;

            // Update Dialer's state
            updateUserState(socket.id, { callState: 'checking_id', targetDropId: dropId });

            if (requiresCode && targetOwnerSocketId && targetOwnerData) {
                // Drop ID exists, requires code, and owner is ONLINE
                // Check if owner is busy
                 if (targetOwnerData.callState !== 'idle') {
                     console.log(`[Dialer] Target Drop ID owner ${targetOwnerSocketId} is busy: ${targetOwnerData.callState}`);
                     socket.emit('call_target_busy', { targetSocketId: targetOwnerSocketId, targetUsername: targetOwnerData.username });
                     // Reset dialer state back to idle after busy signal
                     updateUserState(socket.id, { callState: 'idle', targetDropId: null });
                 } else {
                     // Owner is available, proceed with code check
                     socket.emit('drop_id_status', {
                         status: 'available',
                         dropId,
                         requiresCode: true,
                         displayName: targetOwnerData.username || `Drop ${dropId}`, // Use owner's name
                         targetSocketId: targetOwnerSocketId // IMPORTANT: Send the *actual* target socket ID
                     });
                      // Update Dialer state - now needs code
                      updateUserState(socket.id, {
                          requiresCode: true,
                          targetSocketId: targetOwnerSocketId, // Store who we plan to call
                          targetDisplayName: targetOwnerData.username || `Drop ${dropId}`
                      });
                      // Frontend will transition to playingIntro -> awaitingCode
                 }
            } else if (requiresCode && !targetOwnerSocketId) {
                // Drop ID exists and requires code, but owner is OFFLINE
                console.log(`[Dialer] Target Drop ID owner ${dropId} is offline.`);
                socket.emit('drop_id_status', { status: 'unavailable', dropId });
                 // Reset dialer state
                 updateUserState(socket.id, { callState: 'idle', targetDropId: null });
            } else {
                // Drop ID does not exist / is not in dropCodeMap
                console.log(`[Dialer] Drop ID ${dropId} is invalid or public calling not configured.`);
                 socket.emit('drop_id_status', { status: 'invalid', dropId });
                  // Reset dialer state
                  updateUserState(socket.id, { callState: 'idle', targetDropId: null });
            }
        });

        // --- DIALER: validate_drop_code Event ---
        socket.on('validate_drop_code', ({ dropId, code, callerSocketId }) => { // callerSocketId included for clarity, though socket.id is sender
            console.log(`[Dialer] validate_drop_code received for ${dropId} from ${socket.id}, code: ${code}`);
            if (!dropId || code === undefined || callerSocketId !== socket.id) { console.warn('[Dialer] Invalid validate_drop_code data'); return; }

            const correctCode = dropCodeMap[dropId];
            const key = `${socket.id}_${dropId}`; // Attempt key unique to this caller+target

             // Check if caller is in the right state
             const callerData = userSocketMap.get(socket.id);
             if (!callerData || callerData.callState !== 'awaiting_code') { // Should be awaiting code to validate
                  console.warn(`[Dialer] Received validate_drop_code from ${socket.id} but state is ${callerData?.callState}`);
                  return; // Ignore if not in correct state
             }

            // Update state to validating
            updateUserState(socket.id, { callState: 'validating_code' });

            if (!callerAttempts[key]) callerAttempts[key] = 0;
            callerAttempts[key]++;
            const attempt = callerAttempts[key];

            if (code === correctCode) {
                console.log(`[Dialer] Code VALID for ${dropId} from ${socket.id}`);
                socket.emit('drop_code_validation', { isValid: true, dropId });
                delete callerAttempts[key]; // Reset attempts on success

                 // Update state - ready to ring (WebRTC offer will be sent by client now)
                 updateUserState(socket.id, { callState: 'ringing' });
            } else {
                console.log(`[Dialer] Code INVALID for ${dropId} from ${socket.id}. Attempt: ${attempt}`);
                socket.emit('drop_code_validation', { isValid: false, dropId, attempt });

                if (attempt >= 3) {
                    console.log(`[Dialer] Max attempts reached for ${socket.id} -> ${dropId}.`);
                    delete callerAttempts[key]; // Reset after final failure
                    // Update state to failed/idle, client will disconnect/end
                     updateUserState(socket.id, { callState: 'idle', targetDropId: null, targetSocketId: null });
                } else {
                    // Update state back to awaiting code
                    updateUserState(socket.id, { callState: 'awaiting_code' });
                }
            }
        });

    } // End if (connectionContext === 'dialer')

    // --- SHARED EVENTS (Used by both Messenger & Dialer WebRTC) ---

    // --- REVISED hangup_call / call_rejected LOGIC ---
    socket.on('hangup_call', (data) => {
        const { targetSocketId } = data; // The ID of the person they were talking to/calling
        const senderId = socket.id;
        const senderData = userSocketMap.get(senderId);

        if (!senderData) { console.warn(`[Hangup] Received from unknown user ${senderId}`); return; }

        const actualPartnerId = senderData.currentCallPartnerId;
        const notifiedTargetId = targetSocketId; // Who the client *thought* they should notify

        console.log(`[Hangup] Initiated by ${senderData.username || senderId} (Context: ${senderData.context}). Client specified target: ${notifiedTargetId}. Actual partner: ${actualPartnerId}`);

        // Determine the correct partner ID
        const partnerToNotifyId = actualPartnerId || notifiedTargetId;

        // Reset sender's state FIRST
        const senderPreviousState = senderData.callState; // Store state before resetting
        updateUserState(senderId, { callState: 'idle', currentCallPartnerId: null, targetDropId: null, targetSocketId: null }); // Reset fully

        if (!partnerToNotifyId) { console.log(`[Hangup] No partner ID found for hangup from ${senderId}.`); return; }

        const partnerData = userSocketMap.get(partnerToNotifyId);
        const partnerSocket = io.sockets.sockets.get(partnerToNotifyId);

        // Reset partner's state
         updateUserState(partnerToNotifyId, { callState: 'idle', currentCallPartnerId: null });

        if (partnerSocket) {
            // Decide which event to send based on context/state
            // If the partner was in 'receiving' (Messenger) or 'ringing' (Dialer) state, it's a rejection before connection
            if (partnerData && (partnerData.callState === 'receiving' || partnerData.callState === 'ringing')) {
                console.log(`[Hangup] Call rejected by ${senderId} before connection. Notifying ${partnerToNotifyId} with 'call_rejected'.`);
                io.to(partnerToNotifyId).emit('call_rejected', { rejectedBySocketId: senderId });
            }
            // If the sender was 'calling' (Messenger) or 'ringing' (Dialer) and hung up, partner was likely 'receiving'/'ringing'
            else if (senderPreviousState === 'calling' || senderPreviousState === 'ringing') {
                console.log(`[Hangup] Call cancelled by sender ${senderId} during ringing/calling. Notifying ${partnerToNotifyId} with 'call_hungup'.`);
                 io.to(partnerToNotifyId).emit('call_hungup', { hungupBySocketId: senderId }); // Treat cancellation as hangup for receiver
            }
            // Otherwise, assume it was a connected call hangup
            else {
                console.log(`[Hangup] Normal hangup. Notifying ${partnerToNotifyId} with 'call_hungup'.`);
                io.to(partnerToNotifyId).emit('call_hungup', { hungupBySocketId: senderId });
            }
        } else {
            console.log(`[Hangup] Target partner ${partnerToNotifyId} not found/disconnected.`);
        }

        // Clean up dialer attempts if the sender was a dialer
        if (senderData.context === 'dialer' && senderData.targetDropId) {
             const key = `${senderId}_${senderData.targetDropId}`;
             delete callerAttempts[key];
             logDebug(`[Dialer] Cleared attempts for ${key} due to hangup.`);
        }
    });


    // --- WebRTC Signaling Relays (Should work for both contexts) ---
    socket.on('call_offer', (data) => {
        const { targetSocketId, offer, callerId } = data; // Use callerId for dialer context
        const senderId = socket.id; // Get sender ID directly

        if (!targetSocketId || !offer) { console.warn(`[WebRTC] Invalid call_offer data from ${senderId}.`); return; }

        const senderData = userSocketMap.get(senderId);
        const targetData = userSocketMap.get(targetSocketId);

        // Log context
        const senderContext = senderData ? senderData.context : 'unknown';
        console.log(`[WebRTC] Relaying call_offer from ${senderId} (Context: ${senderContext}) to ${targetSocketId}`);

        // Basic validation: Ensure target exists
         if (!targetData) {
             console.log(`[WebRTC] Target ${targetSocketId} not found for call_offer relay.`);
             socket.emit('call_target_unavailable', { targetSocketId });
             // Reset sender state if they were trying to call
             if (senderData && senderData.callState === 'calling' || senderData.callState === 'ringing') {
                 updateUserState(senderId, { callState: 'idle', currentCallPartnerId: null });
             }
             return;
         }

        // Check if target is busy (redundant check, but safe)
         if (targetData.callState !== 'idle' && targetData.callState !== 'receiving' && targetData.callState !== 'ringing') { // Allow offer if receiving/ringing
              console.warn(`[WebRTC] Target ${targetSocketId} is busy (${targetData.callState}) during call_offer relay.`);
              socket.emit('call_target_busy', { targetSocketId, targetUsername: targetData.username });
               // Reset sender state
               if (senderData && senderData.callState === 'calling' || senderData.callState === 'ringing') {
                    updateUserState(senderId, { callState: 'idle', currentCallPartnerId: null });
               }
              return;
         }

        // Update target state to 'receiving' if they were idle (relevant for Dialer flow where offer comes after code)
        if(targetData.callState === 'idle'){
            updateUserState(targetSocketId, { callState: 'receiving', currentCallPartnerId: senderId });
        } else if (targetData.callState === 'ringing') {
             // If target was already 'ringing' from the Dialer state update, this is fine.
             // Ensure partner ID is set correctly.
             updateUserState(targetSocketId, { currentCallPartnerId: senderId });
        }


        // Relay the offer
        io.to(targetSocketId).emit('call_offer', {
            offer,
            callerSocketId: senderId, // Always use the actual sender socket ID
            callerName: senderData ? senderData.username : null // Send username if available (Messenger)
        });
    });

    socket.on('call_answer', (data) => {
        const { targetSocketId, answer } = data; // targetSocketId is the *original caller*
        const responderId = socket.id;

        if (!targetSocketId || !answer) { console.warn(`[WebRTC] Invalid call_answer data from ${responderId}.`); return; }

        const responderData = userSocketMap.get(responderId);
        const targetData = userSocketMap.get(targetSocketId); // Original Caller

        if (!responderData || !targetData) { console.warn(`[WebRTC] User data not found for answer relay.`); return; }

        // State Check: Responder should be 'receiving' or 'ringing', Target should be 'calling' or 'ringing'
        const validResponderStates = ['receiving', 'ringing'];
        const validTargetStates = ['calling', 'ringing'];
        if (!validResponderStates.includes(responderData.callState) || !validTargetStates.includes(targetData.callState)) {
            console.warn(`[WebRTC] call_answer state mismatch. Responder (${responderId}): ${responderData.callState}, Target (${targetSocketId}): ${targetData.callState}. Aborting relay.`);
            // Don't relay if states are wrong, likely call was cancelled/failed already
            return;
        }

        // Update States to 'connected'
        console.log(`[WebRTC] Call connected between ${targetSocketId} and ${responderId}`);
        updateUserState(responderId, { callState: 'connected' });
        updateUserState(targetSocketId, { callState: 'connected' });

        // Relay the answer
        io.to(targetSocketId).emit('call_answer', { answer, responderSocketId: responderId });
    });

    socket.on('ice_candidate', (data) => {
        const { targetSocketId, candidate } = data;
        if (!targetSocketId || !candidate) { return; } // Silently ignore invalid data
        // Relay directly without heavy checks, clients handle stale candidates
        io.to(targetSocketId).emit('ice_candidate', { candidate, senderSocketId: socket.id });
    });
    // --- END SHARED EVENTS ---

    // --- Disconnect Handling ---
    socket.on('disconnect', () => {
        const disconnectedSocketId = socket.id;
        const userData = userSocketMap.get(disconnectedSocketId);

        if (!userData) { console.log(`[Socket] Disconnected: ${disconnectedSocketId} (No user data found)`); return; }

        const { username, roomId, dropId, context, callState, currentCallPartnerId } = userData;
        console.log(`[Socket] Disconnected: ${disconnectedSocketId} (User: ${username || 'Dialer'}, Context: ${context}, Room: ${roomId || 'N/A'}, DropID: ${dropId || 'N/A'}, State: ${callState})`);

        // --- Handle disconnect during call ---
        if (callState !== 'idle' && currentCallPartnerId) {
            console.log(`[Disconnect] User ${username || disconnectedSocketId} disconnected during call with ${currentCallPartnerId}. Notifying partner.`);
            const partnerSocket = io.sockets.sockets.get(currentCallPartnerId);
            if (partnerSocket) {
                updateUserState(currentCallPartnerId, { callState: 'idle', currentCallPartnerId: null });
                io.to(currentCallPartnerId).emit('call_hungup', { hungupBySocketId: disconnectedSocketId });
            } else {
                console.log(`[Disconnect] Partner ${currentCallPartnerId} not found during disconnect cleanup.`);
                // Clean partner state from map anyway if they exist there
                updateUserState(currentCallPartnerId, { callState: 'idle', currentCallPartnerId: null });
            }
        }

        // --- Cleanup ---
        // Remove Drop ID mapping if this user owned one
        if (context === 'messenger' && dropId && dropIdOwnerSocket[dropId] === disconnectedSocketId) {
            delete dropIdOwnerSocket[dropId];
            console.log(`[Mapping] Removed mapping for Drop ID ${dropId} (owner disconnected)`);
        }
        // Clear dialer attempts related to this socket
        Object.keys(callerAttempts).forEach(key => {
            if (key.startsWith(`${disconnectedSocketId}_`)) {
                delete callerAttempts[key];
            }
        });
        // Notify chat room if applicable
        if (context === 'messenger' && roomId) {
            console.log(`[Messenger] Notifying room ${roomId} that ${username || 'User'} left`);
            socket.to(roomId).emit('user_left_chat', { user: username || 'User', socketId: disconnectedSocketId });
        }
        // Remove user from main map
        userSocketMap.delete(disconnectedSocketId);
        console.log(`[State] Removed user data for ${disconnectedSocketId}. Current users: ${userSocketMap.size}`);
    });

}); // End io.on('connection', ...)

// --- Routes & Server Start (Unchanged) ---
app.get('/c/:roomId', (req, res) => { res.redirect(`/index.html?session=${encodeURIComponent(req.params.roomId)}`); });
app.get('/', (req, res) => { res.redirect('/index.html'); });
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => { console.log(`🚀 Drop Server running on port ${PORT}`); });