import { Router } from "express";
import { sumupEnabled } from "../sumup.js";
import crypto from "crypto";
import { db, now, parseJson, toBool } from "../db.js";
import { requireAdmin } from "../auth.js";
import { DEFAULT_SETTINGS, getSetting } from "../schema.js";

// Quem atende o botão "Pagar online": PAGAMENTO_ONLINE escolhe quando os dois estão
// configurados; sem escolha, SumUp tem prioridade sobre o Mercado Pago.
export function onlinePaymentProvider() {
  const ready = { sumup: sumupEnabled(), mercadopago: !!process.env.MP_ACCESS_TOKEN };
  const chosen = String(process.env.PAGAMENTO_ONLINE || "").toLowerCase();
  if (ready[chosen]) return chosen;
  return ready.sumup ? "sumup" : ready.mercadopago ? "mercadopago" : null;
}

const router = Router();

// ---------- Helpers ----------

export const formatProduct = (p) => ({
  id: p.id,
  name: p.name,
  description: p.description || "",
  price: Number(p.price),
  compareAtPrice: p.compare_at_price ? Number(p.compare_at_price) : null,
  category: p.category || "",
  images: parseJson(p.images, []),
  sizes: parseJson(p.sizes, []),
  featured: toBool(p.featured),
  isNew: toBool(p.is_new),
  active: toBool(p.active),
  color: p.color || "#1a1a1a",
  createdAt: p.created_at,
});

const productRow = (body) => {
  const sizes = Array.isArray(body.sizes)
    ? body.sizes
        .filter((s) => s && String(s.size || "").trim())
        .map((s) => ({ size: String(s.size).trim().toUpperCase(), stock: Math.max(0, parseInt(s.stock, 10) || 0) }))
    : [];
  return {
    name: String(body.name || "").trim(),
    description: String(body.description || ""),
    price: Number(body.price) || 0,
    compare_at_price: body.compareAtPrice ? Number(body.compareAtPrice) : null,
    category: String(body.category || ""),
    images: JSON.stringify(Array.isArray(body.images) ? body.images.filter(Boolean) : []),
    sizes: JSON.stringify(sizes),
    featured: !!body.featured,
    is_new: !!body.isNew,
    active: body.active === undefined ? true : !!body.active,
    color: body.color || "#1a1a1a",
  };
};

const formatBanner = (b) => ({
  id: b.id,
  image: b.image,
  title: b.title || "",
  subtitle: b.subtitle || "",
  buttonLabel: b.button_label || "",
  category: b.category || "",
  order: b.sort_order || 0,
  active: toBool(b.active),
});

const bannerRow = (body) => ({
  image: String(body.image || ""),
  title: body.title || "",
  subtitle: body.subtitle || "",
  button_label: body.buttonLabel || "",
  category: body.category || "",
  sort_order: parseInt(body.order, 10) || 0,
  active: body.active === undefined ? true : !!body.active,
});

// ---------- Configurações públicas da loja ----------

router.get("/settings", async (req, res) => {
  const settings = {};
  for (const key of Object.keys(DEFAULT_SETTINGS)) settings[key] = await getSetting(key);
  res.json({
    ...settings,
    shippingFee: Number(settings.shippingFee) || 0,
    freeShippingMin: Number(settings.freeShippingMin) || 0,
    mercadoPagoEnabled: !!process.env.MP_ACCESS_TOKEN,
    onlinePayment: onlinePaymentProvider(),
  });
});

// ---------- Produtos ----------

router.get("/products", async (req, res) => {
  const query = db("products").orderBy("created_at", "desc");
  if (req.query.all !== "1") query.where({ active: true });
  const rows = await query;
  res.json(rows.map(formatProduct));
});

router.get("/products/:id", async (req, res) => {
  const row = await db("products").where({ id: req.params.id }).first();
  if (!row) return res.status(404).json({ error: "Produto não encontrado." });
  res.json(formatProduct(row));
});

router.post("/products", requireAdmin, async (req, res) => {
  const row = productRow(req.body);
  if (!row.name || row.price <= 0) return res.status(400).json({ error: "Nome e preço são obrigatórios." });
  const product = { id: crypto.randomUUID(), ...row, created_at: now() };
  await db("products").insert(product);
  res.status(201).json(formatProduct(product));
});

router.put("/products/:id", requireAdmin, async (req, res) => {
  const row = productRow(req.body);
  if (!row.name || row.price <= 0) return res.status(400).json({ error: "Nome e preço são obrigatórios." });
  const updated = await db("products").where({ id: req.params.id }).update(row);
  if (!updated) return res.status(404).json({ error: "Produto não encontrado." });
  res.json(formatProduct(await db("products").where({ id: req.params.id }).first()));
});

router.delete("/products/:id", requireAdmin, async (req, res) => {
  await db("products").where({ id: req.params.id }).del();
  res.json({ success: true });
});

// ---------- Categorias ----------

router.get("/categories", async (req, res) => {
  const rows = await db("categories").orderBy("sort_order").orderBy("name");
  res.json(rows.map((c) => ({ id: c.id, name: c.name, order: c.sort_order || 0 })));
});

router.post("/categories", requireAdmin, async (req, res) => {
  const name = String(req.body.name || "").trim();
  if (!name) return res.status(400).json({ error: "Informe o nome da categoria." });
  if (await db("categories").whereRaw("lower(name) = ?", [name.toLowerCase()]).first()) {
    return res.status(409).json({ error: "Essa categoria já existe." });
  }
  const category = { id: crypto.randomUUID(), name, sort_order: parseInt(req.body.order, 10) || 0 };
  await db("categories").insert(category);
  res.status(201).json({ id: category.id, name, order: category.sort_order });
});

router.put("/categories/:id", requireAdmin, async (req, res) => {
  const current = await db("categories").where({ id: req.params.id }).first();
  if (!current) return res.status(404).json({ error: "Categoria não encontrada." });
  const name = String(req.body.name || "").trim() || current.name;
  const order = req.body.order === undefined ? current.sort_order : parseInt(req.body.order, 10) || 0;

  await db.transaction(async (trx) => {
    await trx("categories").where({ id: current.id }).update({ name, sort_order: order });
    // Renomear a categoria leva os produtos e banners junto.
    if (name !== current.name) {
      await trx("products").where({ category: current.name }).update({ category: name });
      await trx("banners").where({ category: current.name }).update({ category: name });
    }
  });
  res.json({ id: current.id, name, order });
});

router.delete("/categories/:id", requireAdmin, async (req, res) => {
  const current = await db("categories").where({ id: req.params.id }).first();
  if (!current) return res.status(404).json({ error: "Categoria não encontrada." });
  const inUse = await db("products").where({ category: current.name }).count("id as count").first();
  if (Number(inUse.count) > 0) {
    return res.status(400).json({ error: `Existem ${inUse.count} produto(s) nessa categoria. Mova-os antes de excluir.` });
  }
  await db("categories").where({ id: current.id }).del();
  res.json({ success: true });
});

// ---------- Banners ----------

router.get("/banners", async (req, res) => {
  const query = db("banners").orderBy("sort_order");
  if (req.query.all !== "1") query.where({ active: true });
  res.json((await query).map(formatBanner));
});

router.post("/banners", requireAdmin, async (req, res) => {
  const row = bannerRow(req.body);
  if (!row.image) return res.status(400).json({ error: "Envie a imagem do banner." });
  const banner = { id: crypto.randomUUID(), ...row };
  await db("banners").insert(banner);
  res.status(201).json(formatBanner(banner));
});

router.put("/banners/:id", requireAdmin, async (req, res) => {
  const row = bannerRow(req.body);
  if (!row.image) return res.status(400).json({ error: "Envie a imagem do banner." });
  const updated = await db("banners").where({ id: req.params.id }).update(row);
  if (!updated) return res.status(404).json({ error: "Banner não encontrado." });
  res.json(formatBanner(await db("banners").where({ id: req.params.id }).first()));
});

router.delete("/banners/:id", requireAdmin, async (req, res) => {
  await db("banners").where({ id: req.params.id }).del();
  res.json({ success: true });
});

// ---------- Imagens ----------

router.post("/images", requireAdmin, async (req, res) => {
  const match = /^data:(image\/(?:png|jpe?g|webp|gif));base64,(.+)$/.exec(String(req.body.dataUrl || ""));
  if (!match) return res.status(400).json({ error: "Formato de imagem inválido." });
  const id = crypto.randomUUID();
  await db("images").insert({ id, mime: match[1], data: match[2], created_at: now() });
  const base = process.env.PUBLIC_API_URL || `${req.protocol}://${req.get("host")}`;
  res.status(201).json({ id, url: `${base}/api/images/${id}` });
});

router.get("/images/:id", async (req, res) => {
  const image = await db("images").where({ id: req.params.id }).first();
  if (!image) return res.status(404).end();
  res.set("Content-Type", image.mime);
  res.set("Cache-Control", "public, max-age=31536000, immutable");
  res.send(Buffer.from(image.data, "base64"));
});

export default router;
