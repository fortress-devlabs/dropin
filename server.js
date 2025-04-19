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

    // --- Join a Chat Room ---
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
            message
        });
    });

    // --- Handle User Disconnect ---
    socket.on('disconnect', () => {
        if (socket.roomId && socket.username) {
            console.log(`User ${socket.username} (${socket.id}) disconnected from ${socket.roomId}`);
            socket.to(socket.roomId).emit('user_left_chat', { user: socket.username, socketId: socket.id });
        }
    });

    // --- (Old StreamDrop compatibility) ---
    socket.on('join', (roomId) => {
        socket.join(roomId);
        console.log(`User ${socket.id} joined room ${roomId}`);
        const room = io.sockets.adapter.rooms.get(roomId);
        const otherUsers = room ? Array.from(room).filter(id => id !== socket.id) : [];
        socket.emit('existing_users', otherUsers);
        socket.to(roomId).emit('user_joined', socket.id);
    });

    socket.on('offer', (data) => {
        socket.to(data.targetId).emit('offer', { senderId: socket.id, offer: data.offer });
    });

    socket.on('answer', (data) => {
        socket.to(data.targetId).emit('answer', { senderId: socket.id, answer: data.answer });
    });

    socket.on('ice_candidate', (data) => {
        socket.to(data.targetId).emit('ice_candidate', { senderId: socket.id, candidate: data.candidate });
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
