const { body } = require("express-validator");

// PATCH /feedback/rating
exports.validateRating = [
  body("rating")
    .notEmpty().withMessage("Rating is required"),
];

// POST /feedback
exports.validateFeedback = [
  body("category")
    .notEmpty().withMessage("Category is required"),

  body("description")
    .trim()
    .notEmpty().withMessage("Description is required").bail()
    .isLength({ max: 1000 }).withMessage("Description cannot exceed 1000 characters"),

  body("screenshot")
    .optional()
    .isURL().withMessage("Screenshot must be a valid URL"),
];