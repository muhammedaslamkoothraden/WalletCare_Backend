require("dotenv").config();
const mongoose = require("mongoose");
const User = require("../models/user");

(async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log("DB connected");

    const user = await User.create({
      name: "Test User",
      email: "testuser1@mail.com",
      password: "password123"
    });

    console.log("User created successfully:", user);

    process.exit(0);
  } catch (error) {
    console.error("Error creating user:", error.message);
    process.exit(1);
  }
})();
console.log("MONGO_URI:", process.env.MONGO_URI ? "LOADED" : "NOT LOADED");
