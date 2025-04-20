// server.js

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

// --- MAIN CONNECTION HANDLER ---
io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    // Store username and sessionId from connection query
    const { username, sessionId } = socket.handshake.query;
    socket.username = username;
    socket.sessionId = sessionId;

    console.log(`Handshake Info -> Username: ${username}, Session: ${sessionId}`);

    // --- Join a Chat Room (DropIt) ---
    socket.on('join_chat_room', (data) => {
        const { room, user } = data;
        socket.join(room);
        socket.roomId = room;
        socket.username = user;
        console.log(`User ${user} (${socket.id}) joined room ${room}`);

        // Notify existing users someone joined
        socket.to(room).emit('user_joined_chat', { user, socketId: socket.id });

        // Send the new user the list of already connected users
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

    // --- Handle Chat Messages ---
    socket.on('chat_message', (data) => {
        const { username, message, session } = data;
        console.log(`Message from ${username} (${socket.id}) in session ${session}: ${message}`);
        socket.to(session).emit('chat_message', {
            username,
            message,
            senderSocketId: socket.id
        });
    });

    // --- Typing Indicators ---
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

    // --- Handle Disconnects ---
    socket.on('disconnect', () => {
        if (socket.sessionId && socket.username) {
            console.log(`User ${socket.username} (${socket.id}) disconnected from session ${socket.sessionId}`);
            socket.to(socket.sessionId).emit('user_left_chat', {
                user: socket.username,
                socketId: socket.id
            });
        }
    });
});

// --- Short Link Redirects ---
app.get('/c/:roomId', (req, res) => {
    res.redirect(`/v1.html#${req.params.roomId}`);
});

// --- Root Redirect ---
app.get('/', (req, res) => {
    res.redirect('/v1.html');
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
