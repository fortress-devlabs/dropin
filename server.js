// --- server.js (v27 - Added Voice Drop Handler) ---

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);

// Helper to format bytes for logging
function formatBytes(bytes, decimals = 2) {
    if (!bytes || bytes === 0) return '0 Bytes'; // Handle null/zero bytes
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    // Handle cases where bytes might be NaN or negative after calculation
    const i = Math.max(0, Math.floor(Math.log(Math.abs(bytes)) / Math.log(k)));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}


const io = new Server(server, {
    cors: {
        origin: '*',
    },
    pingInterval: 20000,
    pingTimeout: 120000,
    // CONFIRMED: maxHttpBufferSize is set high enough for large media
    maxHttpBufferSize: 1e8 // 100MB limit
});

app.use(express.static('public'));
// CONFIRMED: Express limits also set high
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: true, limit: '100mb' }));

io.on('connection', (socket) => {
    console.log('User connected:', socket.id);
    const { username, sessionId } = socket.handshake.query; // Removed unused dropID, isHost
    socket.username = username;
    // socket.sessionId = sessionId; // Store on roomId after join
    console.log(`Handshake Info -> Username: ${username}, Session: ${sessionId}`);

    socket.on('join_chat_room', (data) => {
        const { room, user } = data;
        if (!room || !user) { console.error("Join attempt invalid:", data); return; }
        socket.join(room);
        socket.roomId = room; // Store room ID on the socket
        socket.username = user; // Ensure username is set/updated
        console.log(`User ${user} (${socket.id}) joined chat room ${room}`);
        // Notify others in the room
        socket.to(room).emit('user_joined_chat', { user, socketId: socket.id });
        // Send list of existing users *in this room* to the newly joined user
        const clientsInRoom = Array.from(io.sockets.adapter.rooms.get(room) || []);
        const users = {};
        clientsInRoom.forEach(id => {
            const clientSocket = io.sockets.sockets.get(id);
            // Only include other users, not the user themselves
            if (clientSocket && clientSocket.id !== socket.id) {
                users[clientSocket.id] = clientSocket.username || "Unknown";
            }
        });
        socket.emit('session_users', users); // Send existing users to the new joiner
    });


    socket.on('chat_message', (data) => {
        const { username, message, session } = data;
        const targetRoom = session || socket.roomId; // Use provided session or socket's room
        if (!targetRoom || !username || message === undefined) { console.warn("Invalid chat message:", data); return; }
        console.log(`Message from ${username} (${socket.id}) in ${targetRoom}: ${message.substring(0, 50)}...`);
        // Broadcast message to the specific room, excluding the sender
        socket.to(targetRoom).emit('chat_message', { username, message, senderSocketId: socket.id });
    });

    socket.on('start_typing', (data) => {
        const { session, username } = data;
        const targetRoom = session || socket.roomId;
        if (targetRoom && username) { socket.to(targetRoom).emit('user_started_typing', { username, socketId: socket.id }); }
    });

    socket.on('stop_typing', (data) => {
        const { session, username } = data;
         const targetRoom = session || socket.roomId;
        if (targetRoom && username) { socket.to(targetRoom).emit('user_stopped_typing', { username, socketId: socket.id }); }
    });

    // VIDEO DROP Handler
    socket.on('video_drop', (data) => {
        const { username, session, videoBuffer } = data;
        const targetRoom = session || socket.roomId;

        if (!targetRoom || !username || !videoBuffer) {
             console.warn(`Received incomplete video_drop data from: ${socket.id} (Username: ${username}, Session: ${targetRoom}, HasBuffer: ${!!videoBuffer})`);
             return;
        }

        let bufferToSend;
        let bufferSize = 0;
        if (videoBuffer instanceof Buffer) { bufferToSend = videoBuffer; bufferSize = videoBuffer.length; }
        else if (videoBuffer instanceof ArrayBuffer) { bufferToSend = Buffer.from(videoBuffer); bufferSize = videoBuffer.byteLength; }
        else { console.warn(`Received video_drop with unexpected buffer type from ${socket.id}: ${typeof videoBuffer}`); return; }

        console.log(`Video Drop Buffer from ${username} (${socket.id}) in session ${targetRoom}, Size: ${formatBytes(bufferSize)}`);

        const SERVER_MAX_VIDEO_SIZE = 95 * 1024 * 1024; // 95MB
        if (bufferSize > SERVER_MAX_VIDEO_SIZE) {
            console.error(`Video Drop from ${username} (${socket.id}) rejected: Size ${formatBytes(bufferSize)} exceeds server limit ${formatBytes(SERVER_MAX_VIDEO_SIZE)}`);
            socket.emit('video_drop_error', { reason: 'Video file too large for server.' });
            return;
        }

        // Broadcast to ALL in the room (including sender)
        // Send original ArrayBuffer if received that way, as client expects it
        io.to(targetRoom).emit('video_drop', {
            username: username,
            videoBuffer: (videoBuffer instanceof ArrayBuffer) ? videoBuffer : bufferToSend,
            senderSocketId: socket.id
        });
        console.log(`Broadcasted video drop from ${username} to session ${targetRoom}`);
    });

    // NEW: VOICE DROP Handler
    socket.on('voice_drop', (data) => {
        const { username, session, audioBuffer } = data;
        const targetRoom = session || socket.roomId; // Use room associated with the socket if session not provided

        // Validate data
        if (!targetRoom || !username || !audioBuffer) {
            console.warn(`Received incomplete voice_drop data from: ${socket.id} (Username: ${username}, Session: ${targetRoom}, HasBuffer: ${!!audioBuffer})`);
            return;
        }

        // Determine buffer type and size
        let bufferToSend;
        let bufferSize = 0;
        if (audioBuffer instanceof Buffer) { // Likely from Node.js client (if ever used)
            bufferToSend = audioBuffer;
            bufferSize = audioBuffer.length;
        } else if (audioBuffer instanceof ArrayBuffer) { // Expected from browser client
            // No conversion needed if sending ArrayBuffer directly
            bufferToSend = audioBuffer; // Keep as ArrayBuffer
            bufferSize = audioBuffer.byteLength;
        } else {
            console.warn(`Received voice_drop with unexpected buffer type from ${socket.id}: ${typeof audioBuffer}`);
            return; // Reject unknown type
        }

        console.log(`Voice Drop Buffer from ${username} (${socket.id}) in session ${targetRoom}, Size: ${formatBytes(bufferSize)}`);

        // Server-side size check (e.g., 15MB for audio, generous)
        const SERVER_MAX_AUDIO_SIZE = 15 * 1024 * 1024;
        if (bufferSize > SERVER_MAX_AUDIO_SIZE) {
            console.error(`Voice Drop from ${username} (${socket.id}) rejected: Size ${formatBytes(bufferSize)} exceeds server limit ${formatBytes(SERVER_MAX_AUDIO_SIZE)}`);
            // Notify the sender about the error
            socket.emit('voice_drop_error', { reason: 'Voice recording too large for server.' });
            return; // Stop processing
        }

        // Broadcast the audio data (as ArrayBuffer) to everyone in the room
        io.to(targetRoom).emit('voice_drop', {
            username: username,
            audioBuffer: bufferToSend, // Send the ArrayBuffer
            senderSocketId: socket.id
        });
        console.log(`Broadcasted voice drop from ${username} to session ${targetRoom}`);
    });

    // Error listeners from client
    socket.on('video_drop_error', (data) => { console.error(`Client ${socket.id} reported video error:`, data.reason); });
    socket.on('voice_drop_error', (data) => { console.error(`Client ${socket.id} reported voice error:`, data.reason); });

    // --- DROPIN THEATRE HANDLERS (Placeholders) ---
    // const theatreRooms = {}; // Basic in-memory store
    // function validateHost(socket, roomId) { return false; /* Placeholder */ }
    // function updateTheatreViewerCount(roomId) { /* Placeholder */ }
    // --- End Theatre Handlers ---


    socket.on('disconnect', () => {
        console.log(`User disconnected: ${socket.id} (Username: ${socket.username || 'N/A'}, Session: ${socket.roomId || 'N/A'})`);
        if (socket.roomId && socket.username) { // Use socket.roomId if available
            console.log(`Notifying session ${socket.roomId} that ${socket.username} left`);
            socket.to(socket.roomId).emit('user_left_chat', { user: socket.username, socketId: socket.id });
        }
        // TODO: Add Theatre disconnect logic if needed
    });

}); // End io.on('connection', ...)

// --- Routes & Server Start (Unchanged) ---
app.get('/c/:roomId', (req, res) => { res.redirect(`/index.html?session=${encodeURIComponent(req.params.roomId)}`); });
app.get('/', (req, res) => { res.redirect('/index.html'); });
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => { console.log(`Server running on port ${PORT}`); });