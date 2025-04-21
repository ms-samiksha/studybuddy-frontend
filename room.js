import { db, auth } from './firebase.js';
import { collection, addDoc, onSnapshot, query, orderBy, serverTimestamp, doc, deleteDoc, getDoc, setDoc, getDocs } from 'https://www.gstatic.com/firebasejs/11.6.0/firebase-firestore.js';
import { getAuth, signOut } from 'https://www.gstatic.com/firebasejs/11.6.0/firebase-auth.js';

// URL and room validation
const urlParams = new URLSearchParams(window.location.search);
const roomId = urlParams.get('roomId');
if (!roomId) {
  console.error('No room ID provided');
  alert('No room ID provided.');
  window.location.href = './room-list.html';
}

// DOM elements
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

// Validate DOM elements
for (const [key, element] of Object.entries(elements)) {
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
let streamAssignmentTimeout = {};
const socket = io('https://studybuddy-backend-57xt.onrender.com', {
  reconnection: true,
  reconnectionAttempts: 5,
  reconnectionDelay: 1000,
  reconnectionDelayMax: 5000,
});

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

// Initialize UI
if (elements.chatSection && elements.videoCallSection) {
  elements.chatSection.style.display = 'block';
  elements.videoCallSection.style.display = 'none';
}

// Dynamic video grid layout
function updateVideoGridLayout(participantCount) {
  if (!elements.videoGrid) return;
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

// Pin video
function pinVideo(videoElement) {
  if (!videoElement) return;
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

// Leave room
async function leaveRoom() {
  if (!auth.currentUser) {
    alert('Please log in to leave the room.');
    return;
  }
  if (!confirm('Are you sure you want to leave the room?')) return;

  const userId = auth.currentUser.uid;
  try {
    await deleteDoc(doc(db, 'rooms', roomId, 'room_members', userId));
    socket.emit('leave-room', { roomId, userId });
    stopVideoCall();
    alert('You have left the room.');
    window.location.href = './room-list.html';
  } catch (error) {
    console.error('Error leaving room:', error);
    alert('Failed to leave room.');
  }
}

// Start video call
async function startVideoCall() {
  if (isVideoCallActive) return;

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
    if (elements.localVideo) {
      elements.localVideo.srcObject = localStream;
      elements.localVideo.play().catch(e => console.error('Local video play error:', e));
    }
    isVideoEnabled = true;
    isAudioEnabled = true;
    if (elements.toggleVideoBtn) elements.toggleVideoBtn.textContent = 'Camera Off';
    if (elements.toggleAudioBtn) elements.toggleAudioBtn.textContent = 'Mic Off';
    isVideoCallActive = true;
    if (elements.leaveCallBtn) elements.leaveCallBtn.disabled = false;

    if (elements.localVideo) {
      elements.localVideo.addEventListener('click', () => pinVideo(elements.localVideo));
      let localLabel = elements.localVideo.nextElementSibling;
      if (!localLabel || localLabel.className !== 'video-label') {
        localLabel = document.createElement('div');
        localLabel.className = 'video-label';
        localLabel.textContent = auth.currentUser.displayName || `User_${auth.currentUser.uid.substring(0, 5)}`;
        elements.localVideo.insertAdjacentElement('afterend', localLabel);
      }
    }

    socket.emit('join-room', { roomId, userId: auth.currentUser.uid });

    socket.on('connect', () => {
      socket.emit('join-room', { roomId, userId: auth.currentUser.uid });
    });

    socket.on('connect_error', (error) => {
      console.error('Socket.IO connect error:', error);
      alert('Failed to connect to signaling server. Retrying...');
    });

    socket.on('reconnect', (attempt) => {
      console.log(`Socket.IO reconnected after ${attempt} attempts`);
      socket.emit('join-room', { roomId, userId: auth.currentUser.uid });
    });

    socket.on('reconnect_failed', () => {
      console.error('Socket.IO reconnect failed');
      alert('Failed to reconnect to signaling server. Please refresh the page.');
      stopVideoCall();
    });

    socket.on('user-joined', async ({ userId }) => {
      if (userId !== auth.currentUser.uid) {
        let pc = peerConnections[userId];
        if (!pc) {
          pc = createPeerConnection(userId);
          peerConnections[userId] = pc;
        }
        if (pc.signalingState === 'stable') {
          setTimeout(async () => {
            try {
              const offer = await pc.createOffer();
              await pc.setLocalDescription(offer);
              socket.emit('offer', { roomId, userId, sdp: offer });
            } catch (error) {
              console.error(`Error creating offer for ${userId}:`, error);
            }
          }, 1000);
        }
        updateVideoGridLayout(Object.keys(peerConnections).length + 1);
      }
    });

    socket.on('offer', async ({ userId, sdp }) => {
      if (userId === auth.currentUser.uid) return;
      let pc = peerConnections[userId];
      if (!pc) {
        pc = createPeerConnection(userId);
        peerConnections[userId] = pc;
      }
      const trySetRemoteDescription = async (attempt = 1, maxAttempts = 3) => {
        if (pc.signalingState === 'have-local-offer') {
          await pc.setLocalDescription(new RTCSessionDescription({ type: 'rollback' }));
        }
        if (pc.signalingState === 'stable') {
          try {
            await pc.setRemoteDescription(new RTCSessionDescription(sdp));
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            socket.emit('answer', { roomId, userId, sdp: answer });
            if (candidateQueue[userId]) {
              for (const candidate of candidateQueue[userId]) {
                await tryAddIceCandidate(pc, candidate, userId);
              }
              delete candidateQueue[userId];
            }
            updateVideoGridLayout(Object.keys(peerConnections).length + 1);
          } catch (error) {
            console.error(`Error processing offer from ${userId}, attempt ${attempt}:`, error);
            if (attempt < maxAttempts) {
              setTimeout(() => trySetRemoteDescription(attempt + 1, maxAttempts), 1000);
            }
          }
        }
      };
      trySetRemoteDescription();
    });

    socket.on('answer', async ({ userId, sdp }) => {
      if (userId === auth.currentUser.uid) return;
      if (peerConnections[userId]) {
        const pc = peerConnections[userId];
        if (pc.signalingState === 'have-local-offer') {
          const trySetRemoteDescription = async (attempt = 1, maxAttempts = 3) => {
            try {
              await pc.setRemoteDescription(new RTCSessionDescription(sdp));
              if (candidateQueue[userId]) {
                for (const candidate of candidateQueue[userId]) {
                  await tryAddIceCandidate(pc, candidate, userId);
                }
                delete candidateQueue[userId];
              }
              updateVideoGridLayout(Object.keys(peerConnections).length + 1);
            } catch (error) {
              console.error(`Error processing answer from ${userId}, attempt ${attempt}:`, error);
              if (attempt < maxAttempts) {
                setTimeout(() => trySetRemoteDescription(attempt + 1, maxAttempts), 1000);
              }
            }
          };
          trySetRemoteDescription();
        }
      }
    });

    async function tryAddIceCandidate(pc, candidate, userId, attempt = 1, maxAttempts = 3) {
      try {
        await pc.addIceCandidate(new RTCIceCandidate(candidate));
      } catch (error) {
        console.error(`Error adding ICE candidate for ${userId}, attempt ${attempt}:`, error);
        if (attempt < maxAttempts) {
          setTimeout(() => tryAddIceCandidate(pc, candidate, userId, attempt + 1, maxAttempts), 1000);
        }
      }
    }

    socket.on('ice-candidate', async ({ userId, candidate }) => {
      if (userId === auth.currentUser.uid) return;
      if (peerConnections[userId]) {
        const pc = peerConnections[userId];
        if (pc.remoteDescription && pc.remoteDescription.type) {
          await tryAddIceCandidate(pc, candidate, userId);
        } else {
          candidateQueue[userId] = candidateQueue[userId] || [];
          candidateQueue[userId].push(candidate);
        }
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

    // Validate existing participants
    const membersSnapshot = await getDocs(collection(db, 'rooms', roomId, 'room_members'));
    const validMembers = membersSnapshot.docs.map(doc => doc.id);
    for (const userId of Object.keys(peerConnections)) {
      if (!validMembers.includes(userId)) {
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
    }
    for (const memberDoc of membersSnapshot.docs) {
      const userId = memberDoc.id;
      if (userId !== auth.currentUser.uid && !peerConnections[userId]) {
        const pc = createPeerConnection(userId);
        peerConnections[userId] = pc;
        if (pc.signalingState === 'stable') {
          setTimeout(async () => {
            try {
              const offer = await pc.createOffer();
              await pc.setLocalDescription(offer);
              socket.emit('offer', { roomId, userId, sdp: offer });
            } catch (error) {
              console.error(`Error creating offer for ${userId}:`, error);
            }
          }, 1000);
        }
      }
    }
    updateVideoGridLayout(Object.keys(peerConnections).length + 1);
  } catch (error) {
    console.error('Error starting video call:', error);
    alert('Failed to access camera. Please allow camera access or check device.');
    stopVideoCall();
  }
}

// Stop video call
function stopVideoCall() {
  if (localStream) {
    localStream.getTracks().forEach(track => track.stop());
    localStream = null;
  }
  if (elements.localVideo) elements.localVideo.srcObject = null;
  Object.values(peerConnections).forEach(pc => pc.close());
  peerConnections = {};
  if (elements.videoGrid) {
    while (elements.videoGrid.children.length > 1) {
      elements.videoGrid.removeChild(elements.videoGrid.lastChild);
    }
  }
  if (elements.localVideo) {
    const localLabel = elements.localVideo.nextElementSibling;
    if (localLabel && localLabel.className === 'video-label') localLabel.remove();
    elements.localVideo.classList.remove('pinned');
  }
  pinnedVideo = null;
  if (elements.toggleVideoBtn) elements.toggleVideoBtn.textContent = 'Camera On';
  if (elements.toggleAudioBtn) elements.toggleAudioBtn.textContent = 'Mic On';
  isVideoCallActive = false;
  isVideoEnabled = false;
  isAudioEnabled = false;
  if (elements.leaveCallBtn) elements.leaveCallBtn.disabled = true;
  if (auth.currentUser) {
    socket.emit('leave-room', { roomId, userId: auth.currentUser.uid });
  }
  updateVideoGridLayout(1);
}

// Create peer connection
function createPeerConnection(userId) {
  const pc = new RTCPeerConnection(rtcConfig);
  if (localStream) {
    localStream.getTracks().forEach(track => pc.addTrack(track, localStream));
  }

  pc.ontrack = (event) => {
    let remoteVideo = document.getElementById(`remote-video-${userId}`);
    if (!remoteVideo && elements.videoGrid) {
      remoteVideo = document.createElement('video');
      remoteVideo.id = `remote-video-${userId}`;
      remoteVideo.autoplay = true;
      remoteVideo.playsinline = true;
      const label = document.createElement('div');
      label.className = 'video-label';
      label.textContent = 'Unknown';
      elements.videoGrid.appendChild(remoteVideo);
      elements.videoGrid.appendChild(label);
      remoteVideo.addEventListener('click', () => pinVideo(remoteVideo));
      getDoc(doc(db, 'rooms', roomId, 'room_members', userId)).then(doc => {
        if (doc.exists()) {
          label.textContent = doc.data().userName || `User_${userId.substring(0, 5)}`;
        }
      }).catch(error => console.error(`Error fetching member document for ${userId}:`, error));
    }
    if (remoteVideo) {
      if (streamAssignmentTimeout[userId]) clearTimeout(streamAssignmentTimeout[userId]);
      streamAssignmentTimeout[userId] = setTimeout(() => {
        remoteVideo.srcObject = event.streams[0];
        const tryPlay = (attempt = 1, maxAttempts = 8) => {
          remoteVideo.play().then(() => {
            console.log(`Remote video for ${userId} playing`);
          }).catch(e => {
            console.error(`Remote video play error for ${userId}, attempt ${attempt}:`, e);
            if (attempt < maxAttempts) {
              setTimeout(() => tryPlay(attempt + 1, maxAttempts), 1000);
            }
          });
        };
        tryPlay();
      }, 500);
    }
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

// Toggle video/audio
function toggleVideo() {
  if (!localStream) return;
  const videoTrack = localStream.getVideoTracks()[0];
  isVideoEnabled = !isVideoEnabled;
  videoTrack.enabled = isVideoEnabled;
  if (elements.toggleVideoBtn) elements.toggleVideoBtn.textContent = isVideoEnabled ? 'Camera Off' : 'Camera On';
}

function toggleAudio() {
  if (!localStream) return;
  const audioTrack = localStream.getAudioTracks()[0];
  isAudioEnabled = !isAudioEnabled;
  audioTrack.enabled = isAudioEnabled;
  if (elements.toggleAudioBtn) elements.toggleAudioBtn.textContent = isAudioEnabled ? 'Mic Off' : 'Mic On';
}

// Event listeners
if (elements.leaveRoomButton) elements.leaveRoomButton.addEventListener('click', leaveRoom);
if (elements.chatTab) elements.chatTab.addEventListener('click', () => {
  elements.chatSection.style.display = 'block';
  elements.videoCallSection.style.display = 'none';
  elements.chatTab.classList.add('active');
  if (elements.videoTab) elements.videoTab.classList.remove('active');
});
if (elements.videoTab) elements.videoTab.addEventListener('click', () => {
  elements.chatSection.style.display = 'none';
  elements.videoCallSection.style.display = 'block';
  elements.videoTab.classList.add('active');
  if (elements.chatTab) elements.chatTab.classList.remove('active');
  if (!isVideoCallActive) startVideoCall();
});
if (elements.toggleVideoBtn) elements.toggleVideoBtn.addEventListener('click', toggleVideo);
if (elements.toggleAudioBtn) elements.toggleAudioBtn.addEventListener('click', toggleAudio);
if (elements.leaveCallBtn) elements.leaveCallBtn.addEventListener('click', stopVideoCall);
if (elements.backToChatBtn) elements.backToChatBtn.addEventListener('click', () => {
  elements.videoCallSection.style.display = 'none';
  elements.chatSection.style.display = 'block';
  if (elements.chatTab) elements.chatTab.classList.add('active');
  if (elements.videoTab) elements.videoTab.classList.remove('active');
});

// Handle authentication and room setup
auth.onAuthStateChanged(async (user) => {
  if (!user) {
    alert('Please log in to access the room.');
    window.location.href = './room-list.html';
    return;
  }

  const roomMembersRef = collection(db, 'rooms', roomId, 'room_members');
  try {
    // Clean up invalid and duplicate room_members
    const membersSnapshot = await getDocs(roomMembersRef);
    for (const doc of membersSnapshot.docs) {
      const data = doc.data();
      if (!data.userId || typeof data.userId !== 'string' || !data.joinedAt) {
        console.warn(`Deleting invalid room_member: ${doc.id}`, data);
        await deleteDoc(doc.ref);
      }
    }
    const currentUserDocs = membersSnapshot.docs.filter(doc => doc.id === user.uid);
    if (currentUserDocs.length > 1) {
      for (let i = 1; i < currentUserDocs.length; i++) {
        await deleteDoc(currentUserDocs[i].ref);
      }
    }

    const memberDoc = await getDoc(doc(roomMembersRef, user.uid));
    if (!memberDoc.exists()) {
      await setDoc(doc(roomMembersRef, user.uid), {
        userId: user.uid,
        userName: user.displayName || `User_${user.uid.substring(0, 5)}`,
        joinedAt: serverTimestamp(),
      });
    } else if (!memberDoc.data().userName) {
      await setDoc(doc(roomMembersRef, user.uid), {
        userName: user.displayName || `User_${user.uid.substring(0, 5)}`
      }, { merge: true });
    }

    // Load participants
    if (elements.participantsList) {
      onSnapshot(query(collection(db, 'rooms', roomId, 'room_members'), orderBy('joinedAt')), (snapshot) => {
        console.log('Participants snapshot:', snapshot.docs.map(doc => doc.data()));
        elements.participantsList.innerHTML = '';
        if (snapshot.empty) {
          elements.participantsList.innerHTML = '<li>No participants yet.</li>';
          return;
        }
        snapshot.forEach((doc) => {
          const member = doc.data();
          if (!member.userId || typeof member.userId !== 'string') {
            console.warn(`Invalid member document: ${doc.id}`, member);
            return;
          }
          const li = document.createElement('li');
          li.className = 'participant-item';
          li.innerHTML = `
            <img src="https://www.gravatar.com/avatar/${member.userId}?d=mp" alt="${member.userName || 'User'}" style="width: 30px; height: 30px; border-radius: 50%;">
            ${member.userName || `User_${member.userId.substring(0, 5)}`}
          `;
          elements.participantsList.appendChild(li);
        });
        updateVideoGridLayout(Object.keys(peerConnections).length + 1);
      }, (error) => {
        console.error('Error in participants snapshot:', error);
        elements.participantsList.innerHTML = '<li>Failed to load participants.</li>';
      });
    }

    // Load chat messages
    function loadMessages(attempt = 1, maxAttempts = 10) {
      if (!elements.chatMessages) {
        if (attempt <= maxAttempts) {
          console.warn(`chat-messages not found, retrying (${attempt}/${maxAttempts})...`);
          setTimeout(() => loadMessages(attempt + 1, maxAttempts), 100);
        }
        return;
      }
      elements.chatMessages.style.overflowY = 'auto';
      const messagesQuery = query(collection(db, 'rooms', roomId, 'messages'), orderBy('createdAt', 'asc'));
      onSnapshot(messagesQuery, (snapshot) => {
        elements.chatMessages.innerHTML = '';
        if (snapshot.empty) {
          elements.chatMessages.innerHTML = '<p class="text-gray-500">No messages yet.</p>';
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
          elements.chatMessages.appendChild(msgContainer);
        });
        elements.chatMessages.scrollTop = elements.chatMessages.scrollHeight;
        setTimeout(() => {
          elements.chatMessages.scrollTop = elements.chatMessages.scrollHeight;
        }, 10);
      }, (error) => {
        console.error('Error in messages snapshot:', error);
        elements.chatMessages.innerHTML = '<p class="text-red-500">Failed to load messages.</p>';
      });
    }
    loadMessages();

    // Send message
    if (elements.sendMessage && elements.chatInput) {
      const sendMessageHandler = async () => {
        const text = elements.chatInput.value.trim();
        if (!text) return;
        try {
          await addDoc(collection(db, 'rooms', roomId, 'messages'), {
            text,
            userName: user.displayName || `User_${user.uid.substring(0, 5)}`,
            userId: user.uid,
            createdAt: serverTimestamp()
          });
          elements.chatInput.value = '';
        } catch (error) {
          console.error('Error sending message:', error);
          alert('Failed to send message.');
        }
      };
      elements.sendMessage.addEventListener('click', sendMessageHandler);
      elements.chatInput.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') sendMessageHandler();
      });
    }

    // Add label to local video
    if (elements.localVideo) {
      const existingLabel = elements.localVideo.nextElementSibling;
      if (!existingLabel || existingLabel.className !== 'video-label') {
        const localLabel = document.createElement('div');
        localLabel.className = 'video-label';
        localLabel.textContent = user.displayName || `User_${user.uid.substring(0, 5)}`;
        elements.localVideo.insertAdjacentElement('afterend', localLabel);
      }
    }
  } catch (error) {
    console.error('Error initializing room:', error);
    alert('Failed to join room. Please try again.');
    window.location.href = './room-list.html';
  }
});