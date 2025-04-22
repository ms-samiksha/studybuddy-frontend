// C:\Users\Administrator\Desktop\studybuddy (4)\studybuddy (4)\studybuddy (4)\studybuddy (2)\studybuddy\studybuddy\room.js
import { db, auth } from './firebase.js';
import { collection, addDoc, onSnapshot, query, orderBy, serverTimestamp, doc, deleteDoc, getDoc, setDoc, getDocs } from 'https://www.gstatic.com/firebasejs/11.6.0/firebase-firestore.js';

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
const videoCallBtn = document.getElementById('video-call-btn');
const videoCallSection = document.getElementById('video-call-section');
const chatSection = document.getElementById('chat-section');
const backToChatBtn = document.getElementById('back-to-chat-btn');
const participantsList = document.getElementById('participants-list');
const chatTab = document.getElementById('chat-tab');
const videoTab = document.getElementById('video-tab');

// Initially show only chat
chatSection.style.display = 'block';
videoCallSection.style.display = 'none';

// Function to leave the room with confirmation
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
    alert('You have left the room.');
    window.location.href = './room-list.html';
  } catch (error) {
    console.error('Error leaving room:', error);
    alert('Failed to leave room.');
  }
}

leaveRoomButton?.addEventListener('click', leaveRoom);

// Handle tab switching
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
    // If user is already a member, check if userName exists, if not, update it
    const member = memberDoc.data();
    if (!member.userName) {
      try {
        await setDoc(doc(roomMembersRef, user.uid), {
          userName: user.displayName || `User_${user.uid.substring(0, 5)}`,
        }, { merge: true });
        console.log('UserName updated for existing member');
      } catch (error) {
        console.error('Error updating userName:', error);
      }
    }
    console.log('User is already a member of this room');
  }

  // Load participants list
  onSnapshot(roomMembersRef, (snapshot) => {
    console.log('Participants snapshot triggered, docs:', snapshot.docs.length);
    participantsList.innerHTML = '';
    if (snapshot.empty) {
      console.log('No participants found.');
      participantsList.innerHTML = '<li>No participants yet.</li>';
      return;
    }
    snapshot.forEach((doc) => {
      const member = doc.data();
      const participantItem = document.createElement('li');
      participantItem.className = 'participant-item';
      participantItem.innerHTML = `
        <img src="https://www.gravatar.com/avatar/${member.userId}?d=mp" alt="${member.userName || member.userId}" style="width: 30px; height: 30px; border-radius: 50%;">
        ${member?.userName ? member.userName : (member?.userId ? `User_${member.userId.substring(0,5)}` : 'Unknown')}
      `;
      participantsList.appendChild(participantItem);
    });
  });

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

        let lastMessageDate = null;

        snapshot.forEach((doc) => {
          const msg = doc.data();
          console.log(`Message data: ${JSON.stringify(msg)}`);
          const isCurrentUser = msg.userId === user.uid;
          const messageDate = msg.createdAt?.toDate();
          const messageDateString = messageDate ? messageDate.toLocaleDateString() : '';

          // Insert date divider if the date changes
          if (messageDateString && messageDateString !== lastMessageDate) {
            const dateDivider = document.createElement('div');
            dateDivider.className = 'text-center text-xs text-gray-500 my-4';
            dateDivider.innerText = messageDateString;
            chatMessages.appendChild(dateDivider);

            lastMessageDate = messageDateString;
          }

          const msgContainer = document.createElement('div');
          msgContainer.className = 'flex flex-col mb-2 ' + (isCurrentUser ? 'items-end' : 'items-start');
          msgContainer.innerHTML = `
           <div class="max-w-xs p-2 rounded-lg" style="background-color: ${isCurrentUser ? '#D4BEE4' : '#EEEEEE'}">

              <div class="text-xs font-bold mb-1 ${isCurrentUser ? 'text-right' : 'text-left'}">${msg.userName}:</div>
              <div class="text-sm flex items-center gap-2">
                <span>${msg.text}</span>
                <span class="text-[10px] text-gray-500">${messageDate ? messageDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''}</span>
              </div>
            </div>
          `;
          chatMessages.appendChild(msgContainer);
        });

        // Ensure scroll to bottom with reflow and slight delay
        chatMessages.scrollTop = chatMessages.scrollHeight;
        chatMessages.clientHeight; // Trigger reflow
        setTimeout(() => {
          chatMessages.scrollTop = chatMessages.scrollHeight;
        }, 10); // Small delay to ensure DOM is fully updated
      });
    } else {
      console.error('chatMessages element not found!');
      setTimeout(loadMessages, 100);
    }
  }
  loadMessages();

  // Sending message
  // When clicking the send button
sendMessage?.addEventListener('click', async () => {
  await sendChatMessage();
});

// When pressing Enter inside the chat input
chatInput?.addEventListener('keydown', async (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    await sendChatMessage();
  }
});

// Function to send message
async function sendChatMessage() {
  const text = chatInput?.value.trim();
  if (!text) return;
  try {
    await addDoc(collection(db, 'rooms', roomId, 'messages'), {
      text,
      userName: auth.currentUser.displayName || `User_${auth.currentUser.uid.substring(0, 5)}`,
      userId: auth.currentUser.uid,
      createdAt: serverTimestamp(),
    });
    chatInput.value = '';
  } catch (error) {
    console.error('Error sending message:', error);
    alert('Failed to send message. Please try again.');
  }
}

});


// Handle Video Call Button
videoCallBtn?.addEventListener('click', () => {
  chatSection.style.display = 'none';
  videoCallSection.style.display = 'block';
});

// Handle Back to Chat Button
backToChatBtn?.addEventListener('click', () => {
  videoCallSection.style.display = 'none';
  chatSection.style.display = 'block';
});