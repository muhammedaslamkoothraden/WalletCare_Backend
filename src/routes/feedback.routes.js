const express = require("express");
const router = express.Router();

const { updateRating, submitFeedback, getMyFeedback, getFeedbackById } = require("../controllers/feedback.controller");
const protect = require("../middlewares/auth.middleware");
const validate = require("../middlewares/validate.middleware");
const { validateRating, validateFeedback } = require("../validators/feedback.validator");
const { generalLimiter, strictLimiter } = require("../middlewares/rateLimit.middleware");

router.use(protect);

// Rating
router.patch("/rating", generalLimiter, validateRating, validate, updateRating);

// Feedback
router.post("/", strictLimiter, validateFeedback, validate, submitFeedback);
router.get("/", generalLimiter, getMyFeedback);
router.get("/:id", generalLimiter, getFeedbackById);

module.exports = router;