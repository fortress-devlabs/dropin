// Filename: dropin_frontend.js

// --- Constants ---
const SIGNALING_SERVER_URL = 'http://localhost:3000'; // Replace with actual server URL
const ICE_SERVERS = [ // Example using Google's public STUN servers
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
];

// --- DOM Elements ---
let videoGrid, localVideo, micBtn, camBtn, leaveBtn, initialOverlay, loadingIndicator, permissionPrompt, grantPermissionBtn, permissionError, endedMessage; // Get references in init()

// --- State Variables ---
let localStream = null;
let socket = null;
let roomId = null;
let peerConnections = {}; // Store RTCPeerConnection objects, keyed by socket ID of the peer
let isMicOn = true;
let isCamOn = true;

// --- Core Functions ---

// 1. Initialization (Called on DOMContentLoaded)
function init() {
    console.log("DropIn Initializing...");
    // Get DOM elements
    videoGrid = document.getElementById('video-grid');
    micBtn = document.getElementById('mic-btn');
    camBtn = document.getElementById('cam-btn');
    leaveBtn = document.getElementById('leave-btn');
    initialOverlay = document.getElementById('initial-overlay');
    loadingIndicator = document.getElementById('loading-indicator');
    permissionPrompt = document.getElementById('permission-prompt');
    grantPermissionBtn = document.getElementById('grant-permission-btn');
    permissionError = document.getElementById('permission-error');
    endedMessage = document.getElementById('ended-message');

    // Add event listeners for buttons (Ensure buttons exist before adding listeners)
    if (micBtn) micBtn.addEventListener('click', toggleMic);
    if (camBtn) camBtn.addEventListener('click', toggleCam);
    if (leaveBtn) leaveBtn.addEventListener('click', leaveMeeting);
    if (grantPermissionBtn) grantPermissionBtn.addEventListener('click', handlePermissionGrant);

    // Ensure buttons start disabled visually (matching HTML)
    if (micBtn) micBtn.disabled = true;
    if (camBtn) camBtn.disabled = true;
    if (leaveBtn) leaveBtn.disabled = true;


    // Determine Room ID (e.g., from URL hash or generate)
    roomId = window.location.hash.substring(1) || generateRandomRoomId();
    if (!window.location.hash) {
        window.location.hash = roomId; // Add generated room ID to URL for sharing
    }
    document.title = `DropIn - ${roomId}`; // Update tab title

    // Start the process
    requestMediaPermissions();
}

// 2. Request Media Permissions
function requestMediaPermissions() {
    loadingIndicator.style.display = 'none';
    permissionPrompt.style.display = 'block';
    permissionError.style.display = 'none';
    endedMessage.style.display = 'none'; // Ensure ended message is hidden
     // Buttons remain disabled until permission granted
}

// 3. Handle Permission Grant Button Click
async function handlePermissionGrant() {
    permissionPrompt.style.display = 'none';
    loadingIndicator.style.display = 'block'; // Show loading again
    initialOverlay.style.display = 'block'; // Ensure overlay is visible
    permissionError.style.display = 'none'; // Hide previous errors

    try {
        localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
        console.log("Media permissions granted.");
        displayLocalVideo();
        updateButtonStates(); // Initial state based on defaults (usually on)

        // *** ENABLE BUTTONS HERE ***
        if (micBtn) micBtn.disabled = false;
        if (camBtn) camBtn.disabled = false;
        if (leaveBtn) leaveBtn.disabled = false;

        connectToSignalingServer(); // Connect *after* getting stream and enabling controls
        initialOverlay.style.display = 'none'; // Hide overlay after successful setup

    } catch (err) {
        console.error("getUserMedia error:", err);
        loadingIndicator.style.display = 'none';
        permissionPrompt.style.display = 'block'; // Show prompt again
        permissionError.textContent = `Error: ${err.name}. Check browser/OS permissions. Refresh required.`;
        permissionError.style.display = 'block';
        // Keep buttons disabled if permission fails
        if (micBtn) micBtn.disabled = true;
        if (camBtn) camBtn.disabled = true;
        if (leaveBtn) leaveBtn.disabled = true;
    }
}

// 4. Display Local Video
function displayLocalVideo() {
    if (!localStream || !videoGrid) return;
    // Remove existing local video container if it exists
    const existingContainer = document.getElementById('video-container-local');
    if (existingContainer) existingContainer.remove();

    const videoContainer = createVideoContainer('local');
    localVideo = document.createElement('video');
    localVideo.id = 'local-video';
    localVideo.srcObject = localStream;
    localVideo.autoplay = true;
    localVideo.playsInline = true;
    localVideo.muted = true; // IMPORTANT: Mute local video to prevent echo
    localVideo.style.transform = 'scaleX(-1)'; // Mirror effect
    videoContainer.appendChild(localVideo);
    videoGrid.appendChild(videoContainer); // Add to grid
    updateGridLayout();
    updateButtonStates(); // Ensure button state reflects stream state
}

// 5. Connect to Signaling Server
function connectToSignalingServer() {
    console.log(`Connecting to signaling server for room: ${roomId}`);
    // Ensure no duplicate connection if already connected
    if (socket && socket.connected) {
        console.warn("Already connected to signaling server.");
        return;
    }
    socket = io(SIGNALING_SERVER_URL);

    socket.on('connect', () => {
        console.log("Connected to signaling server with ID:", socket.id);
        socket.emit('join', roomId); // Tell server which room we want
        // Ensure controls are enabled on successful connect (might be redundant but safe)
        if (micBtn) micBtn.disabled = false;
        if (camBtn) camBtn.disabled = false;
        if (leaveBtn) leaveBtn.disabled = false;
    });

    socket.on('disconnect', (reason) => {
        console.log("Disconnected from signaling server. Reason:", reason);
        // Only trigger full leave if not initiated by user clicking leave button
        if (reason !== 'io client disconnect') {
             updateStatusMessage("Disconnected. Please refresh to rejoin.", true);
             leaveMeeting(false); // Trigger cleanup, but don't disconnect socket again
        }
    });

    // Receive list of users already in the room
    socket.on('existing_users', (users) => {
        console.log("Existing users in room:", users);
        users.forEach(peerSocketId => {
            if (peerSocketId !== socket.id) { // Ensure not connecting to self
                connectToPeer(peerSocketId, true); // Initiate connection to existing users
            }
        });
    });

    // A new user joins *after* you
    socket.on('user_joined', (peerSocketId) => {
        console.log(`User ${peerSocketId} joined the room. Waiting for their offer.`);
        // The new user (non-initiator) will typically wait for the offer from existing users.
        // If you wanted the *existing* user to initiate TO the new user, you'd call connectToPeer here.
        // connectToPeer(peerSocketId, true); // Example: if existing user should always initiate
    });

    socket.on('user_left', (peerSocketId) => {
        console.log(`User ${peerSocketId} left the room.`);
        handlePeerDisconnect(peerSocketId);
    });

    socket.on('offer', (data) => {
        console.log(`Received offer from ${data.senderId}`);
        handleOffer(data.senderId, data.offer);
    });

    socket.on('answer', (data) => {
        console.log(`Received answer from ${data.senderId}`);
        handleAnswer(data.senderId, data.answer);
    });

    socket.on('ice_candidate', (data) => { // Event name should match server emission
        // console.log(`Received ICE candidate from ${data.senderId}`); // Verbose
        handleIceCandidate(data.senderId, data.candidate);
    });

    socket.on('connect_error', (err) => {
        console.error("Signaling connection error:", err);
        updateStatusMessage(`Connection Error: ${err.message}. Please refresh.`, true);
        // Disable controls on connection error
        if (micBtn) micBtn.disabled = true;
        if (camBtn) camBtn.disabled = true;
        if (leaveBtn) leaveBtn.disabled = true;
        // Show overlay with error message
        initialOverlay.style.display = 'block';
        loadingIndicator.style.display = 'none';
        permissionPrompt.style.display = 'none';
        endedMessage.textContent = `Connection Error: ${err.message}`;
        endedMessage.style.display = 'block';
    });
}

// 6. WebRTC Peer Connection Handling
function createPeerConnection(peerSocketId) {
    console.log(`Creating peer connection for ${peerSocketId}`);

    if (peerConnections[peerSocketId]) {
        console.warn(`Peer connection for ${peerSocketId} already exists or is being created. State: ${peerConnections[peerSocketId].connectionState}`);
        // Optionally clean up old one if in a bad state, e.g., 'failed'
        if (peerConnections[peerSocketId].connectionState === 'failed') {
            handlePeerDisconnect(peerSocketId); // Clean up failed connection first
        } else {
             return peerConnections[peerSocketId]; // Return existing one if it's not failed
        }
    }

    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    peerConnections[peerSocketId] = pc; // Store immediately

    pc.onicecandidate = (event) => {
        if (event.candidate && socket && socket.connected) { // Check socket connection
            // console.log(`Sending ICE candidate to ${peerSocketId}`); // Verbose
            socket.emit('ice_candidate', {
                targetId: peerSocketId,
                candidate: event.candidate,
            });
        }
    };

    pc.ontrack = (event) => {
        console.log(`Received remote track from ${peerSocketId}, Streams:`, event.streams);
        if (event.streams && event.streams[0]) {
             displayRemoteVideo(peerSocketId, event.streams[0]);
        } else {
             // Handle case where track is added without a stream (less common)
             // Maybe create a new stream and add the track? For now, log.
             console.warn(`Received track from ${peerSocketId} but no associated stream.`);
        }
    };

    if (localStream) {
        localStream.getTracks().forEach(track => {
            try {
                pc.addTrack(track, localStream);
            } catch (err) {
                console.error(`Error adding track for ${peerSocketId}:`, err);
            }
        });
        console.log(`Added local tracks to PC for ${peerSocketId}`);
    } else {
        console.warn("Local stream not available when creating peer connection for", peerSocketId);
    }

    pc.onconnectionstatechange = () => {
        console.log(`Connection state with ${peerSocketId}: ${pc.connectionState}`);
        if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected' || pc.connectionState === 'closed') {
             // Use a small delay for 'disconnected' in case it's temporary network fluctuation
             if (pc.connectionState === 'disconnected') {
                setTimeout(() => {
                    // Re-check state after delay
                    if (pc.connectionState === 'disconnected') {
                         console.warn(`Peer ${peerSocketId} remained disconnected. Cleaning up.`);
                         handlePeerDisconnect(peerSocketId);
                    }
                }, 3000); // 3 second delay
             } else {
                // Clean up immediately for 'failed' or 'closed'
                handlePeerDisconnect(peerSocketId);
             }
        }
         // Could update UI indicator for peer connection status here
    };

     pc.oniceconnectionstatechange = () => {
        console.log(`ICE connection state with ${peerSocketId}: ${pc.iceConnectionState}`);
        if (pc.iceConnectionState === 'failed') {
             console.warn(`ICE connection failed for ${peerSocketId}. Consider ICE restart.`);
             // pc.restartIce(); // Optional: Attempt ICE restart
        }
    };

    pc.onsignalingstatechange = () => {
         console.log(`Signaling state with ${peerSocketId}: ${pc.signalingState}`);
    };

    return pc;
}

// Initiates connection TO a peer (either existing or newly joined)
async function connectToPeer(peerSocketId, isInitiator) {
     // Prevent connecting if already connected or connection is in progress
    if (peerConnections[peerSocketId] &&
       (peerConnections[peerSocketId].connectionState === 'connected' ||
        peerConnections[peerSocketId].connectionState === 'connecting')) {
        console.log(`Already connected or connecting to ${peerSocketId}. State: ${peerConnections[peerSocketId].connectionState}. Skipping.`);
        return;
    }

    console.log(`Attempting to connect to peer: ${peerSocketId}, Initiator: ${isInitiator}`);
    const pc = createPeerConnection(peerSocketId); // Ensure PC is created

    if (isInitiator) {
        // Only create offer if state is stable
        if (pc.signalingState !== 'stable') {
             console.warn(`Cannot create offer for ${peerSocketId}. Signaling state is ${pc.signalingState}. Waiting for stable.`);
             // Consider setting a flag or using a more robust state machine
             // For now, we just don't proceed with the offer. The other side might initiate.
             return;
        }
        try {
            console.log(`Creating offer for ${peerSocketId}...`);
            const offer = await pc.createOffer();
            // Check state *again* before setting local description
            if (pc.signalingState !== 'stable') {
                console.warn(`Signaling state changed to ${pc.signalingState} before setting local offer for ${peerSocketId}. Aborting offer.`);
                return;
            }
            await pc.setLocalDescription(offer);
            console.log(`Sending offer to ${peerSocketId}`);
            if (socket && socket.connected) {
                socket.emit('offer', {
                    targetId: peerSocketId,
                    offer: pc.localDescription,
                });
            } else {
                 console.error("Socket not connected, cannot send offer.");
                 handlePeerDisconnect(peerSocketId); // Clean up attempt
            }
        } catch (err) {
            console.error(`Error creating offer for ${peerSocketId}:`, err);
            handlePeerDisconnect(peerSocketId); // Clean up failed attempt
        }
    } else {
         console.log(`Waiting for offer from ${peerSocketId}`);
    }
}

// Handles an INCOMING offer FROM another peer
async function handleOffer(senderId, offer) {
    console.log(`Handling offer from ${senderId}`);
    const pc = createPeerConnection(senderId); // Get or create PC

    // Check if we are expecting an offer (state should be stable or have-local-offer if polite peer)
    // Or if we are initiating (state should be stable)
    // 'have-remote-offer' means we already got one - potential glare
    if (pc.signalingState !== 'stable' && pc.signalingState !== 'have-local-offer') {
        console.warn(`Received offer from ${senderId}, but signaling state is ${pc.signalingState}. Potential glare or unexpected state. Ignoring offer for now.`);
        // More complex glare handling might be needed for robustness
        return;
    }

    try {
        await pc.setRemoteDescription(new RTCSessionDescription(offer));
        console.log(`Set remote description for offer from ${senderId}`);

        // Now create answer
        // Check state before creating answer
        if (pc.signalingState !== 'have-remote-offer') {
             console.warn(`Signaling state is ${pc.signalingState} (expected have-remote-offer) for ${senderId} before creating answer. Aborting.`);
             return;
        }
        const answer = await pc.createAnswer();
        // Check state before setting local description
        if (pc.signalingState !== 'have-remote-offer') {
             console.warn(`Signaling state changed to ${pc.signalingState} before setting local answer for ${senderId}. Aborting answer.`);
             return;
        }
        await pc.setLocalDescription(answer);
        console.log(`Sending answer to ${senderId}`);
        if (socket && socket.connected) {
            socket.emit('answer', {
                targetId: senderId,
                answer: pc.localDescription,
            });
        } else {
            console.error("Socket not connected, cannot send answer.");
            handlePeerDisconnect(senderId); // Clean up attempt
        }
    } catch (err) {
        console.error(`Error handling offer from ${senderId}:`, err);
        handlePeerDisconnect(senderId); // Clean up failed attempt
    }
}

// Handles an INCOMING answer FROM a peer you sent an offer TO
async function handleAnswer(senderId, answer) {
    console.log(`Handling answer from ${senderId}`);
    const pc = peerConnections[senderId];
    if (pc) {
        // Check state before setting remote description
        if (pc.signalingState !== 'have-local-offer') {
            console.warn(`Received answer from ${senderId}, but signaling state is ${pc.signalingState} (expected 'have-local-offer'). Ignoring.`);
            return;
        }
        try {
            await pc.setRemoteDescription(new RTCSessionDescription(answer));
            console.log(`Set remote description for answer from ${senderId}. Connection should establish.`);
        } catch (err) {
            console.error(`Error handling answer from ${senderId}:`, err);
            handlePeerDisconnect(senderId); // Clean up on error
        }
    } else {
        console.warn(`No peer connection found for answer from ${senderId}`);
    }
}

// Handles an INCOMING ICE candidate FROM a peer
async function handleIceCandidate(senderId, candidate) {
    const pc = peerConnections[senderId];
    if (pc && candidate) {
        try {
            // Queue candidates if remote description isn't set yet
            // addIceCandidate handles this internally, but logging helps understand flow.
            if (!pc.remoteDescription) {
                 console.log(`Queueing ICE candidate from ${senderId} as remote description is not yet set.`);
            }
            await pc.addIceCandidate(new RTCIceCandidate(candidate));
            // console.log(`Added ICE candidate from ${senderId}`); // Verbose
        } catch (err) {
            // Ignore benign errors
            if (!err.message.includes("Cannot add ICE candidate") && !err.message.includes("Error processing ICE candidate")) {
                 console.error(`Error adding ICE candidate from ${senderId}:`, err);
            }
        }
    } else if (!pc) {
         console.warn(`No peer connection found for ICE candidate from ${senderId}`);
    }
}

// Handles cleanup when a peer disconnects or connection fails
function handlePeerDisconnect(peerSocketId) {
    const pc = peerConnections[peerSocketId];
    if (pc) {
        pc.close(); // Close the RTCPeerConnection
        delete peerConnections[peerSocketId]; // Remove from our state
        console.log(`Closed peer connection and cleaned up for ${peerSocketId}`);
        removeVideoContainer(peerSocketId); // Remove video element
        updateGridLayout(); // Adjust layout
    } else {
         // console.log(`Cleanup called for ${peerSocketId}, but no active peer connection found.`);
         // Ensure video container is removed even if PC object was somehow lost
         removeVideoContainer(peerSocketId);
         updateGridLayout();
    }
}

// 7. UI Manipulation
function createVideoContainer(idSuffix) {
    const container = document.createElement('div');
    container.className = 'video-container';
    container.id = `video-container-${idSuffix}`;
    // Add a simple label inside
    const label = document.createElement('span');
    label.className = 'participant-label';
    label.textContent = idSuffix === 'local' ? 'You' : `${idSuffix.substring(0, 6)}...`; // Shortened ID
    container.appendChild(label);
    return container;
}

function displayRemoteVideo(peerSocketId, stream) {
    if (!videoGrid) return;
    const containerId = `video-container-${peerSocketId}`;
    const videoId = `video-${peerSocketId}`;
    let videoContainer = document.getElementById(containerId);
    let video = document.getElementById(videoId);

    // If container doesn't exist, create it
    if (!videoContainer) {
        console.log(`Creating video container for ${peerSocketId}`);
        videoContainer = createVideoContainer(peerSocketId);
        videoGrid.appendChild(videoContainer);
    }

    // If video element doesn't exist, create it
    if (!video) {
        console.log(`Creating video element for ${peerSocketId}`);
        video = document.createElement('video');
        video.id = videoId;
        video.autoplay = true;
        video.playsInline = true; // Crucial for mobile iOS
        videoContainer.appendChild(video); // Add video to container
        video.addEventListener('loadedmetadata', () => {
             console.log(`Remote video metadata loaded for ${peerSocketId}`);
             video.play().catch(e => console.error(`Error playing remote video ${peerSocketId}:`, e));
        });
         // Ensure label is visible if video element is new
         const label = videoContainer.querySelector('.participant-label');
         if (label) label.style.display = '';

    }

    // Update stream if different or element was newly created
    if (video.srcObject !== stream) {
        console.log(`Setting stream for video element ${peerSocketId}`);
        video.srcObject = stream;
    }


    updateGridLayout();
}


function removeVideoContainer(peerSocketId) {
    const videoContainer = document.getElementById(`video-container-${peerSocketId}`);
    if (videoContainer) {
        console.log(`Removing video container for ${peerSocketId}`);
        // Stop any video playback inside
        const video = videoContainer.querySelector('video');
        if (video) {
            video.srcObject = null; // Release stream reference
        }
        videoContainer.remove();
        // No need to call updateGridLayout here, handled in handlePeerDisconnect
    }
}

function updateGridLayout() {
    if (!videoGrid) return;
    const count = videoGrid.childElementCount;
    // Apply CSS classes based on count to trigger grid changes
    videoGrid.className = 'video-grid'; // Reset classes
    if (count === 0) {
        // Handled by overlay usually
    } else if (count === 1) {
        videoGrid.classList.add('grid-1');
    } else if (count === 2) {
        videoGrid.classList.add('grid-2');
    } else if (count >= 3 && count <= 4) {
        videoGrid.classList.add('grid-4'); // Assumes 2x2
    } else if (count >= 5 && count <= 6) {
         videoGrid.classList.add('grid-6'); // Assumes 3x2
    } else if (count > 6) {
         videoGrid.classList.add('grid-many'); // Generic style for > 6
    }
}

// 8. Control Bar Actions
function toggleMic() {
    if (!localStream || !localStream.getAudioTracks().length > 0) {
        console.warn("Cannot toggle mic: No local audio track available.");
        return;
    }
    isMicOn = !isMicOn;
    localStream.getAudioTracks().forEach(track => track.enabled = isMicOn);
    updateButtonStates();
    console.log(`Microphone ${isMicOn ? 'ON' : 'OFF'}`);
}

function toggleCam() {
    if (!localStream || !localStream.getVideoTracks().length > 0) {
        console.warn("Cannot toggle camera: No local video track available.");
        return;
    }
    isCamOn = !isCamOn;
    localStream.getVideoTracks().forEach(track => track.enabled = isCamOn);
    updateButtonStates();
    console.log(`Camera ${isCamOn ? 'ON' : 'OFF'}`);

    // Show/hide local video element visually
    if (localVideo) {
        localVideo.style.visibility = isCamOn ? 'visible' : 'hidden';
        const localContainer = document.getElementById('video-container-local');
        if (localContainer) {
            localContainer.classList.toggle('video-off', !isCamOn);
            const label = localContainer.querySelector('.participant-label');
            if(label) label.style.display = isCamOn ? '' : 'block'; // Ensure label shows when video hidden
        }
    }
}

function updateButtonStates() {
    if (!micBtn || !camBtn) return; // Guard clauses

    // Mic Button
    if (localStream && localStream.getAudioTracks().length > 0) {
        micBtn.classList.toggle('active', isMicOn);
        micBtn.classList.toggle('inactive', !isMicOn);
        micBtn.querySelector('i').className = isMicOn ? 'fas fa-microphone' : 'fas fa-microphone-slash';
        micBtn.title = isMicOn ? 'Mute Microphone' : 'Unmute Microphone';
    } else {
        // Indicate mic not available if no audio track
        micBtn.classList.remove('active');
        micBtn.classList.add('inactive');
        micBtn.querySelector('i').className = 'fas fa-microphone-slash';
        micBtn.title = 'Microphone not available';
        micBtn.disabled = true; // Keep disabled if no track
    }

    // Cam Button
    if (localStream && localStream.getVideoTracks().length > 0) {
        camBtn.classList.toggle('active', isCamOn);
        camBtn.classList.toggle('inactive', !isCamOn);
        camBtn.querySelector('i').className = isCamOn ? 'fas fa-video' : 'fas fa-video-slash';
        camBtn.title = isCamOn ? 'Turn Camera Off' : 'Turn Camera On';
    } else {
         // Indicate cam not available if no video track
        camBtn.classList.remove('active');
        camBtn.classList.add('inactive');
        camBtn.querySelector('i').className = 'fas fa-video-slash';
        camBtn.title = 'Camera not available';
        camBtn.disabled = true; // Keep disabled if no track
    }
}


// Pass optional flag to prevent socket disconnect if called internally
function leaveMeeting(notifyServer = true) {
    console.log("Leaving meeting...");
    document.title = `DropIn - Meeting Ended`; // Update title first

    // 1. Stop local tracks
    if (localStream) {
        localStream.getTracks().forEach(track => track.stop());
        localStream = null;
        console.log("Local media tracks stopped.");
    }

    // 2. Close all peer connections
    Object.keys(peerConnections).forEach(peerId => {
        if (peerConnections[peerId]) {
            peerConnections[peerId].close();
        }
    });
    peerConnections = {};
    console.log("All peer connections closed.");

    // 3. Disconnect signaling socket (if requested and connected)
    if (notifyServer && socket && socket.connected) {
        console.log("Disconnecting from signaling server (requested)...");
        socket.disconnect(); // This triggers the 'disconnect' event listener
    } else if (!notifyServer && socket) {
         console.log("Skipping socket disconnection (internal cleanup or already disconnected).")
    }
    // Don't nullify socket here immediately if disconnect is async, let the event handler do it?
    // For simplicity, let's nullify:
     socket = null;

    // 4. Clean up UI
    if (videoGrid) videoGrid.innerHTML = ''; // Clear all videos
    if (initialOverlay) initialOverlay.style.display = 'block';
    if (loadingIndicator) loadingIndicator.style.display = 'none';
    if (permissionPrompt) permissionPrompt.style.display = 'none';
    if (endedMessage) {
        endedMessage.textContent = 'Meeting Ended.'; // Set final message
        endedMessage.style.display = 'block'; // Show meeting ended message
    }
    if (permissionError) permissionError.style.display = 'none'; // Hide any old errors


    // Disable controls
    if (micBtn) micBtn.disabled = true;
    if (camBtn) camBtn.disabled = true;
    if (leaveBtn) leaveBtn.disabled = true;

     // Optionally clear the room hash from URL
    // window.location.hash = '';
}

// 9. Utility Functions
function generateRandomRoomId(length = 6) {
    return Math.random().toString(36).substring(2, 2 + length);
}

function updateStatusMessage(message, isError = false) {
    console.log(`Status Update: ${message}`);

    // Prioritize showing messages on the overlay if it's visible
    if (initialOverlay && initialOverlay.style.display !== 'none') {
        if (isError) {
            // Show errors preferentially in the permission error area if it exists
            if (permissionError) {
                permissionError.textContent = message;
                permissionError.style.display = 'block';
                loadingIndicator.style.display = 'none';
                permissionPrompt.style.display = 'none';
                endedMessage.style.display = 'none';
            } else { // Fallback to ended message area for errors if no specific error spot
                endedMessage.textContent = message;
                endedMessage.style.color = '#f56565'; // Error color
                endedMessage.style.display = 'block';
                loadingIndicator.style.display = 'none';
                permissionPrompt.style.display = 'none';
            }
        } else {
            // Show non-errors in the loading indicator spot
            loadingIndicator.textContent = message;
            loadingIndicator.style.color = '#ccc'; // Normal color
            loadingIndicator.style.display = 'block';
            permissionPrompt.style.display = 'none';
            permissionError.style.display = 'none';
            endedMessage.style.display = 'none';
        }
    }
     // If overlay isn't visible, maybe use a temporary toast/snackbar (not implemented here)
     // For now, just log if overlay isn't active
     else {
         console.log(`(Overlay hidden) Status Update: ${message}`);
     }
}

// --- Start the application ---
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init(); // DOMContentLoaded has already fired
}