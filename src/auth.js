// src/auth.js
// Google OAuth authentication with Passport.js, session management,
// domain restriction via ALLOWED_DOMAIN env var, and auto-provisioning users.

import passport from "passport";
import { Strategy as GoogleStrategy } from "passport-google-oauth20";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import { pool } from "./db.js";
import { logger } from "./logger.js";

const PgSession = connectPgSimple(session);

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const SESSION_SECRET = process.env.SESSION_SECRET || "autoship-dev-secret-change-me";
const BASE_URL = process.env.BASE_URL || `http://localhost:${process.env.PORT || 3457}`;
const ALLOWED_DOMAIN = process.env.ALLOWED_DOMAIN || "example.com";
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || "admin@example.com";

// ── Session middleware ──────────────────────────────────────────

const sessionMiddleware = session({
  store: new PgSession({
    pool,
    tableName: "session",
    createTableIfMissing: false, // We create it in db.js schema
  }),
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
  },
});

// ── Passport serialization ──────────────────────────────────────

passport.serializeUser((user, done) => {
  done(null, user.id);
});

passport.deserializeUser(async (id, done) => {
  try {
    const { rows } = await pool.query(
      "SELECT id, email, name, image, role FROM users WHERE id = $1",
      [id]
    );
    done(null, rows[0] || null);
  } catch (err) {
    done(err, null);
  }
});

// ── Google OAuth strategy ───────────────────────────────────────

if (GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET) {
  passport.use(
    new GoogleStrategy(
      {
        clientID: GOOGLE_CLIENT_ID,
        clientSecret: GOOGLE_CLIENT_SECRET,
        callbackURL: `${BASE_URL}/auth/google/callback`,
      },
      async (_accessToken, _refreshToken, profile, done) => {
        try {
          const email = profile.emails?.[0]?.value;
          if (!email) {
            return done(null, false, { message: "No email found in Google profile" });
          }

          // Domain restriction — exact match to prevent subdomain bypass
          const emailDomain = email.split("@")[1];
          if (emailDomain !== ALLOWED_DOMAIN) {
            logger.warn({ email }, "Login attempt from unauthorized domain");
            return done(null, false, {
              message: "Access restricted to Saras Analytics employees.",
            });
          }

          // Auto-provision: look up or create user
          let { rows } = await pool.query(
            "SELECT * FROM users WHERE email = $1",
            [email]
          );

          if (rows.length === 0) {
            // New user — check if they should be admin (seeded email)
            const role = email === ADMIN_EMAIL ? "ADMIN" : "READ_ONLY";
            const result = await pool.query(
              `INSERT INTO users (email, name, image, role)
               VALUES ($1, $2, $3, $4)
               ON CONFLICT (email) DO UPDATE SET
                 name = EXCLUDED.name,
                 image = EXCLUDED.image,
                 updated_at = NOW()
               RETURNING *`,
              [email, profile.displayName, profile.photos?.[0]?.value, role]
            );
            rows = result.rows;
            logger.info({ email, role }, "New user auto-provisioned on first login");
          } else {
            // Existing user — update name/image if changed
            await pool.query(
              "UPDATE users SET name = $1, image = $2, updated_at = NOW() WHERE email = $3",
              [profile.displayName, profile.photos?.[0]?.value, email]
            );
          }

          return done(null, rows[0]);
        } catch (err) {
          logger.error({ err: err.message }, "Error during Google OAuth verification");
          return done(err, null);
        }
      }
    )
  );

  logger.info("Google OAuth strategy configured");
} else {
  logger.warn("GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET not set — Google login disabled");
}

// ── Auth guard middleware ────────────────────────────────────────

const PUBLIC_PATHS = ["/login", "/auth/", "/webhook/", "/health"];
const STATIC_ASSET_RE = /\.(css|js|png|jpg|jpeg|gif|svg|ico|woff|woff2|ttf|eot)$/;

// Activity tracking: throttled to once per minute per user
const lastActivityUpdate = new Map();

function trackUserActivity(req) {
  if (!req.user?.id || req.user.id === "00000000-0000-0000-0000-000000000000") return;
  const now = Date.now();
  const lastUpdate = lastActivityUpdate.get(req.user.id) || 0;
  if (now - lastUpdate < 60000) return; // throttle: once per minute
  lastActivityUpdate.set(req.user.id, now);

  const source = req.path.startsWith("/api/") ? "api" : "dashboard";
  pool.query(
    "UPDATE users SET last_active_at = NOW(), activity_source = $1 WHERE id = $2",
    [source, req.user.id]
  ).catch(() => {}); // fire-and-forget
}

/**
 * Middleware that requires authentication.
 * Skips auth check for public routes (webhooks, health, login, auth, static assets).
 */
function requireAuth(req, res, next) {
  if (PUBLIC_PATHS.some((p) => req.path.startsWith(p))) {
    return next();
  }

  if (STATIC_ASSET_RE.test(req.path)) {
    return next();
  }

  if (req.isAuthenticated()) {
    trackUserActivity(req);
    return next();
  }

  // API routes get 401, page routes get redirected
  if (req.path.startsWith("/api/")) {
    return res.status(401).json({ error: "Authentication required" });
  }

  return res.redirect("/login");
}

// ── Auth disabled mode ──────────────────────────────────────────
// When Google OAuth is not configured, provide a passthrough with a mock user

function authDisabledMiddleware(req, _res, next) {
  if (!req.user) {
    req.user = {
      id: "00000000-0000-0000-0000-000000000000",
      email: ADMIN_EMAIL,
      name: "Dev User (Auth Disabled)",
      role: "ADMIN",
    };
    req.isAuthenticated = () => true;
  }
  next();
}

const isAuthEnabled = !!(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET);

// ── Exports ─────────────────────────────────────────────────────

export {
  passport,
  sessionMiddleware,
  requireAuth,
  authDisabledMiddleware,
  isAuthEnabled,
};
