const { User, PendingUser } = require("../models/user");
const { sendOtp } = require("../services/otp.service");
const bcrypt = require("bcryptjs");

// Register User (Signup)
exports.registerUser = async (req, res) => {
  try {
    const { name, email, password, phone } = req.body;

    if (!name || !email || !password) {
      return res.status(400).json({ message: "Name, email and password are required" });
    }

    if (password.length < 8) {
      return res.status(400).json({ message: "Password must be at least 8 characters" });
    }

    const normalizedEmail = email.toLowerCase().trim();

    // Check for existing verified user
    const existingUser = await User.findOne({ email: normalizedEmail });
    if (existingUser) {
      return res.status(400).json({ message: "Email already exists" });
    }

    // Hash password for pending user
    const hashedPassword = await bcrypt.hash(password, 10);

    // Ensure only one pending user exists
    await PendingUser.findOneAndDelete({ email: normalizedEmail });

    const pendingUser = await PendingUser.create({
      name,
      email: normalizedEmail,
      password: hashedPassword,
      phone,
      role: "user"
    });

    // Generate & send OTP
    await sendOtp(normalizedEmail, "signup");

    return res.status(201).json({
      message: "User created successfully, please verify your email",
      pendingUserId: pendingUser._id
    });

  } catch (error) {
    console.error("Register Error:", error);
    return res.status(500).json({ message: "Server error" });
  }
};

// Login User
exports.loginUser = async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ message: "Email and password are required" });
    }

    const normalizedEmail = email.toLowerCase().trim();

    // Fetch user including password
    const user = await User.findOne({ email: normalizedEmail }).select("+password");
    if (!user) {
      return res.status(401).json({ message: "Invalid credentials" });
    }

    if (!user.isEmailVerified) {
      return res.status(403).json({ message: "Please verify your email first" });
    }

    // Compare password
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(401).json({ message: "Invalid credentials" });
    }

    return res.status(200).json({
      message: "Login successful",
      userId: user._id
    });

  } catch (error) {
    console.error("Login Error:", error);
    return res.status(500).json({ message: "Server error" });
  }
};