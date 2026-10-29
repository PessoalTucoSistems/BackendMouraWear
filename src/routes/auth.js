import { Router } from "express";
import crypto from "crypto";
import bcrypt from "bcryptjs";
import { db, now } from "../db.js";
import { publicUser, requireAuth, signToken } from "../auth.js";

const router = Router();

const normalizeEmail = (email) => String(email || "").trim().toLowerCase();
const isValidEmail = (email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

router.post("/register", async (req, res) => {
  const name = String(req.body.name || "").trim();
  const email = normalizeEmail(req.body.email);
  const password = String(req.body.password || "");
  const phone = String(req.body.phone || "").trim();

  if (!name) return res.status(400).json({ error: "Informe seu nome." });
  if (!isValidEmail(email)) return res.status(400).json({ error: "E-mail inválido." });
  if (password.length < 6) return res.status(400).json({ error: "A senha precisa ter pelo menos 6 caracteres." });

  const exists = await db("users").where({ email }).first();
  if (exists) return res.status(409).json({ error: "Já existe uma conta com este e-mail." });

  const user = {
    id: crypto.randomUUID(),
    name,
    email,
    phone,
    password_hash: await bcrypt.hash(password, 10),
    role: "customer",
    created_at: now(),
  };
  await db("users").insert(user);
  res.status(201).json({ token: signToken(user), user: publicUser(user) });
});

router.post("/login", async (req, res) => {
  const email = normalizeEmail(req.body.email);
  const password = String(req.body.password || "");
  const user = await db("users").where({ email }).first();

  if (!user || !(await bcrypt.compare(password, user.password_hash))) {
    return res.status(401).json({ error: "E-mail ou senha incorretos." });
  }
  res.json({ token: signToken(user), user: publicUser(user) });
});

router.get("/me", requireAuth, (req, res) => {
  res.json({ user: publicUser(req.user) });
});

router.put("/me", requireAuth, async (req, res) => {
  const updates = {};
  if (req.body.name !== undefined) updates.name = String(req.body.name).trim();
  if (req.body.phone !== undefined) updates.phone = String(req.body.phone).trim();

  if (req.body.newPassword) {
    const ok = await bcrypt.compare(String(req.body.currentPassword || ""), req.user.password_hash);
    if (!ok) return res.status(400).json({ error: "Senha atual incorreta." });
    if (String(req.body.newPassword).length < 6) {
      return res.status(400).json({ error: "A nova senha precisa ter pelo menos 6 caracteres." });
    }
    updates.password_hash = await bcrypt.hash(String(req.body.newPassword), 10);
  }

  if (updates.name === "") return res.status(400).json({ error: "Informe seu nome." });
  if (Object.keys(updates).length) await db("users").where({ id: req.user.id }).update(updates);

  const user = await db("users").where({ id: req.user.id }).first();
  res.json({ user: publicUser(user) });
});

export default router;
