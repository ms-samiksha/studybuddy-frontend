import { db, auth } from './firebase.js';
import {
  collection,
  addDoc,
  onSnapshot,
  query,
  orderBy,
  serverTimestamp,
  doc,
  deleteDoc,
  getDoc,
  setDoc,
} from 'https://www.gstatic.com/firebasejs/11.6.0/firebase-firestore.js';

// Get roomId from URL
const urlParams = new URLSearchParams(window.location.search);
const roomId = urlParams.get('roomId');
if (!roomId) {
  alert('No room ID provided.');
  window.location.href = './room-list.html';
}

// DOM elements
const leaveRoomButton = document.getElementById('leave-room');
const chatMessages = document.getElementById('chat-messages');
const chatInput = document.getElementById('chat-input');
const sendMessage = document.getElementById('send-message');
const videoCallBtn = document.getElementById('video-call-btn');
const videoCallSection = document.getElementById('video-call-section');
const chatSection = document.getElementById('chat-section');
const backToChatBtn = document.getElementById('back-to-chat-btn');
const participantsList = document.getElementById('participants-list');
const chatTab = document.getElementById('chat-tab');
const videoTab = document.getElementById('video-tab');
const videoGrid = document.getElementById('video-grid');

// Initial UI state
chatSection.style.display = 'block';
videoCallSection.style.display = 'none';

// Leave room
leaveRoomButton?.addEventListener('click', async () => {
  if (!auth.currentUser) return alert('Please log in to leave the room.');
  if (!confirm('Are you sure you want to leave the room?')) return;

  try {
    await deleteDoc(doc(db, 'rooms', roomId, 'room_members', auth.currentUser.uid));
    alert('You have left the room.');
    window.location.href = './room-list.html';
  } catch (error) {
    console.error('Error leaving room:', error);
    alert('Failed to leave room.');
  }
});

// Tab switching
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
});

// Firebase Authentication
auth.onAuthStateChanged(async (user) => {
  if (!user) {
    alert('Please log in to access the room.');
    window.location.href = './room-list.html';
    return;
  }

  // Add or update user in room_members
  const roomMembersRef = collection(db, 'rooms', roomId, 'room_members');
  const memberRef = doc(roomMembersRef, user.uid);
  const memberSnap = await getDoc(memberRef);

  if (!memberSnap.exists()) {
    await setDoc(memberRef, {
      userId: user.uid,
      userName: user.displayName || `User_${user.uid.substring(0, 5)}`,
      joinedAt: serverTimestamp(),
    });
  } else if (!memberSnap.data().userName) {
    await setDoc(memberRef, {
      userName: user.displayName || `User_${user.uid.substring(0, 5)}`,
    }, { merge: true });
  }

  // Update participants list
  onSnapshot(roomMembersRef, (snapshot) => {
    participantsList.innerHTML = '';
    if (snapshot.empty) {
      participantsList.innerHTML = '<li>No participants yet.</li>';
      return;
    }
    snapshot.forEach((doc) => {
      const member = doc.data();
      const li = document.createElement('li');
      li.className = 'participant-item';
      li.innerHTML = `
        <img src="https://www.gravatar.com/avatar/${member.userId}?d=mp" alt="User" style="width:30px;height:30px;border-radius:50%;">
        ${member.userName || `User_${member.userId.substring(0, 5)}`}
      `;
      participantsList.appendChild(li);
    });
  });

  // Load chat messages
  function loadMessages() {
    const messagesRef = query(collection(db, 'rooms', roomId, 'messages'), orderBy('createdAt', 'asc'));
    onSnapshot(messagesRef, (snapshot) => {
      chatMessages.innerHTML = '';
      if (snapshot.empty) {
        chatMessages.innerHTML = '<p class="text-gray-500">No messages yet.</p>';
        return;
      }

      let lastMessageDate = null;
      snapshot.forEach((doc) => {
        const msg = doc.data();
        const isCurrentUser = msg.userId === user.uid;
        const messageDate = msg.createdAt?.toDate();
        const messageDateString = messageDate ? messageDate.toLocaleDateString() : '';

        // Date divider
        if (messageDateString && messageDateString !== lastMessageDate) {
          const dateDivider = document.createElement('div');
          dateDivider.className = 'text-center text-xs text-gray-500 my-4';
          dateDivider.innerText = messageDateString;
          chatMessages.appendChild(dateDivider);
          lastMessageDate = messageDateString;
        }

        const container = document.createElement('div');
        container.className = `flex flex-col mb-2 ${isCurrentUser ? 'items-end' : 'items-start'}`;
        container.innerHTML = `
          <div class="max-w-xs p-2 rounded-lg" style="background:${isCurrentUser ? '#D4BEE4' : '#EEEEEE'}">
            <div class="text-xs font-bold">${msg.userName}:</div>
            <div class="text-sm">${msg.text} <span class="text-[10px] text-gray-500">${messageDate ? messageDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''}</span></div>
          </div>`;
        chatMessages.appendChild(container);
      });
      chatMessages.scrollTop = chatMessages.scrollHeight;
    });
  }
  loadMessages();

  // Send message
  async function sendChatMessage() {
    const text = chatInput.value.trim();
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
      alert('Failed to send message.');
    }
  }

  sendMessage?.addEventListener('click', sendChatMessage);
  chatInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendChatMessage();
    }
  });
});

// WebRTC + Socket.IO
const socket = io('https://studybuddy-backend-57xt.onrender.com', {
  transports: ['websocket'],
  cors: {
    origin: 'https://dainty-longma-fd7059.netlify.app',
    credentials: true,
  },
});

const localVideo = document.createElement('video');
localVideo.muted = true;
localVideo.id = 'local-video';
let localStream;
let peers = {};
const ROOM_ID = roomId;
const USER_ID = auth.currentUser?.uid || `temp_${Math.random().toString(36).substring(2, 15)}`;

function addVideoStream(video, stream) {
  video.srcObject = stream;
  video.autoplay = true;
  video.playsInline = true;
  videoGrid.appendChild(video);
}

function createPeer(userId, isInitiator = true) {
  const peer = new RTCPeerConnection({
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      {
        urls: 'turn:turn.example.com:3478', // Replace with your TURN server
        username: 'your-username',
        credential: 'your-credential',
      },
    ],
  });

  peer.onicecandidate = (e) => {
    if (e.candidate) {
      socket.emit('ice-candidate', {
        roomId: ROOM_ID,
        userId: USER_ID,
        candidate: e.candidate,
      });
    }
  };

  peer.ontrack = (e) => {
    let video = document.getElementById(userId);
    if (!video) {
      video = document.createElement('video');
      video.id = userId;
      video.autoplay = true;
      video.playsInline = true;
      videoGrid.appendChild(video);
    }
    video.srcObject = e.streams[0];
  };

  peer.oniceconnectionstatechange = () => {
    if (peer.iceConnectionState === 'disconnected' || peer.iceConnectionState === 'closed') {
      delete peers[userId];
      document.getElementById(userId)?.remove();
    }
  };

  if (isInitiator) {
    peer.onnegotiationneeded = async () => {
      try {
        const offer = await peer.createOffer();
        await peer.setLocalDescription(offer);
        socket.emit('offer', {
          roomId: ROOM_ID,
          userId: USER_ID,
          sdp: peer.localDescription,
        });
      } catch (error) {
        console.error('Error creating offer:', error);
      }
    };
  }

  return peer;
}

navigator.mediaDevices
  .getUserMedia({ video: true, audio: true })
  .then((stream) => {
    localStream = stream;
    addVideoStream(localVideo, stream);

    socket.emit('join-room', { roomId: ROOM_ID, userId: USER_ID });

    socket.on('user-joined', ({ userId }) => {
      if (userId === USER_ID) return;
      const peer = createPeer(userId);
      peers[userId] = peer;
      localStream.getTracks().forEach((track) => peer.addTrack(track, localStream));
    });

    socket.on('offer', async ({ userId, sdp }) => {
      if (userId === USER_ID) return;
      const peer = createPeer(userId, false);
      peers[userId] = peer;
      await peer.setRemoteDescription(new RTCSessionDescription(sdp));
      const answer = await peer.createAnswer();
      await peer.setLocalDescription(answer);
      socket.emit('answer', { roomId: ROOM_ID, userId: USER_ID, sdp: peer.localDescription });
    });

    socket.on('answer', async ({ userId, sdp }) => {
      if (peers[userId]) {
        await peers[userId].setRemoteDescription(new RTCSessionDescription(sdp));
      }
    });

    socket.on('ice-candidate', ({ userId, candidate }) => {
      if (peers[userId]) {
        peers[userId].addIceCandidate(new RTCIceCandidate(candidate)).catch((e) => console.error('Error adding ICE candidate:', e));
      }
    });

    socket.on('user-left', ({ userId }) => {
      if (peers[userId]) {
        peers[userId].close();
        delete peers[userId];
        document.getElementById(userId)?.remove();
      }
    });
  })
  .catch((error) => {
    console.error('Error accessing media devices:', error);
    alert('Failed to access camera/microphone. Please check permissions.');
  });

// Video call buttons
videoCallBtn?.addEventListener('click', () => {
  chatSection.style.display = 'none';
  videoCallSection.style.display = 'block';
  videoTab.classList.add('active');
  chatTab.classList.remove('active');
});

backToChatBtn?.addEventListener('click', () => {
  videoCallSection.style.display = 'none';
  chatSection.style.display = 'block';
  chatTab.classList.add('active');
  videoTab.classList.remove('active');
});

// Clean up on page unload
window.addEventListener('beforeunload', () => {
  socket.emit('leave-room', { roomId:_room_ID, userId: USER_ID });
  Object.values(peers).forEach((peer) => peer.close());
  if (localStream) {
    localStream.getTracks().forEach((track) => track.stop());
  }
});