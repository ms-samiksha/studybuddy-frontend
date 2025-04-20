import { initTodoList } from './todo.js'; // or './scripts/todo.js' based on your folder

initTodoList(
  'todoContainer',   // ID of the main todo container
  'todoList',        // Where tasks show up
  'todoInput',       // Where user types the task
  'addTodoButton',   // The "Add Task" button
  'usernameDisplay'  // Where to show logged-in user's name/email
);
