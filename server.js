// --- server.js v29.7 - Corrected & Configured for Single 'public' Static Folder ---
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path'); // <-- Required for path.join

const app = express();
const server = http.createServer(app);

// Helper function to format bytes
function formatBytes(bytes, decimals = 2) {
    if (!bytes || bytes === 0) return '0 Bytes';
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.max(0, Math.floor(Math.log(Math.abs(bytes)) / Math.log(k)));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

// Helper function to generate guest names for Live Viewers
function generateGuestName() {
    const adjectives = ['Cool', 'Fast', 'Epic', 'Wild', 'Chill', 'Smart', 'Bold', 'Quick', 'Shiny', 'Happy'];
    const animals = ['Tiger', 'Wolf', 'Eagle', 'Panda', 'Lion', 'Falcon', 'Bear', 'Fox', 'Shark', 'Cobra'];
    const adjective = adjectives[Math.floor(Math.random() * adjectives.length)];
    const animal = animals[Math.floor(Math.random() * animals.length)];
    const number = Math.floor(Math.random() * 900) + 100; // 100-999
    return `${adjective}${animal}${number}`; // Corrected template literal
}


const io = new Server(server, {
    cors: {
        origin: '*',
        methods: ['GET', 'POST']
    },
    pingInterval: 20000,
    pingTimeout: 120000,
    maxHttpBufferSize: 1e8 // Increased buffer size (approx 100MB)
});

// --- Static File Serving ---
// Serve ALL static files (index.html, viewer.html, etc.) from 'public'
app.use(express.static('public'));
// REMOVED: app.use(express.static('dropin-live'));

app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: true, limit: '100mb' }));

// --- State Management ---
const userSocketMap = new Map();
const dropIdOwnerSocket = {};
const dropCodeMap = {
  '0000': '15425',
  '1234': '98765',
};
const callerAttempts = {};

// Utility function to update user state safely
const updateUserState = (socketId, updates) => {
    const userData = userSocketMap.get(socketId);
    if (userData) {
        userSocketMap.set(socketId, { ...userData, ...updates });
    }
};

// Utility function to find the socket ID associated with a private Drop ID
function findSocketIdForDropId(dropId) {
    return dropIdOwnerSocket[dropId] || null;
}

// --- Socket.IO Connection Handling ---
io.on('connection', (socket) => {
    console.log(`[Socket] Connected: ${socket.id}`);
    const { username, sessionId, context, userDropId } = socket.handshake.query;

    let connectionContext = 'messenger';
    if (context === 'dialer' || context === 'receiver' || context === 'live_broadcast') {
        connectionContext = context;
    }

    console.log(`Handshake Info -> Context: ${connectionContext}, User: ${username || 'N/A'}, Session: ${sessionId || 'N/A'}, DropID: ${userDropId || 'N/A'}, Socket: ${socket.id}`);

    userSocketMap.set(socket.id, {
        username: username || null,
        roomId: sessionId || null,
        dropId: userDropId || null,
        context: connectionContext,
        callState: 'idle',
        currentCallPartnerId: null,
        targetDropId: null,
        targetSocketId: null,
        requiresCode: false,
        targetDisplayName: null,
        liveTitle: null,
        liveStreamId: null // Initialize liveStreamId
    });

    // --- Messenger Context Handling ---
    if (connectionContext === 'messenger') {
        socket.username = username;
        socket.dropId = userDropId;
        if (userDropId && dropCodeMap.hasOwnProperty(userDropId)) {
            dropIdOwnerSocket[userDropId] = socket.id;
            console.log(`[Mapping] Drop ID ${userDropId} (Messenger) mapped to Socket ID ${socket.id}`);
        }
        socket.on('join_chat_room', (data) => {
             const { room, user } = data;
             if (!room || !user) { console.error("[Messenger] Join attempt invalid:", data); return; }
             const currentUserData = userSocketMap.get(socket.id);
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
             socket.join(room);
             socket.roomId = room;
             updateUserState(socket.id, { roomId: room, username: user, callState: 'idle', currentCallPartnerId: null });
             console.log(`[Messenger] User ${user} (${socket.id}) joined chat room ${room}`);
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
        socket.on('chat_message', (data) => { const { username, message, session } = data; const targetRoom = session || socket.roomId; if (!targetRoom || !username || message === undefined) { return; } socket.to(targetRoom).emit('chat_message', { username, message, senderSocketId: socket.id }); });
        socket.on('start_typing', (data) => { const targetRoom = data.session || socket.roomId; if (targetRoom && data.username) socket.to(targetRoom).emit('user_started_typing', { username: data.username, socketId: socket.id }); });
        socket.on('stop_typing', (data) => { const targetRoom = data.session || socket.roomId; if (targetRoom && data.username) socket.to(targetRoom).emit('user_stopped_typing', { username: data.username, socketId: socket.id }); });
        socket.on('video_drop', (data) => { const { username, session, videoBuffer } = data; const targetRoom = session || socket.roomId; if (!targetRoom || !username || !videoBuffer) { return; } let bufferToSend; let bufferSize = 0; if (videoBuffer instanceof ArrayBuffer) { bufferToSend = videoBuffer; bufferSize = videoBuffer.byteLength; } else if (videoBuffer instanceof Buffer) { bufferToSend = videoBuffer; bufferSize = videoBuffer.length; } else { return; } const SERVER_MAX_VIDEO_SIZE = 95 * 1024 * 1024; if (bufferSize > SERVER_MAX_VIDEO_SIZE) { socket.emit('video_drop_error', { reason: 'Video file too large.' }); return; } io.to(targetRoom).emit('video_drop', { username, videoBuffer: bufferToSend, senderSocketId: socket.id }); });
        socket.on('voice_drop', (data) => { const { username, session, audioBuffer } = data; const targetRoom = session || socket.roomId; if (!targetRoom || !username || !audioBuffer) { return; } let bufferToSend; let bufferSize = 0; if (audioBuffer instanceof ArrayBuffer) { bufferToSend = audioBuffer; bufferSize = audioBuffer.byteLength; } else if (audioBuffer instanceof Buffer) { bufferToSend = audioBuffer; bufferSize = audioBuffer.length; } else { return; } const SERVER_MAX_AUDIO_SIZE = 15 * 1024 * 1024; if (bufferSize > SERVER_MAX_AUDIO_SIZE) { socket.emit('voice_drop_error', { reason: 'Voice recording too large.' }); return; } io.to(targetRoom).emit('voice_drop', { username, audioBuffer: bufferToSend, senderSocketId: socket.id }); });
        socket.on('start_call', (data) => {
            const { targetSocketId, callerName } = data;
            if (!targetSocketId || !callerName) { console.warn(`[DICE/Messenger] Invalid start_call data from ${socket.id}:`, data); return; }
            const callerData = userSocketMap.get(socket.id);
            const targetData = userSocketMap.get(targetSocketId);
            const targetSocket = io.sockets.sockets.get(targetSocketId);
            if (!callerData) { console.warn(`[DICE/Messenger] Caller ${socket.id} not found in map.`); return; }
            if (!targetData || !targetSocket) { console.log(`[DICE/Messenger] Target ${targetSocketId} not found/disconnected.`); socket.emit('call_target_unavailable', { targetSocketId }); return; }
            if (callerData.callState !== 'idle') { console.log(`[DICE/Messenger] Caller ${callerName} busy: ${callerData.callState}`); socket.emit('call_error', { reason: 'You are already busy.' }); return; }
            if (targetData.callState !== 'idle') { console.log(`[DICE/Messenger] Target ${targetData.username} busy: ${targetData.callState}`); socket.emit('call_target_busy', { targetSocketId, targetUsername: targetData.username }); return; }
            const callId = `call_${socket.id}_${targetSocketId}_${Date.now()}`;
            console.log(`[DICE/Messenger] Call initiated by ${callerName} (${socket.id}) to ${targetData.username} (${targetSocketId}). callId: ${callId}`);
            updateUserState(socket.id, { callState: 'calling', currentCallPartnerId: targetSocketId });
            updateUserState(targetSocketId, { callState: 'receiving', currentCallPartnerId: socket.id });
            io.to(targetSocketId).emit('incoming_call', { callerName: callerName, callerSocketId: socket.id, callId: callId });
        });
    } // End Messenger Context


    // --- Receiver Context Handling ---
    if (connectionContext === 'receiver') {
        socket.dropId = userDropId;
        if (userDropId && dropCodeMap.hasOwnProperty(userDropId)) {
            if (dropIdOwnerSocket[userDropId] && dropIdOwnerSocket[userDropId] !== socket.id) {
                 console.warn(`[Mapping] Drop ID ${userDropId} was already mapped to ${dropIdOwnerSocket[userDropId]}. Re-mapping to new Receiver ${socket.id}.`);
            }
            dropIdOwnerSocket[userDropId] = socket.id;
            console.log(`[Mapping] Drop ID ${userDropId} (Receiver) mapped to Socket ID ${socket.id}`);
             updateUserState(socket.id, { dropId: userDropId });
        } else if (userDropId) {
            console.warn(`[Receiver] User connected with Drop ID ${userDropId}, but it's not in the known private dropCodeMap.`);
             updateUserState(socket.id, { dropId: userDropId });
        } else {
             console.warn(`[Receiver] User connected without specifying a userDropId.`);
        }
    } // End Receiver Context


    // --- Dialer Context Handling ---
    if (connectionContext === 'dialer') {
        socket.on('check_drop_id', ({ dropId }) => {
             console.log(`[Dialer] check_drop_id received for ${dropId} from ${socket.id}`);
             if (!dropId) { console.warn('[Dialer] check_drop_id missing dropId.'); return; }
             const requiresCode = dropCodeMap.hasOwnProperty(dropId);
             const targetOwnerSocketId = findSocketIdForDropId(dropId);
             const targetOwnerData = targetOwnerSocketId ? userSocketMap.get(targetOwnerSocketId) : null;
             updateUserState(socket.id, { callState: 'checking_id', targetDropId: dropId });
             if (requiresCode && targetOwnerSocketId && targetOwnerData && targetOwnerData.callState === 'idle') {
                 console.log(`[Dialer] Private Drop ID ${dropId} owner (${targetOwnerData.username}) is online and available.`);
                 socket.emit('drop_id_status', { status: 'available', dropId, requiresCode: true, displayName: targetOwnerData.username || `Drop ${dropId}`, targetSocketId: targetOwnerSocketId });
                 updateUserState(socket.id, { callState: 'awaiting_code', requiresCode: true, targetSocketId: targetOwnerSocketId, targetDisplayName: targetOwnerData.username || `Drop ${dropId}` });
             }
             else if (requiresCode && targetOwnerSocketId && targetOwnerData && targetOwnerData.callState !== 'idle') {
                 console.log(`[Dialer] Target Drop ID owner ${targetOwnerSocketId} is busy: ${targetOwnerData.callState}`);
                 socket.emit('call_target_busy', { targetSocketId: targetOwnerSocketId, targetUsername: targetOwnerData.username });
                 updateUserState(socket.id, { callState: 'idle', targetDropId: null });
             }
             else if (requiresCode && !targetOwnerSocketId) {
                 console.log(`[Dialer] Target Drop ID owner ${dropId} is offline.`);
                 socket.emit('drop_id_status', { status: 'unavailable', dropId });
                 updateUserState(socket.id, { callState: 'idle', targetDropId: null });
             }
             else {
                 console.log(`[Dialer] Drop ID ${dropId} is invalid or not found.`);
                 socket.emit('drop_id_status', { status: 'invalid', dropId });
                 updateUserState(socket.id, { callState: 'idle', targetDropId: null });
             }
        });
        socket.on('validate_drop_code', ({ dropId, code, callerSocketId }) => {
             const senderSocketId = socket.id;
             console.log(`[Dialer] validate_drop_code received for ${dropId} from ${senderSocketId}, code: ${code}`);
             if (!dropId || code === undefined || callerSocketId !== senderSocketId) { console.warn('[Dialer] Invalid validate_drop_code data or mismatched callerSocketId'); return; }
             const correctCode = dropCodeMap[dropId];
             const key = `${senderSocketId}_${dropId}`;
             const callerData = userSocketMap.get(senderSocketId);
             if (!callerData || callerData.callState !== 'awaiting_code') { console.warn(`[Dialer] Received validate_drop_code from ${senderSocketId} but state is ${callerData?.callState || 'N/A'}. Ignoring.`); return; }
             updateUserState(senderSocketId, { callState: 'validating_code' });
             if (!callerAttempts[key]) callerAttempts[key] = 0;
             callerAttempts[key]++;
             const attempt = callerAttempts[key];
             if (code === correctCode) {
                 console.log(`[Dialer] Code VALID for ${dropId} from ${senderSocketId}`);
                 socket.emit('drop_code_validation', { isValid: true, dropId });
                 delete callerAttempts[key];
                 updateUserState(senderSocketId, { callState: 'ringing' });
                 const targetOwnerSocketId = callerData.targetSocketId;
                 const targetOwnerSocket = io.sockets.sockets.get(targetOwnerSocketId);
                 if (targetOwnerSocket) {
                     console.log(`[Dialer] Notifying target owner ${targetOwnerSocketId} of incoming call from Dialer ${senderSocketId}`);
                     updateUserState(targetOwnerSocketId, { callState: 'receiving', currentCallPartnerId: senderSocketId });
                     io.to(targetOwnerSocketId).emit('incoming_call', { callerName: `Dialer User ${senderSocketId.slice(0,5)}`, callerSocketId: senderSocketId, callId: `call_${senderSocketId}_${targetOwnerSocketId}_${Date.now()}` });
                 } else {
                     console.warn(`[Dialer] Target owner ${targetOwnerSocketId} disconnected after code validation.`);
                     socket.emit('call_target_unavailable', { targetSocketId: targetOwnerSocketId });
                     updateUserState(senderSocketId, { callState: 'idle', targetDropId: null, targetSocketId: null });
                 }
             } else {
                 console.log(`[Dialer] Code INVALID for ${dropId} from ${senderSocketId}. Attempt: ${attempt}`);
                 socket.emit('drop_code_validation', { isValid: false, dropId, attempt });
                 if (attempt >= 3) {
                     console.log(`[Dialer] Max attempts reached for ${senderSocketId} -> ${dropId}.`);
                     delete callerAttempts[key];
                     updateUserState(senderSocketId, { callState: 'idle', targetDropId: null, targetSocketId: null, requiresCode: false, targetDisplayName: null });
                 } else {
                     updateUserState(senderSocketId, { callState: 'awaiting_code' });
                 }
             }
        });
    } // End Dialer Context


    // --- DropIn Live Broadcast System ---
    if (connectionContext === 'live_broadcast') {
        // Retrieve stored stream ID if available
        let liveStreamId = userSocketMap.get(socket.id)?.liveStreamId || null;

        socket.on('start_stream', (data) => {
            if (liveStreamId) {
                 console.warn(`[DropInLive] Broadcaster ${socket.id} tried to start stream again while already having stream ${liveStreamId}. Re-sending ACK.`);
                 socket.emit('stream_started_ack', { streamId: liveStreamId });
                 return;
            }
            const { title } = data;
            liveStreamId = `stream_${socket.id}_${Date.now()}`;
            socket.join(liveStreamId);
            updateUserState(socket.id, { liveStreamId: liveStreamId, liveTitle: title || 'Untitled Stream' });
            socket.emit('stream_started_ack', { streamId: liveStreamId });
            console.log(`[DropInLive] Stream started: ${liveStreamId} - Title: ${title || 'Untitled'}`);
        });

        socket.on('live_stream_data', (data) => {
            const { streamId, chunk } = data;
            const currentStreamId = userSocketMap.get(socket.id)?.liveStreamId;

            if (!streamId || !chunk || streamId !== currentStreamId) {
                console.warn(`[DropInLive] Invalid live_stream_data received from ${socket.id}. Expected: ${currentStreamId}, Got: ${streamId}. Chunk valid: ${!!chunk}`);
                return;
            }
            io.to(streamId).emit('receive_live_chunk', chunk);
        });

        socket.on('send_live_comment', (data) => {
            const { streamId, text } = data;
            const broadcasterData = userSocketMap.get(socket.id);
            const currentStreamId = broadcasterData?.liveStreamId;
            if (streamId && text && streamId === currentStreamId) {
                const username = broadcasterData?.username || `Host_${socket.id.slice(0, 5)}`;
                io.to(streamId).emit('new_live_comment', { username, text, type: 'user' });
            } else {
                 console.warn(`[DropInLive] Invalid send_live_comment from broadcaster ${socket.id}. Expected: ${currentStreamId}, Got: ${streamId}`);
            }
        });

        socket.on('end_stream', (data) => {
            const { streamId } = data;
            const currentStreamId = userSocketMap.get(socket.id)?.liveStreamId;
            if (streamId && streamId === currentStreamId) {
                console.log(`[DropInLive] Stream ended by broadcaster: ${streamId}`);
                io.to(streamId).emit('live_stream_ended');
                io.socketsLeave(streamId);
                updateUserState(socket.id, { liveStreamId: null, liveTitle: null });
            } else {
                 console.warn(`[DropInLive] Invalid end_stream request from broadcaster ${socket.id}. Expected: ${currentStreamId}, Got: ${streamId}`);
            }
        });
    } // End Live Broadcast Context

    // --- DropIn Live Viewer Connection & Interaction ---
    socket.on('join_live_room', (data) => {
        const { streamId } = data;
        if (streamId) {
            const roomExists = io.sockets.adapter.rooms.has(streamId);
            if (!roomExists) {
                console.warn(`[DropInLive] Viewer ${socket.id} tried to join non-existent stream ${streamId}`);
                socket.emit('stream_details', { isLive: false, title: 'Stream Not Found' });
                return;
            }
            socket.join(streamId);
            updateUserState(socket.id, { roomId: streamId });

            const viewerData = userSocketMap.get(socket.id);
            let joiningUsername = viewerData?.username;
            if (!joiningUsername) {
                joiningUsername = generateGuestName();
                updateUserState(socket.id, { username: joiningUsername });
                socket.username = joiningUsername;
            }

            let streamTitle = 'Live Stream';
            const broadcasterSocketId = streamId.split('_')[1];
            const broadcasterData = userSocketMap.get(broadcasterSocketId);
            if (broadcasterData && broadcasterData.liveTitle) {
                 streamTitle = broadcasterData.liveTitle;
            }

            socket.emit('stream_details', { title: streamTitle, isLive: true });
            const numViewers = io.sockets.adapter.rooms.get(streamId)?.size || 0;
            io.to(streamId).emit('viewer_count_update', numViewers);
            console.log(`[DropInLive] Viewer ${joiningUsername} (${socket.id}) joined ${streamId}. Total viewers: ${numViewers}`);
        } else {
            console.warn('[DropInLive] join_live_room event missing streamId');
        }
    });

    socket.on('send_live_comment', (data) => {
        const { streamId, text } = data;
        const senderData = userSocketMap.get(socket.id);
        if (senderData?.context !== 'live_broadcast' && streamId && text && senderData && socket.rooms.has(streamId)) {
            const username = senderData.username || `Viewer_${socket.id.slice(0, 5)}`;
            io.to(streamId).emit('new_live_comment', { username, text, type: 'user' });
        } else if (senderData?.context === 'live_broadcast') {
             // Ignore, handled in broadcaster context
        }
        else {
            console.warn(`[DropInLive] Invalid send_live_comment from non-broadcaster ${socket.id}. Data:`, data, `In Room: ${socket.rooms.has(streamId)}`);
        }
    });

    socket.on('send_live_reaction', (data) => {
        const { streamId, reaction } = data;
        if (streamId && reaction && socket.rooms.has(streamId)) {
            io.to(streamId).emit('broadcast_reaction', { reaction, senderId: socket.id });
        }
    });

    // --- General Call/WebRTC Handling ---
    socket.on('hangup_call', (data) => {
        const { targetSocketId } = data || {};
        const senderId = socket.id;
        const senderData = userSocketMap.get(senderId);
        if (!senderData) { console.warn(`[Hangup] Received from unknown user ${senderId}`); return; }
        const actualPartnerId = senderData.currentCallPartnerId;
        const notifiedTargetId = targetSocketId;
        console.log(`[Hangup] Initiated by ${senderData.username || senderId} (Context: ${senderData.context}, State: ${senderData.callState}). Client specified target: ${notifiedTargetId}. Actual partner: ${actualPartnerId}`);
        const partnerToNotifyId = actualPartnerId || notifiedTargetId;
        const senderPreviousState = senderData.callState;
        updateUserState(senderId, { callState: 'idle', currentCallPartnerId: null, targetDropId: null, targetSocketId: null, requiresCode: false, targetDisplayName: null });
        if (senderData.context === 'dialer' && senderData.targetDropId) { const key = `${senderId}_${senderData.targetDropId}`; delete callerAttempts[key]; console.log(`[Hangup] Cleared dialer attempts for key: ${key}`); }
        if (!partnerToNotifyId) { console.log(`[Hangup] No partner ID found or specified for hangup from ${senderId}.`); return; }
        const partnerData = userSocketMap.get(partnerToNotifyId);
        const partnerSocket = io.sockets.sockets.get(partnerToNotifyId);
        updateUserState(partnerToNotifyId, { callState: 'idle', currentCallPartnerId: null });
        if (partnerSocket && partnerData) {
            const partnerCurrentState = partnerData.callState;
            const partnerWasReceivingOrRinging = partnerCurrentState === 'receiving' || partnerCurrentState === 'ringing';
            const senderWasCallingOrRinging = senderPreviousState === 'calling' || senderPreviousState === 'ringing' || senderPreviousState === 'awaiting_code' || senderPreviousState === 'validating_code';
            if (partnerWasReceivingOrRinging && senderWasCallingOrRinging) { console.log(`[Hangup] Call rejected/cancelled by ${senderId} before connection. Notifying ${partnerToNotifyId} with 'call_rejected'. Partner state: ${partnerCurrentState}`); io.to(partnerToNotifyId).emit('call_rejected', { rejectedBySocketId: senderId }); }
            else { console.log(`[Hangup] Normal hangup or unexpected state. Notifying ${partnerToNotifyId} with 'call_hungup'. Sender state: ${senderPreviousState}, Partner state: ${partnerCurrentState}`); io.to(partnerToNotifyId).emit('call_hungup', { hungupBySocketId: senderId }); }
        } else { console.log(`[Hangup] Target partner ${partnerToNotifyId} not found/disconnected. State reset.`); }
    });
    socket.on('call_offer', (data) => { const { targetSocketId, offer } = data; const senderId = socket.id; if (!targetSocketId || !offer) { return; } const senderData = userSocketMap.get(senderId); const targetData = userSocketMap.get(targetSocketId); console.log(`[WebRTC] Relaying call_offer from ${senderId} to ${targetSocketId}`); if (!targetData) { socket.emit('call_target_unavailable', { targetSocketId }); if (senderData?.callState === 'calling' || senderData?.callState === 'ringing') { updateUserState(senderId, { callState: 'idle', currentCallPartnerId: null }); } return; } const acceptable = ['receiving', 'ringing', 'idle']; if (!acceptable.includes(targetData.callState)) { socket.emit('call_target_busy', { targetSocketId, targetUsername: targetData.username }); if (senderData?.callState === 'calling' || senderData?.callState === 'ringing') { updateUserState(senderId, { callState: 'idle', currentCallPartnerId: null }); } return; } if (targetData.callState === 'idle') { updateUserState(targetSocketId, { callState: 'receiving', currentCallPartnerId: senderId }); } io.to(targetSocketId).emit('call_offer', { offer, callerSocketId: senderId, callerName: senderData?.username }); });
    socket.on('call_answer', (data) => { const { targetSocketId, answer } = data; const responderId = socket.id; if (!targetSocketId || !answer) { return; } const responderData = userSocketMap.get(responderId); const targetData = userSocketMap.get(targetSocketId); if (!responderData || !targetData) { return; } const validR = ['receiving', 'ringing']; const validT = ['calling', 'ringing']; if (!validR.includes(responderData.callState) || !validT.includes(targetData.callState)) { return; } console.log(`[WebRTC] Call connected between ${targetSocketId} and ${responderId}`); updateUserState(responderId, { callState: 'connected' }); updateUserState(targetSocketId, { callState: 'connected' }); io.to(targetSocketId).emit('call_answer', { answer, responderSocketId: responderId }); });
    socket.on('ice_candidate', (data) => { const { targetSocketId, candidate } = data; if (targetSocketId && candidate) { io.to(targetSocketId).emit('ice_candidate', { candidate, senderSocketId: socket.id }); }});


    // --- Disconnection Handling ---
    socket.on('disconnect', (reason) => {
        const disconnectedSocketId = socket.id;
        const userData = userSocketMap.get(disconnectedSocketId);
        if (!userData) { console.log(`[Socket] Disconnected: ${disconnectedSocketId} (No user data found). Reason: ${reason}`); return; }

        const { username, roomId, dropId, context, callState, currentCallPartnerId, liveStreamId } = userData;
        console.log(`[Socket] Disconnected: ${disconnectedSocketId} (User: ${username || 'N/A'}, Context: ${context}, Room: ${roomId || 'N/A'}, DropID: ${dropId || 'N/A'}, State: ${callState}). Reason: ${reason}`);

        if (callState !== 'idle' && currentCallPartnerId) {
            console.log(`[Disconnect] User was in call state (${callState}). Notifying partner ${currentCallPartnerId}.`);
            const partnerSocket = io.sockets.sockets.get(currentCallPartnerId);
            updateUserState(currentCallPartnerId, { callState: 'idle', currentCallPartnerId: null });
            if (partnerSocket) { io.to(currentCallPartnerId).emit('call_hungup', { hungupBySocketId: disconnectedSocketId, reason: 'partner_disconnected' }); }
        }
        if ((context === 'messenger' || context === 'receiver') && dropId && dropIdOwnerSocket[dropId] === disconnectedSocketId) { delete dropIdOwnerSocket[dropId]; console.log(`[Mapping] Removed mapping for Drop ID ${dropId} due to disconnect.`); }
        if (context === 'dialer') { Object.keys(callerAttempts).forEach(key => { if (key.startsWith(`${disconnectedSocketId}_`)) { delete callerAttempts[key]; console.log(`[Disconnect] Cleared dialer attempts for key: ${key}`); } }); }
        if (context === 'messenger' && roomId) { socket.to(roomId).emit('user_left_chat', { user: username || 'User', socketId: disconnectedSocketId }); console.log(`[Messenger] Notified room ${roomId} of user left: ${username || disconnectedSocketId}`); }
        if (context === 'live_broadcast' && liveStreamId) { console.log(`[DropInLive] Broadcaster ${username || disconnectedSocketId} disconnected. Ending stream ${liveStreamId}.`); io.to(liveStreamId).emit('live_stream_ended', { reason: 'broadcaster_disconnected' }); io.socketsLeave(liveStreamId); }
        if (roomId && roomId.startsWith('stream_')) { // Viewer disconnected from a stream
             const streamId = roomId;
             console.log(`[DropInLive] Viewer ${username || disconnectedSocketId} disconnected from stream ${streamId}`);
             setTimeout(() => {
                const numViewers = io.sockets.adapter.rooms.get(streamId)?.size || 0;
                io.to(streamId).emit('viewer_count_update', numViewers);
                console.log(`[DropInLive] Updated viewer count for ${streamId}: ${numViewers}`);
             }, 100);
        }

        userSocketMap.delete(disconnectedSocketId);
        console.log(`[State] Removed user data for ${disconnectedSocketId}. Current users: ${userSocketMap.size}`);
    });

}); // End io.on('connection')


// --- Basic HTTP Routes ---
app.get('/c/:roomId', (req, res) => { res.redirect(`/index.html?session=${encodeURIComponent(req.params.roomId)}`); });
app.get('/', (req, res) => { res.redirect('/index.html'); });

// Route for serving the viewer page
app.get('/watch/:streamId', (req, res) => {
    // Serve the viewer HTML file from the 'public' directory.
    // Associated assets (viewer.js, viewer.css) will also be found in 'public'
    // because of the single app.use(express.static('public')) line above.
    const viewerFilePath = path.join(__dirname, 'public', 'viewer.html'); // <-- Changed back to 'public'
    res.sendFile(viewerFilePath, (err) => {
        if (err) {
            // Log the error on the server, but don't expose details to the client
            console.error(`[Server] Error sending viewer.html for stream ${req.params.streamId}:`, err);
            // Check if the error is because the file doesn't exist
            if (err.code === 'ENOENT') {
                 res.status(404).send('Stream viewer page not found.');
            } else {
                 res.status(500).send('Could not load the stream page due to a server error.');
            }
        }
    });
});

// Optional: Serve a blank favicon to reduce 404 errors in console
app.get('/favicon.ico', (req, res) => res.status(204).send());

// --- Server Listening ---
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 Drop Server running on port ${PORT}`);
    console.log(`   Static files served from: 'public'`); // <-- Updated log message
    console.log(`   Live Mode Enabled`);
    console.log(`   Messenger/Dialer/Receiver Modes Enabled`);
});