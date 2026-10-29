import jwt from "jsonwebtoken";
import { db } from "./db.js";

export const JWT_SECRET = process.env.JWT_SECRET || "moreirawear-dev-secret-troque-em-producao";

if (!process.env.JWT_SECRET) {
  console.warn("⚠️  JWT_SECRET não configurado - usando chave de desenvolvimento.");
}

export const signToken = (user) =>
  jwt.sign({ id: user.id, role: user.role }, JWT_SECRET, { expiresIn: "7d" });

export const publicUser = (user) => ({
  id: user.id,
  name: user.name,
  email: user.email,
  phone: user.phone || "",
  role: user.role,
  createdAt: user.created_at,
});

export async function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Faça login para continuar." });

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const user = await db("users").where({ id: payload.id }).first();
    if (!user) return res.status(401).json({ error: "Sessão inválida." });
    req.user = user;
    next();
  } catch {
    return res.status(401).json({ error: "Sessão expirada. Entre novamente." });
  }
}

export function requireAdmin(req, res, next) {
  requireAuth(req, res, () => {
    if (req.user.role !== "admin") {
      return res.status(403).json({ error: "Acesso restrito ao administrador." });
    }
    next();
  });
}
