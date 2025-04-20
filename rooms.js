// studybuddy/studybuddy/rooms.js
import { db, auth } from './firebase.js';
import {
  collection,
  addDoc,
  getDocs,
  query,
  orderBy,
  serverTimestamp,
  doc,
  setDoc,
  deleteDoc,
  getDoc
} from 'https://www.gstatic.com/firebasejs/11.6.0/firebase-firestore.js';

document.addEventListener('DOMContentLoaded', () => {
  console.log('rooms.js loaded');

  // Create room (create-room.html)
  const createRoomButton = document.getElementById('create-room-button');
  const roomNameInput = document.getElementById('room-name-input');
  if (createRoomButton && roomNameInput) {
    let createRoomClicked = false;

    createRoomButton.addEventListener('click', async (event) => {
      event.preventDefault();
      if (createRoomClicked) return;
      createRoomClicked = true;

      const roomName = roomNameInput.value.trim();
      if (!roomName) {
        alert('Please enter a room name.');
        createRoomClicked = false;
        return;
      }

      if (!auth.currentUser) {
        alert('Please log in to create a room.');
        createRoomClicked = false;
        return;
      }

      try {
        const roomRef = await addDoc(collection(db, 'rooms'), {
          name: roomName,
          createdAt: serverTimestamp(),
          userId: auth.currentUser.uid
        });

        // Add the creator as the first member
        const memberRef = doc(db, 'rooms', roomRef.id, 'room_members', auth.currentUser.uid);
        await setDoc(memberRef, { joinedAt: serverTimestamp() });

        alert(`Room created! Share this ID: ${roomRef.id}`);
        roomNameInput.value = '';
        window.location.href = './room-list.html';
      } catch (error) {
        alert('Failed to create room: ' + error.message);
        createRoomClicked = false;
      }
    });
  }

  // List rooms that the user is a member of (room-list.html)
  const roomList = document.getElementById('room-list');
  const joinByIdButton = document.getElementById('join-by-id-button');
  const roomIdInput = document.getElementById('room-id-input');

  if (roomList) {
    async function renderUserRooms() {
      roomList.innerHTML = '<p class="text-center text-gray-500">Loading rooms...</p>';

      if (!auth.currentUser) {
        roomList.innerHTML = '<p class="text-center text-gray-500">Please log in to see rooms.</p>';
        return;
      }

      const userId = auth.currentUser.uid;
      const q = query(collection(db, 'rooms'), orderBy('createdAt', 'desc'));
      const querySnapshot = await getDocs(q);

      roomList.innerHTML = '';
      let hasRoom = false;

      // Fetch rooms where the user is a member
      for (const roomDoc of querySnapshot.docs) {
        const memberRef = doc(db, 'rooms', roomDoc.id, 'room_members', userId);
        const memberDoc = await getDoc(memberRef);

        // Only show rooms where the user is a member
        if (!memberDoc.exists()) continue;

        hasRoom = true;
        const room = roomDoc.data();

        const roomItem = document.createElement('div');
        roomItem.className = 'room-item';
        roomItem.innerHTML = `
          <span>${room.name} (ID: ${roomDoc.id})</span>
          <div class="buttons">
            <!-- View Button -->
            <a href="./room.html?roomId=${encodeURIComponent(roomDoc.id)}" 
               class="bg-[#7e5bef] hover:bg-[#5b21b6] text-white px-3 py-1 rounded-lg">
              View
            </a>

            <!-- Leave Button -->
            <button class="leave-room bg-red-500 hover:bg-red-600 text-white px-3 py-1 rounded-lg" 
                    data-room-id="${roomDoc.id}">
              Leave
            </button>
          </div>
        `;

        roomList.appendChild(roomItem);
      }

      if (!hasRoom) {
        roomList.innerHTML = '<p class="text-center text-gray-500">You have not joined any rooms yet.</p>';
      }

      // Bind leave buttons
      document.querySelectorAll('.leave-room').forEach(button => {
        button.addEventListener('click', () => {
          const roomId = button.getAttribute('data-room-id');
          leaveRoom(roomId);
        });
      });
    }

    auth.onAuthStateChanged(() => {
      renderUserRooms();
    });

    // Join by room ID
    if (joinByIdButton && roomIdInput) {
      joinByIdButton.addEventListener('click', async () => {
        const roomId = roomIdInput.value.trim();
        if (!roomId) {
          alert('Enter a valid room ID.');
          return;
        }

        const user = auth.currentUser;
        if (!user) {
          alert('Please log in first.');
          return;
        }

        const memberRef = doc(db, 'rooms', roomId, 'room_members', user.uid);
        const roomDoc = await getDoc(doc(db, 'rooms', roomId));
        if (!roomDoc.exists()) {
          alert('Room not found.');
          return;
        }

        try {
          await setDoc(memberRef, { joinedAt: serverTimestamp() });
          alert(`Successfully joined room ${roomId}`);
          roomIdInput.value = '';
          renderUserRooms();
        } catch (error) {
          alert('Failed to join room: ' + error.message);
        }
      });
    }
  }
});

async function leaveRoom(roomId) {
  const user = auth.currentUser;
  if (!user) {
    alert('Please log in first.');
    return;
  }

  const memberRef = doc(db, 'rooms', roomId, 'room_members', user.uid);
  try {
    await deleteDoc(memberRef);
    alert('You have left the room.');
    document.querySelector(`[data-room-id="${roomId}"]`)?.closest('.room-item')?.remove();
  } catch (error) {
    alert('Failed to leave room: ' + error.message);
  }
}