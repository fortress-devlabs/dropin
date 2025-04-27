// viewer.js - Client-side logic for the DropIn Live Viewer Page

document.addEventListener('DOMContentLoaded', () => {
    // --- DOM Elements ---
    const videoPlayer = document.getElementById('live-video');
    const streamTitleElement = document.getElementById('stream-title');
    const hostNameElement = document.getElementById('host-name'); // Assuming you add this ID
    const liveBadge = document.querySelector('.live-badge');
    const viewerCountElement = document.getElementById('viewer-count');
    const chatFeedList = document.getElementById('chat-feed-list');
    const chatMessageInput = document.getElementById('chat-message-input');
    const sendChatButton = document.getElementById('send-chat-button');
    const reactionButtonsContainer = document.querySelector('.reactions');
    const supportButton = document.getElementById('support-button'); // Placeholder

    // --- State & Config ---
    let socket = null;
    let mediaSource = null;
    let sourceBuffer = null;
    let streamId = null; // Will be extracted from URL or elsewhere
    let bufferQueue = []; // Queue for chunks arriving before SourceBuffer is ready
    let isSourceBufferReady = false;
    let isStreamActive = false; // Track if stream is supposed to be playing

    const MIME_TYPE = 'video/webm;codecs="vp8, opus"'; // MUST match broadcaster's codecs

    // --- Initialization ---

    // Function to extract Stream ID from URL (Example: /watch/xyz123)
    function getStreamIdFromUrl() {
        const pathSegments = window.location.pathname.split('/').filter(Boolean);
        // Assuming the last segment is the stream ID, adjust if needed
        if (pathSegments.length > 0 && pathSegments[0].toLowerCase() === 'watch') {
             return pathSegments[pathSegments.length - 1];
        }
        console.error("Could not determine Stream ID from URL:", window.location.pathname);
        return null; // Or handle error appropriately
    }

    // Function to initialize MediaSource and SourceBuffer
    function initializeMediaSource() {
        if (!MediaSource.isTypeSupported(MIME_TYPE)) {
            console.error("MediaSource MIME type not supported:", MIME_TYPE);
            updateStreamStatus(false, "Browser unsupported");
            alert("Your browser doesn't support the required video format for this stream.");
            return;
        }

        try {
            mediaSource = new MediaSource();
            videoPlayer.src = URL.createObjectURL(mediaSource);

            mediaSource.addEventListener('sourceopen', handleSourceOpen, { once: true });
            mediaSource.addEventListener('sourceended', () => console.log('MediaSource sourceended'));
            mediaSource.addEventListener('sourceclose', () => console.log('MediaSource sourceclose'));

        } catch (error) {
            console.error("Error creating MediaSource:", error);
            updateStreamStatus(false, "Playback error");
        }
    }

    function handleSourceOpen() {
        console.log('MediaSource opened. ReadyState:', mediaSource.readyState);
        try {
            sourceBuffer = mediaSource.addSourceBuffer(MIME_TYPE);
            sourceBuffer.mode = 'sequence'; // Important for live streams

            sourceBuffer.addEventListener('updateend', () => {
                isSourceBufferReady = true;
                // Process any queued chunks
                processBufferQueue();
            });

            sourceBuffer.addEventListener('error', (e) => {
                console.error('SourceBuffer error:', e);
                updateStreamStatus(false, "Playback error");
            });

            // Start processing queue once buffer is ready
            isSourceBufferReady = true;
            processBufferQueue();

        } catch (error) {
            console.error('Error adding SourceBuffer:', error);
            updateStreamStatus(false, "Playback error");
        }
    }

    // Function to add chunks to the buffer or queue them
    function appendChunk(chunk) {
        if (sourceBuffer && isSourceBufferReady && !sourceBuffer.updating && mediaSource.readyState === 'open') {
            try {
                isSourceBufferReady = false; // Mark as busy
                sourceBuffer.appendBuffer(chunk);
            } catch (error) {
                console.error('Error appending buffer:', error);
                isSourceBufferReady = true; // Mark as ready again on error
                 // Handle specific errors like QuotaExceededError by cleaning up buffer
                if (error.name === 'QuotaExceededError') {
                    cleanupBuffer();
                }
                // Attempt to append again might be risky, maybe just drop chunk or reset
            }
        } else {
            // If buffer isn't ready or is updating, queue the chunk
            bufferQueue.push(chunk);
             // Optional: Limit queue size to prevent memory issues
             if (bufferQueue.length > 50) { // Example limit
                 console.warn("Buffer queue long, dropping oldest chunk.");
                 bufferQueue.shift();
             }
        }
    }

    // Process queued chunks when SourceBuffer is ready
    function processBufferQueue() {
        if (sourceBuffer && isSourceBufferReady && !sourceBuffer.updating && bufferQueue.length > 0) {
            appendChunk(bufferQueue.shift()); // Append the oldest chunk
            // updateend listener will re-call processBufferQueue if needed
        }
    }

     // Basic buffer cleanup (remove old segments)
    function cleanupBuffer() {
        if (!sourceBuffer || sourceBuffer.updating || bufferQueue.length > 0) {
            return; // Don't cleanup if busy or queue exists
        }
        try {
            const buffered = sourceBuffer.buffered;
            if (buffered.length > 0) {
                const removeEnd = buffered.start(0) + (buffered.end(0) - buffered.start(0)) * 0.5; // Remove first 50%
                // Or keep last X seconds: const removeEnd = videoPlayer.currentTime - 30;
                 if (removeEnd > buffered.start(0)) {
                    console.log(Cleaning up buffer: Removing up to ${removeEnd});
                    isSourceBufferReady = false; // Mark busy for removal
                    sourceBuffer.remove(buffered.start(0), removeEnd);
                 }
            }
        } catch (error) {
            console.error("Error cleaning up buffer:", error);
             isSourceBufferReady = true; // Ensure it becomes ready even on error
        }
    }


    // --- Socket.IO Event Handling ---
    function connectWebSocket() {
        streamId = getStreamIdFromUrl();
        if (!streamId) {
            updateStreamStatus(false, "Invalid Stream Link");
            return;
        }

        addChatMessage({ type: 'system', text: 'Connecting to stream...' });

        // IMPORTANT: Replace with your actual server URL
        socket = io('https://dropin-43k0.onrender.com', {
            // Optional: Add authentication query params if needed
            // query: { token: 'VIEWER_AUTH_TOKEN' }
        });

        socket.on('connect', () => {
            console.log('Socket connected:', socket.id);
            addChatMessage({ type: 'system', text: 'Connected. Joining stream...' });
            // Tell the server which stream we want to join
            socket.emit('join_live_room', { streamId: streamId });
            isStreamActive = true; // Assume stream is potentially active on connect
        });

        // Listen for confirmation or initial stream details
        socket.on('stream_details', (details) => {
             console.log("Received stream details:", details);
             streamTitleElement.textContent = details.title || 'Live Stream';
             // Add host name if available: hostNameElement.textContent = by ${details.hostName || 'Broadcaster'};
             updateStreamStatus(details.isLive !== false); // Update based on backend status if provided
             if (details.isLive !== false) {
                 initializeMediaSource(); // Start playback setup only if confirmed live
             } else {
                 updateStreamStatus(false, "Stream Offline");
             }
        });


        // Listen for video/audio chunks
        socket.on('receive_live_chunk', (chunk) => {
            // Ensure chunk is ArrayBuffer (Socket.IO might need configuration for binary)
            if (chunk instanceof ArrayBuffer || chunk instanceof Blob || chunk instanceof Uint8Array) {
                 appendChunk(chunk);
                 // Attempt to play if paused (e.g., after buffering)
                 if (videoPlayer.paused && videoPlayer.readyState >= videoPlayer.HAVE_FUTURE_DATA) {
                     videoPlayer.play().catch(e => console.warn("Autoplay prevented:", e));
                 }
            } else {
                console.warn("Received non-binary data on 'receive_live_chunk'");
            }
        });

        socket.on('new_live_comment', (message) => {
            addChatMessage(message);
        });

        socket.on('viewer_count_update', (count) => {
            viewerCountElement.textContent = 👀 ${count};
        });

        socket.on('live_stream_ended', () => {
            console.log("Received stream ended signal.");
            updateStreamStatus(false, "Stream Ended");
            isStreamActive = false;
            if (mediaSource && mediaSource.readyState === 'open') {
                try {
                    mediaSource.endOfStream();
                } catch (e) {
                    console.warn("Error ending MediaSource stream:", e);
                }
            }
            // Optionally clear video source: videoPlayer.src = '';
            chatMessageInput.disabled = true;
            sendChatButton.disabled = true;
        });

        socket.on('connect_error', (err) => {
            console.error('Socket connection error:', err.message);
            addChatMessage({ type: 'system', text: Connection error: ${err.message} });
            updateStreamStatus(false, "Connection Error");
        });

        socket.on('disconnect', (reason) => {
            console.log('Socket disconnected:', reason);
            addChatMessage({ type: 'system', text: Disconnected: ${reason} });
            updateStreamStatus(false, "Disconnected");
            isStreamActive = false;
             // Optionally attempt reconnection here
        });
    }

    // --- UI Updates & Chat ---
    function updateStreamStatus(isLive, statusText = "LIVE") {
        if (isLive) {
            liveBadge.textContent = 🔴 ${statusText};
            liveBadge.style.color = 'var(--live-red)'; // Use CSS variable
            chatMessageInput.disabled = false;
            sendChatButton.disabled = false;
        } else {
            liveBadge.textContent = ⚫ ${statusText}; // Use black circle for offline/ended
            liveBadge.style.color = '#666'; // Grey color
            chatMessageInput.disabled = true;
            sendChatButton.disabled = true;
        }
    }

    function addChatMessage(message) {
        const item = document.createElement('li');
        item.classList.add('chat-message');
        if (message.type === 'system') {
            item.classList.add('system');
            item.innerHTML = <span>${message.text}</span>;
        } else {
             // Basic sanitization
            const safeUsername = (message.username || 'User').replace(/</g, "<").replace(/>/g, ">");
            const safeText = (message.text || '').replace(/</g, "<").replace(/>/g, ">");
            item.innerHTML = <strong>${safeUsername}</strong><span>${safeText}</span>;
        }
        chatFeedList.appendChild(item);
        // Auto-scroll only if user is near the bottom
        const container = chatFeedList.parentElement;
        const isScrolledToBottom = container.scrollHeight - container.clientHeight <= container.scrollTop + 50; // 50px tolerance
        if (isScrolledToBottom) {
            container.scrollTop = container.scrollHeight;
        }
    }

    function sendChatMessage() {
        const messageText = chatMessageInput.value.trim();
        if (messageText && socket && socket.connected && isStreamActive && streamId) {
            const message = {
                streamId: streamId,
                text: messageText
            };
            socket.emit('send_live_comment', message);
            chatMessageInput.value = ''; // Clear input
        }
    }

    // --- Send Reactions ---
    function sendReaction(reaction) {
         if (socket && socket.connected && isStreamActive && streamId) {
             console.log("Sending reaction:", reaction);
             socket.emit('send_live_reaction', {
                 streamId: streamId,
                 reaction: reaction
             });
             // Optional: Add visual feedback like a flying emoji
         }
    }

    // --- Event Listeners ---
    sendChatButton.addEventListener('click', sendChatMessage);
    chatMessageInput.addEventListener('keypress', (event) => {
        if (event.key === 'Enter' && !event.shiftKey) { // Send on Enter, allow Shift+Enter for newline
            event.preventDefault(); // Prevent default form submission/newline
            sendChatMessage();
        }
    });

    reactionButtonsContainer.addEventListener('click', (event) => {
        const button = event.target.closest('.reaction-button');
        if (button) {
            const reaction = button.getAttribute('data-reaction');
            if (reaction) {
                sendReaction(reaction);
            }
        }
    });

    // Attempt to play video on interaction if needed (browsers often block autoplay with sound)
    videoPlayer.addEventListener('click', () => {
        if (videoPlayer.paused) {
            videoPlayer.play().catch(e => console.warn("Manual play failed:", e));
        }
        if (videoPlayer.muted) {
            videoPlayer.muted = false; // Unmute on click
        }
    });