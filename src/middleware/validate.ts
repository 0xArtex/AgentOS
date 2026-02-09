import { Request, Response, NextFunction } from "express";

interface FieldRule {
  name: string;
  type?: "string" | "number" | "boolean" | "object" | "array";
  required?: boolean;
  minLength?: number;
  maxLength?: number;
  pattern?: RegExp;
  patternHint?: string;
  min?: number;
  max?: number;
  enum?: string[];
}

/**
 * Creates a validation middleware for request body fields.
 * Returns 400 with helpful error messages on validation failure.
 */
export function validate(rules: FieldRule[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    const errors: string[] = [];
    const body = req.body || {};

    for (const rule of rules) {
      const value = body[rule.name];

      // Required check
      if (rule.required && (value === undefined || value === null || value === "")) {
        errors.push(`'${rule.name}' is required`);
        continue;
      }

      // Skip optional missing fields
      if (value === undefined || value === null) continue;

      // Type check
      if (rule.type) {
        const actualType = Array.isArray(value) ? "array" : typeof value;
        if (actualType !== rule.type) {
          errors.push(`'${rule.name}' must be a ${rule.type}, got ${actualType}`);
          continue;
        }
      }

      // String validations
      if (typeof value === "string") {
        if (rule.minLength && value.length < rule.minLength) {
          errors.push(`'${rule.name}' must be at least ${rule.minLength} characters`);
        }
        if (rule.maxLength && value.length > rule.maxLength) {
          errors.push(`'${rule.name}' must be at most ${rule.maxLength} characters`);
        }
        if (rule.pattern && !rule.pattern.test(value)) {
          errors.push(`'${rule.name}' ${rule.patternHint || "has invalid format"}`);
        }
      }

      // Number validations
      if (typeof value === "number") {
        if (rule.min !== undefined && value < rule.min) {
          errors.push(`'${rule.name}' must be >= ${rule.min}`);
        }
        if (rule.max !== undefined && value > rule.max) {
          errors.push(`'${rule.name}' must be <= ${rule.max}`);
        }
      }

      // Enum check
      if (rule.enum && !rule.enum.includes(value)) {
        errors.push(`'${rule.name}' must be one of: ${rule.enum.join(", ")}`);
      }
    }

    if (errors.length > 0) {
      res.status(400).json({
        error: "Validation Error",
        message: errors.length === 1 ? errors[0] : `${errors.length} validation errors`,
        details: errors,
        hint: "Check the API docs at /docs or /skill.md for field requirements",
      });
      return;
    }

    next();
  };
}

/**
 * Validates email format
 */
export const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Validates phone number format (E.164)
 */
export const PHONE_PATTERN = /^\+[1-9]\d{1,14}$/;

/**
 * Validates country code (2 letters)
 */
export const COUNTRY_PATTERN = /^[A-Z]{2}$/;
