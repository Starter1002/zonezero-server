const express = require("express");
const http    = require("http");
const { Server } = require("socket.io");

const app    = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: "*" }
});

// ── Estado compartido de salas ─────────────────
// rooms[roomId] = { players: { [socketId]: { id, x, y, angle, hp, maxHp, class, alive } } }
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
      // avisar a los demás que salió
      io.to(roomId).emit("playerDisconnected", { id: socketId });
      // limpiar sala vacía
      if (Object.keys(room.players).length === 0) {
        delete rooms[roomId];
      }
      // continúa iterando para cubrir el caso de múltiples salas
    }
  }
}

// ── Conexiones ────────────────────────────────
io.on("connection", (socket) => {
  console.log("🟢 Conectado:", socket.id);

  // ── joinRoom ─────────────────────────────────
  socket.on("joinRoom", ({ room, playerClass, hp, maxHp }) => {
    socket.join(room);

    const roomState = getOrCreateRoom(room);

    // Registrar jugador con estado inicial
    const playerData = {
      id:     socket.id,
      x:      0,
      y:      0,
      angle:  0,
      hp:     hp    ?? 100,
      maxHp:  maxHp ?? 100,
      class:  playerClass ?? "scavenger",
      alive:  true
    };
    roomState.players[socket.id] = playerData;

    console.log(`📥 ${socket.id} (${playerData.class}) entró a sala "${room}" — jugadores: ${Object.keys(roomState.players).length}`);

    // Responder al jugador que acaba de unirse con el estado actual de la sala
    socket.emit("roomData", {
      room,
      players: roomState.players
    });

    // Avisar a TODOS en la sala (incluido el nuevo) que entró un jugador
    io.to(room).emit("playerJoined", playerData);
  });

  // ── playerMove ───────────────────────────────
  socket.on("playerMove", ({ room, x, y, angle }) => {
    if (!room || !rooms[room]) return;
    const roomState = rooms[room];
    if (!roomState.players[socket.id]) return;

    roomState.players[socket.id].x     = x;
    roomState.players[socket.id].y     = y;
    roomState.players[socket.id].angle = angle;

    // Reenviar a los DEMÁS en la sala (no al emisor)
    socket.to(room).emit("playerMoved", {
      id: socket.id,
      x, y, angle
    });
  });

  // ── playerShoot ──────────────────────────────
  socket.on("playerShoot", ({ room, x, y, angle }) => {
    const roomState = rooms[room];
    if (!roomState || !roomState.players[socket.id]) return;

    socket.to(room).emit("playerShot", {
      id: socket.id,
      x, y, angle
    });
  });

  // ── playerHit ────────────────────────────────
  // targetId: socket.id del jugador que recibió el daño (enviado por el cliente que detectó el impacto)
  socket.on("playerHit", ({ room, targetId, hp }) => {
    const roomState = rooms[room];
    if (!roomState || !targetId || !roomState.players[targetId]) return;

    roomState.players[targetId].hp = hp;
    if (hp <= 0) roomState.players[targetId].alive = false;

    io.to(room).emit("playerHitUpdate", {
      id:    targetId,
      hp,
      alive: roomState.players[targetId].alive
    });
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
