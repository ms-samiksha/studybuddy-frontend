import { db, auth } from './firebase.js';
import { collection, addDoc, onSnapshot, query, orderBy, serverTimestamp, doc, deleteDoc, getDoc, setDoc } from 'https://www.gstatic.com/firebasejs/11.6.0/firebase-firestore.js';
import { getAuth, signOut } from 'https://www.gstatic.com/firebasejs/11.6.0/firebase-auth.js';

const urlParams = new URLSearchParams(window.location.search);
const roomId = urlParams.get('roomId');
if (!roomId) {
  console.error('No room ID provided');
  alert('No room ID provided.');
  window.location.href = './room-list.html';
}

// DOM elements
const leaveRoomButton = document.getElementById('leave-room');
const chatMessages = document.getElementById('chat-messages');
const chatInput = document.getElementById('chat-input');
const sendMessage = document.getElementById('send-message');
const toggleVideoBtn = document.getElementById('toggle-video-btn');
const toggleAudioBtn = document.getElementById('toggle-audio-btn');
const leaveCallBtn = document.getElementById('leave-call-btn');
const videoCallSection = document.getElementById('video-call-section');
const chatSection = document.getElementById('chat-section');
const backToChatBtn = document.getElementById('back-to-chat-btn');
const participantsList = document.getElementById('participants-list');
const chatTab = document.getElementById('chat-tab');
const videoTab = document.getElementById('video-tab');
const videoGrid = document.getElementById('video-grid');
const localVideo = document.getElementById('local-video');

// WebRTC variables
let localStream = null;
let peerConnections = {};
let isVideoCallActive = false;
let isVideoEnabled = false;
let isAudioEnabled = false;
let pinnedVideo = null;
let candidateQueue = {};
const socket = io('https://studybuddy-backend-57xt.onrender.com');

// WebRTC configuration
const rtcConfig = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' }
  ]
};

// Validate DOM elements
const requiredElements = { leaveRoomButton, chatMessages, chatInput, sendMessage, toggleVideoBtn, toggleAudioBtn, leaveCallBtn, videoCallSection, chatSection, backToChatBtn, participantsList, chatTab, videoTab, videoGrid, localVideo };
for (const [key, element] of Object.entries(requiredElements)) {
  if (!element) console.error(`DOM element missing: ${key}`);
}

// Initially show only chat
if (chatSection && videoCallSection) {
  chatSection.style.display = 'block';
  videoCallSection.style.display = 'none';
} else {
  console.error('chatSection or videoCallSection missing');
}

// Dynamic video grid layout
function updateVideoGridLayout(participantCount) {
  if (!videoGrid) {
    console.error('videoGrid element not found');
    return;
  }

  // Minimum height to prevent collapse
  const minHeight = 200;
  const maxHeight = window.innerHeight * 0.8;
  
  let height = Math.max(minHeight, maxHeight / Math.ceil(participantCount / 2));
  videoGrid.style.height = `${Math.min(height, maxHeight)}px`;

  if (pinnedVideo) {
    videoGrid.style.gridTemplateColumns = '1fr';
    videoGrid.style.gridTemplateRows = '1fr';
    videoGrid.style.height = '80vh';
  } else {
    const columns = Math.min(Math.ceil(Math.sqrt(participantCount)), 3);
    const rows = Math.ceil(participantCount / columns);
    videoGrid.style.gridTemplateColumns = `repeat(${columns}, 1fr)`;
    videoGrid.style.gridTemplateRows = `repeat(${rows}, 1fr)`;
  }
}

// Pin video
function pinVideo(videoElement) {
  if (!videoElement) {
    console.error('pinVideo: videoElement is null');
    return;
  }

  if (pinnedVideo === videoElement) {
    videoElement.classList.remove('pinned');
    pinnedVideo = null;
  } else {
    if (pinnedVideo) pinnedVideo.classList.remove('pinned');
    videoElement.classList.add('pinned');
    pinnedVideo = videoElement;
  }
  updateVideoGridLayout(Object.keys(peerConnections).length + 1);
}

// Process queued ICE candidates
async function processCandidateQueue(userId, pc) {
  if (candidateQueue[userId]) {
    for (const candidate of candidateQueue[userId]) {
      try {
        await pc.addIceCandidate(new RTCIceCandidate(candidate));
      } catch (e) {
        console.error('Failed to add queued ICE candidate:', e);
      }
    }
    delete candidateQueue[userId];
  }
}

// Update UI based on call state
function updateUICallState() {
  if (toggleVideoBtn) toggleVideoBtn.disabled = !isVideoCallActive;
  if (toggleAudioBtn) toggleAudioBtn.disabled = !isVideoCallActive;
  if (leaveCallBtn) leaveCallBtn.disabled = !isVideoCallActive;
}

// Function to leave the room
async function leaveRoom() {
  if (!auth.currentUser) {
    console.error('No authenticated user');
    alert('Please log in to leave the room.');
    return;
  }

  const confirmLeave = confirm('Are you sure you want to leave the room?');
  if (!confirmLeave) return;

  const userId = auth.currentUser.uid;
  try {
    const memberRef = doc(db, 'rooms', roomId, 'room_members', userId);
    await deleteDoc(memberRef);
    socket.emit('leave-room', { roomId, userId });
    stopVideoCall();
    alert('You have left the room.');
    window.location.href = './room-list.html';
  } catch (error) {
    console.error('Error leaving room:', error);
    alert('Failed to leave room.');
  }
}

// Initialize WebRTC
async function startVideoCall() {
  if (isVideoCallActive) {
    console.log('Video call already active');
    return;
  }

  try {
    console.log('Requesting media devices...');
    try {
      localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    } catch (error) {
      console.error('Error accessing media devices:', error);
      // Fallback to audio-only if video is denied
      try {
        localStream = await navigator.mediaDevices.getUserMedia({ video: false, audio: true });
        isVideoEnabled = false;
        if (toggleVideoBtn) toggleVideoBtn.textContent = 'Camera On';
      } catch (audioError) {
        console.error('Error accessing audio:', audioError);
        alert('Cannot start call without media permissions');
        stopVideoCall();
        return;
      }
    }

    console.log('Local stream acquired:', localStream);
    if (localVideo) {
      localVideo.srcObject = localStream;
      localVideo.play().catch(e => console.error('Local video play error:', e));
    } else {
      console.error('localVideo element not found');
    }

    isVideoEnabled = !!localStream.getVideoTracks().length;
    isAudioEnabled = !!localStream.getAudioTracks().length;
    if (toggleVideoBtn) toggleVideoBtn.textContent = isVideoEnabled ? 'Camera Off' : 'Camera On';
    if (toggleAudioBtn) toggleAudioBtn.textContent = isAudioEnabled ? 'Mic Off' : 'Mic On';
    isVideoCallActive = true;
    updateUICallState();

    if (localVideo) {
      // Only add event listener once
      if (!localVideo.hasPinListener) {
        localVideo.addEventListener('click', () => pinVideo(localVideo));
        localVideo.hasPinListener = true;
      }
      
      let localLabel = localVideo.nextElementSibling;
      if (!localLabel || localLabel.className !== 'video-label') {
        localLabel = document.createElement('div');
        localLabel.className = 'video-label';
        localLabel.textContent = auth.currentUser.displayName || `User_${auth.currentUser.uid.substring(0, 5)}`;
        localVideo.insertAdjacentElement('afterend', localLabel);
      }
    }

    console.log(`Emitting join-room: roomId=${roomId}, userId=${auth.currentUser.uid}`);
    socket.emit('join-room', { roomId, userId: auth.currentUser.uid });

    // Setup socket listeners
    socket.on('user-joined', handleUserJoined);
    socket.on('offer', handleOffer);
    socket.on('answer', handleAnswer);
    socket.on('ice-candidate', handleIceCandidate);
    socket.on('user-left', handleUserLeft);
    socket.on('connect_error', handleConnectError);
    socket.on('disconnect', handleDisconnect);
    socket.on('reconnect', handleReconnect);

    updateVideoGridLayout(1);
  } catch (error) {
    console.error('Error starting video call:', error);
    alert('Failed to start video call. Please try again.');
    stopVideoCall();
  }
}

// Socket event handlers
async function handleUserJoined({ userId }) {
  console.log(`User joined: ${userId}`);
  if (userId !== auth.currentUser.uid) {
    const pc = createPeerConnection(userId);
    peerConnections[userId] = pc;
    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      socket.emit('offer', { roomId, userId, sdp: offer });
    } catch (error) {
      console.error('Error creating offer:', error);
    }
  }
  updateVideoGridLayout(Object.keys(peerConnections).length + 1);
}

async function handleOffer({ userId, sdp }) {
  console.log(`Received offer from ${userId}, state: ${peerConnections[userId]?.signalingState || 'none'}`);
  if (userId !== auth.currentUser.uid) {
    const pc = createPeerConnection(userId);
    peerConnections[userId] = pc;
    try {
      await pc.setRemoteDescription(new RTCSessionDescription(sdp));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      socket.emit('answer', { roomId, userId, sdp: answer });
      await processCandidateQueue(userId, pc);
    } catch (error) {
      console.error('Error handling offer:', error);
    }
  }
}

async function handleAnswer({ userId, sdp }) {
  console.log(`Received answer from ${userId}, state: ${peerConnections[userId]?.signalingState || 'none'}`);
  if (peerConnections[userId]) {
    try {
      await peerConnections[userId].setRemoteDescription(new RTCSessionDescription(sdp));
      await processCandidateQueue(userId, peerConnections[userId]);
    } catch (error) {
      console.error('Error handling answer:', error);
    }
  }
}

function handleIceCandidate({ userId, candidate }) {
  if (peerConnections[userId]) {
    if (peerConnections[userId].remoteDescription) {
      peerConnections[userId].addIceCandidate(new RTCIceCandidate(candidate))
        .catch(e => console.error('ICE candidate error:', e));
    } else {
      candidateQueue[userId] = candidateQueue[userId] || [];
      candidateQueue[userId].push(candidate);
      
      // Set timeout to clear stale candidates
      setTimeout(() => {
        if (candidateQueue[userId]) {
          console.warn(`Clearing stale ICE candidates for ${userId}`);
          delete candidateQueue[userId];
        }
      }, 30000); // 30 seconds
    }
  }
}

function handleUserLeft({ userId }) {
  console.log(`User left: ${userId}`);
  if (peerConnections[userId]) {
    peerConnections[userId].close();
    delete peerConnections[userId];
    removeRemoteVideo(userId);
  }
  updateVideoGridLayout(Object.keys(peerConnections).length + 1);
}

function handleConnectError(error) {
  console.error('Socket.IO connection error:', error);
  alert('Failed to connect to signaling server. Please try again later.');
  stopVideoCall();
}

function handleDisconnect() {
  console.log('Disconnected from signaling server');
}

function handleReconnect() {
  console.log('Reconnected to signaling server');
  if (isVideoCallActive && auth.currentUser) {
    socket.emit('join-room', { roomId, userId: auth.currentUser.uid });
  }
}

function removeRemoteVideo(userId) {
  const videoElement = document.getElementById(`remote-video-${userId}`);
  if (videoElement) {
    if (pinnedVideo === videoElement) pinnedVideo = null;
    if (videoElement.srcObject) {
      videoElement.srcObject.getTracks().forEach(track => track.stop());
    }
    const label = videoElement.nextElementSibling;
    if (label && label.className === 'video-label') label.remove();
    videoElement.remove();
  }
}

function stopVideoCall() {
  // Stop local stream
  if (localStream) {
    localStream.getTracks().forEach(track => track.stop());
    localStream = null;
  }
  
  // Clear local video
  if (localVideo) {
    localVideo.srcObject = null;
    const localLabel = localVideo.nextElementSibling;
    if (localLabel && localLabel.className === 'video-label') localLabel.remove();
    localVideo.classList.remove('pinned');
  }
  
  // Close all peer connections
  Object.values(peerConnections).forEach(pc => pc.close());
  peerConnections = {};
  
  // Clear remote videos
  if (videoGrid) {
    while (videoGrid.children.length > 1) {
      const child = videoGrid.lastChild;
      if (child.srcObject) {
        child.srcObject.getTracks().forEach(track => track.stop());
      }
      videoGrid.removeChild(child);
    }
  }
  
  // Reset state
  pinnedVideo = null;
  candidateQueue = {};
  if (toggleVideoBtn) toggleVideoBtn.textContent = 'Camera On';
  if (toggleAudioBtn) toggleAudioBtn.textContent = 'Mic On';
  isVideoCallActive = false;
  isVideoEnabled = false;
  isAudioEnabled = false;
  updateUICallState();
  
  // Notify server
  if (auth.currentUser) {
    socket.emit('leave-room', { roomId, userId: auth.currentUser.uid });
  }
  
  // Remove socket listeners
  socket.off('user-joined', handleUserJoined);
  socket.off('offer', handleOffer);
  socket.off('answer', handleAnswer);
  socket.off('ice-candidate', handleIceCandidate);
  socket.off('user-left', handleUserLeft);
  socket.off('connect_error', handleConnectError);
  socket.off('disconnect', handleDisconnect);
  socket.off('reconnect', handleReconnect);
  
  updateVideoGridLayout(1);
}

function createPeerConnection(userId) {
  const pc = new RTCPeerConnection(rtcConfig);
  
  // Add local stream tracks if available
  if (localStream) {
    localStream.getTracks().forEach(track => {
      pc.addTrack(track, localStream);
    });
  }

  pc.ontrack = (event) => {
    console.log(`Received track from ${userId}, streams: ${event.streams.length}`);
    let remoteVideo = document.getElementById(`remote-video-${userId}`);
    if (!remoteVideo && videoGrid) {
      remoteVideo = document.createElement('video');
      remoteVideo.id = `remote-video-${userId}`;
      remoteVideo.autoplay = true;
      remoteVideo.playsinline = true;
      remoteVideo.addEventListener('click', () => pinVideo(remoteVideo));
      
      const label = document.createElement('div');
      label.className = 'video-label';
      label.textContent = 'Loading...';
      
      videoGrid.appendChild(remoteVideo);
      videoGrid.appendChild(label);
      
      // Fetch user name from Firestore
      getDoc(doc(db, 'rooms', roomId, 'room_members', userId))
        .then(doc => {
          if (doc.exists()) {
            label.textContent = doc.data().userName || `User_${userId.substring(0, 5)}`;
          }
        })
        .catch(error => {
          console.error(`Error fetching member document:`, error);
          label.textContent = `User_${userId.substring(0, 5)}`;
        });
    }
    
    if (remoteVideo) {
      remoteVideo.srcObject = event.streams[0];
      remoteVideo.play().catch(e => console.error(`Remote video play error:`, e));
    }
    
    updateVideoGridLayout(Object.keys(peerConnections).length + 1);
  };

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      socket.emit('ice-candidate', { roomId, userId, candidate: event.candidate });
    }
  };

  pc.oniceconnectionstatechange = () => {
    console.log(`ICE connection state for ${userId}: ${pc.iceConnectionState}`);
    if (pc.iceConnectionState === 'disconnected' || pc.iceConnectionState === 'failed') {
      console.log(`ICE connection failed for ${userId}`);
      pc.close();
      delete peerConnections[userId];
      removeRemoteVideo(userId);
      updateVideoGridLayout(Object.keys(peerConnections).length + 1);
    }
  };

  pc.onsignalingstatechange = () => {
    console.log(`Signaling state for ${userId}: ${pc.signalingState}`);
  };

  return pc;
}

function toggleVideo() {
  if (!localStream) return;
  const videoTrack = localStream.getVideoTracks()[0];
  if (videoTrack) {
    isVideoEnabled = !videoTrack.enabled;
    videoTrack.enabled = isVideoEnabled;
    if (toggleVideoBtn) toggleVideoBtn.textContent = isVideoEnabled ? 'Camera Off' : 'Camera On';
  }
}

function toggleAudio() {
  if (!localStream) return;
  const audioTrack = localStream.getAudioTracks()[0];
  if (audioTrack) {
    isAudioEnabled = !audioTrack.enabled;
    audioTrack.enabled = isAudioEnabled;
    if (toggleAudioBtn) toggleAudioBtn.textContent = isAudioEnabled ? 'Mic Off' : 'Mic On';
  }
}

// Event listeners
if (leaveRoomButton) leaveRoomButton.addEventListener('click', leaveRoom);

if (chatTab) {
  chatTab.addEventListener('click', () => {
    if (chatSection && videoCallSection) {
      chatSection.style.display = 'block';
      videoCallSection.style.display = 'none';
      chatTab.classList.add('active');
      if (videoTab) videoTab.classList.remove('active');
    }
  });
}

if (videoTab) {
  videoTab.addEventListener('click', () => {
    if (chatSection && videoCallSection) {
      chatSection.style.display = 'none';
      videoCallSection.style.display = 'block';
      videoTab.classList.add('active');
      if (chatTab) chatTab.classList.remove('active');
      if (!isVideoCallActive) startVideoCall();
    }
  });
}

if (toggleVideoBtn) toggleVideoBtn.addEventListener('click', toggleVideo);
if (toggleAudioBtn) toggleAudioBtn.addEventListener('click', toggleAudio);
if (leaveCallBtn) leaveCallBtn.addEventListener('click', stopVideoCall);

if (backToChatBtn) {
  backToChatBtn.addEventListener('click', () => {
    if (videoCallSection && chatSection) {
      videoCallSection.style.display = 'none';
      chatSection.style.display = 'block';
      if (chatTab) chatTab.classList.add('active');
      if (videoTab) videoTab.classList.remove('active');
    }
  });
}

// Handle page unload
window.addEventListener('beforeunload', () => {
  stopVideoCall();
  if (auth.currentUser) {
    socket.emit('leave-room', { roomId, userId: auth.currentUser.uid });
  }
});

// Handle authentication
auth.onAuthStateChanged(async (user) => {
  if (!user) {
    console.error('No authenticated user');
    alert('Please log in to access the room.');
    window.location.href = './room-list.html';
    return;
  }

  const displayName = user.displayName || `User_${user.uid.substring(0, 5)}`;
  const roomMembersRef = collection(db, 'rooms', roomId, 'room_members');
  
  try {
    const memberDoc = await getDoc(doc(roomMembersRef, user.uid));
    if (!memberDoc.exists()) {
      await setDoc(doc(roomMembersRef, user.uid), {
        userId: user.uid,
        userName: displayName,
        joinedAt: serverTimestamp(),
      });
    } else if (!memberDoc.data().userName) {
      await setDoc(doc(roomMembersRef, user.uid), {
        userName: displayName
      }, { merge: true });
    }
  } catch (error) {
    console.error('Error managing room member:', error);
    alert('Failed to join room. Check permissions or try again.');
  }

  // Load participants list
  if (participantsList) {
    onSnapshot(query(collection(db, 'rooms', roomId, 'room_members'), orderBy('joinedAt')), (snapshot) => {
      participantsList.innerHTML = '';
      if (snapshot.empty) {
        participantsList.innerHTML = '<li>No participants yet.</li>';
        return;
      }
      
      snapshot.forEach((doc) => {
        const member = doc.data();
        const participantItem = document.createElement('li');
        participantItem.className = 'participant-item';
        participantItem.innerHTML = `
          <img src="https://www.gravatar.com/avatar/${member.userId}?d=mp" alt="${member.userName}" style="width: 30px; height: 30px; border-radius: 50%;">
          ${member.userName}
        `;
        participantsList.appendChild(participantItem);
      });
    }, (error) => {
      console.error('Error in participants snapshot:', error);
    });
  }

  // Load chat messages
  function loadMessages() {
    if (!chatMessages) {
      console.error('chat-messages element not found, retrying...');
      setTimeout(loadMessages, 100);
      return;
    }
    
    const messagesQuery = query(collection(db, 'rooms', roomId, 'messages'), orderBy('createdAt', 'asc'));
    onSnapshot(messagesQuery, (snapshot) => {
      chatMessages.innerHTML = '';
      if (snapshot.empty) {
        chatMessages.innerHTML = '<p class="text-gray-500">No messages yet.</p>';
        return;
      }
      
      snapshot.forEach((doc) => {
        const msg = doc.data();
        const isCurrentUser = msg.userId === user.uid;
        const msgContainer = document.createElement('div');
        msgContainer.className = `flex flex-col mb-2 ${isCurrentUser ? 'items-end' : 'items-start'}`;
        msgContainer.innerHTML = `
          <div class="max-w-xs p-2 rounded-lg ${isCurrentUser ? 'bg-green-300' : 'bg-gray-200'}">
            <div class="text-xs font-bold mb-1 ${isCurrentUser ? 'text-right' : 'text-left'}">${msg.userName}:</div>
            <div class="text-sm">${msg.text}</div>
          </div>
        `;
        chatMessages.appendChild(msgContainer);
      });
      
      chatMessages.scrollTop = chatMessages.scrollHeight;
    }, (error) => {
      console.error('Error in messages snapshot:', error);
      chatMessages.innerHTML = '<p class="text-red-500">Failed to load messages.</p>';
    });
  }
  loadMessages();

  // Sending message
  if (sendMessage && chatInput) {
    sendMessage.addEventListener('click', async () => {
      const text = chatInput.value.trim();
      if (!text) return;
      
      try {
        await addDoc(collection(db, 'rooms', roomId, 'messages'), {
          text,
          userName: displayName,
          userId: user.uid,
          createdAt: serverTimestamp(),
        });
        chatInput.value = '';
      } catch (error) {
        console.error('Error sending message:', error);
        alert('Failed to send message. Please try again.');
      }
    });
    
    // Also allow sending with Enter key
    chatInput.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') {
        sendMessage.click();
      }
    });
  }

  // Add label to local video
  if (localVideo) {
    const localLabel = document.createElement('div');
    localLabel.className = 'video-label';
    localLabel.textContent = displayName;
    localVideo.insertAdjacentElement('afterend', localLabel);
  }
});