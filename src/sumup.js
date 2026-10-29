// Pagamento online pela SumUp (adaptado do projeto Gira Kids):
// - PIX: checkout com código copia e cola (o QR Code é desenhado no navegador);
// - cartão: página de pagamento hospedada pela SumUp, que volta para o pedido.
// A SumUp não usa webhook aqui: o status vem de consulta à API (tela do pedido +
// conciliação periódica no backend).
const API = process.env.SUMUP_API_URL || "https://api.sumup.com";
const API_KEY = process.env.SUMUP_API_KEY;

export const sumupEnabled = () => Boolean(API_KEY);

const httpError = (status, message) => Object.assign(new Error(message), { status, expose: true });

async function call(method, path, body) {
  if (!API_KEY) throw httpError(400, "Pagamento online indisponível no momento.");
  const response = await fetch(`${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { text };
  }
  if (!response.ok) {
    const detail = data.message || data.error_message || data.detail || data.text || response.status;
    console.error(`❌ SumUp ${method} ${path}: ${response.status} ${detail}`);
    throw httpError(502, response.status === 401 ? "A SumUp recusou a API key." : `SumUp: ${detail}`);
  }
  return data;
}

// merchant_code vem da variável ou da própria conta da API key (guardado em memória).
let merchantCode = process.env.SUMUP_MERCHANT_CODE || "";
async function merchant() {
  if (merchantCode) return merchantCode;
  const me = await call("GET", "/v0.1/me");
  merchantCode = String(me?.merchant_profile?.merchant_code || "");
  if (!merchantCode) throw httpError(502, "A SumUp não devolveu o código da loja para esta API key.");
  return merchantCode;
}

const frontendUrl = () => (process.env.FRONTEND_URL || "http://localhost:5173").split(",")[0].trim();

async function createCheckout(order, extras = {}) {
  const checkout = await call("POST", "/v0.1/checkouts", {
    checkout_reference: `${order.id}-${Date.now()}`,
    amount: Number(Number(order.total).toFixed(2)),
    currency: "BRL",
    merchant_code: await merchant(),
    description: `Pedido ${order.id} - MoreiraWear`,
    // A cobrança vale só até o fim da reserva do pedido.
    ...(order.expires_at ? { valid_until: order.expires_at } : {}),
    ...extras,
  });
  if (!checkout?.id) throw httpError(502, "A SumUp não criou o checkout.");
  return checkout;
}

async function readArtefact(artefact) {
  if (!artefact) return null;
  if (artefact.content) return String(artefact.content);
  if (!artefact.location) return null;
  const response = await fetch(artefact.location, { headers: { Authorization: `Bearer ${API_KEY}` } });
  return response.ok ? (await response.text()).trim() : null;
}

// A SumUp devolve os artefatos dentro do objeto do método; os outros lugares ficam de reserva.
const artefactsOf = (data, type) =>
  data?.[type]?.artefacts || data?.pix?.artefacts || data?.qr_code_pix?.artefacts || data?.artefacts || data?.next_step?.artefacts || [];

// Último recurso: qualquer texto no formato do PIX copia e cola (EMV "000201...").
function findPixCode(value) {
  if (typeof value === "string") return /^000201/.test(value) && /br\.gov\.bcb\.pix/i.test(value) ? value : null;
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) {
      const found = findPixCode(item);
      if (found) return found;
    }
  }
  return null;
}

async function generatePix(checkoutId, type, order) {
  const [first, ...rest] = String(order.customer_name || "").trim().split(/\s+/);
  const processed = await call("PUT", `/v0.1/checkouts/${checkoutId}`, {
    payment_type: type,
    personal_details: {
      ...(order.customer_email ? { email: order.customer_email } : {}),
      ...(first ? { first_name: first } : {}),
      ...(rest.length ? { last_name: rest.join(" ") } : {}),
    },
  });
  const artefacts = artefactsOf(processed, type);
  const code = artefacts.find((a) => String(a?.name || "").toLowerCase() === "code");
  const pixCode = (await readArtefact(code)) || findPixCode(processed);
  if (!pixCode) {
    console.warn(`[SumUp] Resposta do PIX (${type}) sem código. Campos:`, Object.keys(processed || {}).join(", "));
  }
  return pixCode;
}

/**
 * Cria a cobrança do pedido. method: "pix" | "card".
 * Retorna { reference, pixCode?, url? }; reference = "checkout:<id>".
 */
export async function createCharge(order, method) {
  if (method === "pix") {
    // "pix" cai direto na conta; se a conta não aceitar, "qr_code_pix". Cada tentativa usa um checkout novo.
    let lastError = null;
    for (const type of ["pix", "qr_code_pix"]) {
      try {
        const checkout = await createCheckout(order);
        const pixCode = await generatePix(checkout.id, type, order);
        if (pixCode) return { reference: `checkout:${checkout.id}`, pixCode };
      } catch (error) {
        lastError = error;
        console.warn(`[SumUp] PIX (${type}) não gerado:`, error.message);
      }
    }
    throw httpError(502, `Não foi possível gerar o PIX${lastError ? ` (${lastError.message})` : ""}. Tente o cartão ou fale com a loja.`);
  }
  const checkout = await createCheckout(order, {
    hosted_checkout: { enabled: true },
    redirect_url: `${frontendUrl()}/pedidos/${order.id}`,
  });
  if (!checkout.hosted_checkout_url) throw httpError(502, "A SumUp não devolveu a página de pagamento.");
  return { reference: `checkout:${checkout.id}`, url: checkout.hosted_checkout_url };
}

/** Consulta a cobrança: { status: "paid" | "failed" | "expired" | "pending", amount? }. */
export async function checkCharge(reference) {
  const [type, ...rest] = String(reference || "").split(":");
  if (type !== "checkout" || !rest.length) return { status: "pending" };
  const checkout = await call("GET", `/v0.1/checkouts/${rest.join(":")}`);
  const status = String(checkout?.status || "").toUpperCase();
  if (status === "PAID") return { status: "paid", amount: Number(checkout.amount) };
  if (status === "FAILED") return { status: "failed" };
  if (status === "EXPIRED") return { status: "expired" };
  return { status: "pending" };
}

/** Desativa um checkout em aberto (pedido cancelado). */
export async function cancelCharge(reference) {
  const [type, ...rest] = String(reference || "").split(":");
  if (type !== "checkout" || !rest.length) return;
  await call("DELETE", `/v0.1/checkouts/${rest.join(":")}`);
}
