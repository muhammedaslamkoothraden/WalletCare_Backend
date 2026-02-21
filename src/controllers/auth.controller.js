const User = require("../models/user");
const { initializeWalletForUser } = require("../services/wallet.service");
const { sendOtp } = require("../services/otp.service");



// Register logic
exports.registerUser = async (req, res) => {
  try {
    const { name, email, password, phone } = req.body;

    // Basic validation
    if (!name || !email || !password) {
      return res.status(400).json({ message: "Name, email and password are required" });
    }

    const normalizedEmail = email.toLowerCase().trim();

    // Check existing user
    const existingUser = await User.findOne({ email: normalizedEmail });
    if (existingUser) {
      return res.status(400).json({ message: "Email already exists" });
    }

    // Optional: basic password strength check
    if (password.length < 8) {
      return res.status(400).json({ message: "Password must be at least 8 characters" });
    }

    // Create user
    const user = await User.create({
      name,
      email: normalizedEmail,
      password,
      phone
    });

    // Initialize wallet
    await initializeWalletForUser(user._id);

    //  SEND OTP AFTER USER CREATION
    await sendOtp(normalizedEmail);

    return res.status(201).json({
      message: "User created successfully",
      userId: user._id
    });

  } catch (error) {
    console.error("Register Error:", error);
    return res.status(500).json({ message: "Server error" });
  }
};


// Login logic
exports.loginUser = async (req, res) => {
  try {
    // Extract login data from request body
    const { email, password } = req.body;

    // Basic validation
    if (!email || !password) {
      return res.status(400).json({ message: "Email and password are required" });
    }

    // Select password explicitly because select: false
    const user = await User.findOne({ email }).select("+password");

    if (!user) {
      return res.status(401).json({ message: "Invalid credentials" });
    }

    // Use model method
    const isMatch = await user.comparePassword(password);

    if (!isMatch) {
      return res.status(401).json({ message: "Invalid credentials" });
    }

    res.status(200).json({
      message: "Login successful",
      userId: user._id
    });

  } catch (error) {
    console.error("Login Error:", error);
    res.status(500).json({ message: "Server error" });
  }
};
