import { io } from 'socket.io-client';

// Configure socket with polling fallback for better reliability in restricted environments
export const socket = io({
  transports: ['polling', 'websocket'],
  autoConnect: true,
  reconnection: true,
  reconnectionAttempts: Infinity,
  reconnectionDelay: 1000,
  reconnectionDelayMax: 5000,
  timeout: 60000,
});

if (typeof window !== 'undefined') {
  socket.on('connect', () => {
    console.log('%c--- SYSTEM CONNECTED (WEBSOCKET) ---', 'color: green; font-weight: bold;');
  });
  socket.on('connect_error', (err) => {
    if (err.message === 'websocket error') {
      console.warn('%c--- WEBSOCKET UPGRADE FAILED (FALLING BACK TO POLLING) ---', 'color: gray;');
      return;
    }
    console.error('%c--- CONNECTION ERROR ---', 'color: red; font-weight: bold;', err.message);
  });
  socket.on('disconnect', (reason) => {
    console.warn('%c--- DISCONNECTED ---', 'color: orange; font-weight: bold;', reason);
  });
}
