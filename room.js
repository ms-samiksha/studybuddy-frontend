import { db, auth } from './firebase.js';
import { collection, addDoc, onSnapshot, query, orderBy, serverTimestamp, doc, deleteDoc, getDoc, setDoc, getDocs, where } from 'https://www.gstatic.com/firebasejs/11.6.0/firebase-firestore.js';

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
let peerConnections = new Map();
let isVideoCallActive = false;
let isVideoEnabled = false;
let isAudioEnabled = false;
let pinnedVideo = null;
const candidateQueue = new Map();
const streamAssignmentTimeout = new Map();

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
} else {
  console.error('chatSection or videoCallSection missing');
}

// Dynamic video grid layout
function updateVideoGridLayout(participantCount) {
  if (!elements.videoGrid) {
    console.error('videoGrid element not found');
    return;
  }
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
  updateVideoGridLayout(peerConnections.size + 1);
}

// Leave room
async function leaveRoom() {
  if (!auth.currentUser) {
    console.error('No authenticated user');
    alert('Please log in to leave the room.');
    return;
  }
  if (!confirm('Are you sure you want to leave the room?')) return;

  const userId = auth.currentUser.uid;
  try {
    const response = await fetch('https://studybuddy-backend-57xt.onrender.com/leave-room', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ roomId, userId })
    });
    const data = await response.json();
    if (data.error) throw new Error(data.error);
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

    // Join room via Flask
    const response = await fetch('https://studybuddy-backend-57xt.onrender.com/join-room', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        roomId,
        userId: auth.currentUser.uid,
        userName: auth.currentUser.displayName || `User_${auth.currentUser.uid.substring(0, 5)}`
      })
    });
    const data = await response.json();
    if (data.error) throw new Error(data.error);
    console.log('Joined room:', data);

    // Setup signaling and validate participants
    await setupSignalingListener();
    await validateParticipants();
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
  peerConnections.forEach((pc, userId) => {
    pc.close();
    const videoElement = document.getElementById(`remote-video-${userId}`);
    if (videoElement) {
      if (pinnedVideo === videoElement) pinnedVideo = null;
      const label = videoElement.nextElementSibling;
      if (label && label.className === 'video-label') label.remove();
      videoElement.remove();
    }
  });
  peerConnections.clear();
  if (elements.localVideo) {
    const localLabel = elements.localVideo.nextElementSibling;
    if (localLabel && localLabel.className === 'video-label') localLabel.remove();
    elements.localVideo.classList.remove('pinned');
  }
  pinnedVideo = null;
  if (elements.toggleVideoBtn) elements.toggleVideoBtn.textContent = 'Camera On';
  if (elements.toggleAudioBtn) elements.toggleAudioBtn.textContent = 'Mic On';
  isVideoCallActive = false;
  isAudioEnabled = false;
  isVideoEnabled = false;
  if (elements.leaveCallBtn) elements.leaveCallBtn.disabled = true;
  updateVideoGridLayout(1);
}

// Create peer connection
function createPeerConnection(userId) {
  const pc = new RTCPeerConnection(rtcConfig);
  if (localStream) {
    localStream.getTracks().forEach(track => pc.addTrack(track, localStream));
  }

  pc.ontrack = (event) => {
    console.log(`Received track from ${userId}, streams: ${event.streams.length}`);
    let remoteVideo = document.getElementById(`remote-video-${userId}`);
    if (!remoteVideo && elements.videoGrid) {
      remoteVideo = document.createElement('video');
      remoteVideo.id = `remote-video-${userId}`;
      remoteVideo.autoplay = true;
      remoteVideo.playsInline = true;
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
    if (remoteVideo && event.streams[0]) {
      if (streamAssignmentTimeout.get(userId)) clearTimeout(streamAssignmentTimeout.get(userId));
      streamAssignmentTimeout.set(userId, setTimeout(() => {
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
      }, 500));
    }
    updateVideoGridLayout(peerConnections.size + 1);
  };

  pc.onicecandidate = async (event) => {
    if (event.candidate) {
      await addDoc(collection(db, 'rooms', roomId, 'signaling'), {
        type: 'candidate',
        candidate: event.candidate,
        senderId: auth.currentUser.uid,
        receiverId: userId,
        createdAt: serverTimestamp()
      });
      console.log(`Sent ICE candidate to ${userId}`);
    }
  };

  pc.onconnectionstatechange = () => {
    console.log(`Peer ${userId} connection state: ${pc.connectionState}`);
    if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
      pc.close();
      peerConnections.delete(userId);
      const videoElement = document.getElementById(`remote-video-${userId}`);
      if (videoElement) {
        if (pinnedVideo === videoElement) pinnedVideo = null;
        const label = videoElement.nextElementSibling;
        if (label && label.className === 'video-label') label.remove();
        videoElement.remove();
      }
      updateVideoGridLayout(peerConnections.size + 1);
    }
  };

  return pc;
}

// Validate participants
async function validateParticipants() {
  const membersSnapshot = await getDocs(collection(db, 'rooms', roomId, 'room_members'));
  const validMembers = membersSnapshot.docs.map(doc => doc.id);
  console.log(`Valid room_members: ${validMembers}`);
  peerConnections.forEach((pc, userId) => {
    if (!validMembers.includes(userId)) {
      console.log(`Closing stale peer connection for ${userId}`);
      pc.close();
      peerConnections.delete(userId);
      const videoElement = document.getElementById(`remote-video-${userId}`);
      if (videoElement) {
        if (pinnedVideo === videoElement) pinnedVideo = null;
        const label = videoElement.nextElementSibling;
        if (label && label.className === 'video-label') label.remove();
        videoElement.remove();
      }
    }
  });
  for (const memberDoc of membersSnapshot.docs) {
    const userId = memberDoc.id;
    if (userId !== auth.currentUser.uid && !peerConnections.has(userId)) {
      const pc = createPeerConnection(userId);
      peerConnections.set(userId, pc);
      if (pc.signalingState === 'stable') {
        setTimeout(async () => {
          try {
            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);
            await addDoc(collection(db, 'rooms', roomId, 'signaling'), {
              type: 'offer',
              offer,
              senderId: auth.currentUser.uid,
              receiverId: userId,
              createdAt: serverTimestamp()
            });
            console.log(`Sent offer to ${userId}`);
          } catch (error) {
            console.error(`Error creating offer for ${userId}:`, error);
          }
        }, 1000);
      }
    }
  }
  updateVideoGridLayout(peerConnections.size + 1);
}

// Setup Firestore signaling
async function setupSignalingListener() {
  const signalingQuery = query(
    collection(db, 'rooms', roomId, 'signaling'),
    where('receiverId', '==', auth.currentUser.uid),
    orderBy('createdAt', 'asc')
  );

  onSnapshot(signalingQuery, async (snapshot) => {
    for (const change of snapshot.docChanges()) {
      if (change.type !== 'added') continue;
      const data = change.doc.data();
      const senderId = data.senderId;
      if (senderId === auth.currentUser.uid) continue;

      let pc = peerConnections.get(senderId);
      if (!pc) {
        pc = createPeerConnection(senderId);
        peerConnections.set(senderId, pc);
      }

      try {
        if (data.type === 'offer') {
          if (pc.signalingState === 'have-local-offer') {
            await pc.setLocalDescription(new RTCSessionDescription({ type: 'rollback' }));
          }
          await pc.setRemoteDescription(new RTCSessionDescription(data.offer));
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          await addDoc(collection(db, 'rooms', roomId, 'signaling'), {
            type: 'answer',
            answer,
            senderId: auth.currentUser.uid,
            receiverId: senderId,
            createdAt: serverTimestamp()
          });
          console.log(`Processed offer from ${senderId}`);
        } else if (data.type === 'answer') {
          if (pc.signalingState === 'have-local-offer') {
            await pc.setRemoteDescription(new RTCSessionDescription(data.answer));
            console.log(`Processed answer from ${senderId}`);
          }
        } else if (data.type === 'candidate') {
          if (pc.remoteDescription) {
            await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
            console.log(`Added ICE candidate from ${senderId}`);
          } else {
            candidateQueue.set(senderId, candidateQueue.get(senderId) || []);
            candidateQueue.get(senderId).push(data.candidate);
          }
        }
        await deleteDoc(change.doc.ref);
      } catch (error) {
        console.error(`Error processing signaling for ${senderId}:`, error);
      }
    }
  }, (error) => {
    console.error('Error in signaling snapshot:', error);
    alert('Failed to load signaling data. Please refresh.');
  });
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
    console.error('No authenticated user');
    alert('Please log in to access the room.');
    window.location.href = './room-list.html';
    return;
  }

  const roomMembersRef = collection(db, 'rooms', roomId, 'room_members');
  try {
    // Clean up duplicates for current user only
    const membersSnapshot = await getDocs(roomMembersRef);
    const currentUserDocs = membersSnapshot.docs.filter(doc => doc.id === user.uid);
    if (currentUserDocs.length > 1) {
      console.warn(`Found ${currentUserDocs.length} duplicates for ${user.uid}, cleaning up...`);
      for (let i = 1; i < currentUserDocs.length; i++) {
        await deleteDoc(currentUserDocs[i].ref);
        console.log(`Deleted duplicate room_member: ${currentUserDocs[i].id}`);
      }
    }

    const memberDoc = await getDoc(doc(roomMembersRef, user.uid));
    if (!memberDoc.exists()) {
      console.log('Creating member document for:', user.uid);
      await setDoc(doc(roomMembersRef, user.uid), {
        userId: user.uid,
        userName: user.displayName || `User_${user.uid.substring(0, 5)}`,
        joinedAt: serverTimestamp()
      });
    } else if (!memberDoc.data().userName) {
      console.log('Updating userName for:', user.uid);
      await setDoc(doc(roomMembersRef, user.uid), {
        userName: user.displayName || `User_${user.uid.substring(0, 5)}`
      }, { merge: true });
    }

    // Load participants
    if (elements.participantsList) {
      onSnapshot(query(collection(db, 'rooms', roomId, 'room_members'), orderBy('joinedAt')), (snapshot) => {
        elements.participantsList.innerHTML = '';
        if (snapshot.empty) {
          elements.participantsList.innerHTML = '<li>No participants yet.</li>';
          return;
        }
        snapshot.forEach((doc) => {
          const member = doc.data();
          const li = document.createElement('li');
          li.className = 'participant-item';
          li.innerHTML = `
            <img src="https://www.gravatar.com/avatar/${member.userId}?d=mp" alt="${member.userName}" style="width: 30px; height: 30px; border-radius: 50%;">
            ${member.userName || `User_${member.userId.substring(0, 5)}`}
          `;
          elements.participantsList.appendChild(li);
        });
        updateVideoGridLayout(peerConnections.size + 1);
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
        } else {
          console.error('chat-messages element not found after max retries');
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
  } catch (error) {
    console.error('Error initializing room:', error);
    alert('Failed to join room. Please try again.');
    window.location.href = './room-list.html';
  }
});