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

// Track sessions: sessionId => [ { socketId, username } ]
const sessions = new Map();

io.on('connection', (socket) => {
    console.log('A user connected:', socket.id);

    // --- JOIN SESSION (DropIt) ---
    socket.on('join_session', (data) => {
        const { sessionId, username } = data;
        console.log(`User ${username} (${socket.id}) is joining session ${sessionId}`);

        if (!sessions.has(sessionId)) {
            sessions.set(sessionId, []);
        }
        sessions.get(sessionId).push({ socketId: socket.id, username });

        // Save sessionId on socket object to know later
        socket.sessionId = sessionId;
        socket.username = username;

        const usersInSession = sessions.get(sessionId);

        if (usersInSession.length === 2) {
            // Notify both users about each other
            const [user1, user2] = usersInSession;

            io.to(user1.socketId).emit('partner_joined', {
                username: user2.username,
                socketId: user2.socketId
            });

            io.to(user2.socketId).emit('partner_joined', {
                username: user1.username,
                socketId: user1.socketId
            });

            console.log(`Session ${sessionId}: Paired ${user1.username} <-> ${user2.username}`);
        }
    });

    // --- RELAY PRIVATE MESSAGE ---
    socket.on('private_message', (data) => {
        const { recipientSocketId, message } = data;
        console.log(`Private message from ${socket.id} to ${recipientSocketId}:`, message);

        io.to(recipientSocketId).emit('private_message', {
            senderUsername: socket.username,
            senderSocketId: socket.id,
            message
        });
    });

    // --- Handle Disconnects ---
    socket.on('disconnect', () => {
        console.log('User disconnected:', socket.id);

        const sessionId = socket.sessionId;

        if (sessionId && sessions.has(sessionId)) {
            const users = sessions.get(sessionId).filter(user => user.socketId !== socket.id);

            if (users.length === 0) {
                sessions.delete(sessionId);
            } else {
                sessions.set(sessionId, users);
                const remainingUser = users[0];

                io.to(remainingUser.socketId).emit('partner_left');
                console.log(`Notified ${remainingUser.username} that their partner left.`);
            }
        }
    });

    // --- Existing DropIn Room Logic (for StreamDrop etc) ---
    socket.on('join', (roomId) => {
        socket.join(roomId);
        console.log(`User ${socket.id} joined room ${roomId}`);

        const room = io.sockets.adapter.rooms.get(roomId);
        const otherUsers = room ? Array.from(room).filter(id => id !== socket.id) : [];

        socket.emit('existing_users', otherUsers);
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

    socket.on('chat_message', (data) => {
        console.log(`Chat message from ${socket.id}:`, data);

        socket.rooms.forEach(roomId => {
            if (roomId !== socket.id) {
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
