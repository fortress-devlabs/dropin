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

io.on('connection', (socket) => {
    console.log('A user connected:', socket.id);

    socket.on('join', (roomId) => {
        socket.join(roomId);
        console.log(`User ${socket.id} joined room ${roomId}`);

        // Fetch existing users IN THE ROOM *before* adding the new user
        const room = io.sockets.adapter.rooms.get(roomId);
        const otherUsers = room ? Array.from(room).filter(id => id !== socket.id) : [];

        // Send the list of existing users to the newly joined user
        socket.emit('existing_users', otherUsers);

        // Notify existing users about the new user
        socket.to(roomId).emit('user_joined', socket.id);
    });

    socket.on('offer', (data) => {
        socket.to(data.targetId).emit('offer', {
            senderId: socket.id,
            offer: data.offer
        });
    });

    socket.on('answer', (data) => {
        socket.to(data.targetId).emit('answer', {
            senderId: socket.id,
            answer: data.answer
        });
    });

    socket.on('ice_candidate', (data) => {
        socket.to(data.targetId).emit('ice_candidate', {
            senderId: socket.id,
            candidate: data.candidate
        });
    });

    // --- 💬 ADD CHAT HANDLER ---
    socket.on('chat_message', (data) => {
        console.log(`Chat message from ${socket.id}:`, data);

        socket.rooms.forEach(roomId => {
            if (roomId !== socket.id) { // Skip personal room
                io.to(roomId).emit('chat_message', {
                    senderId: socket.id,
                    message: data.message
                });
            }
        });
    });

    socket.on('disconnecting', () => {
        console.log(`User disconnecting: ${socket.id}`);
        socket.rooms.forEach(roomId => {
            if (roomId !== socket.id) {
                socket.to(roomId).emit('user_left', socket.id);
                console.log(`Notified room ${roomId} that user ${socket.id} left`);
            }
        });
    });

    socket.on('disconnect', () => {
        console.log(`User disconnected event: ${socket.id}`);
        // No extra logic needed here
    });
});

// --- Handle Short Links (Redirects)
app.get('/c/:roomId', (req, res) => {
    const roomId = req.params.roomId;
    res.redirect(`/v1.html#${roomId}`);
});

// --- Root Redirect to v1.html
app.get('/', (req, res) => {
    res.redirect('/v1.html');
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Signaling server running on port ${PORT}`);
});
