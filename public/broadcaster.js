// broadcaster.js - Client-side logic for the DropIn Live Studio

document.addEventListener('DOMContentLoaded', () => {
    // --- DOM Elements ---
    const videoPreview = document.getElementById('video-preview');
    const previewOverlay = document.getElementById('preview-overlay');
    const previewOverlayText = previewOverlay.querySelector('p');
    const goLiveButton = document.getElementById('go-live-button');
    const endStreamButton = document.getElementById('end-stream-button');
    const streamTitleInput = document.getElementById('stream-title');
    const cameraSelect = document.getElementById('camera-select');
    const micSelect = document.getElementById('mic-select');
    const streamStatusIndicator = document.getElementById('stream-status-indicator');
    const statusDot = streamStatusIndicator.querySelector('.status-dot');
    const statusText = streamStatusIndicator.childNodes[2]; // The text node after the dot
    const liveStatsDisplay = document.getElementById('live-stats-display');
    const liveViewerCount = document.getElementById('live-viewer-count');
    const liveDuration = document.getElementById('live-duration');

    // Chat Elements
    const studioChatList = document.getElementById('studio-chat-list');
    const studioChatMessageInput = document.getElementById('studio-chat-message');
    const studioSendChatButton = document.getElementById('studio-send-chat');

    // Tab Elements
    const tabsContainer = document.querySelector('.tabs');
    const tabContents = document.querySelectorAll('.tab-content');

    // --- State Variables ---
    let localStream = null;
    let mediaRecorder = null;
    let socket = null;
    let isStreaming = false;
    let streamId = null; // Unique ID for this stream session (assigned by backend)
    let recordedChunks = []; // Not currently used, but good practice
    let streamDurationInterval = null;
    let streamStartTime = null;

    // Use a more reliable MIME type first, fallback if needed
    const PREFERRED_MIME_TYPE = 'video/webm;codecs=vp8,opus';
    const FALLBACK_MIME_TYPE = 'video/webm'; // Broader fallback
    let actualMimeType = ''; // Store the actually used mimeType

    const TIMESLICE = 2000; // Send chunk every 2 seconds (adjust as needed)

    // --- Initialization ---

    // Function to update the preview overlay message
    function updateOverlay(message, show = true) {
        if (show) {
            previewOverlayText.textContent = message;
            previewOverlay.classList.add('active');
            previewOverlayText.style.display = 'block';
        } else {
            previewOverlay.classList.remove('active');
            previewOverlayText.style.display = 'none';
        }
    }

    // Function to populate device dropdowns
    async function getDevices() {
        updateOverlay('Requesting permissions...');
        try {
            // Request permission first to get meaningful labels
            await navigator.mediaDevices.getUserMedia({ video: true, audio: true });

            const devices = await navigator.mediaDevices.enumerateDevices();
            cameraSelect.innerHTML = '<option value="">Select Camera</option>';
            micSelect.innerHTML = '<option value="">Select Microphone</option>';

            devices.forEach(device => {
                if (device.kind === 'videoinput') {
                    const option = document.createElement('option');
                    option.value = device.deviceId;
                    option.text = device.label || `Camera ${cameraSelect.length}`;
                    cameraSelect.appendChild(option);
                } else if (device.kind === 'audioinput') {
                    const option = document.createElement('option');
                    option.value = device.deviceId;
                    option.text = device.label || `Microphone ${micSelect.length}`;
                    micSelect.appendChild(option);
                }
            });
            updateOverlay('Select devices and Go Live!', true);
            startPreview(); // Attempt preview with defaults
        } catch (err) {
            console.error("Error accessing media devices.", err);
            updateOverlay(`Error accessing devices: ${err.message}. Please grant permissions.`);
            alert("Could not access camera/microphone. Please ensure permissions are granted in your browser settings.");
            goLiveButton.disabled = true; // Keep disabled if permissions fail
        }
    }

    // Function to start the video preview
    async function startPreview() {
        if (localStream) {
            localStream.getTracks().forEach(track => track.stop());
        }
        updateOverlay('Initializing camera...');
        const selectedCameraId = cameraSelect.value;
        const selectedMicId = micSelect.value;

        const constraints = {
            video: { deviceId: selectedCameraId ? { exact: selectedCameraId } : undefined },
            audio: { deviceId: selectedMicId ? { exact: selectedMicId } : undefined }
        };

        try {
            localStream = await navigator.mediaDevices.getUserMedia(constraints);
            videoPreview.srcObject = localStream;
            // videoPreview.play(); // Not strictly needed with autoplay, but safe
            updateOverlay('', false); // Hide overlay
            goLiveButton.disabled = false; // Enable Go Live
        } catch (err) {
            console.error("Error starting preview.", err);
            updateOverlay(`Preview Error: ${err.message}`);
            goLiveButton.disabled = true;
        }
    }

    // Function to update stream status indicator
    function updateStreamStatus(live, statusMsg = 'OFFLINE') {
        if (live) {
            statusDot.className = 'status-dot live';
            statusText.nodeValue = ' LIVE';
            goLiveButton.style.display = 'none';
            endStreamButton.style.display = 'inline-block';
            liveStatsDisplay.style.display = 'flex';
        } else {
            statusDot.className = 'status-dot offline';
            statusText.nodeValue = ` ${statusMsg}`;
            goLiveButton.style.display = 'inline-block';
            endStreamButton.style.display = 'none';
            liveStatsDisplay.style.display = 'none';
            liveViewerCount.textContent = '0';
            liveDuration.textContent = '00:00:00';
        }
    }

    // --- Streaming Logic ---

    function goLive() {
        if (!localStream) {
            alert("Preview not available. Cannot go live.");
            return;
        }
        if (isStreaming) {
            alert("Already streaming.");
            return;
        }

        const streamTitle = streamTitleInput.value.trim();
        if (!streamTitle) {
            alert("Please enter a stream title.");
            streamTitleInput.focus();
            return;
        }

        console.log("Attempting to go live...");
        updateOverlay('Connecting to server...');
        goLiveButton.disabled = true;
        goLiveButton.textContent = 'Starting...';

        // 1. Connect Socket.IO (or reconnect) WITH THE CORRECT CONTEXT
        // Disconnect previous socket if exists, to ensure fresh handshake with context
        if (socket && socket.connected) {
            socket.disconnect();
        }

        // Establish new connection with live_broadcast context
        // !!! THIS IS THE KEY FIX !!!
        socket = io('https://dropin-43k0.onrender.com', {
            query: {
                context: 'live_broadcast',
                // Replace 'BroadcasterName' with dynamic name later if needed
                username: 'BroadcasterName'
            },
            // Optional: Force new connection if issues persist
            // forceNew: true
        });

        // Setup listeners for this new socket connection
        setupSocketListeners();

        // Note: The 'start_stream' emit is now handled inside the 'connect' listener
        // in setupSocketListeners to ensure the server has registered the context.
    }

    function endStream() {
        if (!isStreaming && !mediaRecorder && !socket) { // Check if already mostly cleaned up
            console.log("Stream appears to be already stopped or was never fully started.");
            // Ensure UI is fully reset
            updateStreamStatus(false, 'ENDED');
            updateOverlay('Stream Ended. Select devices to go live again.');
            goLiveButton.disabled = false;
            goLiveButton.textContent = 'Go Live';
            if(localStream) { // Ensure preview stops if endStream is called prematurely
                 localStream.getTracks().forEach(track => track.stop());
                 localStream = null;
                 videoPreview.srcObject = null;
            }
            return;
        }


        console.log("Ending stream...");
        updateOverlay('Ending stream...');
        isStreaming = false; // Set state early

        if (mediaRecorder && mediaRecorder.state === 'recording') {
            try {
                mediaRecorder.stop();
                console.log("MediaRecorder stop() called.");
            } catch (e) {
                 console.error("Error stopping MediaRecorder:", e);
            }
        }
        mediaRecorder = null; // Clear recorder reference


        // Stop local media tracks
        if (localStream) {
            localStream.getTracks().forEach(track => track.stop());
            localStream = null;
            videoPreview.srcObject = null;
            console.log("Local media tracks stopped.");
        }

        // Notify the server if we have a streamId and socket
        if (socket && streamId) {
            console.log(`Emitting end_stream for stream ID: ${streamId}`);
            socket.emit('end_stream', { streamId: streamId });
        } else {
             console.warn("Cannot emit end_stream: socket or streamId missing.");
        }

        // Stop duration timer
        if (streamDurationInterval) {
            clearInterval(streamDurationInterval);
            streamDurationInterval = null;
            console.log("Duration timer stopped.");
        }

        // Clear stream ID reference
        streamId = null;

         // Update UI
        updateStreamStatus(false, 'ENDED');
        updateOverlay('Stream Ended. Select devices to go live again.');
        goLiveButton.disabled = false;
        goLiveButton.textContent = 'Go Live';

        // Disconnect socket after giving end_stream a chance to send
        setTimeout(() => {
             if (socket) {
                 socket.disconnect();
                 socket = null;
                 console.log("Socket disconnected.");
             }
        }, 500); // Small delay
    }

    // --- MediaRecorder Handling ---
    function setupMediaRecorder() {
        if (!localStream) {
            console.error("Cannot setup MediaRecorder: localStream is null");
            alert("Camera/Mic stream lost. Cannot start recording.");
            endStream(); // Abort the process
            return;
        }

        // Determine the best supported MIME type
        if (MediaRecorder.isTypeSupported(PREFERRED_MIME_TYPE)) {
            actualMimeType = PREFERRED_MIME_TYPE;
        } else if (MediaRecorder.isTypeSupported(FALLBACK_MIME_TYPE)) {
            actualMimeType = FALLBACK_MIME_TYPE;
            console.warn(`Using fallback MIME type: ${FALLBACK_MIME_TYPE}`);
        } else {
            actualMimeType = ''; // Let the browser choose default
            console.warn("Using browser default MIME type.");
        }

        try {
            console.log(`Attempting to create MediaRecorder with mimeType: '${actualMimeType || 'default'}'`);
            mediaRecorder = new MediaRecorder(localStream, { mimeType: actualMimeType });

            mediaRecorder.ondataavailable = (event) => {
                // console.log('MediaRecorder ondataavailable fired!'); // Debug log
                if (event.data && event.data.size > 0) {
                    if (socket && socket.connected && streamId && isStreaming) { // Double check state
                        // console.log(`Emitting chunk, size: ${event.data.size}`); // Verbose debug
                        socket.emit('live_stream_data', { streamId: streamId, chunk: event.data });
                    } else if (isStreaming) { // Only warn if we *should* be streaming
                        console.warn("Socket not ready or streamId missing during ondataavailable, cannot send chunk.");
                    }
                }
            };

            mediaRecorder.onstop = () => {
                console.log("MediaRecorder stopped event fired.");
                // No action needed here usually, handled by endStream logic
            };

            mediaRecorder.onerror = (event) => {
                console.error("MediaRecorder Error:", event.error);
                alert(`Streaming recording error: ${event.error.name}. Stream may be interrupted.`);
                // Don't call endStream directly from here to avoid potential loops, let user handle UI
                updateStreamStatus(false, 'REC ERR'); // Indicate recording error
                isStreaming = false; // Update state
            };

            // Start recording, capturing chunks at specified interval
            mediaRecorder.start(TIMESLICE);
            console.log(`MediaRecorder started with state: ${mediaRecorder.state} and mimeType: ${mediaRecorder.mimeType}`);

        } catch (err) {
            console.error("Failed to create or start MediaRecorder:", err);
            alert(`Could not start recording: ${err.message}`);
            endStream(); // Abort if recorder setup fails critically
        }
    }


    // --- Socket.IO Event Handling ---
    function setupSocketListeners() {
        if (!socket) {
            console.error("setupSocketListeners called but socket is null");
            return;
        }

        // Remove previous listeners if any, to prevent duplicates on reconnect
        socket.off('connect');
        socket.off('stream_started_ack');
        socket.off('connect_error');
        socket.off('disconnect');
        socket.off('new_chat_message'); // Renamed from new_live_comment in server? Check server.js
        socket.off('viewer_count_update');
        socket.off('stream_error');

        // --- Add Listeners ---
        socket.on('connect', () => {
            console.log('Socket connected successfully:', socket.id);
            // NOW that we are connected with the correct context, emit start_stream
            const streamTitle = streamTitleInput.value.trim();
            if (streamTitle) { // Ensure title exists before emitting
                 console.log("Socket connected with context, emitting start_stream for title:", streamTitle);
                 socket.emit('start_stream', { title: streamTitle });
                 updateOverlay('Waiting for server ACK...'); // Update UI
            } else {
                console.warn("Cannot emit start_stream: Title is empty.");
                alert("Please enter a stream title before going live.");
                endStream(); // Abort if title missing at this point
            }
        });

        socket.on('stream_started_ack', (data) => {
            if (data && data.streamId) {
                streamId = data.streamId;
                isStreaming = true; // Set streaming state TRUE
                console.log(`Stream started successfully acknowledged by server. Stream ID: ${streamId}`);
                updateOverlay('', false); // Hide overlay
                updateStreamStatus(true); // Update UI to LIVE state
                startDurationTimer(); // Start clock
                setupMediaRecorder(); // NOW start the recorder
            } else {
                console.error("Backend ACK error: Invalid or missing streamId.", data);
                alert("Failed to get confirmation from the server to start stream.");
                endStream(); // Clean up
            }
        });

        socket.on('connect_error', (err) => {
            console.error('Socket connection error:', err);
            alert(`Connection Error: ${err.message || 'Unknown connection error'}. Please check server status and refresh.`);
            // Clean up if we were trying to start
            if (goLiveButton.disabled && !isStreaming) {
                 endStream(); // Reset UI
            }
        });

        socket.on('disconnect', (reason) => {
            console.warn('Socket disconnected:', reason);
            // If streaming was active, handle unexpected disconnect
            if (isStreaming) {
                alert(`Connection lost: ${reason}. Stream interrupted.`);
                // Call endStream to ensure full cleanup
                endStream();
            } else {
                 // If not streaming, maybe just update overlay
                 updateOverlay('Disconnected. Refresh maybe?', true);
            }
             socket = null; // Ensure socket is nullified
        });

        // Listener for incoming chat messages (from viewers or system)
        socket.on('new_live_comment', (message) => { // Make sure this matches server emit event name
            addChatMessage(message);
        });

        socket.on('viewer_count_update', (count) => {
            liveViewerCount.textContent = count;
        });

        socket.on('stream_error', (error) => {
            console.error("Received Stream Error from Server:", error);
            alert(`Server reported an error: ${error.message || 'Unknown error'}. Stream ending.`);
            endStream();
        });
    }

    // --- Chat Functionality ---
    function addChatMessage(message) {
        const item = document.createElement('li');
        item.classList.add('chat-message');
        if (message.type === 'system') {
            item.classList.add('system');
            item.innerHTML = `<span>${message.text || ''}</span>`;
        } else {
            // Corrected Sanitization
            const safeUsername = (message.username || 'Guest').replace(/</g, "<").replace(/>/g, ">");
            const safeText = (message.text || '').replace(/</g, "<").replace(/>/g, ">");
            item.innerHTML = `<strong>${safeUsername}</strong><span>${safeText}</span>`;
        }
        studioChatList.appendChild(item);
        // Auto-scroll to bottom
        studioChatList.parentElement.scrollTop = studioChatList.parentElement.scrollHeight;
    }

    function sendChatMessage() {
        const messageText = studioChatMessageInput.value.trim();
        // Check all conditions: text exists, socket connected, currently streaming, have streamId
        if (messageText && socket && socket.connected && isStreaming && streamId) {
            const message = {
                streamId: streamId,
                text: messageText
            };
            // Emit using the correct event name expected by the server
            socket.emit('send_live_comment', message);
            studioChatMessageInput.value = ''; // Clear input
        } else if (!isStreaming) {
             addChatMessage({type:'system', text: 'Stream is not live. Cannot send chat.'});
        } else if (!socket || !socket.connected) {
             addChatMessage({type:'system', text: 'Not connected to chat server.'});
        }
    }

    // --- Timer ---
    function startDurationTimer() {
        streamStartTime = Date.now();
        if (streamDurationInterval) clearInterval(streamDurationInterval);

        liveDuration.textContent = '00:00:00'; // Reset display immediately

        streamDurationInterval = setInterval(() => {
            // Check isStreaming flag inside interval for safety
            if (!isStreaming || !streamStartTime) {
                clearInterval(streamDurationInterval);
                streamDurationInterval = null;
                return;
            }
            const elapsed = Date.now() - streamStartTime;
            liveDuration.textContent = formatDuration(elapsed);
        }, 1000);
    }

    function formatDuration(ms) {
        const totalSeconds = Math.floor(ms / 1000);
        const hours = Math.floor(totalSeconds / 3600);
        const minutes = Math.floor((totalSeconds % 3600) / 60);
        const seconds = totalSeconds % 60;
        return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
    }


    // --- Tab Functionality ---
    tabsContainer.addEventListener('click', (event) => {
        if (event.target.classList.contains('tab-button')) {
            const targetTab = event.target.getAttribute('data-tab');
            tabsContainer.querySelectorAll('.tab-button').forEach(btn => btn.classList.remove('active'));
            event.target.classList.add('active');
            tabContents.forEach(content => {
                content.classList.toggle('active', content.id === `tab-${targetTab}`);
            });
        }
    });

    // --- Event Listeners ---
    goLiveButton.addEventListener('click', goLive);
    endStreamButton.addEventListener('click', endStream);
    cameraSelect.addEventListener('change', startPreview);
    micSelect.addEventListener('change', startPreview);

    studioSendChatButton.addEventListener('click', sendChatMessage);
    studioChatMessageInput.addEventListener('keypress', (event) => {
        if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault(); // Prevent default newline
            sendChatMessage();
        }
    });

    // --- Initial Setup ---
    updateStreamStatus(false, 'OFFLINE');
    goLiveButton.disabled = true; // Keep disabled until devices ready
    getDevices(); // Start device discovery

}); // End DOMContentLoaded