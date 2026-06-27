const express = require("express");
const http    = require("http");
const { Server } = require("socket.io");

const app    = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: "*" }
});

// ── Estado compartido de salas ─────────────────
// rooms[roomId] = { players: { [socketId]: { id, x, y, angle, hp, maxHp, class, alive, reviving } } }
const rooms = {};

function getOrCreateRoom(roomId) {
  if (!rooms[roomId]) {
    rooms[roomId] = { players: {} };
  }
  return rooms[roomId];
}

function removePlayerFromRooms(socketId) {
  for (const roomId of Object.keys(rooms)) {
    const room = rooms[roomId];
    if (room.players[socketId]) {
      delete room.players[socketId];
      io.to(roomId).emit("playerDisconnected", { id: socketId });
      if (Object.keys(room.players).length === 0) {
        delete rooms[roomId];
      } else {
        // Recalcular caídos tras salida
        broadcastDownedCount(roomId);
      }
    }
  }
}

// Emite cuántos jugadores están caídos en una sala
function broadcastDownedCount(roomId) {
  const room = rooms[roomId];
  if (!room) return;
  const count = Object.values(room.players).filter(p => !p.alive).length;
  io.to(roomId).emit("downedPlayersCount", count);
}

// ── Conexiones ────────────────────────────────
io.on("connection", (socket) => {
  console.log("🟢 Conectado:", socket.id);

  // ── joinRoom ─────────────────────────────────
  socket.on("joinRoom", ({ room, playerClass, hp, maxHp }) => {
    socket.join(room);

    const roomState = getOrCreateRoom(room);

    const playerData = {
      id:       socket.id,
      x:        0,
      y:        0,
      angle:    0,
      hp:       hp    ?? 100,
      maxHp:    maxHp ?? 100,
      class:    playerClass ?? "scavenger",
      alive:    true,
      reviving: false
    };
    roomState.players[socket.id] = playerData;

    console.log(`📥 ${socket.id} (${playerData.class}) entró a sala "${room}" — jugadores: ${Object.keys(roomState.players).length}`);

    socket.emit("roomData", {
      room,
      players: roomState.players
    });

    io.to(room).emit("playerJoined", playerData);
  });

  // ── playerMove ───────────────────────────────
  socket.on("playerMove", ({ room, x, y, angle }) => {
    if (!room || !rooms[room]) return;
    const roomState = rooms[room];
    if (!roomState.players[socket.id]) return;
    // Muerto no se mueve
    if (!roomState.players[socket.id].alive) return;

    roomState.players[socket.id].x     = x;
    roomState.players[socket.id].y     = y;
    roomState.players[socket.id].angle = angle;

    socket.to(room).emit("playerMoved", { id: socket.id, x, y, angle });
  });

  // ── playerShoot ──────────────────────────────
  socket.on("playerShoot", ({ room, x, y, angle }) => {
    const roomState = rooms[room];
    if (!roomState || !roomState.players[socket.id]) return;
    // Muerto no dispara
    if (!roomState.players[socket.id].alive) return;

    socket.to(room).emit("playerShot", { id: socket.id, x, y, angle });
  });

  // ── playerHit ────────────────────────────────
  socket.on("playerHit", ({ room, targetId, hp }) => {
    const roomState = rooms[room];
    if (!roomState || !targetId || !roomState.players[targetId]) return;

    const target = roomState.players[targetId];
    target.hp = hp;

    if (hp <= 0) {
      target.hp       = 0;
      target.alive    = false;
      target.reviving = false;

      io.to(room).emit("playerHitUpdate", { id: targetId, hp: 0, alive: false });
      io.to(room).emit("playerDown",      { id: targetId });
      broadcastDownedCount(room);
    } else {
      io.to(room).emit("playerHitUpdate", { id: targetId, hp, alive: true });
    }
  });

  // ── startRevive ──────────────────────────────
  socket.on("startRevive", ({ room, targetId }) => {
    const roomState = rooms[room];
    if (!roomState) return;

    const healer = roomState.players[socket.id];
    const target = roomState.players[targetId];

    // Solo si el healer está vivo y el target está muerto
    if (!healer || !healer.alive)   return;
    if (!target || target.alive)    return;
    if (target.reviving)            return; // ya se está reviviendo

    target.reviving = true;
    io.to(room).emit("reviveStarted", { targetId, healerId: socket.id });

    const reviveTimer = setTimeout(() => {
      // Verificar que la sala aún existe y el estado sigue válido
      if (!rooms[room]) return;
      const t = rooms[room].players[targetId];
      if (!t || !t.reviving) return; // fue cancelado

      t.alive    = true;
      t.hp       = t.maxHp;
      t.reviving = false;

      io.to(room).emit("playerRevived", { id: targetId, hp: t.hp });
      broadcastDownedCount(room);
    }, 5000);

    // Guardar referencia del timer para poder cancelarlo
    target._reviveTimer = reviveTimer;
  });

  // ── cancelRevive ─────────────────────────────
  socket.on("cancelRevive", ({ room, targetId }) => {
    const roomState = rooms[room];
    if (!roomState) return;

    const target = roomState.players[targetId];
    if (!target) return;

    if (target._reviveTimer) {
      clearTimeout(target._reviveTimer);
      target._reviveTimer = null;
    }
    target.reviving = false;

    io.to(room).emit("reviveCancelled", { targetId });
  });

  // ── disconnect ───────────────────────────────
  socket.on("disconnect", () => {
    console.log("🔴 Desconectado:", socket.id);
    removePlayerFromRooms(socket.id);
  });
});

server.listen(process.env.PORT || 3000, () => {
  console.log("✅ Servidor Zone Zero listo en puerto", process.env.PORT || 3000);
});
