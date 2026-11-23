const path = require('path');
const fs = require('fs');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: '*',
        methods: ['GET', 'POST']
    }
});

const PORT = process.env.PORT || 3000;

// Phục vụ file tĩnh (hỗ trợ cả cấu trúc nhiều file hoặc 1 file index.html đặt cạnh server.js)
app.use(express.static(__dirname));

app.get('/', (req, res) => {
    const indexPath = path.join(__dirname, 'index.html');
    if (fs.existsSync(indexPath)) {
        res.sendFile(indexPath);
    } else {
        res.status(404).send('Khong tim thay file index.html');
    }
});

// Lưu danh sách phòng chơi đang hoạt động trên RAM của server
// room = { id, name, maxPlayers, hasPassword, password, status, seed, createdAt, players: {} }
const rooms = new Map();

function toPublicRoom(room) {
    return {
        id: room.id,
        name: room.name,
        maxPlayers: room.maxPlayers,
        playerCount: Object.keys(room.players).length,
        hasPassword: room.hasPassword,
        status: room.status,
        seed: room.seed,
        createdAt: room.createdAt
    };
}

function broadcastRooms() {
    const list = Array.from(rooms.values()).map(toPublicRoom);
    io.emit('rooms:list', list);
}

function leaveCurrentRoom(socket) {
    for (const [roomId, room] of rooms.entries()) {
        if (room.players[socket.id]) {
            socket.leave(roomId);
            delete room.players[socket.id];
            socket.to(roomId).emit('player:left', { id: socket.id });

            if (Object.keys(room.players).length === 0) {
                rooms.delete(roomId);
            }
            broadcastRooms();
            return roomId;
        }
    }
    return null;
}

io.on('connection', (socket) => {
    console.log(`[+] Player ket noi: ${socket.id}`);

    // Gửi danh sách server hiện có cho người mới vào
    socket.emit('rooms:list', Array.from(rooms.values()).map(toPublicRoom));

    socket.on('rooms:getList', () => {
        socket.emit('rooms:list', Array.from(rooms.values()).map(toPublicRoom));
    });

    // Tạo server mới
    socket.on('rooms:create', (payload = {}, cb) => {
        const cleanName = String(payload.name || '').trim().slice(0, 32) || `Server #${rooms.size + 1}`;
        const maxPlayers = Math.min(4, Math.max(1, Number(payload.maxPlayers) || 4));
        const password = String(payload.password || '');
        const seed = Number(payload.seed) || Math.floor(Math.random() * 899999) + 100000;
        const roomId = `room_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;

        const newRoom = {
            id: roomId,
            name: cleanName,
            maxPlayers,
            hasPassword: password.length > 0,
            password,
            status: 'waiting',
            seed,
            createdAt: Date.now(),
            players: {}
        };

        rooms.set(roomId, newRoom);
        broadcastRooms();

        if (typeof cb === 'function') {
            cb({ ok: true, room: toPublicRoom(newRoom) });
        }
    });

    // Vào server
    socket.on('rooms:join', (payload = {}, cb) => {
        const room = rooms.get(payload.roomId);
        if (!room) {
            if (typeof cb === 'function') cb({ ok: false, error: 'Server khong ton tai hoac da dong.' });
            return;
        }

        const currentPlayers = Object.keys(room.players).length;
        if (currentPlayers >= room.maxPlayers) {
            if (typeof cb === 'function') cb({ ok: false, error: 'Server da du nguoi choi.' });
            return;
        }

        if (room.hasPassword && room.password !== String(payload.password || '')) {
            if (typeof cb === 'function') cb({ ok: false, error: 'Mat khau server khong dung.' });
            return;
        }

        leaveCurrentRoom(socket);
        socket.join(room.id);

        const nickname =
            String(payload.nickname || '').trim().slice(0, 20) ||
            `Survivor_${socket.id.slice(0, 4)}`;

        room.players[socket.id] = {
            id: socket.id,
            nickname,
            x: 0,
            y: 1.7,
            z: -2,
            yaw: 0,
            pitch: 0,
            hp: 100,
            isHiding: false,
            currentRoom: 1
        };

        room.status = 'playing';

        io.to(room.id).emit('game:playersSync', room.players);
        broadcastRooms();

        if (typeof cb === 'function') {
            cb({
                ok: true,
                room: toPublicRoom(room),
                players: room.players
            });
        }
    });

    // Đồng bộ vị trí và trạng thái người chơi trong cùng server
    socket.on('player:state', (state = {}) => {
        for (const [roomId, room] of rooms.entries()) {
            const p = room.players[socket.id];
            if (p) {
                p.x = Number(state.x) || 0;
                p.y = Number(state.y) || 1.7;
                p.z = Number(state.z) || 0;
                p.yaw = Number(state.yaw) || 0;
                p.pitch = Number(state.pitch) || 0;
                p.hp = Math.max(0, Math.min(100, Number(state.hp ?? p.hp)));
                p.isHiding = Boolean(state.isHiding);
                p.currentRoom = Math.max(1, Math.min(100, Number(state.currentRoom) || p.currentRoom));

                socket.to(roomId).emit('player:remoteState', {
                    id: socket.id,
                    state: p
                });
                break;
            }
        }
    });

    // Đồng bộ sự kiện mở cửa hoặc quái vật xuất hiện trong phòng
    socket.on('game:event', (eventData = {}) => {
        for (const [roomId, room] of rooms.entries()) {
            if (room.players[socket.id]) {
                if (eventData.type === 'doorOpened' && Number(eventData.roomIndex)) {
                    room.players[socket.id].currentRoom = Math.max(
                        room.players[socket.id].currentRoom,
                        Number(eventData.roomIndex) + 1
                    );
                }
                socket.to(roomId).emit('game:event', {
                    from: socket.id,
                    ...eventData
                });
                break;
            }
        }
    });

    socket.on('disconnect', () => {
        console.log(`[-] Player ngat ket noi: ${socket.id}`);
        leaveCurrentRoom(socket);
    });
});

server.listen(PORT, () => {
    console.log(`Doors But Gei Online Server dang chay tai cong ${PORT}`);
});