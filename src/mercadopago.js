// Access token do Mercado Pago. MP_ACCESS_TOKEN é o nome oficial; os outros nomes são
// aceitos para o caso de a variável ter sido cadastrada com outro nome no Render.
export const mpToken = () =>
  String(
    process.env.MP_ACCESS_TOKEN ||
      process.env.MERCADOPAGO_ACCESS_TOKEN ||
      process.env.MERCADO_PAGO_ACCESS_TOKEN ||
      process.env.ACCESS_TOKEN ||
      "",
  ).trim();

export const mpEnabled = () => Boolean(mpToken());
