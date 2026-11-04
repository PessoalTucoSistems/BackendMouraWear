// Pagamento online pelo Mercado Pago:
// - PIX: pagamento criado direto na API (/v1/payments); o QR Code e o copia e cola
//   aparecem na tela do pedido, sem sair do site;
// - cartão: Checkout Pro (link do Mercado Pago), aberto em outra aba.
// A confirmação chega pelo webhook e, como reserva, pela consulta da tela do pedido
// e pela conciliação periódica do backend.
import crypto from "crypto";

const MP_API = "https://api.mercadopago.com";

// MP_ACCESS_TOKEN é o nome oficial; os outros nomes são aceitos para o caso de a
// variável ter sido cadastrada com outro nome no Render.
export const mpToken = () =>
  String(
    process.env.MP_ACCESS_TOKEN ||
      process.env.MERCADOPAGO_ACCESS_TOKEN ||
      process.env.MERCADO_PAGO_ACCESS_TOKEN ||
      process.env.ACCESS_TOKEN ||
      "",
  ).trim();

export const mpEnabled = () => Boolean(mpToken());

const httpError = (status, message) => Object.assign(new Error(message), { status, expose: true });

async function call(method, path, body, headers = {}) {
  if (!mpToken()) throw httpError(400, "Pagamento online indisponível no momento.");
  const response = await fetch(`${MP_API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${mpToken()}`, "Content-Type": "application/json", ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = data.cause?.[0]?.description || data.message || response.status;
    console.error(`❌ Mercado Pago ${method} ${path}: ${response.status} ${detail}`);
    throw httpError(502, response.status === 401 ? "O Mercado Pago recusou o access token." : `Mercado Pago: ${detail}`);
  }
  return data;
}

const frontendUrl = () => (process.env.FRONTEND_URL || "http://localhost:5173").split(",")[0].trim();
// No Render, RENDER_EXTERNAL_URL já vem preenchida com o endereço público do serviço.
const apiBase = () => String(process.env.PUBLIC_API_URL || process.env.RENDER_EXTERNAL_URL || "").replace(/\/+$/, "");
const notificationUrl = () => (apiBase().startsWith("https://") ? { notification_url: `${apiBase()}/api/webhooks/mercadopago` } : {});

/** Cria um PIX do pedido. Retorna { reference: "pix:<id>", pixCode }. */
export async function createPix(order) {
  const [first, ...rest] = String(order.customer_name || "").trim().split(/\s+/);
  const payment = await call(
    "POST",
    "/v1/payments",
    {
      transaction_amount: Number(Number(order.total).toFixed(2)),
      description: `Pedido ${order.id} - MoreiraWear`,
      payment_method_id: "pix",
      external_reference: order.id,
      payer: {
        email: order.customer_email,
        ...(first ? { first_name: first } : {}),
        ...(rest.length ? { last_name: rest.join(" ") } : {}),
      },
      ...notificationUrl(),
    },
    { "X-Idempotency-Key": crypto.randomUUID() },
  );
  const pixCode = payment?.point_of_interaction?.transaction_data?.qr_code;
  if (!pixCode) throw httpError(502, "O Mercado Pago não devolveu o código PIX.");
  console.log(`[Mercado Pago] PIX ${payment.id} gerado para o pedido ${order.id}`);
  return { reference: `pix:${payment.id}`, pixCode };
}

/** Link do Checkout Pro só para cartão (PIX é feito na tela do site). */
export async function createCardLink(order) {
  const back = `${frontendUrl()}/pedidos/${order.id}`;
  const preference = await call("POST", "/checkout/preferences", {
    items: [
      { id: order.id, title: `Pedido ${order.id} - MoreiraWear`, quantity: 1, currency_id: "BRL", unit_price: Number(order.total) },
    ],
    payer: { name: order.customer_name, email: order.customer_email },
    external_reference: order.id,
    back_urls: { success: back, pending: back, failure: back },
    auto_return: "approved",
    payment_methods: { excluded_payment_types: [{ id: "ticket" }, { id: "atm" }, { id: "bank_transfer" }] },
    // O link expira junto com a reserva do pedido.
    ...(order.expires_at ? { expires: true, expiration_date_to: order.expires_at } : {}),
    ...notificationUrl(),
  });
  if (!preference.init_point) throw httpError(502, "O Mercado Pago não devolveu o link de pagamento.");
  return preference.init_point;
}

/** Pagamentos do pedido no Mercado Pago, do mais novo para o mais antigo. */
export async function paymentsOf(orderId) {
  const data = await call(
    "GET",
    `/v1/payments/search?external_reference=${encodeURIComponent(orderId)}&sort=date_created&criteria=desc`,
  );
  return data.results || [];
}

export const getPayment = (id) => call("GET", `/v1/payments/${encodeURIComponent(id)}`);

/** Cancela os pagamentos ainda em aberto do pedido (pedido cancelado ou expirado). */
export async function cancelPendingPayments(orderId) {
  const pending = (await paymentsOf(orderId)).filter((p) => p.status === "pending" || p.status === "in_process");
  for (const p of pending) {
    await call("PUT", `/v1/payments/${p.id}`, { status: "cancelled" }).catch(() => {});
  }
}
