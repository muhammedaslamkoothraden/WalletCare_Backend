require("dotenv").config();
require("./jobs/cron"); // Start the cron job for overdue goals

const app = require("./app");
const connectDB = require("./config/db");
const notificationRoutes = require("./routes/notification.routes");

// Connect to database
connectDB();

app.use("/notifications", notificationRoutes);

const PORT = process.env.PORT || 5000;

// Start server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});





