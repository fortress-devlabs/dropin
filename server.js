// --- server.js (v29.2 - DropInLive - Added Code Line To Broadcast To Viewers) ---
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

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
    return `${adjective}${animal}${number}`;
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

app.use(express.static('public'));
app.use(express.json({ limit: '100mb' })); // Increased limit for potential large JSON (less likely needed)
app.use(express.urlencoded({ extended: true, limit: '100mb' })); // Increased limit

// --- State Management ---
const userSocketMap = new Map(); // Stores data about each connected socket { username, roomId, dropId, context, callState, currentCallPartnerId, etc. }
const dropIdOwnerSocket = {}; // Maps Drop IDs (requiring codes) to the socket ID of the owner (Messenger/Receiver)
const dropCodeMap = { // Maps Drop IDs to their required access code
  '0000': '15425', // Example Private Drop ID -> Code
  '1234': '98765', // Example Private Drop ID -> Code
  // 'PUBLIC_ID_EXAMPLE': null // Example Public Drop ID (no code needed, handled differently)
};
const callerAttempts = {}; // Tracks failed code validation attempts: { 'callerSocketId_dropId': count }

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

    // Determine connection context, default to 'messenger' if not specified or invalid
    let connectionContext = 'messenger'; // Default context
    if (context === 'dialer' || context === 'receiver' || context === 'live_broadcast') {
        connectionContext = context;
    }

    console.log(`Handshake Info -> Context: ${connectionContext}, User: ${username || 'N/A'}, Session: ${sessionId || 'N/A'}, DropID: ${userDropId || 'N/A'}, Socket: ${socket.id}`);

    // Initialize user data in the map
    userSocketMap.set(socket.id, {
        username: username || null,
        roomId: sessionId || null, // Primarily for messenger context
        dropId: userDropId || null, // Primarily for receiver/dialer context
        context: connectionContext,
        callState: 'idle', // Shared state: idle, calling, receiving, validating_code, awaiting_code, ringing, connected
        currentCallPartnerId: null, // Socket ID of the person they are in a call with
        targetDropId: null, // For dialer context: the Drop ID they are trying to reach
        targetSocketId: null, // For dialer context: resolved socket ID of the target Drop ID owner
        requiresCode: false, // For dialer context
        targetDisplayName: null, // For dialer context
        liveTitle: null // For live_broadcast context
    });

    // --- Messenger Context Handling ---
    if (connectionContext === 'messenger') {
        // Assign username and dropId directly to socket object for convenience in this context
        socket.username = username;
        socket.dropId = userDropId;

        // If the user has a Drop ID that requires a code, map it to their socket
        if (userDropId && dropCodeMap.hasOwnProperty(userDropId)) {
            dropIdOwnerSocket[userDropId] = socket.id;
            console.log(`[Mapping] Drop ID ${userDropId} (Messenger) mapped to Socket ID ${socket.id}`);
        }

        socket.on('join_chat_room', (data) => {
             const { room, user } = data;
             if (!room || !user) { console.error("[Messenger] Join attempt invalid:", data); return; }

             const currentUserData = userSocketMap.get(socket.id);

             // Handle leaving previous room if changing rooms
             if (currentUserData && currentUserData.roomId && currentUserData.roomId !== room) {
                 // If user was in a call while changing rooms, hang up the call
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

             // Join the new room
             socket.join(room);
             socket.roomId = room; // Update convenient socket property
             updateUserState(socket.id, { roomId: room, username: user, callState: 'idle', currentCallPartnerId: null }); // Update central map
             console.log(`[Messenger] User ${user} (${socket.id}) joined chat room ${room}`);

             // Notify others in the room
             socket.to(room).emit('user_joined_chat', { user, socketId: socket.id });

             // Send list of current users in the room back to the joining user
             const clientsInRoom = Array.from(io.sockets.adapter.rooms.get(room) || []);
             const users = {};
             clientsInRoom.forEach(id => {
                 const clientSocket = io.sockets.sockets.get(id);
                 // Don't include the user themselves in the list
                 if (clientSocket && clientSocket.id !== socket.id) {
                     const userData = userSocketMap.get(clientSocket.id);
                     users[clientSocket.id] = userData ? userData.username : "Unknown"; // Send socket ID and username
                 }
             });
             socket.emit('session_users', users);
        });

        // Standard chat and typing indicators
        socket.on('chat_message', (data) => {
            const { username, message, session } = data;
            const targetRoom = session || socket.roomId; // Use provided session or fallback to current room
            if (!targetRoom || !username || message === undefined) { console.warn('[Messenger] Invalid chat_message data:', data); return; }
            // Broadcast message to everyone else in the room
            socket.to(targetRoom).emit('chat_message', { username, message, senderSocketId: socket.id });
        });
        socket.on('start_typing', (data) => {
            const targetRoom = data.session || socket.roomId;
            if (targetRoom && data.username) {
                socket.to(targetRoom).emit('user_started_typing', { username: data.username, socketId: socket.id });
            }
        });
        socket.on('stop_typing', (data) => {
            const targetRoom = data.session || socket.roomId;
            if (targetRoom && data.username) {
                socket.to(targetRoom).emit('user_stopped_typing', { username: data.username, socketId: socket.id });
            }
        });

        // Media Drops (Video/Audio)
        socket.on('video_drop', (data) => {
            const { username, session, videoBuffer } = data;
            const targetRoom = session || socket.roomId;
            if (!targetRoom || !username || !videoBuffer) { console.warn('[Messenger] Invalid video_drop data'); return; }

            let bufferToSend;
            let bufferSize = 0;
            if (videoBuffer instanceof ArrayBuffer) { bufferToSend = videoBuffer; bufferSize = videoBuffer.byteLength; }
            else if (videoBuffer instanceof Buffer) { bufferToSend = videoBuffer; bufferSize = videoBuffer.length; }
            else { console.warn('[Messenger] video_drop received non-buffer data'); return; }

            const SERVER_MAX_VIDEO_SIZE = 95 * 1024 * 1024; // ~95MB limit
            if (bufferSize > SERVER_MAX_VIDEO_SIZE) {
                console.warn(`[Messenger] Video drop rejected from ${username} (${formatBytes(bufferSize)} > ${formatBytes(SERVER_MAX_VIDEO_SIZE)})`);
                socket.emit('video_drop_error', { reason: 'Video file too large.' });
                return;
            }

            console.log(`[Messenger] Relaying video drop from ${username} (${formatBytes(bufferSize)}) to room ${targetRoom}`);
            // Broadcast to others in the room, including the buffer
            io.to(targetRoom).emit('video_drop', { username, videoBuffer: bufferToSend, senderSocketId: socket.id });
        });
        socket.on('voice_drop', (data) => {
             const { username, session, audioBuffer } = data;
             const targetRoom = session || socket.roomId;
             if (!targetRoom || !username || !audioBuffer) { console.warn('[Messenger] Invalid voice_drop data'); return; }

             let bufferToSend;
             let bufferSize = 0;
             if (audioBuffer instanceof ArrayBuffer) { bufferToSend = audioBuffer; bufferSize = audioBuffer.byteLength; }
             else if (audioBuffer instanceof Buffer) { bufferToSend = audioBuffer; bufferSize = audioBuffer.length; }
             else { console.warn('[Messenger] voice_drop received non-buffer data'); return; }

             const SERVER_MAX_AUDIO_SIZE = 15 * 1024 * 1024; // ~15MB limit
             if (bufferSize > SERVER_MAX_AUDIO_SIZE) {
                 console.warn(`[Messenger] Voice drop rejected from ${username} (${formatBytes(bufferSize)} > ${formatBytes(SERVER_MAX_AUDIO_SIZE)})`);
                 socket.emit('voice_drop_error', { reason: 'Voice recording too large.' });
                 return;
             }

             console.log(`[Messenger] Relaying voice drop from ${username} (${formatBytes(bufferSize)}) to room ${targetRoom}`);
             io.to(targetRoom).emit('voice_drop', { username, audioBuffer: bufferToSend, senderSocketId: socket.id });
        });

        // Initiating a call from Messenger UI to another Messenger user
        socket.on('start_call', (data) => {
            const { targetSocketId, callerName } = data;
            if (!targetSocketId || !callerName) { console.warn(`[DICE/Messenger] Invalid start_call data from ${socket.id}:`, data); return; }

            const callerData = userSocketMap.get(socket.id);
            const targetData = userSocketMap.get(targetSocketId);
            const targetSocket = io.sockets.sockets.get(targetSocketId);

            if (!callerData) { console.warn(`[DICE/Messenger] Caller ${socket.id} not found in map.`); return; }
            if (!targetData || !targetSocket) {
                console.log(`[DICE/Messenger] Target ${targetSocketId} not found/disconnected.`);
                socket.emit('call_target_unavailable', { targetSocketId });
                return;
            }

            // Check if caller or target is already busy
            if (callerData.callState !== 'idle') {
                console.log(`[DICE/Messenger] Caller ${callerName} busy: ${callerData.callState}`);
                socket.emit('call_error', { reason: 'You are already busy.' });
                return;
            }
            if (targetData.callState !== 'idle') {
                console.log(`[DICE/Messenger] Target ${targetData.username} busy: ${targetData.callState}`);
                socket.emit('call_target_busy', { targetSocketId, targetUsername: targetData.username });
                return;
            }

            // Update states and notify target
            const callId = `call_${socket.id}_${targetSocketId}_${Date.now()}`;
            console.log(`[DICE/Messenger] Call initiated by ${callerName} (${socket.id}) to ${targetData.username} (${targetSocketId}). callId: ${callId}`);
            updateUserState(socket.id, { callState: 'calling', currentCallPartnerId: targetSocketId });
            updateUserState(targetSocketId, { callState: 'receiving', currentCallPartnerId: socket.id });
            io.to(targetSocketId).emit('incoming_call', { callerName: callerName, callerSocketId: socket.id, callId: callId });
        });
    } // End Messenger Context


    // --- Receiver Context Handling ---
    if (connectionContext === 'receiver') {
        // Primarily exists to map a Drop ID to a socket for receiving calls via Dialer
        socket.dropId = userDropId; // Assign for potential reference

        if (userDropId && dropCodeMap.hasOwnProperty(userDropId)) {
            // If owner already connected, log warning but update mapping (last connection wins)
            if (dropIdOwnerSocket[userDropId] && dropIdOwnerSocket[userDropId] !== socket.id) {
                 console.warn(`[Mapping] Drop ID ${userDropId} was already mapped to ${dropIdOwnerSocket[userDropId]}. Re-mapping to new Receiver ${socket.id}.`);
            }
            dropIdOwnerSocket[userDropId] = socket.id;
            console.log(`[Mapping] Drop ID ${userDropId} (Receiver) mapped to Socket ID ${socket.id}`);
             updateUserState(socket.id, { dropId: userDropId }); // Update central state map
        } else if (userDropId) {
            // Connected with a Drop ID not in the map - might be public or invalid
            console.warn(`[Receiver] User connected with Drop ID ${userDropId}, but it's not in the known private dropCodeMap.`);
             updateUserState(socket.id, { dropId: userDropId });
        } else {
             console.warn(`[Receiver] User connected without specifying a userDropId.`);
        }
    } // End Receiver Context


    // --- Dialer Context Handling ---
    if (connectionContext === 'dialer') {
        // Handles initiating calls TO Drop IDs (which might require codes)

        socket.on('check_drop_id', ({ dropId }) => {
             console.log(`[Dialer] check_drop_id received for ${dropId} from ${socket.id}`);
             if (!dropId) { console.warn('[Dialer] check_drop_id missing dropId.'); return; }

             const requiresCode = dropCodeMap.hasOwnProperty(dropId);
             const targetOwnerSocketId = findSocketIdForDropId(dropId); // Find owner via mapping
             const targetOwnerData = targetOwnerSocketId ? userSocketMap.get(targetOwnerSocketId) : null;

             // Initial state update for the dialer
             updateUserState(socket.id, { callState: 'checking_id', targetDropId: dropId });

             // Case 1: Private Drop ID, Owner is Online & Idle
             if (requiresCode && targetOwnerSocketId && targetOwnerData && targetOwnerData.callState === 'idle') {
                 console.log(`[Dialer] Private Drop ID ${dropId} owner (${targetOwnerData.username}) is online and available.`);
                 socket.emit('drop_id_status', {
                     status: 'available',
                     dropId,
                     requiresCode: true,
                     displayName: targetOwnerData.username || `Drop ${dropId}`, // Get name from owner's data
                     targetSocketId: targetOwnerSocketId
                 });
                 // Update dialer state with target info
                 updateUserState(socket.id, {
                     callState: 'awaiting_code', // Move to awaiting code state
                     requiresCode: true,
                     targetSocketId: targetOwnerSocketId,
                     targetDisplayName: targetOwnerData.username || `Drop ${dropId}`
                 });
             }
             // Case 2: Private Drop ID, Owner is Online but Busy
             else if (requiresCode && targetOwnerSocketId && targetOwnerData && targetOwnerData.callState !== 'idle') {
                 console.log(`[Dialer] Target Drop ID owner ${targetOwnerSocketId} is busy: ${targetOwnerData.callState}`);
                 socket.emit('call_target_busy', { targetSocketId: targetOwnerSocketId, targetUsername: targetOwnerData.username });
                 updateUserState(socket.id, { callState: 'idle', targetDropId: null }); // Reset dialer state
             }
             // Case 3: Private Drop ID, Owner is Offline
             else if (requiresCode && !targetOwnerSocketId) {
                 console.log(`[Dialer] Target Drop ID owner ${dropId} is offline.`);
                 socket.emit('drop_id_status', { status: 'unavailable', dropId });
                 updateUserState(socket.id, { callState: 'idle', targetDropId: null }); // Reset dialer state
             }
             // Case 4: Public Drop ID Example (No Code Required) - Customize logic as needed
             /*
             else if (!requiresCode && dropId === 'PUBLIC_ID_EXAMPLE') {
                  console.log(`[Dialer] Public Drop ID ${dropId} found.`);
                     socket.emit('drop_id_status', {
                         status: 'available',
                         dropId,
                         requiresCode: false,
                         displayName: `Public Line ${dropId}`,
                         targetSocketId: 'SOCKET_ID_FOR_PUBLIC_LINE' // Needs specific handling/routing
                     });
                    // Update state to ringing directly or similar
                    updateUserState(socket.id, { callState: 'ringing', targetSocketId: 'SOCKET_ID_FOR_PUBLIC_LINE', ... });
             }
             */
             // Case 5: Invalid Drop ID (Not in map, not public)
             else {
                 console.log(`[Dialer] Drop ID ${dropId} is invalid or not found.`);
                 socket.emit('drop_id_status', { status: 'invalid', dropId });
                 updateUserState(socket.id, { callState: 'idle', targetDropId: null }); // Reset dialer state
             }
        });

        socket.on('validate_drop_code', ({ dropId, code, callerSocketId }) => {
             const senderSocketId = socket.id; // Use socket.id as the source of truth
             console.log(`[Dialer] validate_drop_code received for ${dropId} from ${senderSocketId}, code: ${code}`);

             // Basic validation
             if (!dropId || code === undefined || callerSocketId !== senderSocketId) {
                 console.warn('[Dialer] Invalid validate_drop_code data or mismatched callerSocketId');
                 return;
             }

             const correctCode = dropCodeMap[dropId]; // Get the correct code for this Drop ID
             const key = `${senderSocketId}_${dropId}`; // Key for attempt tracking

             const callerData = userSocketMap.get(senderSocketId);

             // Check if the caller is actually in the 'awaiting_code' state
             if (!callerData || callerData.callState !== 'awaiting_code') {
                 console.warn(`[Dialer] Received validate_drop_code from ${senderSocketId} but state is ${callerData?.callState || 'N/A'}. Ignoring.`);
                 return; // Ignore if not in the right state
             }

             // Update state to show validation is in progress
             updateUserState(senderSocketId, { callState: 'validating_code' });

             // Attempt counting
             if (!callerAttempts[key]) callerAttempts[key] = 0;
             callerAttempts[key]++;
             const attempt = callerAttempts[key];

             if (code === correctCode) {
                 // Code is VALID
                 console.log(`[Dialer] Code VALID for ${dropId} from ${senderSocketId}`);
                 socket.emit('drop_code_validation', { isValid: true, dropId });
                 delete callerAttempts[key]; // Reset attempts on success
                 updateUserState(senderSocketId, { callState: 'ringing' }); // Move to ringing state

                 // Now, initiate the call signaling to the target owner
                 const targetOwnerSocketId = callerData.targetSocketId;
                 const targetOwnerSocket = io.sockets.sockets.get(targetOwnerSocketId);
                 if (targetOwnerSocket) {
                     console.log(`[Dialer] Notifying target owner ${targetOwnerSocketId} of incoming call from Dialer ${senderSocketId}`);
                     updateUserState(targetOwnerSocketId, { callState: 'receiving', currentCallPartnerId: senderSocketId });
                     io.to(targetOwnerSocketId).emit('incoming_call', {
                         callerName: `Dialer User ${senderSocketId.slice(0,5)}`, // Or get name if dialer provided one
                         callerSocketId: senderSocketId,
                         callId: `call_${senderSocketId}_${targetOwnerSocketId}_${Date.now()}`
                     });
                 } else {
                     console.warn(`[Dialer] Target owner ${targetOwnerSocketId} disconnected after code validation.`);
                     socket.emit('call_target_unavailable', { targetSocketId: targetOwnerSocketId });
                     updateUserState(senderSocketId, { callState: 'idle', targetDropId: null, targetSocketId: null });
                 }

             } else {
                 // Code is INVALID
                 console.log(`[Dialer] Code INVALID for ${dropId} from ${senderSocketId}. Attempt: ${attempt}`);
                 socket.emit('drop_code_validation', { isValid: false, dropId, attempt });

                 if (attempt >= 3) {
                     // Max attempts reached
                     console.log(`[Dialer] Max attempts reached for ${senderSocketId} -> ${dropId}.`);
                     delete callerAttempts[key]; // Clean up attempts
                     updateUserState(senderSocketId, { callState: 'idle', targetDropId: null, targetSocketId: null, requiresCode: false, targetDisplayName: null }); // Reset state
                 } else {
                     // Allow retry - return to awaiting code state
                     updateUserState(senderSocketId, { callState: 'awaiting_code' });
                 }
             }
        });
    } // End Dialer Context


    // --- DropIn Live Broadcast System ---
    if (connectionContext === 'live_broadcast') {
        let liveStreamId = null; // Store the stream ID associated with this broadcaster socket

        // Event from broadcaster client to start streaming
        socket.on('start_stream', (data) => {
            const { title } = data;
            // Generate a unique stream ID
            liveStreamId = `stream_${socket.id}_${Date.now()}`;
            socket.join(liveStreamId); // Broadcaster joins their own stream room
            updateUserState(socket.id, { liveStreamId: liveStreamId, liveTitle: title || 'Untitled Stream' }); // Store stream details

            // Acknowledge stream start and send back the ID
            socket.emit('stream_started_ack', { streamId: liveStreamId });
            console.log(`[DropInLive] Stream started: ${liveStreamId} - ${title || 'Untitled'}`);
        });

        // Event carrying video/audio chunks from broadcaster
        socket.on('live_stream_data', (data) => {
    const { streamId, chunk } = data;
    if (!streamId || !chunk) {
        console.warn(`[DropInLive] Invalid live_stream_data received.`);
        return;
    }

    console.log(`[DropInLive] Received chunk for stream ${streamId}. Chunk size: ${chunk.size || chunk.length || 0} bytes`);

   io.to(streamId).emit('receive_live_chunk', chunk);
});

    // Optional: Save to disk temporarily (for later full video creation)
    /*
    const fs = require('fs');
    const path = require('path');
    const streamPath = path.join(__dirname, 'streams', `${streamId}.webm`);
    fs.appendFileSync(streamPath, chunk);
    */
});


        // Event for broadcaster sending a chat message
        socket.on('send_live_comment', (data) => {
            const { streamId, text } = data;
            if (streamId && text && streamId === liveStreamId) {
                const broadcasterData = userSocketMap.get(socket.id);
                const username = broadcasterData?.username || `Host_${socket.id.slice(0, 5)}`; // Use host's actual name or generate one
                // Broadcast chat message to everyone in the room (including broadcaster)
                io.to(streamId).emit('new_live_comment', { username, text, type: 'user' }); // Add type if distinguishing user/system
            }
        });

        // Event from broadcaster client to end the stream
        socket.on('end_stream', (data) => {
            const { streamId } = data;
            if (streamId && streamId === liveStreamId) {
                console.log(`[DropInLive] Stream ended by broadcaster: ${streamId}`);
                // Notify all viewers the stream has ended
                io.to(streamId).emit('live_stream_ended');
                // Make all sockets leave the room
                io.socketsLeave(streamId);
                // Clear stream-related state for the broadcaster
                updateUserState(socket.id, { liveStreamId: null, liveTitle: null });
                liveStreamId = null; // Clear local variable
            }
        });
    } // End Live Broadcast Context

    // --- DropIn Live Viewer Connection & Interaction (Handles events from viewer clients) ---
    socket.on('join_live_room', (data) => {
        const { streamId } = data;
        if (streamId) {
            // Check if the room (stream) actually exists (i.e., broadcaster is connected)
            const roomExists = io.sockets.adapter.rooms.has(streamId);
            if (!roomExists) {
                console.warn(`[DropInLive] Viewer ${socket.id} tried to join non-existent stream ${streamId}`);
                socket.emit('stream_details', { isLive: false, title: 'Stream Not Found' }); // Notify viewer
                return;
            }

            socket.join(streamId); // Viewer joins the stream room
            updateUserState(socket.id, { roomId: streamId }); // Track which stream viewer is in

            // Assign guest username if the viewer doesn't have one (e.g., connected directly)
            const viewerData = userSocketMap.get(socket.id);
            if (viewerData && !viewerData.username) {
                const guestName = generateGuestName();
                updateUserState(socket.id, { username: guestName });
                socket.username = guestName; // Assign to socket convenience property too
            }

            // Find broadcaster's data to potentially send real title
            let streamTitle = 'Live Stream';
            const broadcasterSocketId = streamId.split('_')[1]; // Extract broadcaster socket ID from streamId pattern
            const broadcasterData = userSocketMap.get(broadcasterSocketId);
            if (broadcasterData && broadcasterData.liveTitle) {
                 streamTitle = broadcasterData.liveTitle;
            }

            // Send initial stream details to the joining viewer
            socket.emit('stream_details', {
                title: streamTitle,
                isLive: true
            });

            // Notify everyone in the room about the current viewer count
            const numViewers = io.sockets.adapter.rooms.get(streamId)?.size || 0;
            io.to(streamId).emit('viewer_count_update', numViewers);

            // Send system message about user joining (optional)
            const joiningUsername = viewerData?.username || 'Viewer';
            // io.to(streamId).emit('new_live_comment', { type: 'system', text: `${joiningUsername} joined`});

            console.log(`[DropInLive] Viewer ${joiningUsername} (${socket.id}) joined ${streamId}. Total viewers: ${numViewers}`);
        } else {
            console.warn('[DropInLive] join_live_room event missing streamId');
        }
    });

    // Viewer sending a chat message during a live stream
    socket.on('send_live_comment', (data) => {
        const { streamId, text } = data;
        const viewerData = userSocketMap.get(socket.id);

        // Check if viewer is actually in the specified room and message is valid
        if (streamId && text && viewerData && socket.rooms.has(streamId)) {
            const username = viewerData.username || `Viewer_${socket.id.slice(0, 5)}`;
            // Broadcast chat message to everyone in the stream room
            io.to(streamId).emit('new_live_comment', { username, text, type: 'user' });
        } else {
            console.warn(`[DropInLive] Invalid send_live_comment from ${socket.id}. Data:`, data, `In Room: ${socket.rooms.has(streamId)}`);
        }
    });

    // Viewer sending a reaction
    socket.on('send_live_reaction', (data) => {
        const { streamId, reaction } = data;
         // Check if viewer is actually in the specified room and reaction is valid
        if (streamId && reaction && socket.rooms.has(streamId)) {
            // Broadcast the reaction event to everyone in the room (viewer UI handles display)
            io.to(streamId).emit('broadcast_reaction', { reaction, senderId: socket.id }); // Optionally send senderId
        }
    });


    // --- General Call/WebRTC Handling (Used by Messenger & Dialer) ---

    socket.on('hangup_call', (data) => {
        const { targetSocketId } = data || {}; // Gracefully handle missing data
        const senderId = socket.id;
        const senderData = userSocketMap.get(senderId);

        if (!senderData) { console.warn(`[Hangup] Received from unknown user ${senderId}`); return; }

        const actualPartnerId = senderData.currentCallPartnerId;
        const notifiedTargetId = targetSocketId; // The ID the client *thinks* it should notify

        console.log(`[Hangup] Initiated by ${senderData.username || senderId} (Context: ${senderData.context}, State: ${senderData.callState}). Client specified target: ${notifiedTargetId}. Actual partner: ${actualPartnerId}`);

        // Determine the correct partner to notify and update state for
        const partnerToNotifyId = actualPartnerId || notifiedTargetId; // Prioritize actual partner if known

        // Reset sender's state first
        const senderPreviousState = senderData.callState; // Store previous state for logic below
        updateUserState(senderId, { callState: 'idle', currentCallPartnerId: null, targetDropId: null, targetSocketId: null, requiresCode: false, targetDisplayName: null });

        // Clean up dialer attempts if the sender was a dialer targeting a specific Drop ID
        if (senderData.context === 'dialer' && senderData.targetDropId) {
            const key = `${senderId}_${senderData.targetDropId}`;
            delete callerAttempts[key];
            console.log(`[Hangup] Cleared dialer attempts for key: ${key}`);
        }

        // If no partner ID could be determined, stop here
        if (!partnerToNotifyId) {
            console.log(`[Hangup] No partner ID found or specified for hangup from ${senderId}.`);
            return;
        }

        // Find partner's data and socket
        const partnerData = userSocketMap.get(partnerToNotifyId);
        const partnerSocket = io.sockets.sockets.get(partnerToNotifyId);

        // Always attempt to reset the partner's state, even if they are disconnected
        updateUserState(partnerToNotifyId, { callState: 'idle', currentCallPartnerId: null });

        // If the partner is connected, emit the appropriate hangup/rejection event
        if (partnerSocket && partnerData) {
            const partnerCurrentState = partnerData.callState;
            const partnerWasReceivingOrRinging = partnerCurrentState === 'receiving' || partnerCurrentState === 'ringing';
            const senderWasCallingOrRinging = senderPreviousState === 'calling' || senderPreviousState === 'ringing' || senderPreviousState === 'awaiting_code' || senderPreviousState === 'validating_code';

            // Logic to determine if it was a rejection/cancellation vs. a normal hangup
            if (partnerWasReceivingOrRinging && senderWasCallingOrRinging) {
                // Call was never fully 'connected', sender hung up before answer/during validation
                console.log(`[Hangup] Call rejected/cancelled by ${senderId} before connection. Notifying ${partnerToNotifyId} with 'call_rejected'. Partner state: ${partnerCurrentState}`);
                io.to(partnerToNotifyId).emit('call_rejected', { rejectedBySocketId: senderId });
            } else {
                // Normal hangup during a 'connected' state or other scenarios
                console.log(`[Hangup] Normal hangup or unexpected state. Notifying ${partnerToNotifyId} with 'call_hungup'. Sender state: ${senderPreviousState}, Partner state: ${partnerCurrentState}`);
                io.to(partnerToNotifyId).emit('call_hungup', { hungupBySocketId: senderId });
            }
        } else {
            console.log(`[Hangup] Target partner ${partnerToNotifyId} not found/disconnected. State reset.`);
        }
    });

    // WebRTC Signaling: Offer
    socket.on('call_offer', (data) => {
        const { targetSocketId, offer, callerId } = data; // callerId might be redundant if using socket.id
        const senderId = socket.id;

        if (!targetSocketId || !offer) { console.warn(`[WebRTC] Invalid call_offer data from ${senderId}.`); return; }

        const senderData = userSocketMap.get(senderId);
        const targetData = userSocketMap.get(targetSocketId);
        const senderContext = senderData ? senderData.context : 'unknown';

        console.log(`[WebRTC] Relaying call_offer from ${senderId} (Context: ${senderContext}, State: ${senderData?.callState}) to ${targetSocketId}`);

        // Check if target exists
        if (!targetData) {
            console.log(`[WebRTC] Target ${targetSocketId} not found for offer.`);
            socket.emit('call_target_unavailable', { targetSocketId });
            // If sender was in a calling state, reset them
            if (senderData && (senderData.callState === 'calling' || senderData.callState === 'ringing')) {
                updateUserState(senderId, { callState: 'idle', currentCallPartnerId: null });
            }
            return;
        }

        // Check if target is in a state to receive an offer (receiving, ringing, or potentially idle if offer comes fast)
        const acceptableTargetStates = ['receiving', 'ringing', 'idle'];
        if (!acceptableTargetStates.includes(targetData.callState)) {
             console.warn(`[WebRTC] Target ${targetSocketId} busy (${targetData.callState}), cannot receive offer.`);
             socket.emit('call_target_busy', { targetSocketId, targetUsername: targetData.username });
             if (senderData && (senderData.callState === 'calling' || senderData.callState === 'ringing')) {
                 updateUserState(senderId, { callState: 'idle', currentCallPartnerId: null });
             }
             return;
        }

        // If target was idle, update state to receiving (offer implies incoming call)
        if (targetData.callState === 'idle') {
             console.log(`[WebRTC] Target ${targetSocketId} was idle, setting state to 'receiving' due to offer.`);
             updateUserState(targetSocketId, { callState: 'receiving', currentCallPartnerId: senderId });
        }

        // Relay the offer
        io.to(targetSocketId).emit('call_offer', {
            offer,
            callerSocketId: senderId,
            callerName: senderData ? senderData.username : null // Send caller's name if available
        });
    });

    // WebRTC Signaling: Answer
    socket.on('call_answer', (data) => {
        const { targetSocketId, answer } = data;
        const responderId = socket.id;

        if (!targetSocketId || !answer) { console.warn(`[WebRTC] Invalid call_answer data from ${responderId}.`); return; }

        const responderData = userSocketMap.get(responderId);
        const targetData = userSocketMap.get(targetSocketId);

        // Ensure both parties exist
        if (!responderData || !targetData) {
            console.warn(`[WebRTC] User data not found for answer relay. Responder: ${!!responderData}, Target: ${!!targetData}`);
            return;
        }

        // Validate states: Responder should be 'receiving' or 'ringing', Target should be 'calling' or 'ringing'
        const validResponderStates = ['receiving', 'ringing'];
        const validTargetStates = ['calling', 'ringing'];

        if (!validResponderStates.includes(responderData.callState) || !validTargetStates.includes(targetData.callState)) {
            console.warn(`[WebRTC] call_answer state mismatch. Responder (${responderId}): ${responderData.callState}, Target (${targetSocketId}): ${targetData.callState}. Aborting answer relay.`);
            // Optionally notify sender that answer failed due to state issue
            return;
        }

        // States seem valid, connect the call
        console.log(`[WebRTC] Call connected between ${targetSocketId} (Caller) and ${responderId} (Responder)`);
        updateUserState(responderId, { callState: 'connected' });
        updateUserState(targetSocketId, { callState: 'connected' });

        // Relay the answer back to the original caller
        io.to(targetSocketId).emit('call_answer', { answer, responderSocketId: responderId });
    });

    // WebRTC Signaling: ICE Candidate
    socket.on('ice_candidate', (data) => {
        const { targetSocketId, candidate } = data;
        if (!targetSocketId || !candidate) { console.warn(`[WebRTC] Invalid ice_candidate data from ${socket.id}`); return; }

        // console.log(`[Server ICE Relay] Relaying candidate from ${socket.id} to ${targetSocketId}`);
        // console.log(candidate); // Log candidate details if needed for debugging

        // Relay the candidate directly to the target
        io.to(targetSocketId).emit('ice_candidate', { candidate, senderSocketId: socket.id });
    });

    // --- Disconnection Handling ---
    socket.on('disconnect', (reason) => {
        const disconnectedSocketId = socket.id;
        const userData = userSocketMap.get(disconnectedSocketId);

        // If user data doesn't exist (shouldn't normally happen), just log and exit
        if (!userData) {
            console.log(`[Socket] Disconnected: ${disconnectedSocketId} (No user data found). Reason: ${reason}`);
            return;
        }

        const { username, roomId, dropId, context, callState, currentCallPartnerId, liveStreamId } = userData;
        console.log(`[Socket] Disconnected: ${disconnectedSocketId} (User: ${username || 'N/A'}, Context: ${context}, Room: ${roomId || 'N/A'}, DropID: ${dropId || 'N/A'}, State: ${callState}). Reason: ${reason}`);

        // --- Cleanup based on context and state ---

        // 1. If user was in an active call (any state other than 'idle')
        if (callState !== 'idle' && currentCallPartnerId) {
            console.log(`[Disconnect] User was in call state (${callState}). Notifying partner ${currentCallPartnerId}.`);
            const partnerSocket = io.sockets.sockets.get(currentCallPartnerId);
            // Reset partner's state regardless of connection status
            updateUserState(currentCallPartnerId, { callState: 'idle', currentCallPartnerId: null });
            // If partner is still connected, notify them
            if (partnerSocket) {
                io.to(currentCallPartnerId).emit('call_hungup', { hungupBySocketId: disconnectedSocketId, reason: 'partner_disconnected' });
            }
        }

        // 2. If user was a Drop ID owner (Receiver or Messenger)
        if ((context === 'messenger' || context === 'receiver') && dropId && dropIdOwnerSocket[dropId] === disconnectedSocketId) {
            delete dropIdOwnerSocket[dropId]; // Remove mapping
            console.log(`[Mapping] Removed mapping for Drop ID ${dropId} due to disconnect.`);
        }

        // 3. If user was a Dialer, clear any pending attempts
        if (context === 'dialer') {
             Object.keys(callerAttempts).forEach(key => {
                 if (key.startsWith(`${disconnectedSocketId}_`)) {
                     delete callerAttempts[key];
                     console.log(`[Disconnect] Cleared dialer attempts for key: ${key}`);
                 }
             });
        }

        // 4. If user was in a Messenger chat room
        if (context === 'messenger' && roomId) {
            // Notify others in the room that the user left
            socket.to(roomId).emit('user_left_chat', { user: username || 'User', socketId: disconnectedSocketId });
            console.log(`[Messenger] Notified room ${roomId} of user left: ${username || disconnectedSocketId}`);
        }

        // 5. If user was a Live Broadcaster
        if (context === 'live_broadcast' && liveStreamId) {
             console.log(`[DropInLive] Broadcaster ${username || disconnectedSocketId} disconnected. Ending stream ${liveStreamId}.`);
             // Notify viewers and clean up the room
             io.to(liveStreamId).emit('live_stream_ended', { reason: 'broadcaster_disconnected' });
             io.socketsLeave(liveStreamId); // Force everyone out
        }

        // 6. If user was a Live Viewer
        if (roomId && roomId.startsWith('stream_')) { // Check if they were in a stream room
             const streamId = roomId;
             console.log(`[DropInLive] Viewer ${username || disconnectedSocketId} disconnected from stream ${streamId}`);
             // Update viewer count for the room they left
             // Need a slight delay maybe, or rely on next join/message to update count?
             // For simplicity, let's update immediately after they leave:
             // Note: This might be slightly inaccurate if disconnects happen rapidly.
             const numViewers = io.sockets.adapter.rooms.get(streamId)?.size || 0; // Get count *after* they left
             io.to(streamId).emit('viewer_count_update', numViewers);

        }


        // Finally, remove the user from the central map
        userSocketMap.delete(disconnectedSocketId);
        console.log(`[State] Removed user data for ${disconnectedSocketId}. Current users: ${userSocketMap.size}`);
    });

}); // End io.on('connection')


// --- Basic HTTP Routes ---
// Redirect /c/<roomId> to index.html with session parameter
app.get('/c/:roomId', (req, res) => {
    res.redirect(`/index.html?session=${encodeURIComponent(req.params.roomId)}`);
});

// Redirect root path to index.html
app.get('/', (req, res) => {
    res.redirect('/index.html');
});

// --- Server Listening ---
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 Drop Server running on port ${PORT}`);
    console.log(`   Live Mode Enabled`);
    console.log(`   Messenger/Dialer/Receiver Modes Enabled`);
});