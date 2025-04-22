// --- server.js (v28 - Added Image Drop Handler) ---

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);

// Helper to format bytes for logging
function formatBytes(bytes, decimals = 2) {
    if (!bytes || bytes === 0) return '0 Bytes';
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.max(0, Math.floor(Math.log(Math.abs(bytes)) / Math.log(k)));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

const io = new Server(server, {
    cors: { origin: '*' },
    pingInterval: 20000,
    pingTimeout: 120000,
    maxHttpBufferSize: 1e8 // 100MB limit
});

app.use(express.static('public'));
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: true, limit: '100mb' }));

io.on('connection', (socket) => {
    console.log('User connected:', socket.id);
    const { username, sessionId } = socket.handshake.query;
    socket.username = username;
    // Store session ID on join
    console.log(`Handshake Info -> User: ${username}, Session: ${sessionId}`);

    socket.on('join_chat_room', (data) => {
        const { room, user } = data;
        if (!room || !user) { console.error("Join invalid:", data); return; }
        socket.join(room);
        socket.roomId = room;
        socket.username = user;
        console.log(`User ${user} (${socket.id}) joined room ${room}`);
        socket.to(room).emit('user_joined_chat', { user, socketId: socket.id });
        const clientsInRoom = Array.from(io.sockets.adapter.rooms.get(room) || []);
        const users = {};
        clientsInRoom.forEach(id => {
            const clientSocket = io.sockets.sockets.get(id);
            if (clientSocket && clientSocket.id !== socket.id) {
                users[clientSocket.id] = clientSocket.username || "Unknown";
            }
        });
        socket.emit('session_users', users);
    });

    socket.on('chat_message', (data) => {
        const { username, message, session } = data;
        const targetRoom = session || socket.roomId;
        if (!targetRoom || !username || message === undefined) { console.warn("Invalid chat msg:", data); return; }
        console.log(`Msg from ${username} in ${targetRoom}: ${message.substring(0, 50)}...`);
        socket.to(targetRoom).emit('chat_message', { username, message, senderSocketId: socket.id });
    });

    socket.on('start_typing', (data) => {
        const targetRoom = data.session || socket.roomId;
        if (targetRoom && data.username) socket.to(targetRoom).emit('user_started_typing', { username: data.username, socketId: socket.id });
    });

    socket.on('stop_typing', (data) => {
        const targetRoom = data.session || socket.roomId;
        if (targetRoom && data.username) socket.to(targetRoom).emit('user_stopped_typing', { username: data.username, socketId: socket.id });
    });

    // VIDEO DROP Handler
    socket.on('video_drop', (data) => {
        const { username, session, videoBuffer } = data;
        const targetRoom = session || socket.roomId;
        if (!targetRoom || !username || !videoBuffer) { console.warn(`Incomplete video_drop from ${socket.id}`); return; }
        let bufferToSend; let bufferSize = 0;
        if (videoBuffer instanceof Buffer) { bufferToSend = videoBuffer; bufferSize = videoBuffer.length; }
        else if (videoBuffer instanceof ArrayBuffer) { bufferToSend = Buffer.from(videoBuffer); bufferSize = videoBuffer.byteLength; }
        else { console.warn(`Unexpected video buffer type from ${socket.id}: ${typeof videoBuffer}`); return; }
        console.log(`Video Drop from ${username} in ${targetRoom}, Size: ${formatBytes(bufferSize)}`);
        const SERVER_MAX_VIDEO_SIZE = 95 * 1024 * 1024;
        if (bufferSize > SERVER_MAX_VIDEO_SIZE) {
            console.error(`Video Drop from ${username} rejected: Size ${formatBytes(bufferSize)} > ${formatBytes(SERVER_MAX_VIDEO_SIZE)}`);
            socket.emit('video_drop_error', { reason: 'Video file too large.' }); return;
        }
        io.to(targetRoom).emit('video_drop', { username, videoBuffer: (videoBuffer instanceof ArrayBuffer) ? videoBuffer : bufferToSend, senderSocketId: socket.id });
        console.log(`Broadcasted video drop from ${username} to ${targetRoom}`);
    });

    // VOICE DROP Handler
    socket.on('voice_drop', (data) => {
        const { username, session, audioBuffer } = data;
        const targetRoom = session || socket.roomId;
        if (!targetRoom || !username || !audioBuffer) { console.warn(`Incomplete voice_drop from ${socket.id}`); return; }
        let bufferToSend; let bufferSize = 0;
        if (audioBuffer instanceof Buffer) { bufferToSend = audioBuffer; bufferSize = audioBuffer.length; }
        else if (audioBuffer instanceof ArrayBuffer) { bufferToSend = audioBuffer; bufferSize = audioBuffer.byteLength; } // Send ArrayBuffer directly
        else { console.warn(`Unexpected audio buffer type from ${socket.id}: ${typeof audioBuffer}`); return; }
        console.log(`Voice Drop from ${username} in ${targetRoom}, Size: ${formatBytes(bufferSize)}`);
        const SERVER_MAX_AUDIO_SIZE = 15 * 1024 * 1024;
        if (bufferSize > SERVER_MAX_AUDIO_SIZE) {
            console.error(`Voice Drop from ${username} rejected: Size ${formatBytes(bufferSize)} > ${formatBytes(SERVER_MAX_AUDIO_SIZE)}`);
            socket.emit('voice_drop_error', { reason: 'Voice recording too large.' }); return;
        }
        io.to(targetRoom).emit('voice_drop', { username, audioBuffer: bufferToSend, senderSocketId: socket.id });
        console.log(`Broadcasted voice drop from ${username} to ${targetRoom}`);
    });

    // NEW: IMAGE DROP Handler
    socket.on('image_drop', (data) => {
        const { username, session, imageBuffer, mimeType } = data;
        const targetRoom = session || socket.roomId;

        // Validate data
        if (!targetRoom || !username || !imageBuffer || !mimeType) {
            console.warn(`Incomplete image_drop data from: ${socket.id} (User: ${username}, Room: ${targetRoom}, HasBuffer: ${!!imageBuffer}, Mime: ${mimeType})`);
            return;
        }

        // Determine buffer type and size
        let bufferToSend;
        let bufferSize = 0;
        if (imageBuffer instanceof Buffer) {
            bufferToSend = imageBuffer;
            bufferSize = imageBuffer.length;
        } else if (imageBuffer instanceof ArrayBuffer) {
            bufferToSend = imageBuffer; // Send ArrayBuffer directly
            bufferSize = imageBuffer.byteLength;
        } else {
            console.warn(`Received image_drop with unexpected buffer type from ${socket.id}: ${typeof imageBuffer}`);
            return;
        }

        console.log(`Image Drop from ${username} (${socket.id}) in session ${targetRoom}, Size: ${formatBytes(bufferSize)}, Type: ${mimeType}`);

        // Server-side size check (e.g., 15MB, matching audio for now)
        const SERVER_MAX_IMAGE_SIZE = 15 * 1024 * 1024;
        if (bufferSize > SERVER_MAX_IMAGE_SIZE) {
            console.error(`Image Drop from ${username} (${socket.id}) rejected: Size ${formatBytes(bufferSize)} exceeds server limit ${formatBytes(SERVER_MAX_IMAGE_SIZE)}`);
            socket.emit('image_drop_error', { reason: 'Image file too large for server.' });
            return;
        }

        // Broadcast the image data (as ArrayBuffer) and MIME type to everyone in the room
        io.to(targetRoom).emit('image_drop', {
            username: username,
            imageBuffer: bufferToSend, // Send ArrayBuffer
            mimeType: mimeType,        // Include MIME type
            senderSocketId: socket.id
        });
        console.log(`Broadcasted image drop from ${username} to session ${targetRoom}`);
    });


    // Error listeners from client
    socket.on('video_drop_error', (data) => { console.error(`Client ${socket.id} video error:`, data.reason); });
    socket.on('voice_drop_error', (data) => { console.error(`Client ${socket.id} voice error:`, data.reason); });
    socket.on('image_drop_error', (data) => { console.error(`Client ${socket.id} image error:`, data.reason); }); // NEW


    socket.on('disconnect', () => {
        console.log(`User disconnected: ${socket.id} (User: ${socket.username || 'N/A'}, Room: ${socket.roomId || 'N/A'})`);
        if (socket.roomId && socket.username) {
            socket.to(socket.roomId).emit('user_left_chat', { user: socket.username, socketId: socket.id });
        }
    });

}); // End io.on('connection', ...)

// --- Routes & Server Start (Unchanged) ---
app.get('/c/:roomId', (req, res) => { res.redirect(`/index.html?session=${encodeURIComponent(req.params.roomId)}`); });
app.get('/', (req, res) => { res.redirect('/index.html'); });
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => { console.log(`Server running on port ${PORT}`); });