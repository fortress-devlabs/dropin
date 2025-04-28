// v33.0: Final polish - Initial status, remove debug probe, prep host name, adjust queue limit, graceful errors.
// viewer.js - Client-side logic for the DropIn Live Viewer Page

document.addEventListener('DOMContentLoaded', () => {
    // --- DOM Elements ---
    const videoPlayer = document.getElementById('live-video');
    const streamTitleElement = document.getElementById('stream-title');
    const hostNameElement = document.getElementById('host-name'); // Element to display host name
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
    let isSourceBufferReady = false;
    let isStreamActive = false;
    let receivedMimeType = null;
    let isMediaSourceOpen = false;
    let sawFirstChunk = false;
    const BUFFER_QUEUE_LIMIT = 20; // Adjusted queue limit (Suggestion #4)

    // Set initial status immediately (Suggestion #1)
    updateStreamStatus(false, "Connecting...");

    // Initialize socket with ArrayBuffer transport option
    socket = io('https://dropin-43k0.onrender.com', {
      transports: ['websocket'],
      transportOptions: {
        websocket: { binaryType: 'arraybuffer' }
      }
    });

    // --- Initialization ---

    // REMOVED: debugMimeVariants function (Suggestion #2)

    function getStreamIdFromUrl() {
        const pathSegments = window.location.pathname.split('/').filter(Boolean);
        if (pathSegments.length === 2 && pathSegments[0].toLowerCase() === 'watch') {
             return pathSegments[1];
        }
        console.error("Could not determine Stream ID from URL path:", window.location.pathname);
        updateStreamStatus(false, "Invalid Link");
        return null;
    }

    function initializeMediaSource() {
        if (!window.MediaSource) {
            console.error("MediaSource API not supported.");
            updateStreamStatus(false, "Browser unsupported"); // Use status badge (Suggestion #5)
            // alert("Your browser doesn't support the MediaSource API required for this stream."); // Replaced alert
            return;
        }
        if (mediaSource && mediaSource.readyState !== 'closed') {
             console.warn("Cleaning up existing MediaSource object.");
             try {
                 if (videoPlayer.src) { URL.revokeObjectURL(videoPlayer.src); videoPlayer.src = ''; videoPlayer.removeAttribute('src'); }
                 if (mediaSource.readyState === 'open') { mediaSource.endOfStream(); }
             } catch(e) { console.warn("Error during old MediaSource cleanup:", e); }
        }
        mediaSource = null; sourceBuffer = null; isMediaSourceOpen = false; isSourceBufferReady = false; bufferQueue = [];

        try {
            console.log("Creating new MediaSource instance.");
            mediaSource = new MediaSource();
            videoPlayer.src = URL.createObjectURL(mediaSource);
            mediaSource.addEventListener('sourceopen', handleSourceOpen, { once: true });
            mediaSource.addEventListener('sourceended', () => console.log('MediaSource sourceended. ReadyState:', mediaSource?.readyState));
            mediaSource.addEventListener('sourceclose', () => { console.log('MediaSource sourceclose. ReadyState:', mediaSource?.readyState); isMediaSourceOpen = false; isSourceBufferReady = false; });
        } catch (error) {
            console.error("Error creating MediaSource:", error);
            updateStreamStatus(false, "Playback error");
        }
    }

    function handleSourceOpen() {
        console.log('MediaSource opened. ReadyState:', mediaSource.readyState);
        isMediaSourceOpen = true;
        // REMOVED: Call to debugMimeVariants(mediaSource); (Suggestion #2)
        if (receivedMimeType) {
            console.log("MediaSource opened and mimeType was already determined. Attempting addSourceBuffer.");
            addSourceBuffer();
        } else {
             console.log("MediaSource opened, waiting for stream_details to determine mimeType.");
        }
    }

    function addSourceBuffer() {
        if (!isMediaSourceOpen || !receivedMimeType || sourceBuffer || mediaSource.readyState !== 'open') {
            console.warn("addSourceBuffer prerequisites not met.", { isMediaSourceOpen, receivedMimeType, sourceBufferExists: !!sourceBuffer, mediaSourceState: mediaSource?.readyState });
            return;
        }
        console.log(`Attempting to addSourceBuffer with determined mimeType: "${receivedMimeType}"`);
        try {
            sourceBuffer = mediaSource.addSourceBuffer(receivedMimeType);
            sourceBuffer.mode = 'sequence';
            console.log("✅ SourceBuffer added successfully.");
            sourceBuffer.addEventListener('updateend', () => { isSourceBufferReady = true; processBufferQueue(); });
            sourceBuffer.addEventListener('error', (e) => { console.error('SourceBuffer error event:', sourceBuffer.error || e); updateStreamStatus(false, "Playback error"); isStreamActive = false; isSourceBufferReady = false; bufferQueue = []; if (mediaSource.readyState === 'open') { try { mediaSource.endOfStream(); } catch(eosErr){} } });
            sourceBuffer.addEventListener('abort', () => { console.warn('SourceBuffer aborted.'); isSourceBufferReady = false; });
            isSourceBufferReady = true;
            processBufferQueue();
        } catch (error) {
            console.error(`❌ Error adding SourceBuffer with mimeType "${receivedMimeType}":`, error);
            updateStreamStatus(false, "Playback error");
            if (mediaSource.readyState === 'open') { try { mediaSource.endOfStream(); } catch(e){} }
        }
    }

    function appendChunk(chunk) {
         if (!isStreamActive || !sourceBuffer || !isSourceBufferReady || mediaSource.readyState !== 'open') {
              return;
         }
        if (!sourceBuffer.updating) {
            try {
                isSourceBufferReady = false;
                sourceBuffer.appendBuffer(chunk);
            } catch (error) {
                console.error("❌ appendBuffer threw:", error);
                isSourceBufferReady = true; // Reset cautiously
                if (error.name === 'QuotaExceededError') { console.warn('QuotaExceededError: Buffer full. Attempting cleanup.'); cleanupBuffer(); }
                else { updateStreamStatus(false, "Playback Error"); isStreamActive = false; if (mediaSource.readyState === 'open') { try { mediaSource.endOfStream(); } catch(eosErr) {} } }
            }
        } else {
            bufferQueue.push(chunk);
             // Adjusted queue limit check (Suggestion #4)
             if (bufferQueue.length > BUFFER_QUEUE_LIMIT) {
                 console.warn(`Buffer queue limit reached (${BUFFER_QUEUE_LIMIT}), dropping oldest chunk.`);
                 bufferQueue.shift();
             }
        }
    }

    function processBufferQueue() {
        if (!isStreamActive || !sourceBuffer || !isSourceBufferReady || mediaSource.readyState !== 'open') return;
        while (bufferQueue.length > 0 && isSourceBufferReady && !sourceBuffer.updating) {
            appendChunk(bufferQueue.shift());
        }
    }

    function cleanupBuffer() {
        if (!sourceBuffer || sourceBuffer.updating || mediaSource.readyState !== 'open') return;
        try {
            const buffered = sourceBuffer.buffered; const currentTime = videoPlayer.currentTime;
            if (buffered.length > 0 && currentTime > 0) {
                const keepDuration = 30; const removalPoint = Math.max(0, currentTime - keepDuration); const bufferedStart = buffered.start(0);
                if (removalPoint > bufferedStart + 1) { console.log(`Buffer cleanup: Removing ${bufferedStart.toFixed(2)} to ${removalPoint.toFixed(2)}`); isSourceBufferReady = false; sourceBuffer.remove(bufferedStart, removalPoint); }
            }
        } catch (error) { console.error("Error during buffer cleanup:", error); isSourceBufferReady = true; }
    }

    // --- Socket.IO Event Handling ---
    function connectWebSocket() {
        streamId = getStreamIdFromUrl();
        if (!streamId) return;
        // Don't add chat message here, status is set globally

        socket.off('connect'); socket.off('stream_details'); socket.off('receive_live_chunk'); socket.off('new_live_comment'); socket.off('viewer_count_update'); socket.off('live_stream_ended'); socket.off('connect_error'); socket.off('disconnect'); socket.off('broadcast_reaction');

        socket.on('connect', () => {
            console.log('Socket connected:', socket.id);
            addChatMessage({ type: 'system', text: 'Connected. Joining stream...' });
            socket.emit('join_live_room', { streamId: streamId });
            isStreamActive = false; isMediaSourceOpen = false; isSourceBufferReady = false; receivedMimeType = null; sawFirstChunk = false; bufferQueue = [];
            // Update status again on connect, might still be waiting for details
            updateStreamStatus(false, "Joining...");
        });

        socket.on('stream_details', (details) => {
             console.log("Received stream details:", details);
             streamTitleElement.textContent = details.title || 'Live Stream';

             // Set Host Name (Suggestion #3) - Prepare for optional 'hostName' field
             if (hostNameElement) { // Check if the element exists
                 hostNameElement.textContent = details.hostName ? `by ${details.hostName}` : 'by Broadcaster';
             }

             // Check live status first
             const isServerLive = details.isLive !== false;
             if (isServerLive) {
                 // Determine MIME Type (Server or Fallback)
                 if (details.mimeType && typeof details.mimeType === 'string' && details.mimeType.trim().length > 0) {
                     console.log(`Using mimeType from server: "${details.mimeType}"`);
                     receivedMimeType = details.mimeType;
                 } else {
                     console.warn("stream_details did not include a valid mimeType. Falling back.");
                     const fallbackPreferred = 'video/webm; codecs="vp8,opus"';
                     const fallbackBasic = 'video/webm';
                     if (MediaSource.isTypeSupported(fallbackPreferred)) { receivedMimeType = fallbackPreferred; }
                     else if (MediaSource.isTypeSupported(fallbackBasic)) { receivedMimeType = fallbackBasic; }
                     else { receivedMimeType = null; } // No supported type found

                     if(receivedMimeType) {
                         console.log(`Using fallback MIME type: "${receivedMimeType}"`);
                     }
                 }

                 // Validate the determined MIME type
                 if (!receivedMimeType || !MediaSource.isTypeSupported(receivedMimeType)) {
                      const errorMsg = `Unsupported Format: ${receivedMimeType || 'None Found'}`;
                      console.error(errorMsg);
                      updateStreamStatus(false, "Unsupported Format"); // Use status badge (Suggestion #5)
                      // alert(`Playback error: Browser doesn't support required video formats.`); // Replaced alert
                      isStreamActive = false;
                      receivedMimeType = null;
                      return; // Stop processing
                 }

                 // Passed validation, mark stream active and proceed
                 isStreamActive = true;
                 updateStreamStatus(true, "LIVE"); // Update status badge now

                 // Initialize MediaSource if needed
                 if (!mediaSource || mediaSource.readyState === 'closed') {
                    console.log("Stream is live, initializing MediaSource.");
                    initializeMediaSource();
                 } else { console.log("MediaSource already exists and is opening/open."); }

                 // If MediaSource is already open, attempt to add buffer now
                 if (isMediaSourceOpen && receivedMimeType) {
                     console.log("stream_details received, MediaSource is already open. Attempting addSourceBuffer.");
                     addSourceBuffer();
                 }

             } else { // Stream is NOT live
                 updateStreamStatus(false, "Stream Offline");
                 isStreamActive = false;
                 receivedMimeType = null;
                 if (mediaSource && mediaSource.readyState === 'open') { console.log("Stream is not live, closing open MediaSource."); try { mediaSource.endOfStream(); } catch (e) {} }
             }
        });

        socket.on('receive_live_chunk', (chunk) => {
             if (!isStreamActive) return;
             if (!(chunk instanceof ArrayBuffer)) { console.warn("Received chunk is not an ArrayBuffer."); return; }
             if (chunk.byteLength === 0) return;

             if (!sawFirstChunk) {
                sawFirstChunk = true;
                const header = new Uint8Array(chunk).subarray(0, 16);
                const hexHeader = Array.from(header).map(b => b.toString(16).padStart(2, '0')).join(' ');
                console.log("▶️ First 16 bytes of first chunk:", hexHeader);
                if (header[0] === 0x1a && header[1] === 0x45 && header[2] === 0xdf && header[3] === 0xa3) { console.log("  ✅ Header looks like WebM EBML."); }
                else { console.warn("  ⚠️ First chunk header doesn't match expected WebM EBML signature!"); }
             }
             appendChunk(chunk);
             if (videoPlayer.paused && videoPlayer.readyState >= videoPlayer.HAVE_METADATA) {
                 if (sourceBuffer && sourceBuffer.buffered.length > 0) {
                     const bufferedEnd = sourceBuffer.buffered.end(sourceBuffer.buffered.length - 1);
                     if (bufferedEnd > videoPlayer.currentTime + 0.1) { videoPlayer.play().catch(e => { if (e.name !== 'AbortError' && e.name !== 'NotAllowedError') { console.warn("Autoplay attempt failed:", e.name, e.message); } }); }
                 }
             }
        });

        socket.on('new_live_comment', (message) => { addChatMessage(message); });
        socket.on('viewer_count_update', (count) => { viewerCountElement.textContent = `👀 ${count}`; });
        socket.on('broadcast_reaction', (data) => { if (data && data.reaction) { /* Placeholder */ } });

        socket.on('live_stream_ended', (data) => {
            console.log("Received live_stream_ended signal. Reason:", data?.reason || "N/A");
            addChatMessage({ type: 'system', text: 'Stream has ended.' });
            updateStreamStatus(false, "Stream Ended");
            isStreamActive = false; receivedMimeType = null; bufferQueue = [];
            if (mediaSource && mediaSource.readyState === 'open') {
                console.log("Attempting to cleanly end MediaSource stream.");
                try {
                    if (sourceBuffer && !sourceBuffer.updating) { mediaSource.endOfStream(); }
                    else if (sourceBuffer && sourceBuffer.updating) { console.warn("Stream ended while SourceBuffer updating, waiting briefly..."); const endStreamAfterUpdate = () => { if (mediaSource && mediaSource.readyState === 'open') { try { mediaSource.endOfStream(); console.log("MediaSource endOfStream called after update."); } catch(e) { console.warn("Error ending MediaSource stream post-update:", e); } } }; sourceBuffer.addEventListener('updateend', endStreamAfterUpdate, { once: true }); setTimeout(() => { sourceBuffer?.removeEventListener('updateend', endStreamAfterUpdate); endStreamAfterUpdate(); }, 500); }
                    else { mediaSource.endOfStream(); }
                } catch (e) { console.warn("Error during MediaSource endOfStream:", e); }
            }
            chatMessageInput.disabled = true; sendChatButton.disabled = true;
        });

        socket.on('connect_error', (err) => { console.error('Socket connection error:', err.message, err); addChatMessage({ type: 'system', text: `Connection error: ${err.message}` }); updateStreamStatus(false, "Connection Error"); isStreamActive = false; receivedMimeType = null; });
        socket.on('disconnect', (reason) => { console.log('Socket disconnected:', reason); addChatMessage({ type: 'system', text: `Disconnected: ${reason}` }); updateStreamStatus(false, "Disconnected"); isStreamActive = false; receivedMimeType = null; if (mediaSource && mediaSource.readyState === 'open') { console.warn("Socket disconnected, ending MediaSource stream."); try { if (!sourceBuffer || !sourceBuffer.updating) mediaSource.endOfStream(); else console.warn("SourceBuffer was updating on disconnect."); } catch(e){ console.warn("Error ending MediaSource on disconnect:", e); } } });

        if (!socket.connected && !socket.connecting) { console.log("Attempting socket connection..."); socket.connect(); }
        else if (socket.connected) { console.log("Socket already connected, manually emitting join_live_room for:", streamId); socket.emit('join_live_room', { streamId: streamId }); }
        else { console.log("Socket is currently connecting..."); }
    }

    // --- UI Updates & Chat ---
    function updateStreamStatus(isLive, statusText = "LIVE") {
        const showAsLive = isLive && isStreamActive; // Derived state based on server signal AND local readiness
        if (showAsLive) {
            liveBadge.textContent = `🔴 ${statusText}`;
            liveBadge.style.color = 'var(--live-red)';
            chatMessageInput.disabled = false;
            sendChatButton.disabled = false;
        } else {
            let displayStatus = statusText;
            // Refine offline/error messages
            if (!isLive && statusText === "LIVE") displayStatus = "Joining..."; // Server says live, but we're not ready
            else if (statusText === "Connecting..." || statusText === "Joining...") displayStatus = statusText;
            else if (statusText === "Unsupported Format" || statusText === "Stream Config Error" || statusText === "Playback error" || statusText === "Browser unsupported" || statusText === "Connection Error" || statusText === "Invalid Link") displayStatus = `⚫ Error: ${statusText}`;
            else displayStatus = `⚫ ${statusText}`; // Default offline state (Offline, Ended, Disconnected)

            liveBadge.textContent = displayStatus;
            liveBadge.style.color = '#666'; // Use grey for all non-live states
            chatMessageInput.disabled = true;
            sendChatButton.disabled = true;
            // Explicitly mark inactive if server says not live or we hit a setup error
            if (!isLive || displayStatus.startsWith('⚫ Error:')) {
                isStreamActive = false;
            }
        }
    }

    function addChatMessage(message) {
        const item = document.createElement('li');
        item.classList.add('chat-message');
        let safeText;
        if (message.type === 'system') {
            item.classList.add('system');
            safeText = (message.text || '').replace(/</g, "<").replace(/>/g, ">");
            item.innerHTML = `<span>${safeText}</span>`;
        } else {
            const safeUsername = (message.username || 'User').replace(/</g, "<").replace(/>/g, ">");
            safeText = (message.text || '').replace(/</g, "<").replace(/>/g, ">");
            item.innerHTML = `<strong>${safeUsername}:</strong> <span>${safeText}</span>`;
        }
        chatFeedList.appendChild(item);
        const container = chatFeedList.parentElement;
        const isScrolledToBottom = container.scrollHeight - container.clientHeight <= container.scrollTop + 50;
        if (isScrolledToBottom) { container.scrollTop = container.scrollHeight; }
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
    chatMessageInput.addEventListener('keypress', (event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); sendChatMessage(); } });
    reactionButtonsContainer.addEventListener('click', (event) => { const btn = event.target.closest('.reaction-button'); if (btn) sendReaction(btn.dataset.reaction); });
    videoPlayer.addEventListener('click', () => { if (videoPlayer.paused) videoPlayer.play().catch(e => console.warn("Manual play failed:", e.name)); if (videoPlayer.muted) videoPlayer.muted = false; });

    // --- Start Connection ---
    connectWebSocket();

}); // End DOMContentLoaded