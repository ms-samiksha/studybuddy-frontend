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
      label.textContent = 'Unknown';
      videoGrid.appendChild(remoteVideo);
      videoGrid.appendChild(label);
      remoteVideo.addEventListener('click', () => pinVideo(remoteVideo));
      getDoc(doc(db, 'rooms', roomId, 'room_members', userId)).then(doc => {
        if (doc.exists()) {
          label.textContent = doc.data().userName || `User_${userId.substring(0, 5)}`;
        } else {
          console.error(`No member document found for userId: ${userId}`);
        }
      }).catch(error => {
        console.error(`Error fetching member document for userId: ${userId}`, error);
      });
    }
    remoteVideo.srcObject = event.streams[0];
    updateVideoGridLayout(Object.keys(peerConnections).length + 1);
  };

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      socket.emit('ice-candidate', { roomId, userId, candidate: event.candidate });
    }
  };

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
      pc.close();
      delete peerConnections[userId];
      const videoElement = document.getElementById(`remote-video-${userId}`);
      if (videoElement) {
        if (pinnedVideo === videoElement) pinnedVideo = null;
        const label = videoElement.nextElementSibling;
        if (label && label.className === 'video-label') label.remove();
        videoElement.remove();
      }
      updateVideoGridLayout(Object.keys(peerConnections).length + 1);
    }
  };

  return pc;
}

function toggleVideo() {
  if (!localStream) return;
  const videoTrack = localStream.getVideoTracks()[0];
  isVideoEnabled = !isVideoEnabled;
  videoTrack.enabled = isVideoEnabled;
  toggleVideoBtn.textContent = isVideoEnabled ? 'Camera Off' : 'Camera On';
}

function toggleAudio() {
  if (!localStream) return;
  const audioTrack = localStream.getAudioTracks()[0];
  isAudioEnabled = !isAudioEnabled;
  audioTrack.enabled = isAudioEnabled;
  toggleAudioBtn.textContent = isAudioEnabled ? 'Mic Off' : 'Mic On';
}

// Event listeners
leaveRoomButton?.addEventListener('click', leaveRoom);

chatTab?.addEventListener('click', () => {
  chatSection.style.display = 'block';
  videoCallSection.style.display = 'none';
  chatTab.classList.add('active');
  videoTab.classList.remove('active');
});

videoTab?.addEventListener('click', () => {
  chatSection.style.display = 'none';
  videoCallSection.style.display = 'block';
  videoTab.classList.add('active');
  chatTab.classList.remove('active');
  if (!isVideoCallActive) startVideoCall();
});

toggleVideoBtn?.addEventListener('click', toggleVideo);

toggleAudioBtn?.addEventListener('click', toggleAudio);

leaveCallBtn?.addEventListener('click', stopVideoCall);

backToChatBtn?.addEventListener('click', () => {
  videoCallSection.style.display = 'none';
  chatSection.style.display = 'block';
  chatTab.classList.add('active');
  videoTab.classList.remove('active');
});

// Handle authentication
auth.onAuthStateChanged(async (user) => {
  if (!user) {
    alert('Please log in to access the room.');
    window.location.href = './room-list.html';
    return;
  }

  const roomMembersRef = collection(db, 'rooms', roomId, 'room_members');
  const memberDoc = await getDoc(doc(roomMembersRef, user.uid));
  if (!memberDoc.exists()) {
    try {
      await setDoc(doc(roomMembersRef, user.uid), {
        userId: user.uid,
        userName: user.displayName || `User_${user.uid.substring(0, 5)}`,
        joinedAt: serverTimestamp(),
      });
      console.log('User added to the room successfully');
    } catch (error) {
      console.error('Error adding user to the room:', error);
    }
  } else {
    // Update existing document if userName is missing
    const data = memberDoc.data();
    if (!data.userName) {
      try {
        await setDoc(doc(roomMembersRef, user.uid), { userName: user.displayName || `User_${user.uid.substring(0, 5)}` }, { merge: true });
        console.log('Updated userName for existing member');
      } catch (error) {
        console.error('Error updating userName:', error);
      }
    }
  }

  // Load participants list
  onSnapshot(query(collection(db, 'rooms', roomId, 'room_members'), orderBy('joinedAt')), (snapshot) => {
    console.log('Participants snapshot triggered, docs:', snapshot.docs.length);
    participantsList.innerHTML = '';
    if (snapshot.empty) {
      console.log('No participants found.');
      participantsList.innerHTML = '<li>No participants yet.</li>';
      return;
    }
    snapshot.forEach((doc) => {
      const member = doc.data();
      console.log(`Participant data: ${JSON.stringify(member)}`);
      const participantItem = document.createElement('li');
      participantItem.className = 'participant-item';
      participantItem.innerHTML = `
        <img src="https://www.gravatar.com/avatar/${member.userId}?d=mp" alt="${member.userName || member.userId}" style="width: 30px; height: 30px; border-radius: 50%;">
        ${member.userName || `User_${member.userId.substring(0, 5)}`}
      `;
      participantsList.appendChild(participantItem);
    });
  });

  // Load chat messages
  function loadMessages() {
    if (chatMessages) {
      console.log('ChatMessages element found:', chatMessages);
      chatMessages.style.overflowY = 'auto';
      const messagesQuery = query(collection(db, 'rooms', roomId, 'messages'), orderBy('createdAt', 'asc'));
      onSnapshot(messagesQuery, (snapshot) => {
        console.log('Messages snapshot triggered, docs:', snapshot.docs.length);
        chatMessages.innerHTML = '';
        if (snapshot.empty) {
          console.log('No messages found.');
          chatMessages.innerHTML = '<p class="text-gray-500">No messages yet.</p>';
          return;
        }
        snapshot.forEach((doc) => {
          const msg = doc.data();
          console.log(`Message data: ${JSON.stringify(msg)}`);
          const msgContainer = document.createElement('div');
          const isCurrentUser = msg.userId === user.uid;
          msgContainer.className = 'flex flex-col mb-2 ' + (isCurrentUser ? 'items-end' : 'items-start');
          msgContainer.innerHTML = `
            <div class="max-w-xs p-2 rounded-lg ${isCurrentUser ? 'bg-green-300' : 'bg-gray-200'}">
              <div class="text-xs font-bold mb-1 ${isCurrentUser ? 'text-right' : 'text-left'}">${msg.userName}:</div>
              <div class="text-sm">${msg.text}</div>
            </div>
          `;
          chatMessages.appendChild(msgContainer);
        });
        chatMessages.scrollTop = chatMessages.scrollHeight;
        setTimeout(() => {
          chatMessages.scrollTop = chatMessages.scrollHeight;
        }, 10);
      });
    } else {
      console.error('chatMessages element not found!');
      setTimeout(loadMessages, 100);
    }
  }
  loadMessages();

  // Sending message
  sendMessage?.addEventListener('click', async () => {
    const text = chatInput?.value.trim();
    if (!text) return;
    try {
      await addDoc(collection(db, 'rooms', roomId, 'messages'), {
        text,
        userName: user.displayName || `User_${user.uid.substring(0, 5)}`,
        userId: user.uid,
        createdAt: serverTimestamp(),
      });
      chatInput.value = '';
    } catch (error) {
      console.error('Error sending message:', error);
      alert('Failed to send message. Please try again.');
    }
  });

  // Add label to local video
  const localLabel = document.createElement('div');
  localLabel.className = 'video-label';
  localLabel.textContent = user.displayName || `User_${user.uid.substring(0, 5)}`;
  localVideo.insertAdjacentElement('afterend', localLabel);
});