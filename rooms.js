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
  getDoc,
  onSnapshot,
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
          userId: auth.currentUser.uid,
        });

        // Add the creator as the first member
        const memberRef = doc(db, 'rooms', roomRef.id, 'room_members', auth.currentUser.uid);
        await setDoc(memberRef, { joinedAt: serverTimestamp() });

        alert(`Room created! Share this ID: ${roomRef.id}`);
        roomNameInput.value = '';
        window.location.href = './room-list.html';
      } catch (error) {
        console.error('Error creating room:', error);
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
    function renderUserRooms(user) {
      roomList.innerHTML = '<p class="text-center text-gray-500">Loading rooms...</p>';

      if (!user) {
        roomList.innerHTML = '<p class="text-center text-gray-500">Please log in to see rooms.</p>';
        return;
      }

      // Query rooms where the user is a member
      const userRoomsQuery = query(
        collection(db, `rooms`),
        orderBy('createdAt', 'desc')
      );

      // Use real-time listener for room updates
      onSnapshot(userRoomsQuery, async (querySnapshot) => {
        const userId = user.uid;
        roomList.innerHTML = '';
        let hasRoom = false;

        const roomPromises = querySnapshot.docs.map(async (roomDoc) => {
          const memberRef = doc(db, 'rooms', roomDoc.id, 'room_members', userId);
          const memberDoc = await getDoc(memberRef);
          if (!memberDoc.exists()) return null;

          const room = roomDoc.data();
          return {
            roomId: roomDoc.id,
            roomName: room.name,
          };
        });

        const rooms = (await Promise.all(roomPromises)).filter((room) => room !== null);

        if (rooms.length === 0) {
          roomList.innerHTML = '<p class="text-center text-gray-500">You have not joined any rooms yet.</p>';
        } else {
          rooms.forEach((room) => {
            const roomItem = document.createElement('div');
            roomItem.className = 'room-item';
            roomItem.innerHTML = `
              <span>${room.roomName} (ID: ${room.roomId})</span>
              <div class="buttons">
                <a href="./room.html?roomId=${encodeURIComponent(room.roomId)}" 
                   class="bg-[#9B7EBD] hover:bg-[#3B1E54] text-white px-3 py-1 rounded-lg">
                  View
                </a>
                <button class="leave-room bg-red-500 hover:bg-red-600 text-white px-3 py-1 rounded-lg" 
                        data-room-id="${room.roomId}">
                  Leave
                </button>
              </div>
            `;
            roomList.appendChild(roomItem);
          });
        }

        // Bind leave buttons (avoid duplicate listeners)
        document.querySelectorAll('.leave-room').forEach((button) => {
          button.removeEventListener('click', handleLeaveRoom); // Prevent duplicates
          button.addEventListener('click', handleLeaveRoom);
        });
      }, (error) => {
        console.error('Error fetching rooms:', error);
        roomList.innerHTML = '<p class="text-center text-red-500">Failed to load rooms. Please try again.</p>';
      });
    }

    // Handle leave room button clicks
    function handleLeaveRoom(event) {
      const roomId = event.target.getAttribute('data-room-id');
      leaveRoom(roomId);
    }

    // Auth state listener
    auth.onAuthStateChanged((user) => {
      renderUserRooms(user);
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

        const roomDoc = await getDoc(doc(db, 'rooms', roomId));
        if (!roomDoc.exists()) {
          alert('Room not found.');
          return;
        }

        const memberRef = doc(db, 'rooms', roomId, 'room_members', user.uid);
        try {
          await setDoc(memberRef, { joinedAt: serverTimestamp() });
          roomIdInput.value = '';
          // Room list will update automatically via onSnapshot
        } catch (error) {
          console.error('Error joining room:', error);
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
    // Room list will update automatically via onSnapshot
  } catch (error) {
    console.error('Error leaving room:', error);
    alert('Failed to leave room: ' + error.message);
  }
}