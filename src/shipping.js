// Cotação de frete dos Correios (PAC e SEDEX) pelo Melhor Envio.
// A API de preços dos próprios Correios exige contrato; o Melhor Envio tem conta grátis
// e devolve PAC/SEDEX com o preço que a loja paga ao gerar a etiqueta por lá.
// Configuração: MELHOR_ENVIO_TOKEN (+ MELHOR_ENVIO_SANDBOX=true para testes).

import { getSetting } from "./schema.js";

const SERVICES = { 1: "pac", 2: "sedex" }; // ids dos serviços Correios no Melhor Envio
export const SHIPPING_METHODS = ["pickup", "pac", "sedex", "fixed"];
export const SHIPPING_LABEL = { pickup: "Retirar em mãos", pac: "PAC (Correios)", sedex: "SEDEX (Correios)", fixed: "Entrega" };

const meToken = () => process.env.MELHOR_ENVIO_TOKEN || "";
export const correiosEnabled = () => !!meToken();
const meBase = () =>
  /^(1|true|sim)$/i.test(process.env.MELHOR_ENVIO_SANDBOX || "")
    ? "https://sandbox.melhorenvio.com.br"
    : "https://www.melhorenvio.com.br";

const digits = (v) => String(v || "").replace(/\D/g, "");
const round2 = (n) => Math.round(n * 100) / 100;

// Caixa estimada: base de uma caixa de roupas que cresce em altura conforme as peças.
function packageFor(quantity, weightPerItem) {
  const qty = Math.max(1, quantity);
  return {
    width: 25,
    length: 30,
    height: Math.min(100, 4 + 4 * qty),
    weight: Math.max(0.1, round2(qty * weightPerItem)),
  };
}

// Cache curto: a tela cota ao digitar o CEP e o pedido recota ao finalizar.
const cache = new Map();
const CACHE_MS = 30 * 60_000;

/**
 * Cotação PAC/SEDEX para o CEP. Devolve [{ method, label, price, days }].
 * `subtotal` define o seguro e o frete grátis (aplicado ao PAC).
 */
export async function quoteCorreios({ cep, quantity, subtotal }) {
  if (!correiosEnabled()) throw httpError(503, "Cotação dos Correios indisponível no momento.");
  const to = digits(cep);
  if (to.length !== 8) throw httpError(400, "Informe um CEP válido.");
  const from = digits(await getSetting("originCep"));
  if (from.length !== 8) throw httpError(503, "A loja ainda não configurou o CEP de origem do frete.");
  const weightPerItem = Number(String(await getSetting("itemWeightKg")).replace(",", ".")) || 0.3;
  const freeMin = Number(await getSetting("freeShippingMin")) || 0;

  const pkg = packageFor(quantity, weightPerItem);
  const key = [from, to, pkg.weight, pkg.height, Math.round(subtotal)].join(":");
  let raw = cache.get(key);
  if (!raw || Date.now() - raw.at > CACHE_MS) {
    raw = { at: Date.now(), options: await fetchMelhorEnvio({ from, to, pkg, insurance: subtotal }) };
    cache.set(key, raw);
    if (cache.size > 500) cache.clear();
  }

  return raw.options.map((o) => {
    const free = o.method === "pac" && freeMin > 0 && subtotal >= freeMin;
    return { ...o, label: SHIPPING_LABEL[o.method], price: free ? 0 : o.price, free };
  });
}

async function fetchMelhorEnvio({ from, to, pkg, insurance }) {
  let response;
  try {
    response = await fetch(`${meBase()}/api/v2/me/shipment/calculate`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Authorization: `Bearer ${meToken()}`,
        "User-Agent": `MoreiraWear (${process.env.MELHOR_ENVIO_EMAIL || "loja"})`,
      },
      body: JSON.stringify({
        from: { postal_code: from },
        to: { postal_code: to },
        package: pkg,
        options: { insurance_value: round2(insurance), receipt: false, own_hand: false },
        services: Object.keys(SERVICES).join(","),
      }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    console.warn("[Frete] Melhor Envio sem resposta:", error.message);
    throw httpError(502, "Não foi possível consultar os Correios agora. Tente de novo.");
  }
  const data = await response.json().catch(() => null);
  if (!response.ok || !Array.isArray(data)) {
    console.warn(`[Frete] Melhor Envio ${response.status}:`, JSON.stringify(data)?.slice(0, 300));
    throw httpError(502, "Não foi possível consultar os Correios agora. Tente de novo.");
  }
  const options = data
    .filter((s) => SERVICES[s.id] && !s.error && Number(s.custom_price ?? s.price) > 0)
    .map((s) => ({
      method: SERVICES[s.id],
      price: round2(Number(s.custom_price ?? s.price)),
      days: Number(s.custom_delivery_time ?? s.delivery_time) || null,
    }))
    .sort((a, b) => a.price - b.price);
  if (!options.length) throw httpError(422, "Os Correios não atendem esse CEP com PAC ou SEDEX.");
  return options;
}

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  error.expose = true;
  return error;
}

/**
 * Todas as opções de entrega com endereço para o carrinho. Sem o token do Melhor Envio,
 * cai no frete fixo das configurações para a loja continuar vendendo.
 * Devolve { options, error } — `error` explica por que não há opção dos Correios.
 */
export async function deliveryOptions({ cep, quantity, subtotal }) {
  if (correiosEnabled()) {
    try {
      return { options: await quoteCorreios({ cep, quantity, subtotal }), error: null };
    } catch (error) {
      return { options: [], error: error.message };
    }
  }
  const fee = Number(await getSetting("shippingFee")) || 0;
  const freeMin = Number(await getSetting("freeShippingMin")) || 0;
  const free = freeMin > 0 && subtotal >= freeMin;
  return { options: [{ method: "fixed", label: SHIPPING_LABEL.fixed, price: free ? 0 : fee, days: null, free }], error: null };
}
