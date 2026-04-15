const express = require('express');
const router = express.Router();
const socketService = require('../services/socket.service');
const notificationService = require('../services/notification.service'); // Ensure this import exists
const { isFirebaseInitialized } = require('../config/firebase');

// --- 1. Log Buffer Logic (Keep this, it's great for debugging!) ---
if (!global.logBuffer) {
    global.logBuffer = [];
    const originalLog = console.log;
    const originalError = console.error;

    console.log = function (...args) {
        global.logBuffer.unshift(`[${new Date().toLocaleTimeString()}] [INFO] ${args.join(' ')}`);
        if (global.logBuffer.length > 50) global.logBuffer.pop();
        originalLog.apply(console, args);
    };

    console.error = function (...args) {
        global.logBuffer.unshift(`[${new Date().toLocaleTimeString()}] [ERROR] ${args.join(' ')}`);
        if (global.logBuffer.length > 50) global.logBuffer.pop();
        originalError.apply(console, args);
    };
}

// --- 2. Routes ---

// View logs at http://localhost:5000/api/test/logs
router.get('/logs', (req, res) => {
    res.send(`
        <body style="background: #1e1e1e; color: #d4d4d4; font-family: monospace; padding: 20px;">
            <h2>🛠️ WalletCare Server Logs</h2>
            <hr/>
            <pre>${(global.logBuffer || []).join('\n')}</pre>
            <script>setTimeout(() => location.reload(), 3000);</script> 
        </body>
    `);
});

// Test Endpoint: Trigger Hybrid Alert (Socket + FCM)
// POST to http://localhost:5000/api/test/test-hybrid
router.post('/test-hybrid', async (req, res) => {
    const { userId, message, title } = req.body;

    if (!userId) return res.status(400).json({ error: "Missing userId" });

    console.log(`🧪 Manually triggering Hybrid Alert for User: ${userId}`);

    try {
        const result = await notificationService.createNotification(
            userId,
            message || "This is a test hybrid alert!",
            "TEST_ALERT",
            { title: title || "Test Success! ✅", category: "SYSTEM" }
        );

        res.json({
            success: true,
            firebaseActive: isFirebaseInitialized,
            data: result
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

const { checkDailyInactivity } = require('../jobs/dailyInactivity.job');
router.post('/test-inactivity', async (req, res) => {
    try {
        await checkDailyInactivity();
        res.json({ success: true, message: "Daily inactivity job executed" });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Test Endpoint: Simple Broadcast to EVERYONE (Socket Only)
router.post('/trigger-notification', (req, res) => {
    const { title, message } = req.body;

    socketService.broadcastAll({
        _id: new Date().getTime().toString(),
        title: title || "Global Broadcast",
        message: message || "Testing socket broadcast to all connected devices",
        category: "SYSTEM",
        type: "TEST",
        isRead: false,
        createdAt: new Date().toISOString()
    });

    res.json({ success: true, broadcast: true });
});

module.exports = router;