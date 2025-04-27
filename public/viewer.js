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

    // NOTE: Changed MIME_TYPE based on common MediaRecorder output.
    // Ensure this EXACTLY matches the mimeType being recorded in broadcaster.js
    // Common options: 'video/webm;codecs=vp8,opus', 'video/webm;codecs=vp9,opus', 'video/mp4;codecs=avc1.42E01E,mp4a.40.2'
    // Check broadcaster.js console logs for the 'mimeType' reported when MediaRecorder starts.
    const MIME_TYPE = 'video/webm;codecs=vp8,opus'; // MAKE SURE THIS MATCHES BROADCASTER

    // --- Initialization ---

    // Function to extract Stream ID from URL (Example: /watch/xyz123)
    function getStreamIdFromUrl() {
        const pathSegments = window.location.pathname.split('/').filter(Boolean);
        // Assuming the path is /watch/STREAM_ID
        if (pathSegments.length === 2 && pathSegments[0].toLowerCase() === 'watch') {
             return pathSegments[1]; // Return the second segment
        }
        console.error("Could not determine Stream ID from URL path:", window.location.pathname);
        updateStreamStatus(false, "Invalid Link"); // Update UI
        return null; // Or handle error appropriately
    }

    // Function to initialize MediaSource and SourceBuffer
    function initializeMediaSource() {
        if (!MediaSource || !MediaSource.isTypeSupported(MIME_TYPE)) { // Added check for MediaSource existence
            console.error("MediaSource API or MIME type not supported:", MIME_TYPE);
            updateStreamStatus(false, "Browser unsupported");
            alert("Your browser doesn't support the required video format or MediaSource API for this stream.");
            return;
        }

        try {
            mediaSource = new MediaSource();
            videoPlayer.src = URL.createObjectURL(mediaSource);

            mediaSource.addEventListener('sourceopen', handleSourceOpen, { once: true });
            mediaSource.addEventListener('sourceended', () => console.log('MediaSource sourceended. ReadyState:', mediaSource?.readyState));
            mediaSource.addEventListener('sourceclose', () => console.log('MediaSource sourceclose. ReadyState:', mediaSource?.readyState));

        } catch (error) {
            console.error("Error creating MediaSource:", error);
            updateStreamStatus(false, "Playback error");
        }
    }

    function handleSourceOpen() {
        console.log('MediaSource opened. ReadyState:', mediaSource.readyState);
        // Ensure sourceopen isn't called if already closed/ended
        if (mediaSource.readyState !== 'open') {
            console.warn('SourceOpen called but MediaSource state is not "open":', mediaSource.readyState);
            return;
        }
        try {
            // Clean up old source buffer if exists (can happen on reconnect/retry)
            if (sourceBuffer) {
                console.warn("Removing existing source buffer before adding new one.");
                try {
                   mediaSource.removeSourceBuffer(sourceBuffer);
                } catch (removeErr) {
                    console.error("Error removing old source buffer:", removeErr);
                }
                sourceBuffer = null; // Reset reference
                isSourceBufferReady = false;
            }

            sourceBuffer = mediaSource.addSourceBuffer(MIME_TYPE);
            sourceBuffer.mode = 'sequence'; // Important for live streams

            sourceBuffer.addEventListener('updateend', () => {
                // console.log('SourceBuffer updateend. Updating:', sourceBuffer.updating);
                isSourceBufferReady = true; // Mark as ready to accept next chunk
                // Process any queued chunks
                processBufferQueue();
            });

            sourceBuffer.addEventListener('error', (e) => {
                console.error('SourceBuffer error:', e);
                updateStreamStatus(false, "Playback error");
                 // Attempt recovery? Maybe try ending stream and re-initializing on next chunk?
            });
            sourceBuffer.addEventListener('abort', () => {
                 console.warn('SourceBuffer aborted.');
                 isSourceBufferReady = false; // Buffer is no longer valid
            });


            // Start processing queue immediately after buffer is added
            isSourceBufferReady = true;
            processBufferQueue();

        } catch (error) {
            console.error('Error adding SourceBuffer:', error, 'MediaSource ReadyState:', mediaSource.readyState);
            updateStreamStatus(false, "Playback error");
             // If addSourceBuffer fails, mediaSource might be unusable
             if (mediaSource.readyState === 'open') {
                  try { mediaSource.endOfStream(); } catch(e){}
             }
        }
    }

    // Function to add chunks to the buffer or queue them
    function appendChunk(chunk) {
         // Guard against adding chunks if stream ended or buffer errored
         if (!isStreamActive || !sourceBuffer || mediaSource.readyState !== 'open') {
              // console.log("Skipping appendChunk: Stream inactive, no buffer, or MediaSource not open.");
              bufferQueue = []; // Clear queue if stream is inactive
              return;
         }

        if (isSourceBufferReady && !sourceBuffer.updating) {
            try {
                // console.log('Appending buffer chunk. Size:', chunk.byteLength);
                isSourceBufferReady = false; // Mark as busy until updateend
                sourceBuffer.appendBuffer(chunk);
            } catch (error) {
                console.error('Error appending buffer:', error.name, error.message);
                isSourceBufferReady = true; // Mark as ready again on error
                // Handle specific errors
                if (error.name === 'QuotaExceededError') {
                    console.warn('QuotaExceededError: Buffer full. Attempting cleanup.');
                    cleanupBuffer(); // Try cleaning up space
                    // Optionally re-queue the chunk to try again after cleanup
                    // bufferQueue.unshift(chunk);
                } else if (error.name === 'InvalidStateError') {
                     console.error("InvalidStateError appending buffer. MediaSource readyState:", mediaSource.readyState);
                     // This might mean the MediaSource or SourceBuffer is in a bad state. Recovery might involve full reset.
                     updateStreamStatus(false, "Playback Error");
                     isStreamActive = false; // Stop trying to append
                     if (mediaSource.readyState === 'open') mediaSource.endOfStream();
                } else {
                     // Other errors might be fatal for this buffer
                     updateStreamStatus(false, "Playback Error");
                     isStreamActive = false; // Stop trying to append
                }
            }
        } else {
            // If buffer isn't ready or is updating, queue the chunk
            // console.log('Queueing chunk. Buffer ready:', isSourceBufferReady, 'Updating:', sourceBuffer?.updating);
            bufferQueue.push(chunk);
             // Optional: Limit queue size to prevent memory issues
             if (bufferQueue.length > 30) { // Limit queue size (e.g., ~5 seconds at 6 chunks/sec)
                 console.warn("Buffer queue growing large (", bufferQueue.length, "), dropping oldest chunk.");
                 bufferQueue.shift(); // Drop the oldest chunk
             }
        }
    }

    // Process queued chunks when SourceBuffer is ready
    function processBufferQueue() {
         // Ensure we still should be processing
        if (!isStreamActive || !sourceBuffer || sourceBuffer.updating || mediaSource.readyState !== 'open' || !isSourceBufferReady) {
            return;
        }
        if (bufferQueue.length > 0) {
            // console.log('Processing buffer queue. Length:', bufferQueue.length);
            appendChunk(bufferQueue.shift()); // Append the oldest chunk
            // The 'updateend' listener will trigger this function again if needed
        } else {
             // Queue empty, maybe try buffer cleanup if needed
             // cleanupBuffer(); // Maybe call cleanup periodically? Or only on QuotaExceededError?
        }
    }

     // Basic buffer cleanup (remove old segments)
    function cleanupBuffer() {
        if (!sourceBuffer || sourceBuffer.updating || mediaSource.readyState !== 'open') {
            return; // Don't cleanup if busy or not open
        }
        try {
            // Only cleanup if buffer is reasonably large to avoid excessive work
            const buffered = sourceBuffer.buffered;
            if (buffered.length > 0 && videoPlayer.currentTime > 0) {
                 // Keep, for example, the last 30 seconds of buffer relative to current playback time
                const removeEnd = Math.max(0, videoPlayer.currentTime - 30); // Don't remove past 0
                const removeStart = buffered.start(0);

                 if (removeEnd > removeStart) { // Only remove if there's something significant before the keep window
                    console.log(`Cleaning up buffer: Removing from ${removeStart} up to ${removeEnd}`);
                    isSourceBufferReady = false; // Mark busy for removal
                    sourceBuffer.remove(removeStart, removeEnd); // remove() triggers 'updateend'
                 }
            }
        } catch (error) {
            console.error("Error cleaning up buffer:", error.name, error.message);
             isSourceBufferReady = true; // Ensure it becomes ready even on error
        }
    }


    // --- Socket.IO Event Handling ---
    function connectWebSocket() {
        streamId = getStreamIdFromUrl();
        if (!streamId) {
            // updateStreamStatus(false, "Invalid Stream Link"); // Already called in getStreamIdFromUrl
            return;
        }

        addChatMessage({ type: 'system', text: 'Connecting to stream...' });

        // Ensure any previous socket is disconnected
        if (socket && socket.connected) {
            socket.disconnect();
        }

        // IMPORTANT: Use the correct Render URL
        socket = io('https://dropin-43k0.onrender.com', {
            transports: ['websocket'], // Force websockets for better performance/reliability
            // Optional: Add authentication query params if needed
            // query: { token: 'VIEWER_AUTH_TOKEN' }
        });

        socket.on('connect', () => {
            console.log('Socket connected:', socket.id);
            addChatMessage({ type: 'system', text: 'Connected. Joining stream...' });
            // Tell the server which stream we want to join
            socket.emit('join_live_room', { streamId: streamId });
            // Reset state flags on fresh connect
            isStreamActive = true;
            isSourceBufferReady = false; // Will be set by MediaSource events
            bufferQueue = [];
        });

        // Listen for confirmation or initial stream details
        socket.on('stream_details', (details) => {
             console.log("Received stream details:", details);
             streamTitleElement.textContent = details.title || 'Live Stream';
             // Add host name if available: hostNameElement.textContent = `by ${details.hostName || 'Broadcaster'}`;
             updateStreamStatus(details.isLive !== false, details.isLive ? "LIVE" : "Stream Offline");
             if (details.isLive !== false) {
                 if (!mediaSource || mediaSource.readyState === 'closed') {
                    console.log("Initializing MediaSource for live stream.");
                    initializeMediaSource(); // Start playback setup only if confirmed live and not already setup
                 } else {
                     console.log("MediaSource already exists or is opening. State:", mediaSource.readyState);
                 }
             } else {
                 // Stream exists but is not live (e.g., waiting to start or ended before viewer joined)
                 console.log("Stream details indicate stream is not live.");
             }
        });


        // Listen for video/audio chunks
        socket.on('receive_live_chunk', (chunk) => {
             if (!isStreamActive) return; // Don't process if stream is known to be inactive

            // Ensure chunk is ArrayBuffer (Socket.IO v3+ handles binary automatically)
            if (chunk instanceof ArrayBuffer && chunk.byteLength > 0) {
                 // console.log('Received chunk size:', chunk.byteLength);
                 appendChunk(chunk);
                 // Attempt to play if paused (e.g., after buffering or initial load)
                 // Only play if enough data is buffered to avoid immediate stall
                 if (videoPlayer.paused && videoPlayer.readyState >= videoPlayer.HAVE_FUTURE_DATA) {
                      // Check if there's actually buffer ahead of current time
                      const buffered = videoPlayer.buffered;
                      let canPlay = false;
                      for (let i = 0; i < buffered.length; i++) {
                           if (buffered.start(i) <= videoPlayer.currentTime && buffered.end(i) > videoPlayer.currentTime + 0.5) { // Check for at least 0.5s buffer ahead
                                canPlay = true;
                                break;
                           }
                      }
                      if (canPlay) {
                           // console.log("Attempting to play video...");
                           videoPlayer.play().catch(e => console.warn("Autoplay attempt failed or interrupted:", e.name, e.message));
                      } else {
                           // console.log("Video paused, not enough buffer ahead to play.");
                      }
                 }
            } else {
                console.warn("Received invalid data on 'receive_live_chunk'. Type:", typeof chunk, "Size:", chunk?.byteLength);
            }
        });

        socket.on('new_live_comment', (message) => {
            addChatMessage(message);
        });

        socket.on('viewer_count_update', (count) => {
            // Corrected backticks
            viewerCountElement.textContent = `👀 ${count}`;
        });

        socket.on('live_stream_ended', (data) => {
            console.log("Received stream ended signal. Reason:", data?.reason || "N/A");
            addChatMessage({ type: 'system', text: 'Stream has ended.' });
            updateStreamStatus(false, "Stream Ended");
            isStreamActive = false;
            bufferQueue = []; // Clear any pending chunks
            if (mediaSource && mediaSource.readyState === 'open') {
                try {
                    // Important: Ensure source buffer isn't updating before ending stream
                    if (sourceBuffer && !sourceBuffer.updating) {
                        mediaSource.endOfStream();
                        console.log("MediaSource endOfStream called.");
                    } else if (sourceBuffer && sourceBuffer.updating) {
                         console.warn("Stream ended, waiting for SourceBuffer update to finish before calling endOfStream.");
                         // Wait for updateend, then end stream
                         sourceBuffer.addEventListener('updateend', () => {
                              if (mediaSource.readyState === 'open') {
                                   try { mediaSource.endOfStream(); console.log("MediaSource endOfStream called after updateend."); }
                                   catch(e) { console.warn("Error ending MediaSource stream after update:", e); }
                              }
                         }, { once: true });
                    } else {
                        // No source buffer or already ended/closed
                         if (mediaSource.readyState === 'open') mediaSource.endOfStream();
                    }
                } catch (e) {
                    console.warn("Error ending MediaSource stream:", e);
                }
            }
            // Optionally clear video source after a delay to let things settle
            // setTimeout(() => { videoPlayer.src = ''; }, 100);
            chatMessageInput.disabled = true;
            sendChatButton.disabled = true;
        });

        socket.on('connect_error', (err) => {
            console.error('Socket connection error:', err.message, err);
            // Corrected backticks
            addChatMessage({ type: 'system', text: `Connection error: ${err.message}` });
            updateStreamStatus(false, "Connection Error");
            isStreamActive = false;
        });

        socket.on('disconnect', (reason) => {
            console.log('Socket disconnected:', reason);
            // Corrected backticks
            addChatMessage({ type: 'system', text: `Disconnected: ${reason}` });
            updateStreamStatus(false, "Disconnected");
            isStreamActive = false;
             // Handle potential cleanup or reconnection logic here if needed
            if (mediaSource && mediaSource.readyState === 'open') {
                 console.warn("Socket disconnected, ending MediaSource stream.");
                 try {
                      if (sourceBuffer && !sourceBuffer.updating) mediaSource.endOfStream();
                 } catch(e){}
            }
            // videoPlayer.src = ''; // Clear video source on disconnect
        });
    }

    // --- UI Updates & Chat ---
    function updateStreamStatus(isLive, statusText = "LIVE") {
        if (isLive) {
            // Corrected backticks
            liveBadge.textContent = `🔴 ${statusText}`;
            liveBadge.style.color = 'var(--live-red)'; // Use CSS variable
            chatMessageInput.disabled = false;
            sendChatButton.disabled = false;
            // Only set isStreamActive if status is actually LIVE
            if (statusText === "LIVE") isStreamActive = true;
        } else {
            // Corrected backticks
            liveBadge.textContent = `⚫ ${statusText}`; // Use black circle for offline/ended
            liveBadge.style.color = '#666'; // Grey color
            chatMessageInput.disabled = true;
            sendChatButton.disabled = true;
            isStreamActive = false; // Ensure stream is marked inactive
        }
    }

    function addChatMessage(message) {
        const item = document.createElement('li');
        item.classList.add('chat-message');
        if (message.type === 'system') {
            item.classList.add('system');
            // Corrected backticks
            item.innerHTML = `<span>${message.text}</span>`;
        } else {
             // Basic sanitization to prevent HTML injection
            const safeUsername = (message.username || 'User').replace(/</g, "<").replace(/>/g, ">");
            const safeText = (message.text || '').replace(/</g, "<").replace(/>/g, ">");
            // Corrected backticks
            item.innerHTML = `<strong>${safeUsername}:</strong> <span>${safeText}</span>`; // Added colon for clarity
        }
        chatFeedList.appendChild(item);
        // Auto-scroll only if user is near the bottom
        const container = chatFeedList.parentElement; // Scroll the container div
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
             // Optional: Add visual feedback like a flying emoji on the screen
             // createFlyingEmoji(reaction);
         }
    }

    // --- Event Listeners ---
    sendChatButton.addEventListener('click', sendChatMessage);
    chatMessageInput.addEventListener('keypress', (event) => {
        if (event.key === 'Enter' && !event.shiftKey) { // Send on Enter, allow Shift+Enter for newline (though textarea might be better)
            event.preventDefault(); // Prevent default form submission/newline in input
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

    // Attempt to play video on interaction if needed (browsers often block autoplay with sound initially)
    videoPlayer.addEventListener('click', () => {
        if (videoPlayer.paused) {
            console.log("User clicked video, attempting play...");
            videoPlayer.play().catch(e => console.warn("Manual play failed:", e.name, e.message));
        }
        // Unmute on first interaction - might be desirable
        if (videoPlayer.muted) {
            console.log("User clicked video, unmuting.");
            videoPlayer.muted = false;
        }
    });

    // --- Start Connection ---
    connectWebSocket();

}); // End DOMContentLoaded