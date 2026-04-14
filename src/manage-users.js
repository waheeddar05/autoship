// src/manage-users.js
// CLI tool for managing users directly in the database.
//
// Usage:
//   node src/manage-users.js list                           — List all users
//   node src/manage-users.js add <email> [role] [name]      — Add a user
//   node src/manage-users.js role <email> <role>             — Change user role
//   node src/manage-users.js remove <email>                  — Remove a user
//
// Roles: ADMIN, DEVELOPER, READ_ONLY (default)
//
// Examples:
//   node src/manage-users.js add admin@example.com ADMIN Admin
//   node src/manage-users.js add dev@example.com DEVELOPER
//   node src/manage-users.js role dev@example.com ADMIN
//   node src/manage-users.js list

import "dotenv/config";
import pg from "pg";

const VALID_ROLES = ["ADMIN", "DEVELOPER", "READ_ONLY"];

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
});

const [command, ...args] = process.argv.slice(2);

async function list() {
  const { rows } = await pool.query(
    "SELECT id, email, name, role, created_at FROM users ORDER BY created_at"
  );
  if (rows.length === 0) {
    console.log("No users found.");
    return;
  }
  console.log("\n%-38s %-35s %-15s %-12s %s", "ID", "EMAIL", "NAME", "ROLE", "CREATED");
  console.log("-".repeat(110));
  for (const u of rows) {
    console.log(
      "%-38s %-35s %-15s %-12s %s",
      u.id,
      u.email,
      u.name || "-",
      u.role,
      new Date(u.created_at).toISOString().split("T")[0]
    );
  }
  console.log(`\nTotal: ${rows.length} users\n`);
}

async function add(email, role = "READ_ONLY", name = null) {
  if (!email) {
    console.error("Error: email is required.\nUsage: node src/manage-users.js add <email> [role] [name]");
    process.exit(1);
  }
  role = role.toUpperCase();
  if (!VALID_ROLES.includes(role)) {
    console.error(`Error: invalid role "${role}". Must be one of: ${VALID_ROLES.join(", ")}`);
    process.exit(1);
  }
  const displayName = name || email.split("@")[0];
  const { rows } = await pool.query(
    `INSERT INTO users (email, name, role)
     VALUES ($1, $2, $3)
     ON CONFLICT (email) DO UPDATE SET
       name = COALESCE(EXCLUDED.name, users.name),
       role = EXCLUDED.role,
       updated_at = NOW()
     RETURNING id, email, name, role`,
    [email, displayName, role]
  );
  const u = rows[0];
  console.log(`User ${u.email} set to ${u.role} (id: ${u.id})`);
}

async function setRole(email, role) {
  if (!email || !role) {
    console.error("Error: email and role are required.\nUsage: node src/manage-users.js role <email> <role>");
    process.exit(1);
  }
  role = role.toUpperCase();
  if (!VALID_ROLES.includes(role)) {
    console.error(`Error: invalid role "${role}". Must be one of: ${VALID_ROLES.join(", ")}`);
    process.exit(1);
  }
  const { rowCount, rows } = await pool.query(
    "UPDATE users SET role = $1, updated_at = NOW() WHERE email = $2 RETURNING email, role",
    [role, email]
  );
  if (rowCount === 0) {
    console.error(`Error: no user found with email "${email}"`);
    process.exit(1);
  }
  console.log(`Updated ${rows[0].email} → ${rows[0].role}`);
}

async function remove(email) {
  if (!email) {
    console.error("Error: email is required.\nUsage: node src/manage-users.js remove <email>");
    process.exit(1);
  }
  const { rowCount } = await pool.query("DELETE FROM users WHERE email = $1", [email]);
  if (rowCount === 0) {
    console.error(`Error: no user found with email "${email}"`);
    process.exit(1);
  }
  console.log(`Removed user: ${email}`);
}

try {
  switch (command) {
    case "list":
    case "ls":
      await list();
      break;
    case "add":
    case "create":
      await add(args[0], args[1], args[2]);
      break;
    case "role":
    case "set-role":
      await setRole(args[0], args[1]);
      break;
    case "remove":
    case "delete":
    case "rm":
      await remove(args[0]);
      break;
    default:
      console.error(`AutoShip User Management CLI

Usage:
  node src/manage-users.js list                        List all users
  node src/manage-users.js add <email> [role] [name]   Add/update a user
  node src/manage-users.js role <email> <role>          Change user role
  node src/manage-users.js remove <email>               Remove a user

Roles: ADMIN, DEVELOPER, READ_ONLY (default)

Examples:
  node src/manage-users.js add admin@example.com ADMIN Admin
  node src/manage-users.js add dev@example.com DEVELOPER
  node src/manage-users.js role dev@example.com ADMIN
  node src/manage-users.js list`);
      process.exit(command ? 1 : 0);
  }
} catch (err) {
  console.error("Database error:", err.message);
  process.exit(1);
} finally {
  await pool.end();
}
