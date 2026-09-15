const db = require("./database");
const config = require("../config");

console.log("SQLite database:", config.sqlitePath);
console.log("✅ SQLite database initialized successfully.");

if (require.main === module) {
  db.closeDatabase();
}
