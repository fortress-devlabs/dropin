// v34.0: Add detailed logging to receive_live_chunk.
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
    const BUFFER_QUEUE_LIMIT = 20;

    updateStreamStatus(false, "Connecting...");

    socket = io('https://dropin-43k0.onrender.com', {
      transports: ['websocket'],
      transportOptions: {
        websocket: { binaryType: 'arraybuffer' }
      }
    });

    // --- Initialization ---

    function getStreamIdFromUrl() {
        const pathSegments = window.location.pathname.split('/').filter(Boolean);
        if (pathSegments.length === 2 && pathSegments[0].toLowerCase() === 'watch') { return pathSegments[1]; }
        console.error("Could not determine Stream ID from URL path:", window.location.pathname);
        updateStreamStatus(false, "Invalid Link"); return null;
    }

    function initializeMediaSource() {
        if (!window.MediaSource) { console.error("MediaSource API not supported."); updateStreamStatus(false, "Browser unsupported"); return; }
        if (mediaSource && mediaSource.readyState !== 'closed') { console.warn("Cleaning up existing MediaSource object."); try { if (videoPlayer.src) { URL.revokeObjectURL(videoPlayer.src); videoPlayer.src = ''; videoPlayer.removeAttribute('src'); } if (mediaSource.readyState === 'open') { mediaSource.endOfStream(); } } catch(e) { console.warn("Error during old MediaSource cleanup:", e); } }
        mediaSource = null; sourceBuffer = null; isMediaSourceOpen = false; isSourceBufferReady = false; bufferQueue = [];
        try { console.log("Creating new MediaSource instance."); mediaSource = new MediaSource(); videoPlayer.src = URL.createObjectURL(mediaSource); mediaSource.addEventListener('sourceopen', handleSourceOpen, { once: true }); mediaSource.addEventListener('sourceended', () => console.log('MediaSource sourceended. ReadyState:', mediaSource?.readyState)); mediaSource.addEventListener('sourceclose', () => { console.log('MediaSource sourceclose. ReadyState:', mediaSource?.readyState); isMediaSourceOpen = false; isSourceBufferReady = false; });
        } catch (error) { console.error("Error creating MediaSource:", error); updateStreamStatus(false, "Playback error"); }
    }

    function handleSourceOpen() {
        console.log('MediaSource opened. ReadyState:', mediaSource.readyState);
        isMediaSourceOpen = true;
        if (receivedMimeType) { console.log("MediaSource opened and mimeType was already determined. Attempting addSourceBuffer."); addSourceBuffer(); }
        else { console.log("MediaSource opened, waiting for stream_details to determine mimeType."); }
    }

    function addSourceBuffer() {
        if (!isMediaSourceOpen || !receivedMimeType || sourceBuffer || mediaSource.readyState !== 'open') { console.warn("addSourceBuffer prerequisites not met.", { isMediaSourceOpen, receivedMimeType, sourceBufferExists: !!sourceBuffer, mediaSourceState: mediaSource?.readyState }); return; }
        console.log(`Attempting to addSourceBuffer with determined mimeType: "${receivedMimeType}"`);
        try {
            sourceBuffer = mediaSource.addSourceBuffer(receivedMimeType); sourceBuffer.mode = 'sequence'; console.log("✅ SourceBuffer added successfully.");
            sourceBuffer.addEventListener('updateend', () => { isSourceBufferReady = true; processBufferQueue(); });
            sourceBuffer.addEventListener('error', (e) => { console.error('SourceBuffer error event:', sourceBuffer.error || e); updateStreamStatus(false, "Playback error"); isStreamActive = false; isSourceBufferReady = false; bufferQueue = []; if (mediaSource.readyState === 'open') { try { mediaSource.endOfStream(); } catch(eosErr){} } });
            sourceBuffer.addEventListener('abort', () => { console.warn('SourceBuffer aborted.'); isSourceBufferReady = false; });
            isSourceBufferReady = true; processBufferQueue();
        } catch (error) { console.error(`❌ Error adding SourceBuffer with mimeType "${receivedMimeType}":`, error); updateStreamStatus(false, "Playback error"); if (mediaSource.readyState === 'open') { try { mediaSource.endOfStream(); } catch(e){} } }
    }

    function appendChunk(chunk) {
         if (!isStreamActive || !sourceBuffer || !isSourceBufferReady || mediaSource.readyState !== 'open') { return; }
        if (!sourceBuffer.updating) {
            try { isSourceBufferReady = false; sourceBuffer.appendBuffer(chunk); }
            catch (error) { console.error("❌ appendBuffer threw:", error); isSourceBufferReady = true; if (error.name === 'QuotaExceededError') { console.warn('QuotaExceededError: Buffer full. Attempting cleanup.'); cleanupBuffer(); } else { updateStreamStatus(false, "Playback Error"); isStreamActive = false; if (mediaSource.readyState === 'open') { try { mediaSource.endOfStream(); } catch(eosErr) {} } } }
        } else { bufferQueue.push(chunk); if (bufferQueue.length > BUFFER_QUEUE_LIMIT) { console.warn(`Buffer queue limit reached (${BUFFER_QUEUE_LIMIT}), dropping oldest chunk.`); bufferQueue.shift(); } }
    }

    function processBufferQueue() {
        if (!isStreamActive || !sourceBuffer || !isSourceBufferReady || mediaSource.readyState !== 'open') return;
        while (bufferQueue.length > 0 && isSourceBufferReady && !sourceBuffer.updating) { appendChunk(bufferQueue.shift()); }
    }

    function cleanupBuffer() {
        if (!sourceBuffer || sourceBuffer.updating || mediaSource.readyState !== 'open') return;
        try { const buffered = sourceBuffer.buffered; const currentTime = videoPlayer.currentTime; if (buffered.length > 0 && currentTime > 0) { const keepDuration = 30; const removalPoint = Math.max(0, currentTime - keepDuration); const bufferedStart = buffered.start(0); if (removalPoint > bufferedStart + 1) { console.log(`Buffer cleanup: Removing ${bufferedStart.toFixed(2)} to ${removalPoint.toFixed(2)}`); isSourceBufferReady = false; sourceBuffer.remove(bufferedStart, removalPoint); } }
        } catch (error) { console.error("Error during buffer cleanup:", error); isSourceBufferReady = true; }
    }

    // --- Socket.IO Event Handling ---
    function connectWebSocket() {
        streamId = getStreamIdFromUrl();
        if (!streamId) return;

        socket.off('connect'); socket.off('stream_details'); socket.off('receive_live_chunk'); socket.off('new_live_comment'); socket.off('viewer_count_update'); socket.off('live_stream_ended'); socket.off('connect_error'); socket.off('disconnect'); socket.off('broadcast_reaction');

        socket.on('connect', () => { console.log('Socket connected:', socket.id); addChatMessage({ type: 'system', text: 'Connected. Joining stream...' }); socket.emit('join_live_room', { streamId: streamId }); isStreamActive = false; isMediaSourceOpen = false; isSourceBufferReady = false; receivedMimeType = null; sawFirstChunk = false; bufferQueue = []; updateStreamStatus(false, "Joining..."); });
        socket.on('stream_details', (details) => {
             console.log("Received stream details:", details);
             streamTitleElement.textContent = details.title || 'Live Stream';
             if (hostNameElement) { hostNameElement.textContent = details.hostName ? `by ${details.hostName}` : 'by Broadcaster'; }
             const isServerLive = details.isLive !== false;
             if (isServerLive) {
                 if (details.mimeType && typeof details.mimeType === 'string' && details.mimeType.trim().length > 0) { console.log(`Using mimeType from server: "${details.mimeType}"`); receivedMimeType = details.mimeType; }
                 else { console.warn("stream_details missing valid mimeType. Falling back."); const fbP = 'video/webm; codecs="vp8,opus"'; const fbB = 'video/webm'; if (MediaSource.isTypeSupported(fbP)) { receivedMimeType = fbP; } else if (MediaSource.isTypeSupported(fbB)) { receivedMimeType = fbB; } else { receivedMimeType = null; } if(receivedMimeType) { console.log(`Using fallback MIME type: "${receivedMimeType}"`); } }
                 if (!receivedMimeType || !MediaSource.isTypeSupported(receivedMimeType)) { const err = `Unsupported Format: ${receivedMimeType || 'None Found'}`; console.error(err); updateStreamStatus(false, "Unsupported Format"); isStreamActive = false; receivedMimeType = null; return; }
                 isStreamActive = true; updateStreamStatus(true, "LIVE");
                 if (!mediaSource || mediaSource.readyState === 'closed') { console.log("Stream live, initializing MediaSource."); initializeMediaSource(); } else { console.log("MediaSource exists and is open/opening."); }
                 if (isMediaSourceOpen && receivedMimeType) { console.log("stream_details received, MediaSource open. Attempting addSourceBuffer."); addSourceBuffer(); }
             } else { updateStreamStatus(false, "Stream Offline"); isStreamActive = false; receivedMimeType = null; if (mediaSource && mediaSource.readyState === 'open') { console.log("Stream not live, closing open MediaSource."); try { mediaSource.endOfStream(); } catch (e) {} } }
        });

        socket.on('receive_live_chunk', (chunk) => {
            // --- Debug Logging Added (Instruction #2 & #3) ---
            console.log('🔥 receive_live_chunk fired:', chunk); // Log the received data itself
            if (!(chunk instanceof ArrayBuffer)) {
                console.warn('Chunk received is NOT an ArrayBuffer! Type:', typeof chunk, chunk);
                return; // Cannot proceed if not ArrayBuffer
            }
            console.log(`   -> byteLength= ${chunk.byteLength}`);
            if (chunk.byteLength === 0) {
                 console.warn('Received zero-length ArrayBuffer chunk.');
                 return; // Ignore empty chunks
            }
            // --- End Debug Logging ---

             if (!isStreamActive) return; // Check active state *after* logging

             if (!sawFirstChunk) {
                sawFirstChunk = true;
                const header = new Uint8Array(chunk).subarray(0, 16);
                const hexHeader = Array.from(header).map(b => b.toString(16).padStart(2, '0')).join(' ');
                console.log("▶️ First 16 bytes of first chunk:", hexHeader); // Instruction #3 log
                if (header[0] === 0x1a && header[1] === 0x45 && header[2] === 0xdf && header[3] === 0xa3) { console.log("  ✅ Header looks like WebM EBML."); }
                else { console.warn("  ⚠️ First chunk header doesn't match expected WebM EBML signature!"); }
             }

             // Only append if checks passed
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
        socket.on('live_stream_ended', (data) => { console.log("Received live_stream_ended signal.", data?.reason); addChatMessage({ type: 'system', text: 'Stream has ended.' }); updateStreamStatus(false, "Stream Ended"); isStreamActive = false; receivedMimeType = null; bufferQueue = []; if (mediaSource && mediaSource.readyState === 'open') { console.log("Attempting clean end MediaSource."); try { if (sourceBuffer && !sourceBuffer.updating) { mediaSource.endOfStream(); } else if (sourceBuffer && sourceBuffer.updating) { console.warn("Stream ended while SB updating..."); const end = () => { if (mediaSource?.readyState === 'open') try { mediaSource.endOfStream();} catch(e){} }; sourceBuffer.addEventListener('updateend', end, { once: true }); setTimeout(() => { sourceBuffer?.removeEventListener('updateend', end); end(); }, 500); } else { mediaSource.endOfStream(); } } catch (e) { console.warn("Error ending MediaSource:", e); } } chatMessageInput.disabled = true; sendChatButton.disabled = true; });
        socket.on('connect_error', (err) => { console.error('Socket connection error:', err.message); addChatMessage({ type: 'system', text: `Connection error: ${err.message}` }); updateStreamStatus(false, "Connection Error"); isStreamActive = false; receivedMimeType = null; });
        socket.on('disconnect', (reason) => { console.log('Socket disconnected:', reason); addChatMessage({ type: 'system', text: `Disconnected: ${reason}` }); updateStreamStatus(false, "Disconnected"); isStreamActive = false; receivedMimeType = null; if (mediaSource && mediaSource.readyState === 'open') { console.warn("Socket disconnected, ending MediaSource."); try { if (!sourceBuffer || !sourceBuffer.updating) mediaSource.endOfStream(); else console.warn("SB updating on disconnect."); } catch(e){ console.warn("Error ending MediaSource on disconnect:", e); } } });

        if (!socket.connected && !socket.connecting) { console.log("Attempting socket connection..."); socket.connect(); }
        else if (socket.connected) { console.log("Socket already connected, manually emitting join_live_room for:", streamId); socket.emit('join_live_room', { streamId: streamId }); }
        else { console.log("Socket is currently connecting..."); }
    }

    // --- UI Updates & Chat ---
    function updateStreamStatus(isLive, statusText = "LIVE") { /* ... (Unchanged from v33) ... */ }
    function addChatMessage(message) { /* ... (Unchanged from v33) ... */ }
    function sendChatMessage() { /* ... (Unchanged from v33) ... */ }
    function sendReaction(reaction) { /* ... (Unchanged from v33) ... */ }

    // --- Event Listeners --- (Unchanged from v33)
    sendChatButton.addEventListener('click', sendChatMessage);
    chatMessageInput.addEventListener('keypress', (event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); sendChatMessage(); } });
    reactionButtonsContainer.addEventListener('click', (event) => { const btn = event.target.closest('.reaction-button'); if (btn) sendReaction(btn.dataset.reaction); });
    videoPlayer.addEventListener('click', () => { if (videoPlayer.paused) videoPlayer.play().catch(e => console.warn("Manual play failed:", e.name)); if (videoPlayer.muted) videoPlayer.muted = false; });

    // --- Start Connection ---
    connectWebSocket();

}); // End DOMContentLoaded