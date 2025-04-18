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
        // --- FIXED BACKTICKS ---
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
        // Send the offer *only* to the target user
        // console.log(`Relaying offer from ${socket.id} to ${data.targetId}`); // Optional log
        socket.to(data.targetId).emit('offer', {
            senderId: socket.id,
            offer: data.offer // Use data.offer as received from client
        });
    });

    socket.on('answer', (data) => {
        // Send the answer *only* to the target user (who sent the offer)
        // console.log(`Relaying answer from ${socket.id} to ${data.targetId}`); // Optional log
        socket.to(data.targetId).emit('answer', {
            senderId: socket.id,
            answer: data.answer // Use data.answer as received from client
        });
    });

    socket.on('ice_candidate', (data) => { // Renamed event to match client
        // Send the ICE candidate *only* to the target user
        // console.log(`Relaying ICE candidate from ${socket.id} to ${data.targetId}`); // Optional log
        socket.to(data.targetId).emit('ice_candidate', { // Renamed event to match client
            senderId: socket.id,
            candidate: data.candidate
        });
    });

    socket.on('disconnecting', () => { // Use 'disconnecting' to access rooms before leaving
        console.log(`User disconnecting: ${socket.id}`);
        // Notify others in the rooms the user was in
        socket.rooms.forEach(roomId => {
            if (roomId !== socket.id) { // Don't broadcast to the user's own default room
                socket.to(roomId).emit('user_left', socket.id);
                console.log(`Notified room ${roomId} that user ${socket.id} left`);
            }
        });
    });

    socket.on('disconnect', () => {
        console.log(`User disconnected event: ${socket.id}`);
        // No need to broadcast here, 'disconnecting' handles it better
    });
});

// --- Handle Short Links (Redirects)
app.get('/c/:roomId', (req, res) => {
    const roomId = req.params.roomId;
    res.redirect(`/#${roomId}`);
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Signaling server running on port ${PORT}`);
});
