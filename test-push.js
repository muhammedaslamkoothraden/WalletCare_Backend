const mongoose = require('mongoose');
const { createNotification } = require('./src/services/notification.service');
require('dotenv').config();

async function testPush() {
  try {
    console.log("⏳ Connecting to DB...");
    await mongoose.connect(process.env.MONGO_URI);
    
    // Find the latest user that has an FCM token
    const db = mongoose.connection.useDb('test'); // Or whatever the dynamic DB is in the URI
    const users = await db.collection('users').find({ fcmToken: { $ne: null } }).sort({ _id: -1 }).limit(1).toArray();
    
    if (users.length === 0) {
      console.log("❌ No user found with an FCM token. Please log into the app first!");
      process.exit(1);
    }

    const userId = users[0]._id;
    console.log(`✅ Found user with FCM Token. Sending test notification...`);

    // Trigger standard notification service logic
    await createNotification(
      userId,
      "This is a test background notification to verify FCM is working!",
      "system_info",
      { title: "Background Push Testing 🚀" }
    );

    console.log("🎉 Notification dispatched successfully. Check your phone!");
  } catch (err) {
    console.error("❌ Error:", err);
  } finally {
    process.exit(0);
  }
}

testPush();
