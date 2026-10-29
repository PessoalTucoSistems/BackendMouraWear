import { Router } from "express";
import { db, dbType, now, parseJson } from "../db.js";
import { requireAdmin, requireAuth } from "../auth.js";
import { getSetting } from "../schema.js";
import { cancelCharge, checkCharge, createCharge, sumupEnabled } from "../sumup.js";

const router = Router();

export const ORDER_STATUSES = ["pending", "paid", "shipped", "delivered", "canceled"];
const PAYMENT_METHODS = ["pix", "whatsapp", "mercadopago", "sumup"];

const MP_TOKEN = process.env.MP_ACCESS_TOKEN;

// Pedidos via WhatsApp seguram o estoque por este tempo esperando o admin confirmar o pagamento.
export const WHATSAPP_HOLD_HOURS = Number(process.env.WHATSAPP_HOLD_HOURS) || 7;
// Pedidos online (SumUp / Mercado Pago) esperam o pagamento por este tempo.
export const ONLINE_HOLD_MINUTES = Number(process.env.ONLINE_HOLD_MINUTES) || 30;
const ONLINE_METHODS = ["sumup", "mercadopago"];

const expiresAtFor = (paymentMethod, from = Date.now()) => {
  if (paymentMethod === "whatsapp") return new Date(from + WHATSAPP_HOLD_HOURS * 3600_000).toISOString();
  if (ONLINE_METHODS.includes(paymentMethod)) return new Date(from + ONLINE_HOLD_MINUTES * 60_000).toISOString();
  return null;
};
const MP_API = "https://api.mercadopago.com";

export const formatOrder = (o) => ({
  id: o.id,
  userId: o.user_id,
  customerName: o.customer_name,
  customerEmail: o.customer_email,
  customerPhone: o.customer_phone || "",
  items: parseJson(o.items, []),
  subtotal: Number(o.subtotal),
  shipping: Number(o.shipping),
  total: Number(o.total),
  address: parseJson(o.address, {}),
  paymentMethod: o.payment_method,
  status: o.status,
  paymentUrl: o.payment_url || null,
  pixCode: o.status === "pending" ? o.payment_qr || null : null,
  notes: o.notes || "",
  expiresAt: o.status === "pending" ? o.expires_at || null : null,
  cancelReason: o.cancel_reason || null,
  createdAt: o.created_at,
  updatedAt: o.updated_at,
});

const newOrderId = () =>
  "MW" + Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2, 5).toUpperCase();

const round2 = (n) => Math.round(n * 100) / 100;

// Soma (ou subtrai) quantidades no estoque de cada tamanho dentro da transação.
async function adjustStock(trx, items, direction) {
  for (const item of items) {
    const query = trx("products").where({ id: item.productId });
    if (dbType === "postgres") query.forUpdate();
    const product = await query.first();
    if (!product) continue;
    const sizes = parseJson(product.sizes, []);
    const entry = sizes.find((s) => s.size === item.size);
    if (!entry) continue;
    entry.stock = Math.max(0, (Number(entry.stock) || 0) + direction * item.quantity);
    await trx("products").where({ id: product.id }).update({ sizes: JSON.stringify(sizes) });
  }
}

// Cancela pedidos não pagos dentro do prazo (WhatsApp: 7h; online: 30 min) e devolve as
// peças ao estoque. Roda num intervalo e também antes das requisições: no plano grátis o
// Render dorme e o intervalo para, então quem acordar o servidor já vê tudo correto.
let lastExpireRun = 0;
let expiring = false;
export async function expireOverdueOrders({ force = false } = {}) {
  if (expiring || (!force && Date.now() - lastExpireRun < 30_000)) return;
  lastExpireRun = Date.now();
  expiring = true;
  try {
    const overdue = await db("orders").where({ status: "pending" }).whereNotNull("expires_at").where("expires_at", "<", now());
    for (const row of overdue) await expireOrder(row);
  } finally {
    expiring = false;
  }
}

async function expireOrder(row) {
  // Online: antes de cancelar, confere no banco se o cliente pagou no último minuto.
  if (ONLINE_METHODS.includes(row.payment_method)) {
    try {
      if (row.payment_method === "sumup") await syncSumupPayment(row);
      else await syncMercadoPagoPayment(row.id);
    } catch (error) {
      console.warn(`[Pagamentos] Pedido ${row.id}: consulta falhou, cancelamento fica para a próxima rodada:`, error.message);
      return;
    }
  }
  await db.transaction(async (trx) => {
    // O where no status evita devolver o estoque duas vezes se o admin agir ao mesmo tempo.
    const updated = await trx("orders")
      .where({ id: row.id, status: "pending" })
      .update({ status: "canceled", cancel_reason: "expired", notice_seen: false, updated_at: now() });
    if (updated) {
      await adjustStock(trx, parseJson(row.items, []), +1);
      console.log(`⏰ Pedido ${row.id} (${row.payment_method}) cancelado: pagamento não confirmado no prazo`);
    }
  });
  // Desativa a cobrança da SumUp para ninguém pagar um pedido já cancelado.
  if (row.payment_method === "sumup" && row.payment_id) await cancelCharge(row.payment_id).catch(() => {});
}

// Pedidos online pendentes criados antes do prazo existir ganham o prazo a partir da criação.
export async function backfillOnlineExpiry() {
  const rows = await db("orders").where({ status: "pending" }).whereIn("payment_method", ONLINE_METHODS).whereNull("expires_at");
  for (const row of rows) {
    await db("orders").where({ id: row.id }).update({ expires_at: expiresAtFor(row.payment_method, new Date(row.created_at).getTime()) });
  }
}

// Marca como pago se a cobrança da SumUp foi paga com o valor do pedido.
async function syncSumupPayment(row) {
  if (!sumupEnabled() || !String(row.payment_id || "").startsWith("checkout:")) return;
  const result = await checkCharge(row.payment_id);
  if (result.status !== "paid") return;
  if (result.amount + 0.01 < Number(row.total)) {
    console.warn(`⚠️ Pedido ${row.id}: SumUp pago com ${result.amount}, total ${row.total}. Confirme manualmente.`);
    return;
  }
  const updated = await db("orders")
    .where({ id: row.id, status: "pending" })
    .update({ status: "paid", payment_qr: null, expires_at: null, updated_at: now() });
  if (updated) console.log(`💸 Pedido ${row.id} pago via SumUp`);
}

// Conciliação: cobranças SumUp em aberto das últimas 48h (cobre quem fechou a tela).
export async function reconcileSumup() {
  if (!sumupEnabled()) return;
  const since = new Date(Date.now() - 48 * 3600_000).toISOString();
  const rows = await db("orders")
    .where({ status: "pending", payment_method: "sumup" })
    .whereNotNull("payment_id")
    .where("updated_at", ">=", since)
    .limit(50);
  for (const row of rows) {
    await syncSumupPayment(row).catch((e) => console.warn(`[SumUp] Conciliação do pedido ${row.id}:`, e.message));
  }
}

async function createMercadoPagoPreference(order) {
  const frontend = (process.env.FRONTEND_URL || "http://localhost:5173").split(",")[0].trim();
  const apiBase = process.env.PUBLIC_API_URL;
  const body = {
    items: [
      {
        id: order.id,
        title: `Pedido ${order.id} - MoreiraWear`,
        quantity: 1,
        currency_id: "BRL",
        unit_price: Number(order.total),
      },
    ],
    payer: { name: order.customer_name, email: order.customer_email },
    external_reference: order.id,
    back_urls: {
      success: `${frontend}/pedidos/${order.id}`,
      pending: `${frontend}/pedidos/${order.id}`,
      failure: `${frontend}/pedidos/${order.id}`,
    },
    auto_return: "approved",
    // O link de pagamento expira junto com a reserva do pedido.
    ...(order.expires_at ? { expires: true, expiration_date_to: order.expires_at } : {}),
    ...(apiBase ? { notification_url: `${apiBase}/api/webhooks/mercadopago` } : {}),
  };

  const response = await fetch(`${MP_API}/checkout/preferences`, {
    method: "POST",
    headers: { Authorization: `Bearer ${MP_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.message || "Falha ao criar pagamento no Mercado Pago");
  return data.init_point;
}

// Marca como pago se o Mercado Pago tiver algum pagamento aprovado do pedido.
async function syncMercadoPagoPayment(orderId) {
  if (!MP_TOKEN) return;
  const response = await fetch(
    `${MP_API}/v1/payments/search?external_reference=${encodeURIComponent(orderId)}&sort=date_created&criteria=desc`,
    { headers: { Authorization: `Bearer ${MP_TOKEN}` } },
  );
  if (!response.ok) return;
  const data = await response.json();
  const approved = (data.results || []).find((p) => p.status === "approved");
  if (approved) {
    await db("orders")
      .where({ id: orderId, status: "pending" })
      .update({ status: "paid", payment_id: String(approved.id), expires_at: null, updated_at: now() });
  }
}

// ---------- Cliente ----------

router.post("/orders", requireAuth, async (req, res) => {
  const { items, address = {}, paymentMethod, notes = "" } = req.body;

  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: "Seu carrinho está vazio." });
  }
  if (!PAYMENT_METHODS.includes(paymentMethod)) {
    return res.status(400).json({ error: "Escolha uma forma de pagamento." });
  }
  if ((paymentMethod === "mercadopago" && !MP_TOKEN) || (paymentMethod === "sumup" && !sumupEnabled())) {
    return res.status(400).json({ error: "Pagamento online indisponível no momento." });
  }
  for (const field of ["cep", "street", "number", "city", "state"]) {
    if (!String(address[field] || "").trim()) {
      return res.status(400).json({ error: "Preencha o endereço de entrega completo." });
    }
  }

  // Lido fora da transação: no SQLite o pool tem uma conexão só.
  const freeMin = Number(await getSetting("freeShippingMin")) || 0;
  const fee = Number(await getSetting("shippingFee")) || 0;

  try {
    const order = await db.transaction(async (trx) => {
      const orderItems = [];
      for (const item of items) {
        const quantity = parseInt(item.quantity, 10);
        if (!quantity || quantity < 1) throw new Error("Quantidade inválida.");

        const query = trx("products").where({ id: item.productId });
        if (dbType === "postgres") query.forUpdate();
        const product = await query.first();
        if (!product || !product.active) throw new Error("Um dos produtos não está mais disponível.");

        const sizes = parseJson(product.sizes, []);
        const entry = sizes.find((s) => s.size === item.size);
        if (!entry) throw new Error(`Tamanho ${item.size} indisponível para ${product.name}.`);
        if ((Number(entry.stock) || 0) < quantity) {
          throw new Error(`Só temos ${entry.stock} unidade(s) de ${product.name} (${item.size}).`);
        }

        // O preço sempre vem do banco, nunca do navegador.
        orderItems.push({
          productId: product.id,
          name: product.name,
          size: entry.size,
          quantity,
          price: Number(product.price),
          image: parseJson(product.images, [])[0] || null,
        });
      }

      await adjustStock(trx, orderItems, -1);

      const subtotal = round2(orderItems.reduce((sum, i) => sum + i.price * i.quantity, 0));
      const shipping = freeMin > 0 && subtotal >= freeMin ? 0 : fee;

      const row = {
        id: newOrderId(),
        user_id: req.user.id,
        customer_name: req.user.name,
        customer_email: req.user.email,
        customer_phone: String(address.phone || req.user.phone || ""),
        items: JSON.stringify(orderItems),
        subtotal,
        shipping,
        total: round2(subtotal + shipping),
        address: JSON.stringify(address),
        payment_method: paymentMethod,
        status: "pending",
        expires_at: expiresAtFor(paymentMethod),
        notes: String(notes).slice(0, 1000),
        created_at: now(),
        updated_at: now(),
      };
      await trx("orders").insert(row);
      return row;
    });

    if (paymentMethod === "mercadopago") {
      try {
        order.payment_url = await createMercadoPagoPreference(order);
        await db("orders").where({ id: order.id }).update({ payment_url: order.payment_url });
      } catch (error) {
        console.error("❌ Mercado Pago:", error.message);
      }
    }

    res.status(201).json(formatOrder(order));
  } catch (error) {
    res.status(400).json({ error: error.message || "Não foi possível finalizar o pedido." });
  }
});

// Pedidos cancelados automaticamente que o cliente ainda não viu (aviso no site).
router.get("/orders/notices", requireAuth, async (req, res) => {
  const rows = await db("orders")
    .where({ user_id: req.user.id, status: "canceled", cancel_reason: "expired", notice_seen: false })
    .orderBy("updated_at", "desc");
  res.json(rows.map(formatOrder));
});

router.post("/orders/:id/notice-seen", requireAuth, async (req, res) => {
  await db("orders").where({ id: req.params.id, user_id: req.user.id }).update({ notice_seen: true });
  res.json({ ok: true });
});

router.get("/orders/mine", requireAuth, async (req, res) => {
  const rows = await db("orders").where({ user_id: req.user.id }).orderBy("created_at", "desc");
  res.json(rows.map(formatOrder));
});

router.get("/orders/:id", requireAuth, async (req, res) => {
  let row = await db("orders").where({ id: req.params.id }).first();
  if (!row || (row.user_id !== req.user.id && req.user.role !== "admin")) {
    return res.status(404).json({ error: "Pedido não encontrado." });
  }
  if (row.status === "pending" && row.payment_method === "mercadopago") {
    await syncMercadoPagoPayment(row.id).catch(() => {});
    row = await db("orders").where({ id: req.params.id }).first();
  }
  if (row.status === "pending" && row.payment_method === "sumup") {
    await syncSumupPayment(row).catch((e) => console.warn(`[SumUp] Consulta do pedido ${row.id}:`, e.message));
    row = await db("orders").where({ id: req.params.id }).first();
  }
  res.json(formatOrder(row));
});

// Gera a cobrança SumUp do pedido: { method: "pix" | "card" }. Pode ser chamada de novo
// (PIX expirado, troca de PIX para cartão etc.); cada chamada cria um checkout novo.
router.post("/orders/:id/sumup", requireAuth, async (req, res) => {
  const row = await db("orders").where({ id: req.params.id, user_id: req.user.id }).first();
  if (!row) return res.status(404).json({ error: "Pedido não encontrado." });
  if (row.payment_method !== "sumup") return res.status(400).json({ error: "Este pedido não é de pagamento online." });
  if (row.status !== "pending") return res.status(400).json({ error: "Este pedido não está aguardando pagamento." });
  const method = req.body?.method === "card" ? "card" : "pix";

  // Antes de gerar outra cobrança, confere se a anterior já foi paga.
  await syncSumupPayment(row).catch(() => {});
  const fresh = await db("orders").where({ id: row.id }).first();
  if (fresh.status !== "pending") return res.json(formatOrder(fresh));

  try {
    const charge = await createCharge(fresh, method);
    await db("orders")
      .where({ id: row.id })
      .update({ payment_id: charge.reference, payment_qr: charge.pixCode || null, payment_url: charge.url || null, updated_at: now() });
    res.json(formatOrder(await db("orders").where({ id: row.id }).first()));
  } catch (error) {
    res.status(error.status || 502).json({ error: error.message });
  }
});

router.post("/orders/:id/cancel", requireAuth, async (req, res) => {
  const row = await db("orders").where({ id: req.params.id, user_id: req.user.id }).first();
  if (!row) return res.status(404).json({ error: "Pedido não encontrado." });
  if (row.status !== "pending") {
    return res.status(400).json({ error: "Só é possível cancelar pedidos aguardando pagamento." });
  }
  await db.transaction(async (trx) => {
    await adjustStock(trx, parseJson(row.items, []), +1);
    await trx("orders").where({ id: row.id }).update({ status: "canceled", cancel_reason: "customer", updated_at: now() });
  });
  res.json(formatOrder(await db("orders").where({ id: row.id }).first()));
});

// ---------- Admin ----------

router.get("/admin/orders", requireAdmin, async (req, res) => {
  const query = db("orders").orderBy("created_at", "desc");
  if (ORDER_STATUSES.includes(req.query.status)) query.where({ status: req.query.status });
  res.json((await query).map(formatOrder));
});

router.put("/admin/orders/:id/status", requireAdmin, async (req, res) => {
  const { status } = req.body;
  if (!ORDER_STATUSES.includes(status)) return res.status(400).json({ error: "Status inválido." });
  const row = await db("orders").where({ id: req.params.id }).first();
  if (!row) return res.status(404).json({ error: "Pedido não encontrado." });

  await db.transaction(async (trx) => {
    // Cancelar devolve as peças ao estoque; reabrir um cancelado retira de novo.
    if (status === "canceled" && row.status !== "canceled") {
      await adjustStock(trx, parseJson(row.items, []), +1);
    } else if (row.status === "canceled" && status !== "canceled") {
      await adjustStock(trx, parseJson(row.items, []), -1);
    }
    // Qualquer ação do admin encerra a reserva automática e o motivo de cancelamento anterior.
    await trx("orders")
      .where({ id: row.id })
      .update({
        status,
        expires_at: null,
        cancel_reason: status === "canceled" ? "admin" : null,
        notice_seen: true,
        updated_at: now(),
      });
  });
  res.json(formatOrder(await db("orders").where({ id: row.id }).first()));
});

// ---------- Webhook Mercado Pago ----------

router.post("/webhooks/mercadopago", async (req, res) => {
  res.sendStatus(200);
  try {
    const paymentId = req.body?.data?.id || req.query.id || req.query["data.id"];
    const type = req.body?.type || req.query.topic || req.query.type;
    if (!MP_TOKEN || !paymentId || (type && type !== "payment")) return;

    const response = await fetch(`${MP_API}/v1/payments/${paymentId}`, {
      headers: { Authorization: `Bearer ${MP_TOKEN}` },
    });
    if (!response.ok) return;
    const payment = await response.json();
    if (payment.status === "approved" && payment.external_reference) {
      await db("orders")
        .where({ id: payment.external_reference, status: "pending" })
        .update({ status: "paid", payment_id: String(payment.id), updated_at: now() });
      console.log(`💸 Pedido ${payment.external_reference} pago via Mercado Pago`);
    }
  } catch (error) {
    console.error("❌ Webhook Mercado Pago:", error.message);
  }
});

export default router;
