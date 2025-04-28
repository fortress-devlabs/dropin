// --- server.js v30.0 - Add volatile emit for chunks ---
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);

// Helper function to format bytes (Unchanged)
function formatBytes(bytes, decimals = 2) { /* ... */ }
// Helper function to generate guest names (Unchanged)
function generateGuestName() { /* ... */ }


const io = new Server(server, {
    cors: { origin: '*', methods: ['GET', 'POST'] },
    pingInterval: 20000,
    pingTimeout: 120000,
    maxHttpBufferSize: 1e8
});

app.use(express.static('public'));
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: true, limit: '100mb' }));

// --- State Management --- (Unchanged)
const userSocketMap = new Map();
const dropIdOwnerSocket = {};
const dropCodeMap = { '0000': '15425', '1234': '98765', };
const callerAttempts = {};
const updateUserState = (socketId, updates) => { const userData = userSocketMap.get(socketId); if (userData) { userSocketMap.set(socketId, { ...userData, ...updates }); } };
function findSocketIdForDropId(dropId) { return dropIdOwnerSocket[dropId] || null; }

// --- Socket.IO Connection Handling ---
io.on('connection', (socket) => {
    console.log(`[Socket] Connected: ${socket.id}`);
    const { username, sessionId, context, userDropId } = socket.handshake.query;
    let connectionContext = 'messenger';
    if (context === 'dialer' || context === 'receiver' || context === 'live_broadcast') { connectionContext = context; }
    console.log(`Handshake -> Context: ${connectionContext}, User: ${username || 'N/A'}, Session: ${sessionId || 'N/A'}, DropID: ${userDropId || 'N/A'}, Socket: ${socket.id}`);

    userSocketMap.set(socket.id, {
        username: username || null, roomId: sessionId || null, dropId: userDropId || null,
        context: connectionContext, callState: 'idle', currentCallPartnerId: null,
        targetDropId: null, targetSocketId: null, requiresCode: false, targetDisplayName: null,
        liveTitle: null, liveStreamId: null, liveMimeType: null // Added liveMimeType placeholder
    });

    // --- Messenger, Receiver, Dialer Context Handling --- (Unchanged)
    if (connectionContext === 'messenger') { /* ... existing messenger handlers ... */ }
    if (connectionContext === 'receiver') { /* ... existing receiver handlers ... */ }
    if (connectionContext === 'dialer') { /* ... existing dialer handlers ... */ }


    // --- DropIn Live Broadcast System ---
    if (connectionContext === 'live_broadcast') {
        let liveStreamId = userSocketMap.get(socket.id)?.liveStreamId || null;

        socket.on('start_stream', (data) => {
            // Store mimeType if provided (Required for Option 1 implementation)
            // Note: The broadcaster example was modified to send this later.
            // If implementing Option 1 fully, handle 'update_stream_details' event here.
            const { title, mimeType } = data; // MimeType might be undefined here based on current broadcaster code
            if (liveStreamId) { console.warn(`[DropInLive] Broadcaster ${socket.id} restart attempt.`); socket.emit('stream_started_ack', { streamId: liveStreamId }); return; }

            liveStreamId = `stream_${socket.id}_${Date.now()}`;
            socket.join(liveStreamId);
            updateUserState(socket.id, {
                liveStreamId: liveStreamId,
                liveTitle: title || 'Untitled Stream',
                liveMimeType: mimeType || null // Store mimeType if received now
            });
            socket.emit('stream_started_ack', { streamId: liveStreamId });
            console.log(`[DropInLive] Stream started: ${liveStreamId} - Title: ${title || 'Untitled'} - MIME: ${mimeType || 'N/A'}`);
        });

        socket.on('live_stream_data', (data) => {
            const { streamId, chunk } = data;
            const broadcasterData = userSocketMap.get(socket.id);
            const currentStreamId = broadcasterData?.liveStreamId;

            if (!streamId || !chunk || streamId !== currentStreamId) {
                console.warn(`[DropInLive] Invalid live_stream_data from ${socket.id}. Expected: ${currentStreamId}, Got: ${streamId}. Chunk valid: ${!!chunk}`);
                return;
            }
            // Ensure chunk is likely ArrayBuffer (or Buffer) - basic check
            if (typeof chunk !== 'object' || chunk === null || typeof chunk.byteLength !== 'number' ) {
                 console.warn(`[DropInLive] Received chunk is not a buffer-like object. Type: ${typeof chunk}`);
                 return;
            }

            // Use volatile emit for potentially better performance with frequent data (Instruction #4)
            // Emit raw chunk data
            io.to(streamId).volatile.emit('receive_live_chunk', chunk);
            // console.log(`Relayed chunk ${chunk.byteLength} bytes to room ${streamId}`); // Verbose log
        });

        // Handler for broadcaster sending chat (Unchanged)
        socket.on('send_live_comment', (data) => { /* ... */ });

        socket.on('end_stream', (data) => {
            const { streamId } = data;
            const currentStreamId = userSocketMap.get(socket.id)?.liveStreamId;
            if (streamId && streamId === currentStreamId) {
                console.log(`[DropInLive] Stream ended by broadcaster: ${streamId}`);
                // Use volatile here too? Probably not necessary for infrequent events.
                io.to(streamId).emit('live_stream_ended', { reason: 'broadcaster_ended' });
                io.socketsLeave(streamId); // Make all viewers leave the room
                updateUserState(socket.id, { liveStreamId: null, liveTitle: null, liveMimeType: null }); // Clear state
                liveStreamId = null; // Clear local variable too
            } else {
                 console.warn(`[DropInLive] Invalid end_stream from broadcaster ${socket.id}. Expected: ${currentStreamId}, Got: ${streamId}`);
            }
        });
    } // End Live Broadcast Context

    // --- DropIn Live Viewer Connection & Interaction ---
    socket.on('join_live_room', (data) => {
        const { streamId } = data;
        if (streamId) {
            const roomExists = io.sockets.adapter.rooms.has(streamId);
            if (!roomExists) { console.warn(`[DropInLive] Viewer ${socket.id} join non-existent stream ${streamId}`); socket.emit('stream_details', { isLive: false, title: 'Stream Not Found' }); return; }

            socket.join(streamId);
            updateUserState(socket.id, { roomId: streamId }); // Store current room for viewer

            let joiningUsername = userSocketMap.get(socket.id)?.username;
            if (!joiningUsername) { joiningUsername = generateGuestName(); updateUserState(socket.id, { username: joiningUsername }); socket.username = joiningUsername; }

            const broadcasterSocketId = streamId.split('_')[1];
            const broadcasterData = userSocketMap.get(broadcasterSocketId);

            const detailsToSend = {
                title: broadcasterData?.liveTitle || 'Live Stream',
                isLive: true,
                // Include mimeType IF Option 1 is implemented and broadcasterData has it
                mimeType: broadcasterData?.liveMimeType || null,
                hostName: broadcasterData?.username || 'Broadcaster' // Example: Use broadcaster's username
            };

            socket.emit('stream_details', detailsToSend);
            const numViewers = io.sockets.adapter.rooms.get(streamId)?.size || 0;
            io.to(streamId).emit('viewer_count_update', numViewers); // Update everyone in the room
            console.log(`[DropInLive] Viewer ${joiningUsername} (${socket.id}) joined ${streamId}. Details:`, detailsToSend, `Viewers: ${numViewers}`);
        } else { console.warn('[DropInLive] join_live_room event missing streamId'); }
    });

    // Handler for viewer sending chat (Unchanged)
    socket.on('send_live_comment', (data) => { /* ... */ });
    // Handler for viewer sending reaction (Unchanged)
    socket.on('send_live_reaction', (data) => { /* ... */ });


    // --- General Call/WebRTC Handling --- (Unchanged)
    socket.on('hangup_call', (data) => { /* ... */ });
    socket.on('call_offer', (data) => { /* ... */ });
    socket.on('call_answer', (data) => { /* ... */ });
    socket.on('ice_candidate', (data) => { /* ... */ });


    // --- Disconnection Handling --- (Logic mostly unchanged, ensure live state cleared)
    socket.on('disconnect', (reason) => {
        const disconnectedSocketId = socket.id;
        const userData = userSocketMap.get(disconnectedSocketId);
        if (!userData) { console.log(`[Socket] Disconnected: ${disconnectedSocketId} (No data). Reason: ${reason}`); return; }

        const { username, roomId, dropId, context, callState, currentCallPartnerId, liveStreamId } = userData;
        console.log(`[Socket] Disconnected: ${disconnectedSocketId} (User: ${username || 'N/A'}, Ctx: ${context}, Room: ${roomId || 'N/A'}, DropID: ${dropId || 'N/A'}, State: ${callState}). Reason: ${reason}`);

        // Existing call hangup logic...
        if (callState !== 'idle' && currentCallPartnerId) { /* ... notify partner ... */ }
        // Existing mapping cleanup...
        if ((context === 'messenger' || context === 'receiver') && dropId && dropIdOwnerSocket[dropId] === disconnectedSocketId) { /* ... delete mapping ... */ }
        // Existing dialer attempt cleanup...
        if (context === 'dialer') { /* ... delete attempts ... */ }
        // Existing chat room notification...
        if (context === 'messenger' && roomId) { /* ... emit user_left_chat ... */ }

        // Specific cleanup for Live context
        if (context === 'live_broadcast' && liveStreamId) {
            console.log(`[DropInLive] Broadcaster ${username || disconnectedSocketId} disconnected. Ending stream ${liveStreamId}.`);
            io.to(liveStreamId).emit('live_stream_ended', { reason: 'broadcaster_disconnected' });
            io.socketsLeave(liveStreamId);
            // State already cleared when 'end_stream' is handled, but clear again just in case
            updateUserState(disconnectedSocketId, { liveStreamId: null, liveTitle: null, liveMimeType: null });
        } else if (roomId && roomId.startsWith('stream_')) { // Viewer disconnected
             const viewerStreamId = roomId;
             console.log(`[DropInLive] Viewer ${username || disconnectedSocketId} disconnected from ${viewerStreamId}`);
             // Update viewer count after a short delay
             setTimeout(() => {
                 const currentRoom = io.sockets.adapter.rooms.get(viewerStreamId);
                 if (currentRoom) { // Only update if room still exists
                    const numViewers = currentRoom.size || 0;
                    io.to(viewerStreamId).emit('viewer_count_update', numViewers);
                    console.log(`[DropInLive] Updated viewer count for ${viewerStreamId}: ${numViewers}`);
                 }
             }, 100);
        }

        userSocketMap.delete(disconnectedSocketId);
        console.log(`[State] Removed user data for ${disconnectedSocketId}. Current users: ${userSocketMap.size}`);
    });

}); // End io.on('connection')


// --- Basic HTTP Routes --- (Unchanged)
app.get('/c/:roomId', (req, res) => { res.redirect(`/index.html?session=${encodeURIComponent(req.params.roomId)}`); });
app.get('/', (req, res) => { res.redirect('/index.html'); });
app.get('/watch/:streamId', (req, res) => {
    const viewerFilePath = path.join(__dirname, 'public', 'viewer.html');
    res.sendFile(viewerFilePath, (err) => {
        if (err) { console.error(`[Server] Error sending viewer.html for stream ${req.params.streamId}:`, err);
            if (err.code === 'ENOENT') { res.status(404).send('Stream viewer page not found.'); }
            else { res.status(500).send('Server error loading stream page.'); }
        }
    });
});
app.get('/favicon.ico', (req, res) => res.status(204).send());

// --- Server Listening --- (Unchanged)
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 Drop Server running on port ${PORT}`);
    console.log(`   Static files served from: 'public'`);
    console.log(`   Live Mode Enabled`);
    console.log(`   Messenger/Dialer/Receiver Modes Enabled`);
});