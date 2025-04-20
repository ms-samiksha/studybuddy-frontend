import { db, auth } from './firebase.js';
import { collection, addDoc, onSnapshot, query, orderBy, serverTimestamp, doc, deleteDoc, getDoc, setDoc, getDocs } from 'https://www.gstatic.com/firebasejs/11.6.0/firebase-firestore.js';
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

// Validate DOM elements
const requiredElements = { leaveRoomButton, chatMessages, chatInput, sendMessage, toggleVideoBtn, toggleAudioBtn, leaveCallBtn, videoCallSection, chatSection, backToChatBtn, participantsList, chatTab, videoTab, videoGrid, localVideo };
for (const [key, element] of Object.entries(requiredElements)) {
  if (!element) console.error(`DOM element missing: ${key}`);
}

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
    { urls: 'stun:stun.l.google.com:19302' },
    {
      urls: 'turn:turn.anyfirewall.com:443?transport=tcp',
      username: 'webrtc',
      credential: 'webrtc'
    }
  ]
};

// Initially show only chat
if (chatSection && videoCallSection) {
  chatSection.style.display = 'block';
  videoCallSection.style.display = 'none';
} else {
  console.error('chatSection or videoCallSection missing');
}

// Dynamic video grid layout
function updateVideoGridLayout(participantCount) {
  console.log(`Updating grid for ${participantCount} participants`);
  if (!videoGrid) {
    console.error('videoGrid element not found');
    return;
  }
  const columns = Math.min(Math.ceil(Math.sqrt(participantCount)), 3);
  const rows = Math.ceil(participantCount / columns);
  videoGrid.style.gridTemplateColumns = `repeat(${columns}, 1fr)`;
  videoGrid.style.gridTemplateRows = `repeat(${rows}, 1fr)`;
  videoGrid.style.height = `${(80 / rows) * 0.9}vh`;
  if (pinnedVideo) {
    videoGrid.style.gridTemplateColumns = '1fr';
    videoGrid.style.gridTemplateRows = '1fr';
    videoGrid.style.height = '80vh';
  }
}

// Pin video
function pinVideo(videoElement) {
  if (!videoElement) {
    console.error('pinVideo: videoElement is null');
    return;
  }
  console.log(`Pinning video: ${videoElement.id}`);
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

// Initialize WebRTC with retry
async function startVideoCall() {
  if (isVideoCallActive) {
    console.log('Video call already active');
    return;
  }

  const tryGetUserMedia = async (attempt = 1, maxAttempts = 3) => {
    try {
      console.log(`Requesting media devices (attempt ${attempt})...`);
      localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      console.log('Local stream acquired:', localStream);
      return localStream;
    } catch (error) {
      if (attempt < maxAttempts) {
        console.warn(`Media access failed, retrying (${attempt}/${maxAttempts})...`, error);
        return tryGetUserMedia(attempt + 1, maxAttempts);
      }
      throw error;
    }
  };

  try {
    await tryGetUserMedia();
    if (localVideo) {
      localVideo.srcObject = localStream;
      localVideo.play().catch(e => console.error('Local video play error:', e));
    } else {
      console.error('localVideo element not found');
    }
    isVideoEnabled = true;
    isAudioEnabled = true;
    if (toggleVideoBtn) toggleVideoBtn.textContent = 'Camera Off';
    if (toggleAudioBtn) toggleAudioBtn.textContent = 'Mic Off';
    isVideoCallActive = true;
    if (leaveCallBtn) leaveCallBtn.disabled = false;

    if (localVideo) {
      localVideo.addEventListener('click', () => pinVideo(localVideo));
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

    socket.on('user-joined', async ({ userId }) => {
      console.log(`User joined: ${userId}`);
      if (userId !== auth.currentUser.uid) {
        let pc = peerConnections[userId];
        if (!pc) {
          pc = createPeerConnection(userId);
          peerConnections[userId] = pc;
        }
        if (pc.signalingState === 'stable') {
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          socket.emit('offer', { roomId, userId, sdp: offer });
          updateVideoGridLayout(Object.keys(peerConnections).length + 1);
        }
      }
    });

    socket.on('offer', async ({ userId, sdp }) => {
      if (userId === auth.currentUser.uid) {
        console.warn(`Ignoring self-offer from ${userId}`);
        return;
      }
      console.log(`Received offer from ${userId}, state: ${peerConnections[userId]?.signalingState || 'none'}`);
      let pc = peerConnections[userId];
      if (!pc) {
        pc = createPeerConnection(userId);
        peerConnections[userId] = pc;
      }
      if (pc.signalingState === 'stable') {
        await pc.setRemoteDescription(new RTCSessionDescription(sdp)).catch(e => console.error('setRemoteDescription error:', e));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        socket.emit('answer', { roomId, userId, sdp: answer });
        if (candidateQueue[userId]) {
          for (const candidate of candidateQueue[userId]) {
            await pc.addIceCandidate(new RTCIceCandidate(candidate)).catch(e => console.error('ICE candidate error:', e));
          }
          delete candidateQueue[userId];
        }
        updateVideoGridLayout(Object.keys(peerConnections).length + 1);
      } else {
        console.warn(`Ignoring offer for ${userId}: Invalid state (${pc.signalingState})`);
      }
    });

    socket.on('answer', async ({ userId, sdp }) => {
      if (userId === auth.currentUser.uid) {
        console.warn(`Ignoring self-answer from ${userId}`);
        return;
      }
      console.log(`Received answer from ${userId}, state: ${peerConnections[userId]?.signalingState || 'none'}`);
      if (peerConnections[userId]) {
        if (peerConnections[userId].signalingState === 'have-local-offer') {
          await peerConnections[userId].setRemoteDescription(new RTCSessionDescription(sdp)).catch(e => console.error('setRemoteDescription error:', e));
          if (candidateQueue[userId]) {
            for (const candidate of candidateQueue[userId]) {
              await peerConnections[userId].addIceCandidate(new RTCIceCandidate(candidate)).catch(e => console.error('ICE candidate error:', e));
            }
            delete candidateQueue[userId];
          }
          updateVideoGridLayout(Object.keys(peerConnections).length + 1);
        } else {
          console.warn(`Ignoring answer for ${userId}: Invalid state (${peerConnections[userId].signalingState})`);
        }
      }
    });

    socket.on('ice-candidate', async ({ userId, candidate }) => {
      if (userId === auth.currentUser.uid) {
        console.warn(`Ignoring self ICE candidate from ${userId}`);
        return;
      }
      console.log(`Received ICE candidate from ${userId}`);
      if (peerConnections[userId]) {
        if (peerConnections[userId].remoteDescription) {
          await peerConnections[userId].addIceCandidate(new RTCIceCandidate(candidate)).catch(e => console.error('ICE candidate error:', e));
        } else {
          candidateQueue[userId] = candidateQueue[userId] || [];
          candidateQueue[userId].push(candidate);
        }
      }
    });

    socket.on('connect_error', (error) => {
      console.error('Socket.IO connection error:', error);
      alert('Failed to connect to signaling server. Please try again later.');
      stopVideoCall();
    });

    socket.on('user-left', ({ userId }) => {
      console.log(`User left: ${userId}`);
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
  if (localVideo) localVideo.srcObject = null;
  Object.values(peerConnections).forEach(pc => pc.close());
  peerConnections = {};
  if (videoGrid) {
    while (videoGrid.children.length > 1) {
      videoGrid.removeChild(videoGrid.lastChild);
    }
  }
  if (localVideo) {
    const localLabel = localVideo.nextElementSibling;
    if (localLabel && localLabel.className === 'video-label') localLabel.remove();
    localVideo.classList.remove('pinned');
  }
  pinnedVideo = null;
  if (toggleVideoBtn) toggleVideoBtn.textContent = 'Camera On';
  if (toggleAudioBtn) toggleAudioBtn.textContent = 'Mic On';
  isVideoCallActive = false;
  isVideoEnabled = false;
  isAudioEnabled = false;
  if (leaveCallBtn) leaveCallBtn.disabled = true;
  if (auth.currentUser) {
    socket.emit('leave-room', { roomId, userId: auth.currentUser.uid });
  }
  updateVideoGridLayout(1);
}

function createPeerConnection(userId) {
  const pc = new RTCPeerConnection(rtcConfig);
  if (localStream) {
    localStream.getTracks().forEach(track => pc.addTrack(track, localStream));
  }

  pc.ontrack = (event) => {
    console.log(`Received track from ${userId}, streams: ${event.streams.length}`);
    let remoteVideo = document.getElementById(`remote-video-${userId}`);
    if (!remoteVideo && videoGrid) {
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
    if (remoteVideo) {
      remoteVideo.srcObject = event.streams[0];
      remoteVideo.play().catch(e => console.error(`Remote video play error for ${userId}:`, e));
    } else {
      console.error(`remote-video-${userId} not found`);
    }
    updateVideoGridLayout(Object.keys(peerConnections).length + 1);
  };

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      socket.emit('ice-candidate', { roomId, userId, candidate: event.candidate });
    }
  };

  pc.onconnectionstatechange = () => {
    console.log(`Peer ${userId} connection state: ${pc.connectionState}`);
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
  if (toggleVideoBtn) toggleVideoBtn.textContent = isVideoEnabled ? 'Camera Off' : 'Camera On';
}

function toggleAudio() {
  if (!localStream) return;
  const audioTrack = localStream.getAudioTracks()[0];
  isAudioEnabled = !isAudioEnabled;
  audioTrack.enabled = isAudioEnabled;
  if (toggleAudioBtn) toggleAudioBtn.textContent = isAudioEnabled ? 'Mic Off' : 'Mic On';
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

// Handle authentication and clean up room_members
auth.onAuthStateChanged(async (user) => {
  if (!user) {
    console.error('No authenticated user');
    alert('Please log in to access the room.');
    window.location.href = './room-list.html';
    return;
  }

  const roomMembersRef = collection(db, 'rooms', roomId, 'room_members');
  try {
    console.log('Accessing room_members for user:', user.uid);
    // Clean up duplicates
    const membersSnapshot = await getDocs(roomMembersRef);
    const currentUserDocs = membersSnapshot.docs.filter(doc => doc.id === user.uid);
    if (currentUserDocs.length > 1) {
      console.warn(`Found ${currentUserDocs.length} duplicate room_members for ${user.uid}, cleaning up...`);
      for (let i = 1; i < currentUserDocs.length; i++) {
        await deleteDoc(currentUserDocs[i].ref);
      }
    }

    const memberDoc = await getDoc(doc(roomMembersRef, user.uid));
    if (!memberDoc.exists()) {
      console.log('Creating member document for:', user.uid);
      await setDoc(doc(roomMembersRef, user.uid), {
        userId: user.uid,
        userName: user.displayName || `User_${user.uid.substring(0, 5)}`,
        joinedAt: serverTimestamp(),
      });
    } else {
      const data = memberDoc.data();
      if (!data.userName) {
        console.log('Updating userName for:', user.uid);
        await setDoc(doc(roomMembersRef, user.uid), {
          userName: user.displayName || `User_${user.uid.substring(0, 5)}`
        }, { merge: true });
      }
    }
  } catch (error) {
    console.error('Error managing room member:', error);
    alert('Failed to join room. Check permissions or try again.');
  }

  // Load participants list
  if (participantsList) {
    onSnapshot(query(collection(db, 'rooms', roomId, 'room_members'), orderBy('joinedAt')), (snapshot) => {
      console.log('Participants:', snapshot.docs.map(doc => doc.data()));
      participantsList.innerHTML = '';
      if (snapshot.empty) {
        participantsList.innerHTML = '<li>No participants yet.</li>';
        return;
      }
      const participantCount = snapshot.docs.length;
      if (participantCount > 2) {
        console.warn(`Unexpected participant count: ${participantCount}, expected <= 2`);
      }
      snapshot.forEach((doc) => {
        const member = doc.data();
        const participantItem = document.createElement('li');
        participantItem.className = 'participant-item';
        participantItem.innerHTML = `
          <img src="https://www.gravatar.com/avatar/${member.userId}?d=mp" alt="${member.userName || member.userId}" style="width: 30px; height: 30px; border-radius: 50%;">
          ${member.userName || `User_${member.userId.substring(0, 5)}`}
        `;
        participantsList.appendChild(participantItem);
      });
      updateVideoGridLayout(Object.keys(peerConnections).length + 1);
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
    chatMessages.style.overflowY = 'auto';
    const messagesQuery = query(collection(db, 'rooms', roomId, 'messages'), orderBy('createdAt', 'asc'));
    onSnapshot(messagesQuery, (snapshot) => {
      console.log('Messages snapshot received, docs:', snapshot.docs.length);
      chatMessages.innerHTML = '';
      if (snapshot.empty) {
        chatMessages.innerHTML = '<p class="text-gray-500">No messages yet.</p>';
        return;
      }
      snapshot.forEach((doc) => {
        const msg = doc.data();
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
        console.log('Sending message:', text);
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
    chatInput.addEventListener('keydown', async (event) => {
      if (event.key === 'Enter') {
        const text = chatInput.value.trim();
        if (!text) return;
        try {
          console.log('Sending message:', text);
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
      }
    });
  } else {
    console.error('sendMessage or chatInput missing');
  }

  // Add label to local video
  if (localVideo) {
    const localLabel = document.createElement('div');
    localLabel.className = 'video-label';
    localLabel.textContent = user.displayName || `User_${user.uid.substring(0, 5)}`;
    localVideo.insertAdjacentElement('afterend', localLabel);
  }
});