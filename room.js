import { db, auth } from './firebase.js';
import { collection, addDoc, onSnapshot, query, orderBy, serverTimestamp, doc, deleteDoc, getDoc, setDoc, getDocs } from 'https://www.gstatic.com/firebasejs/11.6.0/firebase-firestore.js';
import { getAuth, signOut } from 'https://www.gstatic.com/firebasejs/11.6.0/firebase-auth.js';

const urlParams = new URLSearchParams(window.location.search);
const roomId = urlParams.get('roomId');
if (!roomId) {
  console.error('ERROR: No room ID provided in URL parameters');
  alert('No room ID provided in the URL.');
  window.location.href = './room-list.html';
}

// DOM elements with null checks
const elements = {
  leaveRoomButton: document.getElementById('leave-room'),
  chatMessages: document.getElementById('chat-messages'),
  chatInput: document.getElementById('chat-input'),
  sendMessage: document.getElementById('send-message'),
  toggleVideoBtn: document.getElementById('toggle-video-btn'),
  toggleAudioBtn: document.getElementById('toggle-audio-btn'),
  leaveCallBtn: document.getElementById('leave-call-btn'),
  videoCallSection: document.getElementById('video-call-section'),
  chatSection: document.getElementById('chat-section'),
  backToChatBtn: document.getElementById('back-to-chat-btn'),
  participantsList: document.getElementById('participants-list'),
  chatTab: document.getElementById('chat-tab'),
  videoTab: document.getElementById('video-tab'),
  videoGrid: document.getElementById('video-grid'),
  localVideo: document.getElementById('local-video')
};

// Verify all required elements exist
for (const [name, element] of Object.entries(elements)) {
  if (!element) {
    console.error(`CRITICAL ERROR: Missing required DOM element - ${name}`);
    alert(`System error: Missing ${name}. Please refresh the page.`);
  }
}

// WebRTC variables
let localStream = null;
let peerConnections = {};
let isVideoCallActive = false;
let isVideoEnabled = false;
let isAudioEnabled = false;
let pinnedVideo = null;
let candidateQueue = {};
const socket = io('https://studybuddy-backend-57xt.onrender.com', {
  reconnection: true,
  reconnectionAttempts: 5,
  reconnectionDelay: 1000,
  reconnectionDelayMax: 5000,
});

// Enhanced ICE servers configuration
const rtcConfig = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    {
      urls: 'turn:turn.anyfirewall.com:443?transport=tcp',
      username: 'webrtc',
      credential: 'webrtc'
    }
  ],
  iceCandidatePoolSize: 10
};

// Debugging function
function debugPeerConnections() {
  console.group('Active Peer Connections');
  Object.entries(peerConnections).forEach(([userId, pc]) => {
    console.group(`User: ${userId}`);
    console.log('Connection State:', pc.connectionState);
    console.log('ICE State:', pc.iceConnectionState);
    console.log('Signaling State:', pc.signalingState);
    console.log('Tracks:', {
      local: pc.getSenders().map(s => s.track?.kind),
      remote: pc.getReceivers().map(r => r.track?.kind)
    });
    console.groupEnd();
  });
  console.groupEnd();
}

// Set debug interval
setInterval(debugPeerConnections, 10000);

// Initialize UI
if (elements.chatSection && elements.videoCallSection) {
  elements.chatSection.style.display = 'block';
  elements.videoCallSection.style.display = 'none';
}

// Enhanced video grid layout
function updateVideoGridLayout(participantCount) {
  if (!elements.videoGrid) {
    console.error('ERROR: videoGrid element not found');
    return;
  }

  console.log(`Updating grid layout for ${participantCount} participants`);
  
  const columns = Math.min(Math.ceil(Math.sqrt(participantCount)), 3);
  const rows = Math.ceil(participantCount / columns);
  
  elements.videoGrid.style.gridTemplateColumns = `repeat(${columns}, 1fr)`;
  elements.videoGrid.style.gridTemplateRows = `repeat(${rows}, 1fr)`;
  elements.videoGrid.style.height = `${(80 / rows) * 0.9}vh`;
  
  if (pinnedVideo) {
    elements.videoGrid.style.gridTemplateColumns = '1fr';
    elements.videoGrid.style.gridTemplateRows = '1fr';
    elements.videoGrid.style.height = '80vh';
  }
}

// Enhanced pin video function
function pinVideo(videoElement) {
  if (!videoElement) {
    console.error('ERROR: pinVideo called with null videoElement');
    return;
  }

  console.log(`Toggling pin for video: ${videoElement.id}`);
  
  if (pinnedVideo === videoElement) {
    videoElement.classList.remove('pinned');
    pinnedVideo = null;
    console.log('Video unpinned');
  } else {
    if (pinnedVideo) {
      pinnedVideo.classList.remove('pinned');
      console.log(`Unpinned previous video: ${pinnedVideo.id}`);
    }
    videoElement.classList.add('pinned');
    pinnedVideo = videoElement;
    console.log(`Pinned video: ${videoElement.id}`);
  }
  
  updateVideoGridLayout(Object.keys(peerConnections).length + 1);
}

// Enhanced leave room function
async function leaveRoom() {
  if (!auth.currentUser) {
    console.error('ERROR: leaveRoom called without authenticated user');
    alert('Please log in to leave the room.');
    return;
  }

  const confirmLeave = confirm('Are you sure you want to leave the room?');
  if (!confirmLeave) return;

  const userId = auth.currentUser.uid;
  try {
    console.log(`User ${userId} leaving room ${roomId}`);
    
    const memberRef = doc(db, 'rooms', roomId, 'room_members', userId);
    await deleteDoc(memberRef);
    
    socket.emit('leave-room', { roomId, userId });
    stopVideoCall();
    
    console.log(`User ${userId} successfully left room ${roomId}`);
    window.location.href = './room-list.html';
  } catch (error) {
    console.error('ERROR leaving room:', error);
    alert('Failed to leave room. Please try again.');
  }
}

// Enhanced video call start with comprehensive error handling
async function startVideoCall() {
  if (isVideoCallActive) {
    console.warn('WARNING: startVideoCall called when call is already active');
    return;
  }

  console.log('Attempting to start video call...');

  try {
    // Media acquisition with retries
    const tryGetUserMedia = async (attempt = 1, maxAttempts = 3) => {
      try {
        console.log(`Attempt ${attempt} to get user media`);
        const stream = await navigator.mediaDevices.getUserMedia({ 
          video: true, 
          audio: true 
        });
        
        console.log('Successfully acquired local media stream');
        return stream;
      } catch (error) {
        console.error(`Attempt ${attempt} failed:`, error);
        if (attempt < maxAttempts) {
          await new Promise(resolve => setTimeout(resolve, 1000));
          return tryGetUserMedia(attempt + 1, maxAttempts);
        }
        throw error;
      }
    };

    localStream = await tryGetUserMedia();
    
    // Setup local video
    if (elements.localVideo) {
      elements.localVideo.srcObject = localStream;
      try {
        await elements.localVideo.play();
        console.log('Local video playback started');
      } catch (error) {
        console.error('Local video playback error:', error);
      }
      
      // Add click handler for pinning
      elements.localVideo.addEventListener('click', () => pinVideo(elements.localVideo));
      
      // Add label
      const label = document.createElement('div');
      label.className = 'video-label';
      label.textContent = auth.currentUser.displayName || `You (${auth.currentUser.uid.substring(0, 5)})`;
      elements.localVideo.insertAdjacentElement('afterend', label);
    }

    isVideoEnabled = true;
    isAudioEnabled = true;
    isVideoCallActive = true;
    
    if (elements.toggleVideoBtn) elements.toggleVideoBtn.textContent = 'Camera Off';
    if (elements.toggleAudioBtn) elements.toggleAudioBtn.textContent = 'Mic Off';
    if (elements.leaveCallBtn) elements.leaveCallBtn.disabled = false;

    console.log(`Joining WebRTC room: ${roomId}`);
    socket.emit('join-room', { 
      roomId, 
      userId: auth.currentUser.uid 
    });

    // Enhanced socket event handlers
    socket.on('user-joined', handleUserJoined);
    socket.on('offer', handleOffer);
    socket.on('answer', handleAnswer);
    socket.on('ice-candidate', handleIceCandidate);
    socket.on('user-left', handleUserLeft);
    
    // Validate existing participants
    await validateRoomMembers();

    console.log('Video call successfully started');
  } catch (error) {
    console.error('CRITICAL ERROR starting video call:', error);
    alert(`Failed to start video call: ${error.message}`);
    stopVideoCall();
  }
}

// Enhanced peer connection creation
function createPeerConnection(userId) {
  console.log(`Creating peer connection for ${userId}`);
  
  const pc = new RTCPeerConnection(rtcConfig);
  
  // Add local tracks only after negotiation
  const addTracks = () => {
    if (!localStream) {
      console.error('ERROR: No local stream available to add tracks');
      return;
    }
    
    localStream.getTracks().forEach(track => {
      try {
        if (!pc.getSenders().some(s => s.track === track)) {
          pc.addTrack(track, localStream);
          console.log(`Added ${track.kind} track to connection for ${userId}`);
        }
      } catch (error) {
        console.error(`ERROR adding ${track.kind} track:`, error);
      }
    });
  };

  pc.ontrack = (event) => {
    if (!event.streams || event.streams.length === 0) {
      console.error('ERROR: ontrack event received with no streams');
      return;
    }
    
    const remoteStream = event.streams[0];
    console.log(`Received remote stream from ${userId} with ${remoteStream.getTracks().length} tracks`);
    
    let remoteVideo = document.getElementById(`remote-video-${userId}`);
    
    if (!remoteVideo) {
      console.log(`Creating video element for ${userId}`);
      remoteVideo = document.createElement('video');
      remoteVideo.id = `remote-video-${userId}`;
      remoteVideo.autoplay = true;
      remoteVideo.playsInline = true;
      remoteVideo.classList.add('remote-video');
      
      const label = document.createElement('div');
      label.className = 'video-label';
      
      const container = document.createElement('div');
      container.className = 'video-container';
      container.id = `video-container-${userId}`;
      container.appendChild(remoteVideo);
      container.appendChild(label);
      
      container.addEventListener('click', () => pinVideo(container));
      
      if (elements.videoGrid) {
        elements.videoGrid.appendChild(container);
      }
      
      // Get user name from Firestore
      getDoc(doc(db, 'rooms', roomId, 'room_members', userId))
        .then(doc => {
          if (doc.exists()) {
            label.textContent = doc.data().userName || `User_${userId.substring(0, 5)}`;
          }
        })
        .catch(error => {
          console.error(`ERROR fetching user info for ${userId}:`, error);
          label.textContent = `User_${userId.substring(0, 5)}`;
        });
    }
    
    // Attach stream
    remoteVideo.srcObject = remoteStream;
    console.log(`Attached stream to remote video for ${userId}`);
    
    // Play the video with retries
    const tryPlay = (attempt = 1) => {
      remoteVideo.play()
        .then(() => {
          console.log(`Successfully playing remote video for ${userId}`);
        })
        .catch(error => {
          console.error(`ERROR playing video (attempt ${attempt}) for ${userId}:`, error);
          if (attempt < 5) {
            setTimeout(() => tryPlay(attempt + 1), 500 * attempt);
          }
        });
    };
    tryPlay();
    
    updateVideoGridLayout(Object.keys(peerConnections).length + 1);
  };

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      console.log(`Sending ICE candidate to ${userId}`);
      socket.emit('ice-candidate', { 
        roomId, 
        userId, 
        candidate: event.candidate 
      });
    }
  };

  pc.oniceconnectionstatechange = () => {
    console.log(`ICE connection state for ${userId}: ${pc.iceConnectionState}`);
    if (pc.iceConnectionState === 'failed') {
      console.warn(`ICE failed for ${userId}, restarting ICE`);
      pc.restartIce();
    }
  };

  pc.onsignalingstatechange = () => {
    console.log(`Signaling state for ${userId}: ${pc.signalingState}`);
  };

  pc.onconnectionstatechange = () => {
    console.log(`Connection state for ${userId}: ${pc.connectionState}`);
    if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
      console.warn(`Connection failed for ${userId}, cleaning up`);
      cleanupPeerConnection(userId);
    }
  };

  return { pc, addTracks };
}

// Clean up peer connection
function cleanupPeerConnection(userId) {
  console.log(`Cleaning up peer connection for ${userId}`);
  
  if (peerConnections[userId]) {
    peerConnections[userId].pc.close();
    delete peerConnections[userId];
  }
  
  const videoElement = document.getElementById(`remote-video-${userId}`);
  if (videoElement) {
    if (pinnedVideo === videoElement) {
      pinnedVideo = null;
    }
    videoElement.remove();
  }
  
  const container = document.getElementById(`video-container-${userId}`);
  if (container) {
    container.remove();
  }
  
  updateVideoGridLayout(Object.keys(peerConnections).length + 1);
}

// Enhanced stop video call
function stopVideoCall() {
  console.log('Stopping video call...');
  
  // Stop local stream
  if (localStream) {
    localStream.getTracks().forEach(track => {
      track.stop();
      console.log(`Stopped ${track.kind} track`);
    });
    localStream = null;
  }
  
  // Clean up peer connections
  Object.keys(peerConnections).forEach(userId => {
    cleanupPeerConnection(userId);
  });
  
  // Reset UI
  if (elements.localVideo) {
    elements.localVideo.srcObject = null;
    const label = elements.localVideo.nextElementSibling;
    if (label && label.className === 'video-label') {
      label.remove();
    }
  }
  
  isVideoCallActive = false;
  isVideoEnabled = false;
  isAudioEnabled = false;
  
  if (elements.toggleVideoBtn) elements.toggleVideoBtn.textContent = 'Camera On';
  if (elements.toggleAudioBtn) elements.toggleAudioBtn.textContent = 'Mic On';
  if (elements.leaveCallBtn) elements.leaveCallBtn.disabled = true;
  
  // Remove socket listeners
  socket.off('user-joined', handleUserJoined);
  socket.off('offer', handleOffer);
  socket.off('answer', handleAnswer);
  socket.off('ice-candidate', handleIceCandidate);
  socket.off('user-left', handleUserLeft);
  
  console.log('Video call stopped');
}

// Socket event handlers
async function handleUserJoined({ userId }) {
  console.log(`New user joined: ${userId}`);
  
  if (userId === auth.currentUser.uid) {
    console.warn('Ignoring self join event');
    return;
  }
  
  if (!peerConnections[userId]) {
    console.log(`Creating new peer connection for ${userId}`);
    const { pc, addTracks } = createPeerConnection(userId);
    peerConnections[userId] = pc;
    
    try {
      console.log(`Creating offer for ${userId}`);
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      addTracks();
      
      socket.emit('offer', { 
        roomId, 
        userId, 
        sdp: offer 
      });
      
      console.log(`Offer sent to ${userId}, state: ${pc.signalingState}`);
    } catch (error) {
      console.error(`ERROR creating offer for ${userId}:`, error);
    }
  }
}

async function handleOffer({ userId, sdp }) {
  console.log(`Received offer from ${userId}`);
  
  if (userId === auth.currentUser.uid) {
    console.warn('Ignoring self offer');
    return;
  }
  
  let pc;
  if (!peerConnections[userId]) {
    console.log(`Creating new peer connection for ${userId}`);
    const connection = createPeerConnection(userId);
    pc = connection.pc;
    peerConnections[userId] = pc;
  } else {
    pc = peerConnections[userId];
  }
  
  try {
    console.log(`Setting remote description for ${userId}`);
    await pc.setRemoteDescription(new RTCSessionDescription(sdp));
    
    console.log(`Creating answer for ${userId}`);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    
    socket.emit('answer', { 
      roomId, 
      userId, 
      sdp: answer 
    });
    
    console.log(`Answer sent to ${userId}, state: ${pc.signalingState}`);
    
    // Process any queued ICE candidates
    if (candidateQueue[userId]) {
      console.log(`Processing ${candidateQueue[userId].length} queued ICE candidates for ${userId}`);
      for (const candidate of candidateQueue[userId]) {
        await pc.addIceCandidate(new RTCIceCandidate(candidate));
      }
      delete candidateQueue[userId];
    }
  } catch (error) {
    console.error(`ERROR processing offer from ${userId}:`, error);
  }
}

async function handleAnswer({ userId, sdp }) {
  console.log(`Received answer from ${userId}`);
  
  if (userId === auth.currentUser.uid) {
    console.warn('Ignoring self answer');
    return;
  }
  
  const pc = peerConnections[userId];
  if (!pc) {
    console.error(`No peer connection found for ${userId}`);
    return;
  }
  
  try {
    console.log(`Setting remote description for ${userId}`);
    await pc.setRemoteDescription(new RTCSessionDescription(sdp));
    
    // Process any queued ICE candidates
    if (candidateQueue[userId]) {
      console.log(`Processing ${candidateQueue[userId].length} queued ICE candidates for ${userId}`);
      for (const candidate of candidateQueue[userId]) {
        await pc.addIceCandidate(new RTCIceCandidate(candidate));
      }
      delete candidateQueue[userId];
    }
  } catch (error) {
    console.error(`ERROR processing answer from ${userId}:`, error);
  }
}

async function handleIceCandidate({ userId, candidate }) {
  console.log(`Received ICE candidate from ${userId}`);
  
  if (userId === auth.currentUser.uid) {
    console.warn('Ignoring self ICE candidate');
    return;
  }
  
  const pc = peerConnections[userId];
  if (!pc) {
    console.log(`Queueing ICE candidate for ${userId} (no PC yet)`);
    candidateQueue[userId] = candidateQueue[userId] || [];
    candidateQueue[userId].push(candidate);
    return;
  }
  
  try {
    console.log(`Adding ICE candidate for ${userId}`);
    await pc.addIceCandidate(new RTCIceCandidate(candidate));
  } catch (error) {
    console.error(`ERROR adding ICE candidate for ${userId}:`, error);
  }
}

function handleUserLeft({ userId }) {
  console.log(`User left: ${userId}`);
  cleanupPeerConnection(userId);
}

// Validate room members
async function validateRoomMembers() {
  try {
    console.log('Validating room members...');
    const membersSnapshot = await getDocs(collection(db, 'rooms', roomId, 'room_members'));
    const validMembers = membersSnapshot.docs.map(doc => doc.id);
    
    console.log(`Current valid members: ${validMembers.join(', ')}`);
    
    // Clean up stale connections
    Object.keys(peerConnections).forEach(userId => {
      if (!validMembers.includes(userId)) {
        console.log(`Cleaning up stale connection for ${userId}`);
        cleanupPeerConnection(userId);
      }
    });
    
    // Create connections for new members
    for (const memberDoc of membersSnapshot.docs) {
      const userId = memberDoc.id;
      if (userId !== auth.currentUser.uid && !peerConnections[userId]) {
        console.log(`Creating connection for existing member ${userId}`);
        const { pc, addTracks } = createPeerConnection(userId);
        peerConnections[userId] = pc;
        
        try {
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          addTracks();
          
          socket.emit('offer', { 
            roomId, 
            userId, 
            sdp: offer 
          });
          
          console.log(`Offer sent to existing member ${userId}`);
        } catch (error) {
          console.error(`ERROR creating offer for ${userId}:`, error);
        }
      }
    }
  } catch (error) {
    console.error('ERROR validating room members:', error);
  }
}

// Media control functions
function toggleVideo() {
  if (!localStream) {
    console.error('ERROR: No local stream to toggle video');
    return;
  }
  
  const videoTrack = localStream.getVideoTracks()[0];
  if (!videoTrack) {
    console.error('ERROR: No video track found');
    return;
  }
  
  isVideoEnabled = !isVideoEnabled;
  videoTrack.enabled = isVideoEnabled;
  
  if (elements.toggleVideoBtn) {
    elements.toggleVideoBtn.textContent = isVideoEnabled ? 'Camera Off' : 'Camera On';
  }
  
  console.log(`Video ${isVideoEnabled ? 'enabled' : 'disabled'}`);
}

function toggleAudio() {
  if (!localStream) {
    console.error('ERROR: No local stream to toggle audio');
    return;
  }
  
  const audioTrack = localStream.getAudioTracks()[0];
  if (!audioTrack) {
    console.error('ERROR: No audio track found');
    return;
  }
  
  isAudioEnabled = !isAudioEnabled;
  audioTrack.enabled = isAudioEnabled;
  
  if (elements.toggleAudioBtn) {
    elements.toggleAudioBtn.textContent = isAudioEnabled ? 'Mic Off' : 'Mic On';
  }
  
  console.log(`Audio ${isAudioEnabled ? 'enabled' : 'disabled'}`);
}

// Event listeners
if (elements.leaveRoomButton) {
  elements.leaveRoomButton.addEventListener('click', leaveRoom);
}

if (elements.chatTab) {
  elements.chatTab.addEventListener('click', () => {
    if (elements.chatSection && elements.videoCallSection) {
      elements.chatSection.style.display = 'block';
      elements.videoCallSection.style.display = 'none';
      elements.chatTab.classList.add('active');
      if (elements.videoTab) elements.videoTab.classList.remove('active');
    }
  });
}

if (elements.videoTab) {
  elements.videoTab.addEventListener('click', () => {
    if (elements.chatSection && elements.videoCallSection) {
      elements.chatSection.style.display = 'none';
      elements.videoCallSection.style.display = 'block';
      elements.videoTab.classList.add('active');
      if (elements.chatTab) elements.chatTab.classList.remove('active');
      if (!isVideoCallActive) startVideoCall();
    }
  });
}

if (elements.toggleVideoBtn) {
  elements.toggleVideoBtn.addEventListener('click', toggleVideo);
}

if (elements.toggleAudioBtn) {
  elements.toggleAudioBtn.addEventListener('click', toggleAudio);
}

if (elements.leaveCallBtn) {
  elements.leaveCallBtn.addEventListener('click', stopVideoCall);
}

if (elements.backToChatBtn) {
  elements.backToChatBtn.addEventListener('click', () => {
    if (elements.videoCallSection && elements.chatSection) {
      elements.videoCallSection.style.display = 'none';
      elements.chatSection.style.display = 'block';
      if (elements.chatTab) elements.chatTab.classList.add('active');
      if (elements.videoTab) elements.videoTab.classList.remove('active');
    }
  });
}

// Authentication state handler
auth.onAuthStateChanged(async (user) => {
  if (!user) {
    console.error('ERROR: User not authenticated');
    alert('Please log in to access the room.');
    window.location.href = './room-list.html';
    return;
  }

  console.log(`User authenticated: ${user.uid}`);
  
  try {
    // Initialize room membership
    const roomMembersRef = collection(db, 'rooms', roomId, 'room_members');
    const memberRef = doc(roomMembersRef, user.uid);
    
    // Clean up any duplicate memberships
    const membersSnapshot = await getDocs(roomMembersRef);
    const currentUserDocs = membersSnapshot.docs.filter(doc => doc.id === user.uid);
    
    if (currentUserDocs.length > 1) {
      console.warn(`Found ${currentUserDocs.length} duplicate memberships, cleaning up...`);
      for (let i = 1; i < currentUserDocs.length; i++) {
        await deleteDoc(currentUserDocs[i].ref);
      }
    }
    
    // Create or update membership
    await setDoc(memberRef, {
      userId: user.uid,
      userName: user.displayName || `User_${user.uid.substring(0, 5)}`,
      joinedAt: serverTimestamp()
    }, { merge: true });
    
    console.log('Room membership initialized');
    
    // Load participants list
    setupParticipantsList();
    
    // Load chat messages
    setupChat();
    
  } catch (error) {
    console.error('ERROR initializing room membership:', error);
    alert('Failed to join room. Please try again.');
  }
});

// Setup participants list
function setupParticipantsList() {
  if (!elements.participantsList) {
    console.error('ERROR: participantsList element missing');
    return;
  }
  
  const participantsQuery = query(
    collection(db, 'rooms', roomId, 'room_members'),
    orderBy('joinedAt')
  );
  
  onSnapshot(participantsQuery, (snapshot) => {
    console.log(`Participants update: ${snapshot.docs.length} members`);
    
    elements.participantsList.innerHTML = '';
    
    if (snapshot.empty) {
      elements.participantsList.innerHTML = '<li>No participants yet.</li>';
      return;
    }
    
    snapshot.forEach((doc) => {
      const member = doc.data();
      const participantItem = document.createElement('li');
      participantItem.className = 'participant-item';
      participantItem.innerHTML = `
        <img src="https://www.gravatar.com/avatar/${member.userId}?d=mp" 
             alt="${member.userName || member.userId}" 
             style="width: 30px; height: 30px; border-radius: 50%;">
        ${member.userName || `User_${member.userId.substring(0, 5)}`}
      `;
      elements.participantsList.appendChild(participantItem);
    });
    
    updateVideoGridLayout(Object.keys(peerConnections).length + 1);
  }, (error) => {
    console.error('ERROR in participants snapshot:', error);
  });
}

// Setup chat functionality
function setupChat() {
  if (!elements.chatMessages) {
    console.error('ERROR: chatMessages element missing');
    return;
  }
  
  const messagesQuery = query(
    collection(db, 'rooms', roomId, 'messages'),
    orderBy('createdAt', 'asc')
  );
  
  onSnapshot(messagesQuery, (snapshot) => {
    console.log(`New chat messages: ${snapshot.docs.length}`);
    
    elements.chatMessages.innerHTML = '';
    
    if (snapshot.empty) {
      elements.chatMessages.innerHTML = '<p class="text-gray-500">No messages yet.</p>';
      return;
    }
    
    snapshot.forEach((doc) => {
      const msg = doc.data();
      const isCurrentUser = msg.userId === auth.currentUser?.uid;
      
      const msgContainer = document.createElement('div');
      msgContainer.className = `flex flex-col mb-2 ${isCurrentUser ? 'items-end' : 'items-start'}`;
      
      msgContainer.innerHTML = `
        <div class="max-w-xs p-2 rounded-lg ${isCurrentUser ? 'bg-green-300' : 'bg-gray-200'}">
          <div class="text-xs font-bold mb-1 ${isCurrentUser ? 'text-right' : 'text-left'}">
            ${msg.userName}:
          </div>
          <div class="text-sm">${msg.text}</div>
        </div>
      `;
      
      elements.chatMessages.appendChild(msgContainer);
    });
    
    elements.chatMessages.scrollTop = elements.chatMessages.scrollHeight;
  }, (error) => {
    console.error('ERROR in messages snapshot:', error);
    elements.chatMessages.innerHTML = '<p class="text-red-500">Failed to load messages.</p>';
  });
  
  // Message sending
  if (elements.sendMessage && elements.chatInput) {
    elements.sendMessage.addEventListener('click', sendChatMessage);
    elements.chatInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        sendChatMessage();
      }
    });
  }
}

// Send chat message
async function sendChatMessage() {
  if (!auth.currentUser) {
    console.error('ERROR: sendChatMessage called without authenticated user');
    return;
  }
  
  const text = elements.chatInput?.value.trim();
  if (!text) {
    console.warn('WARNING: Attempt to send empty message');
    return;
  }
  
  try {
    console.log(`Sending message: "${text}"`);
    
    await addDoc(collection(db, 'rooms', roomId, 'messages'), {
      text,
      userName: auth.currentUser.displayName || `User_${auth.currentUser.uid.substring(0, 5)}`,
      userId: auth.currentUser.uid,
      createdAt: serverTimestamp()
    });
    
    elements.chatInput.value = '';
  } catch (error) {
    console.error('ERROR sending message:', error);
    alert('Failed to send message. Please try again.');
  }
}