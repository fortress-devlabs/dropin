// --- server.js (UPDATED with maxHttpBufferSize & Express limits) ---

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: '*',
    },
    // Increase maxHttpBufferSize if needed for larger base64 video data
    maxHttpBufferSize: 1e8 // 100 MB (example, adjust as needed) // <-- UNCOMMENTED
});

app.use(express.static('public'));

// --- ADDED Express body limits (Optional but Recommended) ---
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: true, limit: '100mb' }));
// ----------------------------------------------------------

// --- MAIN CONNECTION HANDLER ---
io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    // Store username and sessionId from connection query
    const { username, sessionId, dropID, isHost } = socket.handshake.query;
    socket.username = username; // Assign username to socket object
    socket.sessionId = sessionId; // Assign sessionId to socket object
    // Note: dropID and isHost relate to Theatre, not used in core chat logic here

    console.log(`Handshake Info -> Username: ${username}, Session: ${sessionId}`);

    // --- DROPIN CHAT HANDLERS (Main Chat Functionality) ---
    socket.on('join_chat_room', (data) => {
        const { room, user } = data;
        if (!room || !user) {
             console.error("Join attempt with invalid room or user:", data);
             return;
        }
        socket.join(room);
        socket.roomId = room; // Use roomId consistently for the joined room/session
        socket.username = user; // Ensure username is set from join event too
        console.log(`User ${user} (${socket.id}) joined chat room ${room}`);

        // Notify others in the room about the new user
        socket.to(room).emit('user_joined_chat', { user, socketId: socket.id });

        // Send the list of current users to the newly joined user
        const clientsInRoom = Array.from(io.sockets.adapter.rooms.get(room) || []);
        const users = {};
        clientsInRoom.forEach(id => {
            const clientSocket = io.sockets.sockets.get(id);
            if (clientSocket && clientSocket.id !== socket.id) { // Don't include self in initial list
                users[clientSocket.id] = clientSocket.username || "Unknown";
            }
        });
        // Also include self, marked differently if needed, or handle on client
        users[socket.id] = socket.username; // Include self so client knows its own ID too if needed
        socket.emit('session_users', users);
    });

    socket.on('chat_message', (data) => {
        const { username, message, session } = data;
         if (!session || !username || message === undefined) {
             console.warn("Invalid chat message data received:", data);
             return;
         }
        console.log(`Message from ${username} (${socket.id}) in session ${session}: ${message}`);
        // Broadcast to everyone else in the session room
        socket.to(session).emit('chat_message', {
            username,
            message,
            senderSocketId: socket.id // Important: Send sender's socket ID
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

    // 🔥 **VIDEO DROP Handler (Relies on increased maxHttpBufferSize)** 🔥
    socket.on('video_drop', (data) => {
        const { username, session, videoData } = data;
        if (session && username && videoData) {
            console.log(`Video Drop from ${username} (${socket.id}) in session ${session}`);
            // Broadcast the video drop to others in the session
            socket.to(session).emit('video_drop', {
                username: username,
                videoData: videoData, // The Base64 encoded video string
                senderSocketId: socket.id // Send sender's ID for client-side handling
            });
        } else {
             console.warn("Received incomplete video_drop data from:", socket.id, " Data:", { username, session, videoData: videoData ? '[received]' : '[missing]' });
        }
    });


    // --- DROPIN THEATRE HANDLERS (Separate Feature) ---
    // Note: These are kept separate for clarity, ensure roomId doesn't clash with session
    const theatreRooms = {}; // Simplified tracking for Theatre

    socket.on('create_theatre_room', (data) => {
        const { roomId, videoUrl, hostUsername } = data;
        if (!roomId || !videoUrl) return;
        console.log(`Host ${hostUsername} (${socket.id}) creating theatre room: ${roomId}`);
        socket.join(roomId);
        socket.theatreRoomId = roomId; // Use a distinct property for theatre room
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

    // Play/Pause/Seek (HOST ONLY for Theatre)
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

    // Theatre Chat & Reactions
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


    // --- Disconnection Handling ---
    socket.on('disconnect', () => {
        console.log(`User disconnected: ${socket.id} (Username: ${socket.username}, Session: ${socket.sessionId}, TheatreRoom: ${socket.theatreRoomId})`);

        // Handle Chat Disconnect
        if (socket.sessionId && socket.username) {
            console.log(`Notifying session ${socket.sessionId} that ${socket.username} left`);
            socket.to(socket.sessionId).emit('user_left_chat', {
                user: socket.username, // Use username for consistency
                socketId: socket.id
            });
        }

        // Handle Theatre Disconnect
        if (socket.theatreRoomId) {
            const roomId = socket.theatreRoomId;
            if (theatreRooms[roomId]) {
                if (socket.id === theatreRooms[roomId].hostSocketId) {
                    console.log(`Host disconnected, closing theatre room: ${roomId}`);
                    io.to(roomId).emit('theatre_room_closed');
                    delete theatreRooms[roomId];
                } else {
                    theatreRooms[roomId].viewers.delete(socket.id);
                    updateTheatreViewerCount(roomId);
                }
            }
        }
    });

    // --- Utility Functions (Theatre Specific) ---
    function validateHost(socket, roomId) {
        return theatreRooms[roomId] && theatreRooms[roomId].hostSocketId === socket.id;
    }
    function updateTheatreViewerCount(roomId) {
        if (!theatreRooms[roomId]) return;
        const viewerCount = theatreRooms[roomId].viewers.size;
        io.to(roomId).emit('viewer_count_update', { count: viewerCount });
    }
});

// --- Short Link Redirects (Example) ---
app.get('/c/:roomId', (req, res) => {
    // Redirects short link /c/sessionName to the setup page, prefilling session?
    // Or directly to dropit.html if username is somehow known/stored?
    // For now, let's redirect to setup, maybe prefill later.
    res.redirect(`/index.html?session=${encodeURIComponent(req.params.roomId)}`);
});

// --- Root Redirect ---
app.get('/', (req, res) => {
    res.redirect('/index.html'); // Redirect root to the setup page
});

// --- Server Start ---
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});