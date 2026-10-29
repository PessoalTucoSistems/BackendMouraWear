import knex from "knex";
import fs from "fs";

// Produção (Render): PostgreSQL via DATABASE_URL. Local: SQLite em ./data.
const DATABASE_URL = process.env.DATABASE_URL;

function pgSsl(url) {
  if (process.env.DATABASE_SSL === "false") return false;
  if (process.env.DATABASE_SSL === "true") return { rejectUnauthorized: false };
  // A URL externa do Render (host *.render.com) exige SSL; a interna não.
  return /\.render\.com/.test(url) ? { rejectUnauthorized: false } : false;
}

export const dbType = DATABASE_URL ? "postgres" : "sqlite";

if (!DATABASE_URL) fs.mkdirSync("./data", { recursive: true });

export const db = knex(
  DATABASE_URL
    ? {
        client: "pg",
        connection: { connectionString: DATABASE_URL, ssl: pgSsl(DATABASE_URL) },
        pool: { min: 0, max: 10 },
      }
    : {
        client: "sqlite3",
        connection: { filename: "./data/moreirawear.sqlite" },
        useNullAsDefault: true,
      },
);

// Campos JSON ficam como texto para funcionar igual no SQLite e no Postgres.
export const parseJson = (value, fallback) => {
  if (value === null || value === undefined || value === "") return fallback;
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
};

export const toBool = (value) => value === true || value === 1 || value === "1" || value === "true";

export const now = () => new Date().toISOString();
