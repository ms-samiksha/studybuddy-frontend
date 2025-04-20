// Import Firebase services (ensure correct path to your Firebase config)
import { auth } from './firebase.js'; // Make sure you have exported auth from your firebase.js file
import {
  getFirestore,
  collection,
  doc,
  setDoc,
  getDocs,
  deleteDoc,
  updateDoc,
  serverTimestamp, // ✅ added for Firestore-compatible timestamps
} from "https://www.gstatic.com/firebasejs/11.6.0/firebase-firestore.js";

// Initialize Firestore
const db = getFirestore();
let todos = [];
let userId = null;

export function initTodoList(todoContainerId, todoListId, todoInputId, addTodoButtonId, usernameId) {
  const todoList = document.getElementById(todoListId);
  const todoInput = document.getElementById(todoInputId);
  const addTodoButton = document.getElementById(addTodoButtonId);
  const usernameElement = document.getElementById(usernameId);

  // Handle authentication state
  auth.onAuthStateChanged((user) => {
    if (user) {
      userId = user.uid;
      if (usernameElement) {
        usernameElement.textContent = user.displayName || user.email;
      }
      loadTodos();
    } else {
      window.location.href = 'login.html'; // Redirect to login page if not authenticated
    }
  });

  // Load todos from Firestore
  async function loadTodos() {
    if (!userId) return;
    todos = [];
    try {
      const todosRef = collection(db, `users/${userId}/todos`);
      const querySnapshot = await getDocs(todosRef);
      querySnapshot.forEach((doc) => {
        todos.push({ id: doc.id, ...doc.data() });
      });
      renderTodos();
    } catch (error) {
      console.error('Load todos error:', error);
      alert('Failed to load tasks. Please try again.');
    }
  }

  // Add a new todo
  async function addTodo() {
    const text = todoInput.value.trim();
    if (text) {
      try {
        addTodoButton.disabled = true;
        const todoRef = doc(collection(db, `users/${userId}/todos`));
        await setDoc(todoRef, {
          text,
          completed: false,
          createdAt: serverTimestamp() // ✅ use Firestore timestamp instead of new Date()
        });
        todos.push({ id: todoRef.id, text, completed: false });
        todoInput.value = '';
        loadTodos(); // 🔁 reload from DB so timestamp is included
      } catch (error) {
        console.error('Add todo error:', error);
        alert('Failed to add task. Please try again.');
      } finally {
        addTodoButton.disabled = false;
      }
    }
  }

  // Toggle todo completion status
  window.toggleTodo = async (index) => {
    try {
      todos[index].completed = !todos[index].completed;
      const todoRef = doc(db, `users/${userId}/todos`, todos[index].id);
      await updateDoc(todoRef, { completed: todos[index].completed });
      renderTodos();
    } catch (error) {
      console.error('Toggle todo error:', error);
      alert('Failed to update task. Please try again.');
    }
  };

  // Delete a todo
  window.deleteTodo = async (index) => {
    try {
      const todoRef = doc(db, `users/${userId}/todos`, todos[index].id);
      await deleteDoc(todoRef);
      todos.splice(index, 1);
      renderTodos();
    } catch (error) {
      console.error('Delete todo error:', error);
      alert('Failed to delete task. Please try again.');
    }
  };

  // Render todos in the UI
  function renderTodos() {
    todoList.innerHTML = '';
    todos.sort((a, b) => (a.createdAt?.seconds || 0) - (b.createdAt?.seconds || 0));
    todos.forEach((todo, index) => {
      const todoItem = document.createElement('div');
      todoItem.className = 'todo-item';
      todoItem.innerHTML = `
        <div>
          <input type="checkbox" ${todo.completed ? 'checked' : ''} onchange="toggleTodo(${index})">
          <span style="${todo.completed ? 'text-decoration: line-through;' : ''}">${todo.text}</span>
        </div>
        <button onclick="deleteTodo(${index})" class="text-red-500 hover:text-red-700">Delete</button>
      `;
      todoList.appendChild(todoItem);
    });
  }

  // Event listener for adding a todo
  addTodoButton.addEventListener('click', addTodo);
  todoInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') addTodo();
  });
}
