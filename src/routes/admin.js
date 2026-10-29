import { Router } from "express";
import crypto from "crypto";
import bcrypt from "bcryptjs";
import { db, now, parseJson } from "../db.js";
import { publicUser, requireAdmin } from "../auth.js";
import { ADMIN_EMAIL, DEFAULT_SETTINGS, getSetting } from "../schema.js";

const router = Router();
router.use("/admin", requireAdmin);

// ---------- Usuários ----------

router.get("/admin/users", async (req, res) => {
  const users = await db("users").orderBy("created_at", "desc");
  const counts = await db("orders").select("user_id").count("id as count").groupBy("user_id");
  const byUser = Object.fromEntries(counts.map((c) => [c.user_id, Number(c.count)]));
  res.json(users.map((u) => ({ ...publicUser(u), ordersCount: byUser[u.id] || 0 })));
});

router.post("/admin/users", async (req, res) => {
  const name = String(req.body.name || "").trim();
  const email = String(req.body.email || "").trim().toLowerCase();
  const password = String(req.body.password || "");
  const role = req.body.role === "admin" ? "admin" : "customer";

  if (!name || !email) return res.status(400).json({ error: "Nome e e-mail são obrigatórios." });
  if (password.length < 6) return res.status(400).json({ error: "A senha precisa ter pelo menos 6 caracteres." });
  if (await db("users").where({ email }).first()) {
    return res.status(409).json({ error: "Já existe um usuário com este e-mail." });
  }

  const user = {
    id: crypto.randomUUID(),
    name,
    email,
    phone: String(req.body.phone || ""),
    role,
    password_hash: await bcrypt.hash(password, 10),
    created_at: now(),
  };
  await db("users").insert(user);
  res.status(201).json(publicUser(user));
});

router.put("/admin/users/:id", async (req, res) => {
  const user = await db("users").where({ id: req.params.id }).first();
  if (!user) return res.status(404).json({ error: "Usuário não encontrado." });

  const updates = {};
  if (req.body.name !== undefined) updates.name = String(req.body.name).trim() || user.name;
  if (req.body.phone !== undefined) updates.phone = String(req.body.phone);
  if (req.body.role !== undefined) {
    // O admin principal e o próprio usuário logado não perdem o acesso.
    const role = req.body.role === "admin" ? "admin" : "customer";
    if (role !== "admin" && (user.email === ADMIN_EMAIL || user.id === req.user.id)) {
      return res.status(400).json({ error: "Esse usuário precisa continuar como administrador." });
    }
    updates.role = role;
  }
  if (req.body.password) {
    if (String(req.body.password).length < 6) {
      return res.status(400).json({ error: "A senha precisa ter pelo menos 6 caracteres." });
    }
    updates.password_hash = await bcrypt.hash(String(req.body.password), 10);
  }

  if (Object.keys(updates).length) await db("users").where({ id: user.id }).update(updates);
  res.json(publicUser(await db("users").where({ id: user.id }).first()));
});

router.delete("/admin/users/:id", async (req, res) => {
  const user = await db("users").where({ id: req.params.id }).first();
  if (!user) return res.status(404).json({ error: "Usuário não encontrado." });
  if (user.email === ADMIN_EMAIL || user.id === req.user.id) {
    return res.status(400).json({ error: "Esse usuário não pode ser excluído." });
  }
  await db("users").where({ id: user.id }).del();
  res.json({ success: true });
});

// ---------- Dashboard ----------

router.get("/admin/dashboard", async (req, res) => {
  const orders = (await db("orders").select("id", "items", "total", "status", "created_at")).map((o) => ({
    ...o,
    total: Number(o.total),
    items: parseJson(o.items, []),
  }));
  const sold = orders.filter((o) => ["paid", "shipped", "delivered"].includes(o.status));
  const revenue = sold.reduce((sum, o) => sum + o.total, 0);

  // Vendas por dia nos últimos 30 dias (dias sem venda entram zerados).
  const days = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    days.push(d.toISOString().slice(0, 10));
  }
  const byDay = Object.fromEntries(days.map((d) => [d, 0]));
  for (const o of sold) {
    const day = String(o.created_at).slice(0, 10);
    if (day in byDay) byDay[day] += o.total;
  }

  const productTotals = {};
  for (const o of sold) {
    for (const item of o.items) {
      const entry = (productTotals[item.productId] ||= { name: item.name, quantity: 0, revenue: 0 });
      entry.quantity += item.quantity;
      entry.revenue += item.price * item.quantity;
    }
  }

  const products = await db("products").select("id", "name", "sizes", "active");
  const lowStock = [];
  for (const p of products) {
    for (const s of parseJson(p.sizes, [])) {
      if (Number(s.stock) <= 3) lowStock.push({ productId: p.id, name: p.name, size: s.size, stock: Number(s.stock) });
    }
  }

  const customers = await db("users").where({ role: "customer" }).count("id as count").first();

  res.json({
    revenue,
    ordersCount: orders.length,
    soldCount: sold.length,
    pendingCount: orders.filter((o) => o.status === "pending").length,
    toShipCount: orders.filter((o) => o.status === "paid").length,
    averageTicket: sold.length ? revenue / sold.length : 0,
    customersCount: Number(customers.count),
    productsCount: products.filter((p) => p.active === true || p.active === 1).length,
    salesByDay: days.map((date) => ({ date, total: Math.round(byDay[date] * 100) / 100 })),
    topProducts: Object.values(productTotals).sort((a, b) => b.quantity - a.quantity).slice(0, 5),
    lowStock: lowStock.sort((a, b) => a.stock - b.stock).slice(0, 10),
  });
});

// ---------- Configurações da loja ----------

router.get("/admin/settings", async (req, res) => {
  const settings = {};
  for (const key of Object.keys(DEFAULT_SETTINGS)) settings[key] = await getSetting(key);
  res.json(settings);
});

router.put("/admin/settings", async (req, res) => {
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    if (req.body[key] === undefined) continue;
    const value = String(req.body[key]);
    const exists = await db("settings").where({ key }).first();
    if (exists) await db("settings").where({ key }).update({ value });
    else await db("settings").insert({ key, value });
  }
  const settings = {};
  for (const key of Object.keys(DEFAULT_SETTINGS)) settings[key] = await getSetting(key);
  res.json(settings);
});

export default router;
