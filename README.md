# MoreiraWear — Backend

API da loja streetwear MoreiraWear (Express + Knex). PostgreSQL em produção (Render), SQLite local.

## Rodar local
```bash
cp .env.example .env
npm install
npm run dev   # http://localhost:3001
```

## Deploy no Render
Use o Blueprint (`render.yaml`): cria o web service + PostgreSQL gratuito. Depois preencha:

| Variável | Valor |
|---|---|
| `FRONTEND_URL` | URL da Vercel (ex.: `https://moura-wear.vercel.app`) |
| `PUBLIC_API_URL` | URL deste serviço (ex.: `https://backendmourawear.onrender.com`) |
| `ADMIN_PASSWORD` | senha do admin `moreirawear@admin.com` (padrão `12345678`) |
| `MP_ACCESS_TOKEN` | opcional — habilita pagamento online pelo Mercado Pago |
| `SUMUP_API_KEY` | opcional — habilita pagamento online pela SumUp (PIX com QR Code e cartão); chave `sup_sk_...` |
| `SUMUP_MERCHANT_CODE` | opcional — código da loja na SumUp (sem ele, é lido da própria API key) |
| `PAGAMENTO_ONLINE` | opcional — `sumup` ou `mercadopago`, quando os dois estão configurados (padrão `sumup`) |
| `WHATSAPP_HOLD_HOURS` | opcional — horas de reserva dos pedidos via WhatsApp (padrão `7`) |
| `ONLINE_HOLD_MINUTES` | opcional — minutos que um pedido online espera o pagamento antes de cancelar (padrão `30`) |

O admin é criado na primeira subida. A senha pode ser trocada na aba **Usuários** do painel;
ela só é sobrescrita se o valor de `ADMIN_PASSWORD` no Render for alterado.

## Principais rotas
- `POST /api/auth/register`, `POST /api/auth/login`, `GET/PUT /api/auth/me`
- `GET /api/products`, `/api/categories`, `/api/banners`, `/api/settings` (públicas)
- `POST /api/orders`, `GET /api/orders/mine`, `GET /api/orders/:id`, `POST /api/orders/:id/cancel`
- Admin: `/api/admin/dashboard`, `/api/admin/orders`, `/api/admin/users`, `/api/admin/settings`, CRUD de produtos/categorias/banners, `POST /api/images`
- `POST /api/webhooks/mercadopago`
