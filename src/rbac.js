// src/rbac.js
// Role-Based Access Control middleware and helpers.
// Roles: ADMIN, DEVELOPER, READ_ONLY

const VALID_ROLES = ["ADMIN", "DEVELOPER", "READ_ONLY"];

/**
 * Express middleware factory that checks if the authenticated user
 * has one of the allowed roles. Returns 403 if not authorized.
 *
 * Usage: router.post("/api/something", requireRole("ADMIN", "DEVELOPER"), handler)
 */
function requireRole(...allowedRoles) {
  return (req, res, next) => {
    const user = req.user;
    if (!user) {
      return res.status(401).json({ error: "Authentication required" });
    }

    if (!allowedRoles.includes(user.role)) {
      return res.status(403).json({
        error: `Forbidden: requires ${allowedRoles.join(" or ")} role`,
      });
    }

    next();
  };
}

/**
 * Check if a role value is valid.
 */
function isValidRole(role) {
  return VALID_ROLES.includes(role);
}

export { requireRole, isValidRole, VALID_ROLES };
