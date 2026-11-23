const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
app.use(express.static(path.join(__dirname)));

const rooms = new Map();

function getPublicServerList() {
  return Array.from(rooms.values()).map((r) => ({
    id: r.id,
    name: r.name,
    maxPlayers: r.maxPlayers,
    hasPassword: Boolean(r.password),
    status: r.status,
    playerCount: r.players.length,
    players: r.players.map((p) => ({ id: p.id, name: p.name, isHost: p.id === r.hostId }))
  }));
}

io.on('connection', (socket) => {
  socket.on('get_servers', () => {
    socket.emit('server_list', getPublicServerList());
  });

  socket.on('create_server', ({ name, maxPlayers, password, playerName }, cb) => {
    const id = 'room_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
    const room = {
      id,
      name: (name || 'Phòng mới').slice(0, 32),
      maxPlayers: Math.min(4, Math.max(1, Number(maxPlayers) || 4)),
      password: password || null,
      status: 'waiting',
      hostId: socket.id,
      seed: Math.floor(Math.random() * 900000) + 100000,
      collectedBooks: [],
      players: [{ id: socket.id, name: playerName || 'Host', pos: { x: 0, y: 1.65, z: -2.2 }, yaw: 0 }]
    };
    rooms.set(id, room);
    socket.join(id);
    socket.data.roomId = id;
    socket.emit('joined_lobby', room);
    io.emit('server_list', getPublicServerList());
    cb && cb({ ok: true });
  });

  socket.on('join_server', ({ roomId, password, playerName }, cb) => {
    const room = rooms.get(roomId);
    if (!room) return cb && cb({ ok: false, error: 'Phòng không tồn tại.' });
    if (room.password && room.password !== password) return cb && cb({ ok: false, error: 'Sai mật khẩu.' });
    if (room.players.length >= room.maxPlayers) return cb && cb({ ok: false, error: 'Phòng đã đầy.' });

    room.players.push({ id: socket.id, name: playerName || 'Khách', pos: { x: 0, y: 1.65, z: -2.2 }, yaw: 0 });
    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.emit('joined_lobby', room);
    io.to(roomId).emit('room_updated', room);
    io.emit('server_list', getPublicServerList());
    cb && cb({ ok: true });
  });

  socket.on('start_game', (cb) => {
    const room = rooms.get(socket.data.roomId);
    if (!room || room.hostId !== socket.id) return cb && cb({ ok: false, error: 'Chỉ chủ phòng mới bắt đầu được.' });
    room.status = 'playing';
    io.to(room.id).emit('game_started', room);
    io.emit('server_list', getPublicServerList());
    cb && cb({ ok: true });
  });

  socket.on('player_update', (data) => {
    const room = rooms.get(socket.data.roomId);
    if (!room) return;
    const p = room.players.find((x) => x.id === socket.id);
    if (!p) return;
    Object.assign(p, data);
    socket.to(room.id).emit('remote_player_update', { player: p });
  });

  socket.on('door_opened', (doorIndex) => {
    const room = rooms.get(socket.data.roomId);
    if (room) socket.to(room.id).emit('remote_door_opened', { doorIndex });
  });

  socket.on('drawer_opened', (drawerId) => {
    const room = rooms.get(socket.data.roomId);
    if (room) socket.to(room.id).emit('remote_drawer_opened', { drawerId });
  });

  socket.on('book_collected', (bookId) => {
    const room = rooms.get(socket.data.roomId);
    if (!room) return;
    if (!room.collectedBooks.includes(bookId)) room.collectedBooks.push(bookId);
    io.to(room.id).emit('remote_book_collected', { collectedBooks: room.collectedBooks });
  });

  socket.on('leave_server', () => handleLeave(socket));
  socket.on('disconnect', () => handleLeave(socket));
});

function handleLeave(socket) {
  const roomId = socket.data.roomId;
  if (!roomId) return;
  const room = rooms.get(roomId);
  socket.leave(roomId);
  socket.data.roomId = null;
  if (!room) return;

  room.players = room.players.filter((p) => p.id !== socket.id);
  if (room.players.length === 0) {
    rooms.delete(roomId);
  } else {
    if (room.hostId === socket.id) room.hostId = room.players[0].id;
    io.to(roomId).emit('room_updated', room);
  }
  io.emit('server_list', getPublicServerList());
}

server.listen(PORT, () => {
  console.log(`DOORS BUT GEI server running at http://localhost:${PORT}`);
});