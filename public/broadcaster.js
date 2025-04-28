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

    const TIMESLICE = 2000; // Send chunk every 2 seconds (Instruction #1 requirement)

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
            startPreview();
        } catch (err) {
            console.error("Error accessing media devices.", err);
            updateOverlay(`Error accessing devices: ${err.message}. Please grant permissions.`);
            alert("Could not access camera/microphone. Please ensure permissions are granted in your browser settings.");
            goLiveButton.disabled = true;
        }
    }

    // Function to start the video preview
    async function startPreview() {
        if (localStream) { localStream.getTracks().forEach(track => track.stop()); }
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
            updateOverlay('', false);
            goLiveButton.disabled = false;
        } catch (err) {
            console.error("Error starting preview.", err);
            updateOverlay(`Preview Error: ${err.message}`);
            goLiveButton.disabled = true;
        }
    }

    // Function to update stream status indicator
    function updateStreamStatus(live, statusMsg = 'OFFLINE') {
        if (live) {
            statusDot.className = 'status-dot live'; statusText.nodeValue = ' LIVE';
            goLiveButton.style.display = 'none'; endStreamButton.style.display = 'inline-block';
            liveStatsDisplay.style.display = 'flex';
        } else {
            statusDot.className = 'status-dot offline'; statusText.nodeValue = ` ${statusMsg}`;
            goLiveButton.style.display = 'inline-block'; endStreamButton.style.display = 'none';
            liveStatsDisplay.style.display = 'none'; liveViewerCount.textContent = '0'; liveDuration.textContent = '00:00:00';
        }
    }

    // --- Streaming Logic ---

    function goLive() {
        if (!localStream) { alert("Preview not available."); return; }
        if (isStreaming) { alert("Already streaming."); return; }
        const streamTitle = streamTitleInput.value.trim();
        if (!streamTitle) { alert("Please enter a stream title."); streamTitleInput.focus(); return; }

        console.log("Attempting to go live...");
        updateOverlay('Connecting to server...');
        goLiveButton.disabled = true; goLiveButton.textContent = 'Starting...';

        if (socket && socket.connected) { socket.disconnect(); }
        socket = io('https://dropin-43k0.onrender.com', {
            query: { context: 'live_broadcast', username: 'BroadcasterName' }
        });
        setupSocketListeners();
    }

    function endStream() {
        if (!isStreaming && !mediaRecorder && !socket) { console.log("Stream appears already stopped."); updateStreamStatus(false, 'ENDED'); updateOverlay('Stream Ended.'); goLiveButton.disabled = false; goLiveButton.textContent = 'Go Live'; if(localStream) { localStream.getTracks().forEach(track => track.stop()); localStream = null; videoPreview.srcObject = null;} return; }
        console.log("Ending stream...");
        updateOverlay('Ending stream...');
        isStreaming = false;
        if (mediaRecorder && mediaRecorder.state === 'recording') { try { mediaRecorder.stop(); console.log("MediaRecorder stop() called."); } catch (e) { console.error("Error stopping MediaRecorder:", e); } }
        mediaRecorder = null;
        if (localStream) { localStream.getTracks().forEach(track => track.stop()); localStream = null; videoPreview.srcObject = null; console.log("Local media tracks stopped."); }
        if (socket && streamId) { console.log(`Emitting end_stream for stream ID: ${streamId}`); socket.emit('end_stream', { streamId: streamId }); }
        else { console.warn("Cannot emit end_stream: socket or streamId missing."); }
        if (streamDurationInterval) { clearInterval(streamDurationInterval); streamDurationInterval = null; console.log("Duration timer stopped."); }
        streamId = null;
        updateStreamStatus(false, 'ENDED'); updateOverlay('Stream Ended.');
        goLiveButton.disabled = false; goLiveButton.textContent = 'Go Live';
        setTimeout(() => { if (socket) { socket.disconnect(); socket = null; console.log("Socket disconnected."); } }, 500);
    }

    // --- MediaRecorder Handling ---
    function setupMediaRecorder() {
        if (!localStream) { console.error("Cannot setup MediaRecorder: localStream is null"); alert("Camera/Mic stream lost."); endStream(); return; }

        if (MediaRecorder.isTypeSupported(PREFERRED_MIME_TYPE)) { actualMimeType = PREFERRED_MIME_TYPE; }
        else if (MediaRecorder.isTypeSupported(FALLBACK_MIME_TYPE)) { actualMimeType = FALLBACK_MIME_TYPE; console.warn(`Using fallback MIME type: ${FALLBACK_MIME_TYPE}`); }
        else { actualMimeType = ''; console.warn("Using browser default MIME type."); }

        try {
            console.log(`Attempting to create MediaRecorder with mimeType: '${actualMimeType || 'default'}'`);
            mediaRecorder = new MediaRecorder(localStream, { mimeType: actualMimeType });

            mediaRecorder.ondataavailable = (event) => {
                // console.log('MediaRecorder ondataavailable fired!', event.data?.size); // Debug size
                if (event.data && event.data.size > 0) {
                    if (socket && socket.connected && streamId && isStreaming) {
                        // Convert Blob to ArrayBuffer before sending (Instruction #1)
                        event.data.arrayBuffer().then(arrayBuffer => {
                            // console.log(`Emitting live_stream_data chunk as ArrayBuffer, size: ${arrayBuffer.byteLength}`);
                            socket.emit('live_stream_data', {
                                streamId: streamId,
                                chunk: arrayBuffer // Send the ArrayBuffer
                            });
                        }).catch(err => {
                            console.error("Error converting Blob to ArrayBuffer:", err);
                        });
                    } else if (isStreaming) {
                        console.warn("Socket not ready or streamId missing during ondataavailable, cannot send chunk.");
                    }
                }
            };

            mediaRecorder.onstop = () => { console.log("MediaRecorder stopped event fired."); };
            mediaRecorder.onerror = (event) => { console.error("MediaRecorder Error:", event.error); alert(`Streaming recording error: ${event.error.name}.`); updateStreamStatus(false, 'REC ERR'); isStreaming = false; };

            // Start recording with TIMESLICE (Instruction #1)
            mediaRecorder.start(TIMESLICE);
            console.log(`MediaRecorder started with state: ${mediaRecorder.state} and mimeType: ${mediaRecorder.mimeType}`);
            // Store the actual mimeType used
            actualMimeType = mediaRecorder.mimeType;

        } catch (err) {
            console.error("Failed to create or start MediaRecorder:", err);
            alert(`Could not start recording: ${err.message}`);
            endStream();
        }
    }


    // --- Socket.IO Event Handling ---
    function setupSocketListeners() {
        if (!socket) { console.error("setupSocketListeners called but socket is null"); return; }

        socket.off('connect'); socket.off('stream_started_ack'); socket.off('connect_error'); socket.off('disconnect'); socket.off('new_live_comment'); socket.off('viewer_count_update'); socket.off('stream_error');

        socket.on('connect', () => {
            console.log('Socket connected successfully:', socket.id);
            const streamTitle = streamTitleInput.value.trim();
            if (streamTitle) {
                 console.log("Socket connected, emitting start_stream with title:", streamTitle);
                 // Include the actual mimeType if the recorder is already set up
                 // Note: This is slightly different from the user's previous instruction
                 // as mediaRecorder might not exist *exactly* at 'connect' time.
                 // The reliable way is to send it AFTER setupMediaRecorder runs.
                 // We will send it in the 'stream_started_ack' confirmation step later,
                 // although the user's diff suggested sending it here.
                 // For now, just send title. MimeType will be sent via 'stream_details' IF Option 1 is implemented server-side later.
                 socket.emit('start_stream', { title: streamTitle });
                 updateOverlay('Waiting for server ACK...');
            } else {
                console.warn("Cannot emit start_stream: Title is empty.");
                alert("Please enter a stream title before going live.");
                endStream();
            }
        });

        socket.on('stream_started_ack', (data) => {
            if (data && data.streamId) {
                streamId = data.streamId;
                isStreaming = true;
                console.log(`Stream started ACK received. Stream ID: ${streamId}`);
                updateOverlay('', false);
                updateStreamStatus(true);
                startDurationTimer();
                setupMediaRecorder(); // Setup recorder *after* ACK

                // **Optionally (if implementing Server Option 1 from previous step)**:
                // Now that mediaRecorder exists and has a mimeType, inform the server/viewers
                // This requires server-side changes to handle a 'stream_details_update' or similar.
                // if (mediaRecorder && mediaRecorder.mimeType) {
                //    console.log("Sending updated stream details with mimeType:", mediaRecorder.mimeType);
                //    socket.emit('update_stream_details', { streamId: streamId, mimeType: mediaRecorder.mimeType });
                // }

            } else {
                console.error("Backend ACK error: Invalid or missing streamId.", data);
                alert("Failed to get confirmation from server.");
                endStream();
            }
        });

        socket.on('connect_error', (err) => { console.error('Socket connection error:', err); alert(`Connection Error: ${err.message}.`); if (goLiveButton.disabled && !isStreaming) { endStream(); } });
        socket.on('disconnect', (reason) => { console.warn('Socket disconnected:', reason); if (isStreaming) { alert(`Connection lost: ${reason}. Stream interrupted.`); endStream(); } else { updateOverlay('Disconnected.', true); } socket = null; });
        socket.on('new_live_comment', (message) => { addChatMessage(message); });
        socket.on('viewer_count_update', (count) => { liveViewerCount.textContent = count; });
        socket.on('stream_error', (error) => { console.error("Received Stream Error from Server:", error); alert(`Server error: ${error.message}.`); endStream(); });
    }

    // --- Chat Functionality ---
    function addChatMessage(message) {
        const item = document.createElement('li');
        item.classList.add('chat-message');
        if (message.type === 'system') {
            item.classList.add('system');
            item.innerHTML = `<span>${(message.text || '').replace(/</g, "<").replace(/>/g, ">")}</span>`;
        } else {
            const safeUsername = (message.username || 'Guest').replace(/</g, "<").replace(/>/g, ">");
            const safeText = (message.text || '').replace(/</g, "<").replace(/>/g, ">");
            item.innerHTML = `<strong>${safeUsername}</strong><span>${safeText}</span>`;
        }
        studioChatList.appendChild(item);
        studioChatList.parentElement.scrollTop = studioChatList.parentElement.scrollHeight;
    }

    function sendChatMessage() {
        const messageText = studioChatMessageInput.value.trim();
        if (messageText && socket && socket.connected && isStreaming && streamId) {
            socket.emit('send_live_comment', { streamId: streamId, text: messageText });
            studioChatMessageInput.value = '';
        } else if (!isStreaming) { addChatMessage({type:'system', text: 'Stream not live.'}); }
        else if (!socket || !socket.connected) { addChatMessage({type:'system', text: 'Not connected.'}); }
    }

    // --- Timer ---
    function startDurationTimer() {
        streamStartTime = Date.now();
        if (streamDurationInterval) clearInterval(streamDurationInterval);
        liveDuration.textContent = '00:00:00';
        streamDurationInterval = setInterval(() => {
            if (!isStreaming || !streamStartTime) { clearInterval(streamDurationInterval); streamDurationInterval = null; return; }
            liveDuration.textContent = formatDuration(Date.now() - streamStartTime);
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
            tabContents.forEach(content => { content.classList.toggle('active', content.id === `tab-${targetTab}`); });
        }
    });

    // --- Event Listeners ---
    goLiveButton.addEventListener('click', goLive);
    endStreamButton.addEventListener('click', endStream);
    cameraSelect.addEventListener('change', startPreview);
    micSelect.addEventListener('change', startPreview);
    studioSendChatButton.addEventListener('click', sendChatMessage);
    studioChatMessageInput.addEventListener('keypress', (event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); sendChatMessage(); } });

    // --- Initial Setup ---
    updateStreamStatus(false, 'OFFLINE');
    goLiveButton.disabled = true;
    getDevices();

}); // End DOMContentLoaded