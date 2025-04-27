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
    let socket = null; // Keep socket variable declaration here
    let mediaSource = null;
    let sourceBuffer = null;
    let streamId = null; // Will be extracted from URL or elsewhere
    let bufferQueue = []; // Queue for chunks arriving before SourceBuffer is ready
    let isSourceBufferReady = false;
    let isStreamActive = false; // Track if stream is supposed to be playing

    // 1) Force the websocket layer to give you ArrayBuffers
    socket = io('https://dropin-43k0.onrender.com', {
      transports: ['websocket'],
      transportOptions: {
        websocket: { binaryType: 'arraybuffer' } // <<<--- Set binaryType here
      }
      // Optional: Add authentication query params if needed
      // query: { token: 'VIEWER_AUTH_TOKEN' }
    });
    // REMOVED: socket.binaryType = 'arraybuffer'; // <<<--- No longer needed here

    // 2) Normalize to the exact MSE-expected string
    const rawMimeTypeFromBroadcaster = 'video/webm;codecs=vp8,opus'; // Based on broadcaster log
    // Format needed for MSE: space after semicolon, quotes around codecs
    const FORMATTED_MSE_MIME_TYPE = rawMimeTypeFromBroadcaster.replace(';codecs=', '; codecs="') + '"';
    // => 'video/webm; codecs="vp8,opus"'

    // Check if the *formatted* type is supported
    if (!MediaSource.isTypeSupported(FORMATTED_MSE_MIME_TYPE)) {
      alert("❌ Your browser doesn’t support the required video format (video/webm; codecs=\"vp8,opus\").");
      // Cannot proceed if the format isn't supported
      console.error("❌ Browser does not support required MSE MIME type:", FORMATTED_MSE_MIME_TYPE);
      return; // Stop execution here
    } else {
        console.log("✅ Using MSE mime-type:", FORMATTED_MSE_MIME_TYPE);
    }
    // REMOVED: MIME_CANDIDATES array and find logic


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
        // Check MediaSource API itself first
        if (!window.MediaSource) {
            console.error("MediaSource API not supported in this browser.");
            updateStreamStatus(false, "Browser unsupported");
            alert("Your browser doesn't support the MediaSource API required for this stream.");
            return;
        }
        // MIME type support is already checked above

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
        // MIME_TYPE support is checked globally now.

        try {
            // Clean up old source buffer if exists (can happen on reconnect/retry)
            if (sourceBuffer) {
                console.warn("Removing existing source buffer before adding new one.");
                try {
                   // Check if mediaSource is still open before removing
                   if(mediaSource.readyState === 'open') {
                       mediaSource.removeSourceBuffer(sourceBuffer);
                   }
                } catch (removeErr) {
                    // Ignore errors removing old buffer if it's already detached or invalid
                    console.warn("Non-critical error removing old source buffer:", removeErr);
                }
                sourceBuffer = null; // Reset reference
                isSourceBufferReady = false;
            }

            console.log("Attempting to addSourceBuffer with:", FORMATTED_MSE_MIME_TYPE);
            sourceBuffer = mediaSource.addSourceBuffer(FORMATTED_MSE_MIME_TYPE); // Use the exact formatted string
            sourceBuffer.mode = 'sequence'; // Important for live streams

            sourceBuffer.addEventListener('updateend', () => {
                // console.log('SourceBuffer updateend. Updating:', sourceBuffer.updating);
                isSourceBufferReady = true; // Mark as ready to accept next chunk
                // Process any queued chunks
                processBufferQueue();
            });

            sourceBuffer.addEventListener('error', (e) => {
                // Log the specific event if possible, otherwise just the fact
                const errorDetail = sourceBuffer.error || e;
                console.error('SourceBuffer error event:', errorDetail);
                updateStreamStatus(false, "Playback error");
                // Potentially more drastic error handling needed here
                isStreamActive = false; // Stop trying to append on buffer error
                bufferQueue = [];
                 if (mediaSource.readyState === 'open') {
                      try { mediaSource.endOfStream(); } catch(eosErr){}
                 }
            });
            sourceBuffer.addEventListener('abort', () => {
                 console.warn('SourceBuffer aborted.');
                 isSourceBufferReady = false; // Buffer is no longer valid
            });


            // Start processing queue immediately after buffer is added
            isSourceBufferReady = true;
            processBufferQueue();

        } catch (error) {
            console.error('Error adding SourceBuffer:', error, 'MediaSource ReadyState:', mediaSource.readyState, 'MIME Type:', FORMATTED_MSE_MIME_TYPE);
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
              if (bufferQueue.length > 0) {
                   console.warn("Clearing buffer queue as stream is inactive or buffer invalid.");
                   bufferQueue = []; // Clear queue if stream is inactive
              }
              return;
         }

        if (isSourceBufferReady && !sourceBuffer.updating) {
            try {
                // console.log('Appending buffer chunk. Size:', chunk.byteLength);
                isSourceBufferReady = false; // Mark as busy until updateend
                sourceBuffer.appendBuffer(chunk); // Append the ArrayBuffer directly
            } catch (error) {
                // Specific catch block as requested
                console.error("❌ appendBuffer threw:", error);
                isSourceBufferReady = true; // Mark as ready again on error, although the buffer might be broken

                // Handle specific errors if needed, or rely on the 'error' event listener
                if (error.name === 'QuotaExceededError') {
                    console.warn('QuotaExceededError directly from appendBuffer. Attempting cleanup.');
                    cleanupBuffer();
                     // Re-queueing might cause infinite loops if cleanup fails repeatedly
                     // bufferQueue.unshift(chunk);
                } else {
                    // For other errors caught here, the buffer is likely unusable.
                    updateStreamStatus(false, "Playback Error");
                    isStreamActive = false; // Stop trying to append
                    if (mediaSource.readyState === 'open') {
                        try { mediaSource.endOfStream(); } catch(eosErr) {}
                    }
                }
            }
        } else {
            // If buffer isn't ready or is updating, queue the chunk
            // console.log('Queueing chunk. Buffer ready:', isSourceBufferReady, 'Updating:', sourceBuffer?.updating);
            bufferQueue.push(chunk);
             // Optional: Limit queue size to prevent memory issues
             if (bufferQueue.length > 50) { // Increased limit slightly
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
        while (bufferQueue.length > 0 && isSourceBufferReady && !sourceBuffer.updating && isStreamActive && mediaSource.readyState === 'open') {
            // console.log('Processing buffer queue. Length:', bufferQueue.length);
            const chunkToAppend = bufferQueue.shift(); // Get the oldest chunk
            appendChunk(chunkToAppend); // Attempt to append it
            // appendChunk sets isSourceBufferReady to false syncronously, so the loop should pause until 'updateend'
        }
    }

     // Basic buffer cleanup (remove old segments)
    function cleanupBuffer() {
        if (!sourceBuffer || sourceBuffer.updating || mediaSource.readyState !== 'open') {
            return; // Don't cleanup if busy or not open
        }
        try {
            const buffered = sourceBuffer.buffered;
            const currentTime = videoPlayer.currentTime;
            // Only cleanup if buffer exists and we have a current time
            if (buffered.length > 0 && currentTime > 0) {
                 // Define a threshold, e.g., keep last 30 seconds + a little buffer
                const keepDuration = 30;
                const removalPoint = Math.max(0, currentTime - keepDuration);
                const bufferedStart = buffered.start(0); // Start of the entire buffered range

                 // Only remove if there's a significant amount to remove
                 if (removalPoint > bufferedStart) {
                    console.log(`Buffer cleanup: Removing from ${bufferedStart} to ${removalPoint} (Current time: ${currentTime})`);
                    isSourceBufferReady = false; // Mark busy for removal
                    sourceBuffer.remove(bufferedStart, removalPoint); // remove() triggers 'updateend'
                 } else {
                    // console.log(`Buffer cleanup skipped: Removal point ${removalPoint} not significantly ahead of buffer start ${bufferedStart}`);
                 }
            }
        } catch (error) {
            console.error("Error during buffer cleanup:", error.name, error.message);
             // Don't assume ready=true here, let 'updateend' or 'error' handle state
             isSourceBufferReady = true; // Resetting cautiously, might be better to let updateend handle it
        }
    }


    // --- Socket.IO Event Handling ---
    function connectWebSocket() {
        streamId = getStreamIdFromUrl();
        if (!streamId) {
            // updateStreamStatus called in getStreamIdFromUrl
            return;
        }

        addChatMessage({ type: 'system', text: 'Connecting to stream...' });

        // Socket is already initialized globally with transportOptions.
        // Ensure listeners are clean before attaching.
        socket.off('connect');
        socket.off('stream_details');
        socket.off('receive_live_chunk');
        socket.off('new_live_comment');
        socket.off('viewer_count_update');
        socket.off('live_stream_ended');
        socket.off('connect_error');
        socket.off('disconnect');
        socket.off('broadcast_reaction');

        // Attach listeners
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
                     console.log("MediaSource already exists or is opening/open. State:", mediaSource.readyState);
                      // If MediaSource exists but is open, maybe re-add buffer if needed? Risky.
                      // Safest is usually to let existing logic handle it or require refresh on errors.
                 }
             } else {
                 // Stream exists but is not live
                 console.log("Stream details indicate stream is not currently live.");
                 if (mediaSource && mediaSource.readyState === 'open') {
                     console.log("Closing existing MediaSource as stream is not live.");
                     try { mediaSource.endOfStream(); } catch (e) {}
                 }
             }
        });


        // Listen for video/audio chunks
        socket.on('receive_live_chunk', (chunk) => { // No longer needs async
             if (!isStreamActive) return; // Don't process if stream is known to be inactive

             // Expecting ArrayBuffer due to transportOptions
             if (chunk instanceof ArrayBuffer && chunk.byteLength > 0) {
                 // console.log('Received chunk size:', chunk.byteLength);
                 appendChunk(chunk); // Append the received ArrayBuffer

                 // Attempt to play if paused
                 if (videoPlayer.paused && videoPlayer.readyState >= videoPlayer.HAVE_FUTURE_DATA) {
                      const buffered = videoPlayer.buffered;
                      let canPlay = false;
                      if (buffered.length > 0) {
                           const currentBufferEnd = buffered.end(buffered.length - 1);
                           // Check if buffer extends beyond current time significantly enough
                           if (currentBufferEnd > videoPlayer.currentTime + 0.2) {
                               canPlay = true;
                           }
                      }

                      if (canPlay) {
                           // console.log("Attempting to play video...");
                           videoPlayer.play().catch(e => {
                               // Ignore common interruptions or already playing errors
                               if (e.name !== 'AbortError' && e.name !== 'NotAllowedError') {
                                   console.warn("Autoplay attempt failed:", e.name, e.message);
                               }
                           });
                      } else {
                           // console.log("Video paused, not enough buffer ahead to play yet.");
                      }
                 }
            } else if (chunk instanceof ArrayBuffer && chunk.byteLength === 0) {
                // Ignore empty chunks
            } else {
                 // Log unexpected types, though should be prevented by transportOptions
                console.warn("Received unexpected data type on 'receive_live_chunk'. Expected ArrayBuffer, got:", typeof chunk);
                if (chunk instanceof Blob) {
                    console.warn("-> Chunk was a Blob. Check socket transportOptions.");
                }
            }
        });

        socket.on('new_live_comment', (message) => {
            addChatMessage(message);
        });

        socket.on('viewer_count_update', (count) => {
            viewerCountElement.textContent = `👀 ${count}`;
        });

        // Listen for reactions broadcast by the server
        socket.on('broadcast_reaction', (data) => {
            if (data && data.reaction) {
                // Placeholder: Implement visual feedback for the reaction
                // console.log(`Reaction received: ${data.reaction}`);
                // createFlyingEmoji(data.reaction); // Example function call
            }
        });


        socket.on('live_stream_ended', (data) => {
            console.log("Received stream ended signal. Reason:", data?.reason || "N/A");
            addChatMessage({ type: 'system', text: 'Stream has ended.' });
            updateStreamStatus(false, "Stream Ended");
            isStreamActive = false;
            bufferQueue = []; // Clear any pending chunks
            if (mediaSource && mediaSource.readyState === 'open') {
                try {
                    // Wait for potential final buffer update before ending
                    if (sourceBuffer && !sourceBuffer.updating) {
                        mediaSource.endOfStream();
                        console.log("MediaSource endOfStream called.");
                    } else if (sourceBuffer && sourceBuffer.updating) {
                         console.warn("Stream ended, waiting for SourceBuffer update to finish before calling endOfStream.");
                         const endStreamAfterUpdate = () => {
                             if (mediaSource && mediaSource.readyState === 'open') {
                                  try { mediaSource.endOfStream(); console.log("MediaSource endOfStream called after updateend."); }
                                  catch(e) { console.warn("Error ending MediaSource stream after update:", e); }
                             }
                         };
                         sourceBuffer.addEventListener('updateend', endStreamAfterUpdate, { once: true });
                         // Safety timeout
                         setTimeout(() => {
                             sourceBuffer?.removeEventListener('updateend', endStreamAfterUpdate);
                             endStreamAfterUpdate(); // Attempt regardless after timeout
                         } , 500); // Shorter timeout
                    } else {
                         mediaSource.endOfStream(); // No buffer or not updating
                    }
                } catch (e) {
                    console.warn("Error ending MediaSource stream:", e);
                }
            }
            chatMessageInput.disabled = true;
            sendChatButton.disabled = true;
        });

        socket.on('connect_error', (err) => {
            console.error('Socket connection error:', err.message, err);
            addChatMessage({ type: 'system', text: `Connection error: ${err.message}` });
            updateStreamStatus(false, "Connection Error");
            isStreamActive = false;
        });

        socket.on('disconnect', (reason) => {
            console.log('Socket disconnected:', reason);
            addChatMessage({ type: 'system', text: `Disconnected: ${reason}` });
            updateStreamStatus(false, "Disconnected");
            isStreamActive = false;
            if (mediaSource && mediaSource.readyState === 'open') {
                 console.warn("Socket disconnected, attempting to end MediaSource stream.");
                 try {
                      if (!sourceBuffer || !sourceBuffer.updating) {
                          mediaSource.endOfStream();
                      } else {
                           console.warn("SourceBuffer was updating on disconnect, stream might not end cleanly.");
                           // Less safe, but attempt to close anyway after a small delay
                           setTimeout(() => {
                               if (mediaSource.readyState === 'open') {
                                   try { mediaSource.endOfStream(); } catch (e) {}
                               }
                           }, 100);
                      }
                 } catch(e){
                     console.warn("Error ending MediaSource stream on disconnect:", e);
                 }
            }
            // videoPlayer.src = ''; // Optionally clear video source
        });

        // Initiate the connection if the socket isn't already connected or connecting
        if (!socket.connected && !socket.connecting) {
            console.log("Attempting socket connection...");
            socket.connect();
        } else if (socket.connected) {
             console.log("Socket already connected, emitting join_live_room for:", streamId);
             socket.emit('join_live_room', { streamId: streamId });
             isStreamActive = true; // Assume stream might be active
             isSourceBufferReady = false;
             bufferQueue = [];
             // If already connected, and MediaSource exists but is closed, re-initialize
             if (mediaSource && mediaSource.readyState === 'closed') {
                 console.log("Re-initializing MediaSource on already connected socket.");
                 initializeMediaSource();
             } else if (!mediaSource) {
                 // If no MediaSource exists yet, wait for stream_details
                 console.log("No MediaSource yet, waiting for stream_details.");
             }
        } else {
            // Socket is connecting, wait for 'connect' event
            console.log("Socket is currently connecting...");
        }
    }

    // --- UI Updates & Chat ---
    function updateStreamStatus(isLive, statusText = "LIVE") {
        if (isLive) {
            liveBadge.textContent = `🔴 ${statusText}`;
            liveBadge.style.color = 'var(--live-red)'; // Use CSS variable
            chatMessageInput.disabled = false;
            sendChatButton.disabled = false;
            // Only set isStreamActive if status is actually LIVE and confirmed
            if (statusText === "LIVE") isStreamActive = true;
        } else {
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
            item.innerHTML = `<span>${message.text}</span>`;
        } else {
             // Basic sanitization to prevent HTML injection
            const safeUsername = (message.username || 'User').replace(/</g, "<").replace(/>/g, ">");
            const safeText = (message.text || '').replace(/</g, "<").replace(/>/g, ">");
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
        if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
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

    // Attempt to play video on interaction if needed
    videoPlayer.addEventListener('click', () => {
        if (videoPlayer.paused) {
            console.log("User clicked video, attempting play...");
            videoPlayer.play().catch(e => console.warn("Manual play failed:", e.name, e.message));
        }
        if (videoPlayer.muted) {
            console.log("User clicked video, unmuting.");
            videoPlayer.muted = false;
        }
    });

    // --- Start Connection ---
    connectWebSocket();

}); // End DOMContentLoaded