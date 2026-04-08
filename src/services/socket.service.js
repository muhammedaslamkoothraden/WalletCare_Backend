const { Server } = require("socket.io");
const jwt = require("jsonwebtoken");
require("dotenv").config(); // ✅ Ensures .env variables are loaded immediately

let io;

const socketService = {
  // 1. Setup the connection
  init: (httpServer) => {
    io = new Server(httpServer, {
      cors: {
        origin: "*",
        methods: ["GET", "POST"]
      }
    });

    console.log("🛠️  Socket.io Service: Initialized");

    io.on("connection", (socket) => {
      console.log(`⚡ New connection: ${socket.id}`);

      let token = socket.handshake.auth.token;

      if (!token) {
        console.log(`⚠️  No token — socket ${socket.id} will not join a room`);
        return;
      }

      // Clean token (handles "Bearer " prefix and quoted strings from Flutter)
      if (token.startsWith("Bearer ")) token = token.slice(7).trim();
      token = token.replace(/^"(.*)"$/, '$1');

      const secret = process.env.ACCESS_TOKEN_SECRET || process.env.JWT_SECRET;
      if (!secret) {
        console.error("🚨 CRITICAL: No JWT secret found in .env!");
        return;
      }

      try {
        const decoded = jwt.verify(token, secret);
        console.log(`[DEBUG] Decoded JWT payload keys: ${Object.keys(decoded).join(', ')}`);

        const userId = (decoded._id || decoded.id || decoded.userId || "").toString();

        if (!userId) {
          console.error("❌ JWT has no userId field", JSON.stringify(decoded));
          return;
        }

        socket.join(userId);
        console.log(`✅ User ${userId} joined their private room (${socket.id})`);

        socket.on("disconnect", () => {
          console.log(`❌ User ${userId} disconnected (${socket.id})`);
        });
      } catch (err) {
        console.error(`❌ JWT verify failed for ${socket.id}:`, err.message);
      }
    });

    return io;
  },

  // 2. The Broadcast function
  // Use this in your Controllers: socketService.sendNotification(userId, data)
  sendNotification: (userId, data) => {
    if (io) {
      // Send only to the specific user's room
      io.to(userId.toString()).emit("new_notification", data);
      console.log(`📡 Live Alert Sent to User Room: ${userId}`);
    } else {
      console.error("❌ Socket.io not initialized!");
    }
  },

  broadcastAll: (data) => {
    if (io) {
      io.emit("new_notification", data);
      console.log(`📡 TEST ALERT broadcast to ALL sockets`);
    }
  },

  isUserOnline: (userId) => {
    if (!io) return false;
    const room = io.sockets.adapter.rooms.get(userId.toString());
    return room && room.size > 0;
  }
};

module.exports = socketService;