require("dotenv").config();
const http = require("http");
const app = require("./app");
const connectDB = require("./config/db");
const socketService = require("./services/socket.service");

// Background jobs
require("./jobs/cron");
const { startDeletionJob } = require("./jobs/delete.job");

/**
 * 1. DATABASE & SERVICES INITIALIZATION
 */
connectDB();
startDeletionJob();

/**
 * 2. SERVER INITIALIZATION
 * We wrap the Express 'app' in a native Node.js HTTP server.
 * This is required for Socket.io to share the same port as your API.
 */
const server = http.createServer(app);

// 3. Initialize Socket.io via your service
// Make sure your socket.service.js handles CORS internally!
socketService.init(server);

/**
/**
 * 4. START SERVER
 */
const PORT = process.env.PORT || 5000;
const HOST = "0.0.0.0"; // Allow external access

server.listen(PORT, HOST, () => {
  // Get your Local IP address to show in the console
  const networkInterfaces = require('os').networkInterfaces();
  const localIp = Object.values(networkInterfaces)
    .flat()
    .find(i => i.family === 'IPv4' && !i.internal)?.address;

  console.log("-----------------------------------------");
  console.log(`🚀 Server is globally accessible!`);
  console.log(`🏠 Local:   http://localhost:${PORT}`);
  console.log(`🌐 Network: http://${localIp || HOST}:${PORT}`); // This is what you put in Flutter
  console.log(`📡 WebSocket: Active & Listening`);
  console.log("-----------------------------------------");
});
/**
 * 5. GRACEFUL SHUTDOWN (Optional but Recommended)
 * Ensures that connections are closed properly when the process terminates.
 */
process.on("SIGTERM", () => {
  console.log("SIGTERM signal received: closing HTTP server");
  server.close(() => {
    console.log("HTTP server closed");
    process.exit(0);
  });
});