// --- server.js (Option A: Broadcast video drop to ALL) ---

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: '*',
    },
    pingInterval: 20000,
    pingTimeout: 120000,
    maxHttpBufferSize: 1e8
});

app.use(express.static('public'));
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: true, limit: '100mb' }));

io.on('connection', (socket) => {
    console.log('User connected:', socket.id);
    const { username, sessionId, dropID, isHost } = socket.handshake.query;
    socket.username = username;
    socket.sessionId = sessionId;
    console.log(`Handshake Info -> Username: ${username}, Session: ${sessionId}`);

    socket.on('join_chat_room', (data) => {
        const { room, user } = data;
        if (!room || !user) { console.error("Join attempt invalid:", data); return; }
        socket.join(room);
        socket.roomId = room;
        socket.username = user;
        console.log(`User ${user} (${socket.id}) joined chat room ${room}`);
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
        if (!session || !username || message === undefined) { console.warn("Invalid chat message:", data); return; }
        console.log(`Message from ${username} (${socket.id}) in ${session}: ${message}`);
        socket.to(session).emit('chat_message', { username, message, senderSocketId: socket.id });
    });

    socket.on('start_typing', (data) => {
        const { session, username } = data;
        if (session && username) { socket.to(session).emit('user_started_typing', { username, socketId: socket.id }); }
    });

    socket.on('stop_typing', (data) => {
        const { session, username } = data;
        if (session && username) { socket.to(session).emit('user_stopped_typing', { username, socketId: socket.id }); }
    });

    // VIDEO DROP Handler (UPDATED: Broadcast to ALL using io.to)
    socket.on('video_drop', (data) => {
        const { username, session, videoBuffer } = data;
        if (session && username && videoBuffer instanceof Buffer) {
            console.log(`Video Drop Buffer from ${username} (${socket.id}) in session ${session}, Size: ${videoBuffer.length} bytes`);
            // --- CHANGE HERE: Use io.to instead of socket.to ---
            io.to(session).emit('video_drop', {
                username: username,
                videoBuffer: videoBuffer,
                senderSocketId: socket.id
            });
             // --- End Change ---
        } else {
             console.warn("Received incomplete/invalid video_drop data from:", socket.id, " Type of videoBuffer:", typeof videoBuffer);
        }
    });

    // --- DROPIN THEATRE HANDLERS (Unchanged) ---
    const theatreRooms = {};
    socket.on('create_theatre_room', (data) => { /* ... */ });
    socket.on('join_theatre_room', (data) => { /* ... */ });
    socket.on('play_video', (data) => { /* ... */ });
    socket.on('pause_video', (data) => { /* ... */ });
    socket.on('seek_video', (data) => { /* ... */ });
    socket.on('send_theatre_comment', (data) => { /* ... */ });
    socket.on('send_theatre_reaction', (data) => { /* ... */ });
    function validateHost(socket, roomId) { return theatreRooms[roomId] && theatreRooms[roomId].hostSocketId === socket.id; }
    function updateTheatreViewerCount(roomId) { if (!theatreRooms[roomId]) return; const viewerCount = theatreRooms[roomId].viewers.size; io.to(roomId).emit('viewer_count_update', { count: viewerCount }); }
    // --- End Theatre Handlers ---


    socket.on('disconnect', () => {
        console.log(`User disconnected: ${socket.id} (Username: ${socket.username}, Session: ${socket.sessionId}, TheatreRoom: ${socket.theatreRoomId})`);
        if (socket.sessionId && socket.username) {
            console.log(`Notifying session ${socket.sessionId} that ${socket.username} left`);
            socket.to(socket.sessionId).emit('user_left_chat', { user: socket.username, socketId: socket.id });
        }
        if (socket.theatreRoomId) { /* ... Theatre disconnect logic ... */ }
    });

}); // End io.on('connection', ...)

// --- Routes & Server Start (Unchanged) ---
app.get('/c/:roomId', (req, res) => { res.redirect(`/index.html?session=${encodeURIComponent(req.params.roomId)}`); });
app.get('/', (req, res) => { res.redirect('/index.html'); });
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => { console.log(`Server running on port ${PORT}`); });