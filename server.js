// --- DropIn Secure Messaging + Theatre Server ---

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

// --- Main Connection Handler ---
const theatreRooms = {}; // Theatre state tracking

io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    // Store username and sessionId from connection query
    const { username, sessionId, dropID } = socket.handshake.query;
    socket.username = username;
    socket.sessionId = sessionId;
    socket.dropID = dropID;

    console.log(`Handshake Info -> Username: ${username}, Session: ${sessionId}`);

    // --- DropIn Chat Room Functions ---
    socket.on('join_chat_room', (data) => {
        const { room, user } = data;
        socket.join(room);
        socket.roomId = room;
        socket.username = user;
        console.log(`User ${user} (${socket.id}) joined room ${room}`);

        // Notify existing users
        socket.to(room).emit('user_joined_chat', { user, socketId: socket.id });

        // Send list of already connected users
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
        console.log(`Message from ${username} in session ${session}: ${message}`);
        socket.to(session).emit('chat_message', {
            username,
            message,
            senderSocketId: socket.id
        });
    });

    socket.on('start_typing', (data) => {
        const { session, username } = data;
        socket.to(session).emit('user_started_typing', {
            username,
            socketId: socket.id
        });
    });

    socket.on('stop_typing', (data) => {
        const { session, username } = data;
        socket.to(session).emit('user_stopped_typing', {
            username,
            socketId: socket.id
        });
    });

    socket.on('disconnect', () => {
        if (socket.sessionId && socket.username) {
            console.log(`User ${socket.username} disconnected from session ${socket.sessionId}`);
            socket.to(socket.sessionId).emit('user_left_chat', {
                user: socket.username,
                socketId: socket.id
            });
        }

        // Handle Theatre Room disconnects
        if (socket.theatreRoomId && theatreRooms[socket.theatreRoomId]) {
            const room = theatreRooms[socket.theatreRoomId];
            room.viewers = room.viewers.filter(id => id !== socket.dropID);
            io.to(socket.theatreRoomId).emit('viewer_count_update', {
                count: room.viewers.length
            });
        }
    });

    // --- Short Link Redirects ---
    app.get('/c/:roomId', (req, res) => {
        res.redirect(`/v1.html#${req.params.roomId}`);
    });

    // --- Root Redirect ---
    app.get('/', (req, res) => {
        res.redirect('/v1.html');
    });

    // --- DropIn Theatre Functions ---
    socket.on('create_theatre_room', (data) => {
        const { roomId, videoUrl, hostUsername, scheduledStart, allowReplay } = data;
        theatreRooms[roomId] = {
            host: hostUsername,
            videoUrl,
            scheduledStart: scheduledStart || null,
            allowReplay: allowReplay || false,
            videoState: {
                isPlaying: false,
                currentTime: 0,
                lastUpdate: Date.now()
            },
            viewers: [],
            uniqueViewers: new Set()
        };
        socket.join(roomId);
        socket.theatreRoomId = roomId;
        console.log(`Theatre Room Created: ${roomId} by ${hostUsername}`);
        io.to(roomId).emit('theatre_room_created', { videoUrl, hostUsername, scheduledStart, allowReplay });
    });

    socket.on('join_theatre_room', (data) => {
        const { roomId } = data;
        socket.join(roomId);
        socket.theatreRoomId = roomId;

        if (theatreRooms[roomId]) {
            const room = theatreRooms[roomId];
            if (!room.viewers.includes(socket.dropID)) {
                room.viewers.push(socket.dropID);
            }
            room.uniqueViewers.add(socket.dropID);

            socket.emit('sync_video_state', { videoState: room.videoState });
            if (room.scheduledStart) {
                socket.emit('scheduled_start_info', { scheduledStart: room.scheduledStart });
            }

            io.to(roomId).emit('viewer_count_update', { count: room.viewers.length });
        }
    });

    socket.on('play_video', (data) => {
        const { roomId, currentTime } = data;
        if (theatreRooms[roomId]) {
            theatreRooms[roomId].videoState = { isPlaying: true, currentTime, lastUpdate: Date.now() };
            io.to(roomId).emit('play_video', { currentTime });
        }
    });

    socket.on('pause_video', (data) => {
        const { roomId, currentTime } = data;
        if (theatreRooms[roomId]) {
            theatreRooms[roomId].videoState = { isPlaying: false, currentTime, lastUpdate: Date.now() };
            io.to(roomId).emit('pause_video', { currentTime });
        }
    });

    socket.on('seek_video', (data) => {
        const { roomId, seekTime } = data;
        if (theatreRooms[roomId]) {
            theatreRooms[roomId].videoState.currentTime = seekTime;
            theatreRooms[roomId].videoState.lastUpdate = Date.now();
            io.to(roomId).emit('seek_video', { seekTime });
        }
    });

    socket.on('send_theatre_comment', (data) => {
        const { roomId, username, commentText } = data;
        io.to(roomId).emit('new_theatre_comment', { username, commentText });
    });

    socket.on('send_theatre_reaction', (data) => {
        const { roomId, emoji } = data;
        io.to(roomId).emit('new_theatre_reaction', { emoji });
    });

    socket.on('leave_theatre_room', (data) => {
        const { roomId } = data;
        socket.leave(roomId);
        if (theatreRooms[roomId]) {
            const room = theatreRooms[roomId];
            room.viewers = room.viewers.filter(id => id !== socket.dropID);
            io.to(roomId).emit('viewer_count_update', { count: room.viewers.length });
        }
    });
});

// --- Start the Server ---
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
