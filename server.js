// --- server.js ---

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: '*',
    }
});

app.use(express.static('public'));

// --- GLOBAL Room Data Tracking ---
const theatreRooms = {}; // <- THIS IS NOW OUTSIDE connection handler (important!)

io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    // Store username and sessionId from connection query
    const { username, sessionId, dropID, isHost } = socket.handshake.query;
    socket.username = username;
    socket.sessionId = sessionId;
    socket.dropID = dropID;
    socket.isHost = isHost === "true";

    console.log(`Handshake Info -> Username: ${username}, Session: ${sessionId}, DropID: ${dropID}, Host: ${socket.isHost}`);

    // --- DROPIN CHAT HANDLERS ---
    socket.on('join_chat_room', (data) => {
        const { room, user } = data;
        socket.join(room);
        socket.roomId = room;
        socket.username = user;
        console.log(`User ${user} (${socket.id}) joined chat room ${room}`);

        socket.to(room).emit('user_joined_chat', { user, socketId: socket.id });

        const clientsInRoom = Array.from(io.sockets.adapter.rooms.get(room) || []);
        const users = {};
        clientsInRoom.forEach(id => {
            const clientSocket = io.sockets.sockets.get(id);
            if (clientSocket) {
                users[clientSocket.id] = clientSocket.username || "Unknown";
            }
        });
        socket.emit('session_users', users);
    });

    socket.on('chat_message', (data) => {
        const { username, message, session } = data;
        console.log(`Message from ${username} (${socket.id}) in session ${session}: ${message}`);
        socket.to(session).emit('chat_message', {
            username,
            message,
            senderSocketId: socket.id
        });
    });

    socket.on('start_typing', (data) => {
        const { session, username } = data;
        socket.to(session).emit('user_started_typing', { username, socketId: socket.id });
    });

    socket.on('stop_typing', (data) => {
        const { session, username } = data;
        socket.to(session).emit('user_stopped_typing', { username, socketId: socket.id });
    });

    // --- DROPIN THEATRE HANDLERS ---

    socket.on('create_theatre_room', (data) => {
        const { roomId, videoUrl, hostUsername } = data;
        if (!roomId || !videoUrl) {
            console.error("Invalid room creation attempt.");
            return;
        }

        console.log(`Host ${hostUsername} (${socket.id}) creating theatre room: ${roomId}`);

        socket.join(roomId);
        socket.roomId = roomId;

        theatreRooms[roomId] = {
            hostSocketId: socket.id,
            hostUsername,
            videoUrl,
            viewers: new Set()
        };

        io.to(roomId).emit('theatre_room_created', { videoUrl }); // Broadcast to room
    });

    socket.on('join_theatre_room', (data) => {
        const { roomId, username } = data;
        if (!roomId || !theatreRooms[roomId]) {
            console.error(`Viewer ${username} tried to join nonexistent theatre room: ${roomId}`);
            socket.emit('theatre_room_closed');
            return;
        }

        console.log(`Viewer ${username} (${socket.id}) joining theatre room: ${roomId}`);
        socket.join(roomId);
        socket.roomId = roomId;

        theatreRooms[roomId].viewers.add(socket.id);

        // Send initial theatre info directly to new viewer
        socket.emit('theatre_room_created', {
            videoUrl: theatreRooms[roomId].videoUrl
        });

        updateTheatreViewerCount(roomId);
    });

    socket.on('play_video', (data) => {
        const { roomId, currentTime } = data;
        if (validateHost(socket, roomId)) {
            socket.to(roomId).emit('play_video', { currentTime });
        }
    });

    socket.on('pause_video', (data) => {
        const { roomId, currentTime } = data;
        if (validateHost(socket, roomId)) {
            socket.to(roomId).emit('pause_video', { currentTime });
        }
    });

    socket.on('seek_video', (data) => {
        const { roomId, seekTime } = data;
        if (validateHost(socket, roomId)) {
            socket.to(roomId).emit('seek_video', { seekTime });
        }
    });

    socket.on('send_theatre_comment', (data) => {
        const { roomId, username, commentText } = data;
        if (roomId && username && commentText) {
            io.to(roomId).emit('new_theatre_comment', { username, commentText });
        }
    });

    socket.on('send_theatre_reaction', (data) => {
        const { roomId, emoji } = data;
        if (roomId && emoji) {
            io.to(roomId).emit('new_theatre_reaction', { emoji });
        }
    });

    socket.on('disconnect', () => {
        console.log(`User disconnected: ${socket.id}`);

        if (socket.roomId) {
            const roomId = socket.roomId;

            if (theatreRooms[roomId]) {
                theatreRooms[roomId].viewers.delete(socket.id);

                if (socket.id === theatreRooms[roomId].hostSocketId) {
                    console.log(`Host disconnected, closing theatre room: ${roomId}`);
                    io.to(roomId).emit('theatre_room_closed');
                    delete theatreRooms[roomId];
                } else {
                    updateTheatreViewerCount(roomId);
                }
            }

            if (socket.sessionId && socket.username) {
                socket.to(socket.sessionId).emit('user_left_chat', {
                    user: socket.username,
                    socketId: socket.id
                });
            }
        }
    });

    // --- Utility Functions ---
    function validateHost(socket, roomId) {
        if (!theatreRooms[roomId]) {
            console.error("Theatre room does not exist.");
            return false;
        }
        if (theatreRooms[roomId].hostSocketId !== socket.id) {
            console.error("Only Host can control video.");
            return false;
        }
        return true;
    }

    function updateTheatreViewerCount(roomId) {
        if (!theatreRooms[roomId]) return;
        const viewerCount = theatreRooms[roomId].viewers.size;
        io.to(roomId).emit('viewer_count_update', { count: viewerCount });
    }
});

// --- Redirects ---
app.get('/c/:roomId', (req, res) => {
    res.redirect(`/v1.html#${req.params.roomId}`);
});

app.get('/', (req, res) => {
    res.redirect('/v1.html');
});

// --- Start Server ---
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
