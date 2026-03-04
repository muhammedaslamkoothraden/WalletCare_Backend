require("dotenv").config();
require("./jobs/goalOverdue.job"); // Start the cron job for overdue goals

const app = require("./app");
const connectDB = require("./config/db");

// Connect to database
connectDB();

const PORT = process.env.PORT || 5000;

// Start server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
