import { initializeApp } from "https://www.gstatic.com/firebasejs/11.6.0/firebase-app.js";
import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/11.6.0/firebase-auth.js";
import { getFirestore, collection, doc, setDoc, getDocs, deleteDoc, query, where, orderBy, onSnapshot, addDoc, serverTimestamp, getDoc } from "https://www.gstatic.com/firebasejs/11.6.0/firebase-firestore.js";

const db = getFirestore();
const auth = getAuth();
const roomId = new URLSearchParams(window.location.search).get('roomId');
if (!roomId) {
  console.error('ERROR: No roomId in URL');
  alert('Invalid room URL. Redirecting...');
  window.location.href = './room-list.html';
}

// DOM elements with validation
const elements = {
  videoGrid: document.getElementById('video-grid'),
  localVideo: document.getElementById('local-video'),
  toggleVideoBtn: document.getElementById('toggle-video-btn'),
  toggleAudioBtn: document.getElementById('toggle-audio-btn'),
  leaveCallBtn: document.getElementById('leave-call-btn'),
  backToChatBtn: document.getElementById('back-to-chat-btn'),
  videoCallSection: document.getElementById('video-call-section'),
  chatSection: document.getElementById('chat-section'),
  chatTab: document.getElementById('chat-tab'),
  videoTab: document.getElementById('video-tab'),
  leaveRoom: document.getElementById('leave-room'),
  participantsList: document.getElementById('participants-list'),
  chatMessages: document.getElementById('chat-messages'),
  chatInput: document.getElementById('chat-input'),
  sendMessage: document.getElementById('send-message')
};

Object.entries(elements).forEach(([key, el]) => {
  if (!el) console.error(`ERROR: DOM element ${key} not found`);
});

const peerConnections = new Map();
let localStream = null;
let isVideoOn = true;
let isAudioOn = true;
let pinnedVideo = null;

async function createPeerConnection(userId) {
  if (!userId || peerConnections.has(userId)) {
    console.warn(`Skipping peer connection for ${userId || 'undefined'}: ${peerConnections.has(userId) ? 'Already exists' : 'Invalid ID'}`);
    return;
  }

  const configuration = {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      {
        urls: 'turn:openrelay.metered.ca:80',
        username: 'openrelayproject',
        credential: 'openrelayproject'
      }
    ]
  };

  try {
    const peerConnection = new RTCPeerConnection(configuration);
    peerConnections.set(userId, peerConnection);

    peerConnection.onicecandidate = async (event) => {
      if (event.candidate && auth.currentUser) {
        console.log(`Sending ICE candidate for ${userId}`);
        try {
          await addDoc(collection(db, 'rooms', roomId, 'signaling'), {
            type: 'candidate',
            candidate: event.candidate,
            senderId: auth.currentUser.uid,
            receiverId: userId,
            createdAt: serverTimestamp()
          });
        } catch (error) {
          console.error(`ERROR sending ICE candidate for ${userId}:`, error);
        }
      }
    };

    peerConnection.ontrack = async (event) => {
      console.log(`Received remote track for ${userId}`);
      let remoteVideo = document.getElementById(`video-${userId}`);
      if (!remoteVideo && elements.videoGrid) {
        remoteVideo = document.createElement('video');
        remoteVideo.id = `video-${userId}`;
        remoteVideo.autoplay = true;
        remoteVideo.playsInline = true;

        const videoLabel = document.createElement('div');
        videoLabel.className = 'video-label';
        try {
          const userDoc = await getDoc(doc(db, 'rooms', roomId, 'room_members', userId));
          videoLabel.textContent = userDoc.exists() ? userDoc.data().userName : `User_${userId.substring(0, 5)}`;
        } catch (error) {
          console.error(`ERROR fetching username for ${userId}:`, error);
          videoLabel.textContent = `User_${userId.substring(0, 5)}`;
        }

        const videoContainer = document.createElement('div');
        videoContainer.className = 'video-container';
        videoContainer.appendChild(remoteVideo);
        videoContainer.appendChild(videoLabel);
        elements.videoGrid.appendChild(videoContainer);

        remoteVideo.addEventListener('click', () => pinVideo(remoteVideo));
      }

      if (remoteVideo && event.streams[0] && remoteVideo.srcObject !== event.streams[0]) {
        remoteVideo.srcObject = event.streams[0];
        await tryPlay(remoteVideo, userId);
      }
      updateVideoGridLayout();
    };

    peerConnection.onconnectionstatechange = () => {
      console.log(`Connection state for ${userId}: ${peerConnection.connectionState}`);
      if (peerConnection.connectionState === 'failed' || peerConnection.connectionState === 'disconnected') {
        cleanupPeerConnection(userId);
      }
    };

    if (localStream) {
      localStream.getTracks().forEach(track => peerConnection.addTrack(track, localStream));
    }

    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);
    console.log(`Created and set offer for ${userId}`);
    if (auth.currentUser) {
      await addDoc(collection(db, 'rooms', roomId, 'signaling'), {
        type: 'offer',
        offer,
        senderId: auth.currentUser.uid,
        receiverId: userId,
        createdAt: serverTimestamp()
      });
    }
  } catch (error) {
    console.error(`ERROR creating peer connection for ${userId}:`, error);
    cleanupPeerConnection(userId);
  }

  logPeerConnections();
}

async function tryPlay(videoElement, userId) {
  if (!videoElement || !videoElement.srcObject) {
    console.warn(`Cannot play video for ${userId}: No video element or stream`);
    return;
  }

  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      if (videoElement.readyState < 2) {
        console.log(`Attempt ${attempt}: Video for ${userId} not ready, waiting...`);
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      await videoElement.play();
      console.log(`Successfully playing remote video for ${userId}`);
      return;
    } catch (error) {
      console.error(`Attempt ${attempt} failed for ${userId}:`, error);
      if (attempt === 5) {
        console.error(`Max retries reached for ${userId}`);
        videoElement.srcObject = null;
      }
      await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
    }
  }
}

function cleanupPeerConnection(userId) {
  const peerConnection = peerConnections.get(userId);
  if (peerConnection) {
    try {
      peerConnection.close();
    } catch (error) {
      console.error(`ERROR closing peer connection for ${userId}:`, error);
    }
    peerConnections.delete(userId);
    const videoContainer = document.querySelector(`#video-${userId}`)?.parentElement;
    if (videoContainer) {
      if (pinnedVideo?.id === `video-${userId}`) pinnedVideo = null;
      videoContainer.remove();
    }
    console.log(`Cleaned up peer connection for ${userId}`);
    updateVideoGridLayout();
  }
}

async function setupSignalingListener() {
  if (!auth.currentUser) {
    console.error('ERROR: Cannot setup signaling listener without authenticated user');
    return;
  }

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

      let peerConnection = peerConnections.get(senderId);
      if (!peerConnection) {
        console.log(`Creating peer connection for ${senderId} due to signaling`);
        await createPeerConnection(senderId);
        peerConnection = peerConnections.get(senderId);
        if (!peerConnection) {
          console.error(`Failed to create peer connection for ${senderId}`);
          await deleteDoc(change.doc.ref);
          continue;
        }
      }

      try {
        if (data.type === 'offer') {
          await peerConnection.setRemoteDescription(new RTCSessionDescription(data.offer));
          const answer = await peerConnection.createAnswer();
          await peerConnection.setLocalDescription(answer);
          await addDoc(collection(db, 'rooms', roomId, 'signaling'), {
            type: 'answer',
            answer,
            senderId: auth.currentUser.uid,
            receiverId: senderId,
            createdAt: serverTimestamp()
          });
          console.log(`Processed offer and sent answer for ${senderId}`);
        } else if (data.type === 'answer') {
          await peerConnection.setRemoteDescription(new RTCSessionDescription(data.answer));
          console.log(`Processed answer for ${senderId}`);
        } else if (data.type === 'candidate') {
          await peerConnection.addIceCandidate(new RTCIceCandidate(data.candidate));
          console.log(`Added ICE candidate for ${senderId}`);
        }
        await deleteDoc(change.doc.ref); // Clean up processed signal
      } catch (error) {
        console.error(`ERROR processing signaling for ${senderId}:`, error);
      }
    }
  }, (error) => {
    console.error('ERROR in signaling snapshot:', error);
    alert('Failed to load signaling data. Please refresh.');
  });
}

function updateVideoGridLayout() {
  const videos = elements.videoGrid?.querySelectorAll('video') || [];
  const participantCount = videos.length;
  const maxColumns = Math.min(4, Math.ceil(Math.sqrt(participantCount)));
  if (elements.videoGrid) {
    elements.videoGrid.style.gridTemplateColumns = participantCount > 1 ? `repeat(${maxColumns}, 1fr)` : '1fr';
    elements.videoGrid.style.gridTemplateRows = participantCount > 1 ? `repeat(${Math.ceil(participantCount / maxColumns)}, 1fr)` : '1fr';
  }
}

function pinVideo(videoElement) {
  if (!elements.videoGrid || !videoElement) return;
  const videos = elements.videoGrid.querySelectorAll('video');
  videos.forEach(video => video.classList.remove('pinned'));
  if (pinnedVideo !== videoElement) {
    videoElement.classList.add('pinned');
    pinnedVideo = videoElement;
    elements.videoGrid.style.gridTemplateColumns = '1fr';
    elements.videoGrid.style.gridTemplateRows = '1fr';
  } else {
    pinnedVideo = null;
    updateVideoGridLayout();
  }
}

async function setupParticipantsList() {
  const participantsQuery = query(collection(db, 'rooms', roomId, 'room_members'), orderBy('joinedAt'));
  onSnapshot(participantsQuery, (snapshot) => {
    if (!elements.participantsList) return;
    elements.participantsList.innerHTML = '';
    snapshot.forEach((doc) => {
      const member = doc.data();
      const li = document.createElement('li');
      li.className = 'participant-item';
      li.innerHTML = `
        <img src="https://www.gravatar.com/avatar/${member.userId}?d=mp" alt="Profile" style="width: 30px; height: 30px; border-radius: 50%;">
        <span>${member.userName}</span>
      `;
      elements.participantsList.appendChild(li);
    });
    // Clean up stale peer connections
    peerConnections.forEach((_, userId) => {
      if (!snapshot.docs.some(doc => doc.id === userId)) {
        cleanupPeerConnection(userId);
      }
    });
  }, (error) => {
    console.error('ERROR in participants snapshot:', error);
    if (elements.participantsList) {
      elements.participantsList.innerHTML = '<li class="text-red-500">Failed to load participants.</li>';
    }
  });
}

function setupChat() {
  if (!elements.chatMessages || !elements.chatInput || !elements.sendMessage) {
    console.error('ERROR: Chat elements missing');
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

  elements.sendMessage.addEventListener('click', sendChatMessage);
  elements.chatInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      sendChatMessage();
    }
  });
}

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

async function clearSignaling() {
  if (!auth.currentUser) return;
  try {
    const signalingDocs = await getDocs(collection(db, 'rooms', roomId, 'signaling'));
    for (const doc of signalingDocs.docs) {
      const data = doc.data();
      if (data.senderId === auth.currentUser.uid || data.receiverId === auth.currentUser.uid) {
        await deleteDoc(doc.ref);
      }
    }
    console.log('Cleared stale signaling messages');
  } catch (error) {
    console.error('ERROR clearing signaling:', error);
  }
}

async function leaveRoom() {
  if (localStream) {
    localStream.getTracks().forEach(track => track.stop());
    localStream = null;
  }

  peerConnections.forEach((_, userId) => cleanupPeerConnection(userId));

  try {
    await clearSignaling();
    if (auth.currentUser) {
      const memberRef = doc(collection(db, 'rooms', roomId, 'room_members'), auth.currentUser.uid);
      await deleteDoc(memberRef);
      console.log('Left room successfully');
    }
  } catch (error) {
    console.error('ERROR during cleanup:', error);
  }

  window.location.href = './room-list.html';
}

function logPeerConnections() {
  console.log('Active Peer Connections');
  if (peerConnections.size === 0) {
    console.log('No active peer connections');
    return;
  }
  peerConnections.forEach((pc, userId) => {
    console.log(`User: ${userId}`);
    console.log(`Connection State: ${pc.connectionState}`);
    console.log(`ICE State: ${pc.iceConnectionState}`);
    console.log(`Signaling State: ${pc.signalingState}`);
    console.log('Tracks:', {
      local: localStream?.getTracks().map(t => t.kind) || [],
      remote: pc.getReceivers().map(r => r.track?.kind).filter(Boolean)
    });
  });
}

auth.onAuthStateChanged(async (user) => {
  if (!user) {
    console.error('ERROR: User not authenticated');
    alert('Please log in to access the room.');
    window.location.href = './room-list.html';
    return;
  }

  console.log(`User authenticated: ${user.uid}`);

  try {
    await clearSignaling();

    const roomMembersRef = collection(db, 'rooms', roomId, 'room_members');
    const memberRef = doc(roomMembersRef, user.uid);

    const membersSnapshot = await getDocs(roomMembersRef);
    const currentUserDocs = membersSnapshot.docs.filter(doc => doc.id === user.uid);

    if (currentUserDocs.length > 1) {
      console.warn(`Found ${currentUserDocs.length} duplicate memberships, cleaning up...`);
      for (let i = 1; i < currentUserDocs.length; i++) {
        await deleteDoc(currentUserDocs[i].ref);
      }
    }

    await setDoc(memberRef, {
      userId: user.uid,
      userName: user.displayName || `User_${user.uid.substring(0, 5)}`,
      joinedAt: serverTimestamp()
    }, { merge: true });

    console.log('Room membership initialized');

    setupParticipantsList();
    setupChat();

    try {
      localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      if (elements.localVideo) {
        elements.localVideo.srcObject = localStream;
        await elements.localVideo.play();
        console.log('Local video playing');
      }

      membersSnapshot.forEach((doc) => {
        const member = doc.data();
        if (member.userId !== user.uid && !peerConnections.has(member.userId)) {
          createPeerConnection(member.userId);
        }
      });

      setupSignalingListener();
    } catch (error) {
      console.error('ERROR accessing media devices:', error);
      alert('Failed to access camera/microphone. Please check permissions.');
    }

    setInterval(logPeerConnections, 5000);

    elements.toggleVideoBtn?.addEventListener('click', () => {
      isVideoOn = !isVideoOn;
      localStream?.getVideoTracks().forEach(track => track.enabled = isVideoOn);
      if (elements.toggleVideoBtn) {
        elements.toggleVideoBtn.textContent = `Camera ${isVideoOn ? 'On' : 'Off'}`;
      }
    });

    elements.toggleAudioBtn?.addEventListener('click', () => {
      isAudioOn = !isAudioOn;
      localStream?.getAudioTracks().forEach(track => track.enabled = isAudioOn);
      if (elements.toggleAudioBtn) {
        elements.toggleAudioBtn.textContent = `Mic ${isAudioOn ? 'On' : 'Off'}`;
      }
    });

    elements.leaveCallBtn?.addEventListener('click', leaveRoom);
    elements.backToChatBtn?.addEventListener('click', () => {
      if (elements.videoCallSection) elements.videoCallSection.style.display = 'none';
      if (elements.chatSection) elements.chatSection.style.display = 'block';
      elements.videoTab?.classList.remove('active');
      elements.chatTab?.classList.add('active');
    });

    elements.leaveRoom?.addEventListener('click', leaveRoom);

    elements.videoTab?.addEventListener('click', () => {
      if (elements.videoCallSection) elements.videoCallSection.style.display = 'block';
      if (elements.chatSection) elements.chatSection.style.display = 'none';
      elements.videoTab?.classList.add('active');
      elements.chatTab?.classList.remove('active');
    });

    elements.chatTab?.addEventListener('click', () => {
      if (elements.videoCallSection) elements.videoCallSection.style.display = 'none';
      if (elements.chatSection) elements.chatSection.style.display = 'block';
      elements.videoTab?.classList.remove('active');
      elements.chatTab?.classList.add('active');
    });
  } catch (error) {
    console.error('ERROR initializing room membership:', error);
    alert('Failed to join room. Please try again.');
  }
});