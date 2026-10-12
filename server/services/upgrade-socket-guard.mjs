// Node removes its own error listener from a socket the moment it emits
// 'upgrade'. Until a handler claims the socket and listens itself, a client
// that resets the connection raises an error nobody hears, and an unheard
// 'error' is an uncaught exception that ends the process. Socket.IO leaves a
// socket on a path it does not own alone for a full second before it closes
// it, so any upgrade to an unknown path could take the relay down.

const guarded = new WeakSet();

export function guardUpgradeSocket(socket) {
  if (!socket || typeof socket.on !== 'function' || guarded.has(socket)) return;
  guarded.add(socket);
  socket.on('error', () => {
    try { socket.destroy(); } catch {}
  });
}
