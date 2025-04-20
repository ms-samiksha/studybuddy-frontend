import { db, auth } from './firebase.js';
import { collection, addDoc, onSnapshot, query, orderBy, serverTimestamp, doc, deleteDoc, getDoc, setDoc, getDocs } from 'https://www.gstatic.com/firebasejs/11.6.0/firebase-firestore.js';
import { getAuth, signOut } from 'https://www.gstatic.com/firebasejs/11.6.0/firebase-auth.js';

const urlParams = new URLSearchParams(window.location.search);
const roomId = urlParams.get('roomId');
if (!roomId) {
  alert('No room ID provided.');
  window.location.href = './room-list.html';
}

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
const socket = io('https://studybuddy-backend-57xt.onrender.com');

// WebRTC configuration
const rtcConfig = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    {
      urls: 'turn:turn.anyfirewall.com:443?transport=tcp',
      username: 'webrtc',
      credential: 'webrtc'
    }
  ]
};

// Initially show only chat
chatSection.style.display = 'block';
videoCallSection.style.display = 'none';

// Dynamic video grid layout
function updateVideoGridLayout(participantCount) {
  console.log(`Updating grid for ${participantCount} participants`);
  const columns = Math.min(Math.ceil(Math.sqrt(participantCount)), 3);
  const rows = Math.ceil(participantCount / columns);
  videoGrid.style.gridTemplateColumns = `repeat(${columns}, 1fr)`;
  videoGrid.style.gridTemplateRows = `repeat(${rows}, 1fr)`;
  videoGrid.style.height = `${(80 / rows) * 0.9}vh`; // Dynamic height based on rows
  if (pinnedVideo) {
    videoGrid.style.gridTemplateColumns = '1fr';
    videoGrid.style.gridTemplateRows = '1fr';
    videoGrid.style.height = '80vh'; // Full height for pinned video
  }
}

// Pin video
function pinVideo(videoElement) {
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

// Function to leave the room
async function leaveRoom() {
  if (!auth.currentUser) {
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
  if (isVideoCallActive) return;

  try {
    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    localVideo.srcObject = localStream;
    isVideoEnabled = true;
    isAudioEnabled = true;
    toggleVideoBtn.textContent = 'Camera Off';
    toggleAudioBtn.textContent = 'Mic Off';
    isVideoCallActive = true;
    leaveCallBtn.disabled = false;

    localVideo.addEventListener('click', () => pinVideo(localVideo));
    let localLabel = localVideo.nextElementSibling;
    if (!localLabel || localLabel.className !== 'video-label') {
      localLabel = document.createElement('div');
      localLabel.className = 'video-label';
      localLabel.textContent = auth.currentUser.displayName || `User_${auth.currentUser.uid.substring(0, 5)}`;
      localVideo.insertAdjacentElement('afterend', localLabel);
    }

    socket.emit('join-room', { roomId, userId: auth.currentUser.uid });

    socket.on('user-joined', async ({ userId }) => {
      if (userId !== auth.currentUser.uid) {
        const pc = createPeerConnection(userId);
        peerConnections[userId] = pc;
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        socket.emit('offer', { roomId, userId, sdp: offer });
      }
      updateVideoGridLayout(Object.keys(peerConnections).length + 1);
    });

    socket.on('offer', async ({ userId, sdp }) => {
      if (userId !== auth.currentUser.uid) {
        const pc = createPeerConnection(userId);
        peerConnections[userId] = pc;
        await pc.setRemoteDescription(new RTCSessionDescription(sdp));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        socket.emit('answer', { roomId, userId, sdp: answer });
      }
    });

    socket.on('answer', async ({ userId, sdp }) => {
      if (peerConnections[userId]) {
        await peerConnections[userId].setRemoteDescription(new RTCSessionDescription(sdp));
      }
    });

    socket.on('ice-candidate', async ({ userId, candidate }) => {
      if (peerConnections[userId]) {
        await peerConnections[userId].addIceCandidate(new RTCIceCandidate(candidate));
      }
    });

    socket.on('connect_error', () => {
      alert('Failed to connect to signaling server. Please try again later.');
      stopVideoCall();
    });

    socket.on('user-left', ({ userId }) => {
      if (peerConnections[userId]) {
        peerConnections[userId].close();
        delete peerConnections[userId];
        const videoElement = document.getElementById(`remote-video-${userId}`);
        if (videoElement) {
          if (pinnedVideo === videoElement) pinnedVideo = null;
          const label = videoElement.nextElementSibling;
          if (label && label.className === 'video-label') label.remove();
          videoElement.remove();
        }
      }
      updateVideoGridLayout(Object.keys(peerConnections).length + 1);
    });

    updateVideoGridLayout(1);
  } catch (error) {
    console.error('Error starting video call:', error);
    alert('Failed to access camera. Please allow camera access or check device.');
    stopVideoCall();
  }
}

function stopVideoCall() {
  if (localStream) {
    localStream.getTracks().forEach(track => track.stop());
    localStream = null;
  }
  localVideo.srcObject = null;
  Object.values(peerConnections).forEach(pc => pc.close());
  peerConnections = {};
  while (videoGrid.children.length > 1) {
    videoGrid.removeChild(videoGrid.lastChild);
  }
  const localLabel = localVideo.nextElementSibling;
  if (localLabel && localLabel.className === 'video-label') localLabel.remove();
  localVideo.classList.remove('pinned');
  pinnedVideo = null;
  toggleVideoBtn.textContent = 'Camera On';
  toggleAudioBtn.textContent = 'Mic On';
  isVideoCallActive = false;
  isVideoEnabled = false;
  isAudioEnabled = false;
  leaveCallBtn.disabled = true;
  socket.emit('leave-room', { roomId, userId: auth.currentUser.uid });
  updateVideoGridLayout(1);
}

function createPeerConnection(userId) {
  const pc = new RTCPeerConnection(rtcConfig);
  localStream.getTracks().forEach(track => pc.addTrack(track, localStream));

  pc.ontrack = (event) => {
    let remoteVideo = document.getElementById(`remote-video-${userId}`);
    if (!remoteVideo) {
      remoteVideo = document.createElement('video');
      remoteVideo.id = `remote-video-${userId}`;
      remoteVideo.autoplay = true;
      remoteVideo.playsinline = true;
      const label = document.createElement('div');
      label.className = 'video-label';
      label.textContent = `User_${userId.substring(0, 5)}`;
      remoteVideo.addEventListener('click', () => pinVideo(remoteVideo));
      videoGrid.appendChild(remoteVideo);
      videoGrid.appendChild(label);
    }
    remoteVideo.srcObject = event.streams[0];
  };

  pc.onicecandidate = ({ candidate }) => {
    if (candidate) {
      socket.emit('ice-candidate', { roomId, userId, candidate });
    }
  };

  return pc;
}

// Event Listeners
leaveRoomButton.addEventListener('click', leaveRoom);
toggleVideoBtn.addEventListener('click', () => {
  if (isVideoEnabled) {
    localStream.getTracks().forEach(track => track.kind === 'video' && track.enabled && (track.enabled = false));
    toggleVideoBtn.textContent = 'Camera On';
  } else {
    localStream.getTracks().forEach(track => track.kind === 'video' && (track.enabled = true));
    toggleVideoBtn.textContent = 'Camera Off';
  }
  isVideoEnabled = !isVideoEnabled;
});

toggleAudioBtn.addEventListener('click', () => {
  if (isAudioEnabled) {
    localStream.getTracks().forEach(track => track.kind === 'audio' && track.enabled && (track.enabled = false));
    toggleAudioBtn.textContent = 'Mic On';
  } else {
    localStream.getTracks().forEach(track => track.kind === 'audio' && (track.enabled = true));
    toggleAudioBtn.textContent = 'Mic Off';
  }
  isAudioEnabled = !isAudioEnabled;
});

leaveCallBtn.addEventListener('click', stopVideoCall);

backToChatBtn.addEventListener('click', () => {
  videoCallSection.style.display = 'none';
  chatSection.style.display = 'block';
});

chatTab.addEventListener('click', () => {
  videoCallSection.style.display = 'none';
  chatSection.style.display = 'block';
});

videoTab.addEventListener('click', () => {
  videoCallSection.style.display = 'block';
  chatSection.style.display = 'none';
});

// Fetch room members from Firestore
async function loadRoomMembers() {
  try {
    const membersSnapshot = await getDocs(collection(db, 'rooms', roomId, 'room_members'));
    membersSnapshot.forEach((doc) => {
      const member = doc.data();
      const li = document.createElement('li');
      li.textContent = member.userName || `User_${member.userId.substring(0, 5)}`;
      participantsList.appendChild(li);
    });
  } catch (error) {
    console.error('Error fetching room members:', error);
  }
}

// Fetch existing chat messages
async function loadChatMessages() {
  try {
    const messagesQuery = query(collection(db, 'rooms', roomId, 'messages'), orderBy('timestamp'));
    onSnapshot(messagesQuery, (snapshot) => {
      chatMessages.innerHTML = '';
      snapshot.forEach((doc) => {
        const messageData = doc.data();
        const messageElement = document.createElement('div');
        messageElement.classList.add('chat-message');
        messageElement.innerHTML = `<strong>${messageData.userName || 'Unknown'}:</strong> ${messageData.message}`;
        chatMessages.appendChild(messageElement);
      });
      chatMessages.scrollTop = chatMessages.scrollHeight;
    });
  } catch (error) {
    console.error('Error fetching messages:', error);
  }
}

// Send chat message
sendMessage.addEventListener('click', async () => {
  const message = chatInput.value.trim();
  if (!message) return;

  try {
    await addDoc(collection(db, 'rooms', roomId, 'messages'), {
      userId: auth.currentUser.uid,
      message,
      timestamp: serverTimestamp(),
    });
    chatInput.value = '';
  } catch (error) {
    console.error('Error sending message:', error);
  }
});

// Initialize room
loadRoomMembers();
loadChatMessages();