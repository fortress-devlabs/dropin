// v31.0: Add MIME probe, first chunk logging, use broadcaster MIME type, refactor addSourceBuffer logic.
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
    let streamId = null;
    let bufferQueue = [];
    let isSourceBufferReady = false; // Flag if SB is added and ready for appendBuffer
    let isStreamActive = false;
    let receivedMimeType = null; // Store mimeType from broadcaster
    let isMediaSourceOpen = false; // Flag if 'sourceopen' has fired
    let sawFirstChunk = false; // Flag for logging first chunk bytes

    // Initialize socket with ArrayBuffer transport option
    socket = io('https://dropin-43k0.onrender.com', {
      transports: ['websocket'],
      transportOptions: {
        websocket: { binaryType: 'arraybuffer' }
      }
    });

    // --- Debugging & Initialization ---

    // Function to probe MIME type variants (as provided in instructions)
    function debugMimeVariants(ms) {
        // Check if MediaSource object is valid and open
        if (!ms || ms.readyState !== 'open') {
            console.warn("debugMimeVariants called but MediaSource is not open or valid.");
            return;
        }
        const variants = [
            'video/webm;codecs=vp8,opus',       // Raw, no space, no quotes
            'video/webm; codecs=vp8,opus',      // Space, no quotes
            'video/webm;codecs="vp8,opus"',     // No space, quotes
            'video/webm; codecs="vp8,opus"',    // Space, quotes (often the one needed by MSE)
            'video/webm'                        // Container only
        ];

        console.group("🎯 MIME variant support test");
        variants.forEach(v => {
            let sb = null; // Declare sb here to ensure it's accessible in finally
            try {
                const ok = MediaSource.isTypeSupported(v);
                console.log(`- Checking variant: "${v}" -> isTypeSupported: ${ok}`);
                if (!ok) throw new Error("isTypeSupported returned false");

                // Attempt to add and immediately remove a SourceBuffer
                sb = ms.addSourceBuffer(v);
                console.log(`  ✅ addSourceBuffer OK for → "${v}"`);
            } catch (e) {
                console.warn(`  ❌ addSourceBuffer FAILED for → "${v}"`, e.message || e);
            } finally {
                // Ensure buffer is removed if it was successfully added
                if (sb && ms.readyState === 'open') {
                    try {
                        ms.removeSourceBuffer(sb);
                        // console.log(`  🧹 Cleaned up test SourceBuffer for "${v}"`);
                    } catch (removeError) {
                        console.warn(`  ⚠️ Error removing test SourceBuffer for "${v}"`, removeError);
                    }
                }
            }
        });
        console.groupEnd();
    }


    // Function to extract Stream ID from URL
    function getStreamIdFromUrl() {
        const pathSegments = window.location.pathname.split('/').filter(Boolean);
        if (pathSegments.length === 2 && pathSegments[0].toLowerCase() === 'watch') {
             return pathSegments[1];
        }
        console.error("Could not determine Stream ID from URL path:", window.location.pathname);
        updateStreamStatus(false, "Invalid Link");
        return null;
    }

    // Function to initialize MediaSource object
    function initializeMediaSource() {
        if (!window.MediaSource) {
            console.error("MediaSource API not supported.");
            updateStreamStatus(false, "Browser unsupported");
            alert("Your browser doesn't support the MediaSource API required for this stream.");
            return;
        }

        // Clean up previous MediaSource if any
        if (mediaSource && mediaSource.readyState !== 'closed') {
             console.warn("Cleaning up existing MediaSource object.");
             try {
                 if (videoPlayer.src) {
                      URL.revokeObjectURL(videoPlayer.src);
                      videoPlayer.src = '';
                      videoPlayer.removeAttribute('src'); // Force removal
                 }
                 // Attempt to end stream if open
                  if (mediaSource.readyState === 'open') {
                       mediaSource.endOfStream();
                  }
             } catch(e) { console.warn("Error during old MediaSource cleanup:", e); }
        }
        // Reset related state
        mediaSource = null;
        sourceBuffer = null;
        isMediaSourceOpen = false;
        isSourceBufferReady = false;
        bufferQueue = []; // Clear queue on re-initialization

        try {
            console.log("Creating new MediaSource instance.");
            mediaSource = new MediaSource();
            videoPlayer.src = URL.createObjectURL(mediaSource);

            mediaSource.addEventListener('sourceopen', handleSourceOpen, { once: true });
            mediaSource.addEventListener('sourceended', () => console.log('MediaSource sourceended. ReadyState:', mediaSource?.readyState));
            mediaSource.addEventListener('sourceclose', () => {
                console.log('MediaSource sourceclose. ReadyState:', mediaSource?.readyState);
                // Reset flags when source closes
                isMediaSourceOpen = false;
                isSourceBufferReady = false;
            });

        } catch (error) {
            console.error("Error creating MediaSource:", error);
            updateStreamStatus(false, "Playback error");
        }
    }

    // Called when MediaSource is ready
    function handleSourceOpen() {
        console.log('MediaSource opened. ReadyState:', mediaSource.readyState);
        isMediaSourceOpen = true;

        // Run the debug probe
        debugMimeVariants(mediaSource);

        // Attempt to add the source buffer *if* we have already received the mimeType
        if (receivedMimeType) {
            console.log("MediaSource opened and mimeType was already received. Attempting addSourceBuffer.");
            addSourceBuffer();
        } else {
             console.log("MediaSource opened, waiting for stream_details to receive mimeType.");
        }
    }

    // Function to add the SourceBuffer (needs MediaSource open and mimeType known)
    function addSourceBuffer() {
        // Guard conditions
        if (!isMediaSourceOpen) {
            console.warn("addSourceBuffer called but MediaSource is not open.");
            return;
        }
        if (!receivedMimeType) {
            console.warn("addSourceBuffer called but mimeType is not known.");
            return;
        }
        if (sourceBuffer) {
             console.warn("addSourceBuffer called but sourceBuffer already exists.");
             return; // Avoid adding multiple buffers
        }
        // Check MediaSource state again just before adding
        if (mediaSource.readyState !== 'open') {
             console.error("MediaSource state is not 'open' right before addSourceBuffer. Aborting.");
             isMediaSourceOpen = false; // Update flag
             return;
        }

        console.log(`Attempting to addSourceBuffer with received mimeType: "${receivedMimeType}"`);
        try {
            // Use the mimeType received from the broadcaster
            sourceBuffer = mediaSource.addSourceBuffer(receivedMimeType);
            sourceBuffer.mode = 'sequence';
            console.log("✅ SourceBuffer added successfully.");

            sourceBuffer.addEventListener('updateend', () => {
                isSourceBufferReady = true;
                processBufferQueue();
            });
            sourceBuffer.addEventListener('error', (e) => {
                console.error('SourceBuffer error event:', sourceBuffer.error || e);
                updateStreamStatus(false, "Playback error");
                isStreamActive = false;
                isSourceBufferReady = false; // SB no longer ready
                bufferQueue = [];
                if (mediaSource.readyState === 'open') {
                    try { mediaSource.endOfStream(); } catch(eosErr){}
                }
            });
            sourceBuffer.addEventListener('abort', () => {
                 console.warn('SourceBuffer aborted.');
                 isSourceBufferReady = false;
            });

            // Set ready and process queue immediately after adding
            isSourceBufferReady = true;
            processBufferQueue();

        } catch (error) {
            console.error(`❌ Error adding SourceBuffer with mimeType "${receivedMimeType}":`, error);
            updateStreamStatus(false, "Playback error");
            // If addSourceBuffer fails, the MediaSource might be unusable
            if (mediaSource.readyState === 'open') {
                try { mediaSource.endOfStream(); } catch(e){}
            }
        }
    }


    // Function to append chunks
    function appendChunk(chunk) {
         if (!isStreamActive || !sourceBuffer || !isSourceBufferReady || mediaSource.readyState !== 'open') {
              if (!isStreamActive) console.warn("Skipping appendChunk: Stream not active.");
              else if (!sourceBuffer) console.warn("Skipping appendChunk: SourceBuffer doesn't exist.");
              else if (!isSourceBufferReady) console.warn("Skipping appendChunk: SourceBuffer not ready (maybe updating or errored).");
              else if (mediaSource.readyState !== 'open') console.warn("Skipping appendChunk: MediaSource not open.");

              // Don't clear queue here, wait for stream end or explicit error
              return;
         }

        if (!sourceBuffer.updating) {
            try {
                // console.log('Appending buffer chunk. Size:', chunk.byteLength);
                isSourceBufferReady = false; // Mark as busy until updateend
                sourceBuffer.appendBuffer(chunk);
            } catch (error) {
                console.error("❌ appendBuffer threw:", error);
                // Attempt recovery or state reset depending on error
                isSourceBufferReady = true; // Cautiously reset flag, may need error handler intervention
                if (error.name === 'QuotaExceededError') {
                    console.warn('QuotaExceededError: Buffer full. Attempting cleanup.');
                    cleanupBuffer();
                    // Avoid re-queueing immediately to prevent potential loops
                } else {
                    updateStreamStatus(false, "Playback Error");
                    isStreamActive = false;
                    if (mediaSource.readyState === 'open') {
                        try { mediaSource.endOfStream(); } catch(eosErr) {}
                    }
                }
            }
        } else {
            // console.log('Queueing chunk, SourceBuffer is updating.');
            bufferQueue.push(chunk);
             if (bufferQueue.length > 50) {
                 console.warn("Buffer queue limit reached (", bufferQueue.length, "), dropping oldest chunk.");
                 bufferQueue.shift();
             }
        }
    }

    // Process queued chunks
    function processBufferQueue() {
        if (!isStreamActive || !sourceBuffer || !isSourceBufferReady || mediaSource.readyState !== 'open') {
            return;
        }
        while (bufferQueue.length > 0 && isSourceBufferReady && !sourceBuffer.updating) {
            const chunkToAppend = bufferQueue.shift();
            // console.log(`Processing queue. Appending chunk size: ${chunkToAppend.byteLength}. Queue left: ${bufferQueue.length}`);
            appendChunk(chunkToAppend);
        }
    }

     // Buffer cleanup logic
    function cleanupBuffer() {
        if (!sourceBuffer || sourceBuffer.updating || mediaSource.readyState !== 'open') {
            return;
        }
        try {
            const buffered = sourceBuffer.buffered;
            const currentTime = videoPlayer.currentTime;
            if (buffered.length > 0 && currentTime > 0) {
                const keepDuration = 30; // Keep last 30 seconds
                const removalPoint = Math.max(0, currentTime - keepDuration);
                const bufferedStart = buffered.start(0);
                if (removalPoint > bufferedStart + 1) { // Only remove if more than 1s difference
                    console.log(`Buffer cleanup: Removing ${bufferedStart.toFixed(2)} to ${removalPoint.toFixed(2)} (Current: ${currentTime.toFixed(2)})`);
                    isSourceBufferReady = false; // Mark busy
                    sourceBuffer.remove(bufferedStart, removalPoint);
                 }
            }
        } catch (error) {
            console.error("Error during buffer cleanup:", error);
             isSourceBufferReady = true; // Reset cautiously on error
        }
    }


    // --- Socket.IO Event Handling ---
    function connectWebSocket() {
        streamId = getStreamIdFromUrl();
        if (!streamId) return;

        addChatMessage({ type: 'system', text: 'Connecting to stream...' });

        // Clean up listeners before attaching
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
            socket.emit('join_live_room', { streamId: streamId });
            // Reset flags on *new* successful connection
            isStreamActive = false; // Wait for stream_details to confirm live status
            isMediaSourceOpen = false;
            isSourceBufferReady = false;
            receivedMimeType = null;
            sawFirstChunk = false;
            bufferQueue = [];
            // If MediaSource existed, it needs re-init
            if (mediaSource) {
                 console.log("Socket reconnected, ensuring MediaSource is re-initialized if needed.");
                 // Let stream_details handle the re-init based on live status
            }
        });

        socket.on('stream_details', (details) => {
             console.log("Received stream details:", details);
             streamTitleElement.textContent = details.title || 'Live Stream';
             updateStreamStatus(details.isLive !== false, details.isLive ? "LIVE" : "Stream Offline");

             if (details.isLive !== false) {
                 isStreamActive = true; // Mark stream as active
                 // Store the received mimeType (critical step)
                 if (details.mimeType) {
                      console.log(`Received mimeType from server: "${details.mimeType}"`);
                      // Basic validation - check if it's a non-empty string
                      if (typeof details.mimeType === 'string' && details.mimeType.trim().length > 0) {
                           receivedMimeType = details.mimeType;
                           // Check if the browser *actually* supports this exact type
                           if (!MediaSource.isTypeSupported(receivedMimeType)) {
                                console.error(`Browser reports it does NOT support the received MIME type: "${receivedMimeType}"`);
                                alert(`Playback error: Browser doesn't support the stream format (${receivedMimeType})`);
                                updateStreamStatus(false, "Unsupported Format");
                                isStreamActive = false;
                                receivedMimeType = null; // Invalidate mime type
                                return; // Stop processing this stream detail
                           }
                      } else {
                           console.error("Received invalid mimeType value from server:", details.mimeType);
                           alert("Playback error: Invalid stream format information received.");
                           updateStreamStatus(false, "Stream Config Error");
                           isStreamActive = false;
                           return;
                      }

                 } else {
                      console.error("Stream details received, but 'mimeType' field is missing!");
                      alert("Playback error: Stream format information missing.");
                      updateStreamStatus(false, "Stream Config Error");
                      isStreamActive = false;
                      return; // Cannot proceed without mimeType
                 }

                 // Initialize MediaSource if it doesn't exist or is closed
                 if (!mediaSource || mediaSource.readyState === 'closed') {
                    console.log("Stream is live, initializing MediaSource.");
                    initializeMediaSource();
                 } else {
                      console.log("MediaSource already exists and is opening/open.");
                 }

                 // If MediaSource is already open *and* we just got the mimeType, try adding buffer
                 if (isMediaSourceOpen && receivedMimeType) {
                     console.log("stream_details received, MediaSource is already open. Attempting addSourceBuffer.");
                     addSourceBuffer();
                 }

             } else { // Stream is NOT live
                 isStreamActive = false;
                 receivedMimeType = null; // Clear mime type if stream not live
                 if (mediaSource && mediaSource.readyState === 'open') {
                     console.log("Stream is not live, closing open MediaSource.");
                     try { mediaSource.endOfStream(); } catch (e) {}
                 }
             }
        });


        // Listen for video/audio chunks
        socket.on('receive_live_chunk', (chunk) => {
             if (!isStreamActive) return; // Ignore chunks if stream isn't active

             // Expecting ArrayBuffer
             if (!(chunk instanceof ArrayBuffer)) {
                  console.warn("Received chunk is not an ArrayBuffer. Type:", typeof chunk);
                  return;
             }
             if (chunk.byteLength === 0) {
                 console.log("Received empty chunk, skipping.");
                 return;
             }

             // Log first chunk's header bytes (Instruction #2)
             if (!sawFirstChunk) {
                sawFirstChunk = true;
                const header = new Uint8Array(chunk).subarray(0, 16); // Get first 16 bytes
                const hexHeader = Array.from(header).map(b => b.toString(16).padStart(2, '0')).join(' ');
                console.log("▶️ First 16 bytes of first chunk:", hexHeader);
                // Check if it looks like EBML/WebM: 1a 45 df a3 ...
                if (header[0] === 0x1a && header[1] === 0x45 && header[2] === 0xdf && header[3] === 0xa3) {
                    console.log("  ✅ Header looks like WebM EBML.");
                } else {
                    console.warn("  ⚠️ First chunk header doesn't match expected WebM EBML signature!");
                }
             }

             // Append the chunk
             appendChunk(chunk);

             // Attempt to play if paused
             if (videoPlayer.paused && videoPlayer.readyState >= videoPlayer.HAVE_METADATA) { // Can play once metadata is known
                 if (sourceBuffer && sourceBuffer.buffered.length > 0) {
                     const bufferedEnd = sourceBuffer.buffered.end(sourceBuffer.buffered.length - 1);
                     // Only play if there's some buffer ahead of current time
                     if (bufferedEnd > videoPlayer.currentTime + 0.1) {
                        // console.log("Attempting to play video...");
                        videoPlayer.play().catch(e => {
                            if (e.name !== 'AbortError' && e.name !== 'NotAllowedError') {
                                console.warn("Autoplay attempt failed:", e.name, e.message);
                            }
                        });
                     }
                 }
             }
        });

        socket.on('new_live_comment', (message) => {
            addChatMessage(message);
        });

        socket.on('viewer_count_update', (count) => {
            viewerCountElement.textContent = `👀 ${count}`;
        });

        socket.on('broadcast_reaction', (data) => {
            if (data && data.reaction) { /* Placeholder */ }
        });

        socket.on('live_stream_ended', (data) => {
            console.log("Received live_stream_ended signal. Reason:", data?.reason || "N/A");
            addChatMessage({ type: 'system', text: 'Stream has ended.' });
            updateStreamStatus(false, "Stream Ended");
            isStreamActive = false;
            receivedMimeType = null; // Clear mime type
            bufferQueue = [];
            if (mediaSource && mediaSource.readyState === 'open') {
                console.log("Attempting to cleanly end MediaSource stream.");
                try {
                    if (sourceBuffer && !sourceBuffer.updating) {
                        mediaSource.endOfStream();
                    } else if (sourceBuffer && sourceBuffer.updating) {
                         console.warn("Stream ended while SourceBuffer updating, waiting briefly...");
                         const endStreamAfterUpdate = () => {
                             if (mediaSource && mediaSource.readyState === 'open') {
                                  try { mediaSource.endOfStream(); console.log("MediaSource endOfStream called after update."); }
                                  catch(e) { console.warn("Error ending MediaSource stream post-update:", e); }
                             }
                         };
                         sourceBuffer.addEventListener('updateend', endStreamAfterUpdate, { once: true });
                         setTimeout(() => { // Safety net
                             sourceBuffer?.removeEventListener('updateend', endStreamAfterUpdate);
                             endStreamAfterUpdate();
                         }, 500);
                    } else {
                         mediaSource.endOfStream(); // No buffer or not updating
                    }
                } catch (e) {
                    console.warn("Error during MediaSource endOfStream:", e);
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
            receivedMimeType = null;
        });

        socket.on('disconnect', (reason) => {
            console.log('Socket disconnected:', reason);
            addChatMessage({ type: 'system', text: `Disconnected: ${reason}` });
            updateStreamStatus(false, "Disconnected");
            isStreamActive = false;
            receivedMimeType = null;
            if (mediaSource && mediaSource.readyState === 'open') {
                 console.warn("Socket disconnected, ending MediaSource stream.");
                 try {
                      if (!sourceBuffer || !sourceBuffer.updating) mediaSource.endOfStream();
                      else console.warn("SourceBuffer was updating on disconnect.");
                 } catch(e){ console.warn("Error ending MediaSource on disconnect:", e); }
            }
        });

        // Initiate connection
        if (!socket.connected && !socket.connecting) {
            console.log("Attempting socket connection...");
            socket.connect();
        } else if (socket.connected) {
             console.log("Socket already connected, manually emitting join_live_room for:", streamId);
             socket.emit('join_live_room', { streamId: streamId });
             // State reset will happen in connect/stream_details listeners
        } else {
            console.log("Socket is currently connecting...");
        }
    }

    // --- UI Updates & Chat ---
    function updateStreamStatus(isLive, statusText = "LIVE") {
        if (isLive && isStreamActive) { // Only show live if stream is confirmed active
            liveBadge.textContent = `🔴 ${statusText}`;
            liveBadge.style.color = 'var(--live-red)';
            chatMessageInput.disabled = false;
            sendChatButton.disabled = false;
        } else {
            const displayStatus = isStreamActive ? statusText : (statusText === "LIVE" ? "Connecting..." : statusText);
            liveBadge.textContent = `⚫ ${displayStatus}`;
            liveBadge.style.color = '#666';
            chatMessageInput.disabled = true;
            sendChatButton.disabled = true;
            // Ensure isStreamActive reflects reality if showing offline status
            if (!isLive) isStreamActive = false;
        }
    }

    function addChatMessage(message) {
        const item = document.createElement('li');
        item.classList.add('chat-message');
        if (message.type === 'system') {
            item.classList.add('system');
            // Basic sanitization for system messages too
            const safeText = (message.text || '').replace(/</g, "<").replace(/>/g, ">");
            item.innerHTML = `<span>${safeText}</span>`;
        } else {
            const safeUsername = (message.username || 'User').replace(/</g, "<").replace(/>/g, ">");
            const safeText = (message.text || '').replace(/</g, "<").replace(/>/g, ">");
            item.innerHTML = `<strong>${safeUsername}:</strong> <span>${safeText}</span>`;
        }
        chatFeedList.appendChild(item);
        const container = chatFeedList.parentElement;
        const isScrolledToBottom = container.scrollHeight - container.clientHeight <= container.scrollTop + 50;
        if (isScrolledToBottom) {
            container.scrollTop = container.scrollHeight;
        }
    }

    function sendChatMessage() {
        const messageText = chatMessageInput.value.trim();
        if (messageText && socket && socket.connected && isStreamActive && streamId) {
            socket.emit('send_live_comment', { streamId, text: messageText });
            chatMessageInput.value = '';
        }
    }

    function sendReaction(reaction) {
         if (socket && socket.connected && isStreamActive && streamId) {
             console.log("Sending reaction:", reaction);
             socket.emit('send_live_reaction', { streamId, reaction });
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
        if (button) sendReaction(button.dataset.reaction);
    });
    videoPlayer.addEventListener('click', () => {
        if (videoPlayer.paused) videoPlayer.play().catch(e => console.warn("Manual play failed:", e.name));
        if (videoPlayer.muted) videoPlayer.muted = false;
    });

    // --- Start Connection ---
    connectWebSocket();

}); // End DOMContentLoaded