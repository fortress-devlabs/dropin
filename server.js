// --- server.js (UPDATED with Syntax Fixes) ---

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: '*',
    },
    // UPDATED: Added pingInterval and pingTimeout
    pingInterval: 20000, // Send ping every 20 seconds
    pingTimeout: 120000, // Wait up to 120 seconds (2 minutes) for pong
    // Keep large buffer size
    maxHttpBufferSize: 1e8 // 100 MB
});

app.use(express.static('public'));

// Express body limits
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: true, limit: '100mb' }));

// --- MAIN CONNECTION HANDLER ---
io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    // Store username and sessionId from connection query
    const { username, sessionId, dropID, isHost } = socket.handshake.query;
    socket.username = username;
    socket.sessionId = sessionId;

    console.log(`Handshake Info -> Username: ${username}, Session: ${sessionId}`);

    // --- DROPIN CHAT HANDLERS ---
    socket.on('join_chat_room', (data) => {
        const { room, user } = data;
        if (!room || !user) {
             console.error("Join attempt with invalid room or user:", data);
             return;
        }
        socket.join(room);
        socket.roomId = room;
        socket.username = user;
        console.log(`User ${user} (${socket.id}) joined chat room ${room}`);

        socket.to(room).emit('user_joined_chat', { user, socketId: socket.id });

        const clientsInRoom = Array.from(io.sockets.adapter.rooms.get(room) || []);
        const users = {};
        clientsInRoom.forEach(id => {
            const clientSocket = io.sockets.sockets.get(id);
             // Ensure clientSocket exists before accessing properties
             if (clientSocket) {
                 // Include others, but not self initially
                 if(clientSocket.id !== socket.id) {
                    users[clientSocket.id] = clientSocket.username || "Unknown";
                 }
             }
        });
        // Send list of *other* users to the newly joined user
        socket.emit('session_users', users);
    });

    socket.on('chat_message', (data) => {
        const { username, message, session } = data;
         if (!session || !username || message === undefined) {
             console.warn("Invalid chat message data received:", data);
             return;
         }
        console.log(`Message from ${username} (${socket.id}) in session ${session}: ${message}`);
        socket.to(session).emit('chat_message', {
            username,
            message,
            senderSocketId: socket.id
        });
    });

    socket.on('start_typing', (data) => {
        const { session, username } = data;
        if (session && username) {
            socket.to(session).emit('user_started_typing', {
                username,
                socketId: socket.id
            });
        }
    });

    socket.on('stop_typing', (data) => {
        const { session, username } = data;
        if (session && username) {
             socket.to(session).emit('user_stopped_typing', {
                username,
                socketId: socket.id
            });
        }
    });

    // VIDEO DROP Handler (Receives ArrayBuffer)
    socket.on('video_drop', (data) => {
        const { username, session, videoBuffer } = data;
        if (session && username && videoBuffer instanceof Buffer) {
            console.log(`Video Drop Buffer from ${username} (${socket.id}) in session ${session}, Size: ${videoBuffer.length} bytes`);
            socket.to(session).emit('video_drop', {
                username: username,
                videoBuffer: videoBuffer,
                senderSocketId: socket.id
            });
        } else {
             console.warn("Received incomplete/invalid video_drop data from:", socket.id, " Type of videoBuffer:", typeof videoBuffer);
        }
    });


    // --- DROPIN THEATRE HANDLERS ---
    const theatreRooms = {};

    socket.on('create_theatre_room', (data) => {
        const { roomId, videoUrl, hostUsername } = data;
        if (!roomId || !videoUrl) return;
        console.log(`Host ${hostUsername} (${socket.id}) creating theatre room: ${roomId}`);
        socket.join(roomId);
        socket.theatreRoomId = roomId;
        theatreRooms[roomId] = { hostSocketId: socket.id, videoUrl, viewers: new Set() };
        socket.emit('theatre_room_created', { roomId, videoUrl });
    });

    socket.on('join_theatre_room', (data) => {
        const { roomId, username } = data;
        if (!roomId || !theatreRooms[roomId]) return;
        console.log(`Viewer ${username} (${socket.id}) joining theatre room: ${roomId}`);
        socket.join(roomId);
        socket.theatreRoomId = roomId;
        theatreRooms[roomId].viewers.add(socket.id);
        socket.emit('theatre_room_created', { roomId, videoUrl: theatreRooms[roomId].videoUrl });
        updateTheatreViewerCount(roomId);
    });

    // Play/Pause/Seek
    socket.on('play_video', (data) => { const { roomId, currentTime } = data; if (validateHost(socket, roomId)) { socket.to(roomId).emit('play_video', { currentTime }); } });
    socket.on('pause_video', (data) => { const { roomId, currentTime } = data; if (validateHost(socket, roomId)) { socket.to(roomId).emit('pause_video', { currentTime }); } });
    socket.on('seek_video', (data) => { const { roomId, seekTime } = data; if (validateHost(socket, roomId)) { socket.to(roomId).emit('seek_video', { seekTime }); } });

    // Theatre Chat & Reactions
    socket.on('send_theatre_comment', (data) => { const { roomId, username, commentText } = data; if (roomId && username && commentText) { io.to(roomId).emit('new_theatre_comment', { username, commentText }); } });
    socket.on('send_theatre_reaction', (data) => { const { roomId, emoji } = data; if (roomId && emoji) { io.to(roomId).emit('new_theatre_reaction', { emoji }); } });

    // --- Disconnection Handling ---
    socket.on('disconnect', () => {
        console.log(`User disconnected: ${socket.id} (Username: ${socket.username}, Session: ${socket.sessionId}, TheatreRoom: ${socket.theatreRoomId})`);
        if (socket.sessionId && socket.username) {
            console.log(`Notifying session ${socket.sessionId} that ${socket.username} left`);
            socket.to(socket.sessionId).emit('user_left_chat', { user: socket.username, socketId: socket.id });
        }
        if (socket.theatreRoomId) {
            const roomId = socket.theatreRoomId;
            if (theatreRooms[roomId]) {
                if (socket.id === theatreRooms[roomId].hostSocketId) { console.log(`Host disconnected, closing theatre room: ${roomId}`); io.to(roomId).emit('theatre_room_closed'); delete theatreRooms[roomId]; }
                else { theatreRooms[roomId].viewers.delete(socket.id); updateTheatreViewerCount(roomId); }
            }
        }
    });

    // --- Utility Functions (Theatre Specific) ---
    function validateHost(socket, roomId) { return theatreRooms[roomId] && theatreRooms[roomId].hostSocketId === socket.id; }
    function updateTheatreViewerCount(roomId) { if (!theatreRooms[roomId]) return; const viewerCount = theatreRooms[roomId].viewers.size; io.to(roomId).emit('viewer_count_update', { count: viewerCount }); }
// Removed stray "Use code with caution." line here
}); // This closing brace matches io.on('connection', ...)

// --- Short Link Redirects & Root Redirect ---
// FIXED: Used backticks for template literal
app.get('/c/:roomId', (req, res) => { res.redirect(`/index.html?session=${encodeURIComponent(req.params.roomId)}`); });
app.get('/', (req, res) => { res.redirect('/index.html'); });

// --- Server Start ---
const PORT = process.env.PORT || 3000;
// FIXED: Used backticks for template literal in console.log
server.listen(PORT, () => { console.log(`Server running on port ${PORT}`); });