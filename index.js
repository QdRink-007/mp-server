// index.js – QdRink multi-BAR + OAuth Marketplace + precio(PRODUCCION)
// - OAuth connect por dev (bar2, bar3...)
// - Usa token del vendedor para crear preferencias
// - marketplace_fee para comisión
// - IPN intenta leer payment con token correcto (fallback)
// - refresh automático con refresh_token (offline_access)

const express = require('express');
const axios = require('axios');
const bodyParser = require('body-parser');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 10000;

app.use(bodyParser.json());

// ================== CONFIG ==================

const ACCESS_TOKEN =
  process.env.MP_ACCESS_TOKEN ||
  'APP_USR-6603583526397159-042819-b68923f859e89b4ddb8e28a65eb8a76d-153083685'; // tu token (marketplace) para bar1 o fallback

const MP_CLIENT_ID = process.env.MP_CLIENT_ID || '5741144054953865';
const MP_CLIENT_SECRET = process.env.MP_CLIENT_SECRET || 'ET5bOFcRSRzgdDQU7G8qT7UydoELzA3b';
const MP_REDIRECT_URI =
  process.env.MP_REDIRECT_URI || 'https://mp-server-c1mg.onrender.com/oauth/callback';

const ROTATE_DELAY_MS = Number(process.env.ROTATE_DELAY_MS || 5000);
const WEBHOOK_URL =
  process.env.WEBHOOK_URL || 'https://mp-server-c1mg.onrender.com/ipn';

// Comisión por DEV (porcentaje + piso mínimo)
const MARKETPLACE_FEE_PERCENT_BY_DEV = {
  bar1: 0,     // bar1 cobra a tu cuenta → sin comisión
  bar2: 0.10,  // 10%
  bar3: 0.10,
};

const MARKETPLACE_FEE_MIN = 10; // piso mínimo en pesos

const ALLOWED_DEVS = ['bar1', 'bar2', 'bar3'];

const ITEM_BY_DEV = {
  bar1: { title: 'Pinta Rubia', quantity: 1, currency_id: 'ARS', unit_price: 100 },
  bar2: { title: 'Pinta Negra', quantity: 1, currency_id: 'ARS', unit_price: 110 },
  bar3: { title: 'Pinta Roja',  quantity: 1, currency_id: 'ARS', unit_price: 120 },
};

// ================== TOKENS STORE (por dev) ==================

const TOKENS_PATH = path.join(__dirname, 'tokens.json');

function loadTokens() {
  try {
    if (!fs.existsSync(TOKENS_PATH)) return {};
    return JSON.parse(fs.readFileSync(TOKENS_PATH, 'utf8'));
  } catch (e) {
    console.error('❌ No pude leer tokens.json:', e.message);
    return {};
  }
}

function saveTokens(obj) {
  try {
    fs.writeFileSync(TOKENS_PATH, JSON.stringify(obj, null, 2));
  } catch (e) {
    console.error('❌ No pude guardar tokens.json:', e.message);
  }
}

// Estructura esperada:
// tokensByDev[dev] = {
//   access_token, refresh_token, token_type, expires_in, expires_at, user_id
// }
let tokensByDev = loadTokens();

// ================== ESTADO POR DEV ==================

const stateByDev = {};
ALLOWED_DEVS.forEach((dev) => {
  stateByDev[dev] = {
    paidEvent: null,
    expectedExtRef: null,
    ultimaPreferencia: null,
    linkActual: null,
    rotateScheduled: false,
    lastPrice: ITEM_BY_DEV[dev].unit_price,
  };
});

const pagos = [];
const processedPayments = new Set();

// ================== HELPERS ==================

function buildUniqueExtRef(dev) {
  return `${dev}:${Date.now()}`;
}

function nowAR() {
  return new Date().toLocaleString('es-AR', {
    timeZone: 'America/Argentina/Buenos_Aires',
  });
}

function escapeHtml(str) {
  return String(str)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

// ================== OAUTH ==================

// Link que abre tu socio para conectar su cuenta a un dev (bar2 por ejemplo)
app.get('/connect', (req, res) => {
  const dev = String(req.query.dev || '').toLowerCase();
  if (!ALLOWED_DEVS.includes(dev)) return res.status(400).send('dev invalido');

  // scopes: read, write, offline_access (ya los marcaste en el panel)
  // Nota: MP usa un flujo standard. El endpoint de authorization es este:
  const authUrl =
    `https://auth.mercadopago.com.ar/authorization` +
    `?response_type=code` +
    `&client_id=${encodeURIComponent(MP_CLIENT_ID)}` +
    `&redirect_uri=${encodeURIComponent(MP_REDIRECT_URI)}` +
    `&state=${encodeURIComponent(dev)}`;

  res.redirect(authUrl);
});

// Callback: MP vuelve acá con ?code=...&state=bar2
app.get('/oauth/callback', async (req, res) => {
  try {
    const code = String(req.query.code || '');
    const dev = String(req.query.state || '').toLowerCase();

    if (!code) return res.status(400).send('Falta code');
    if (!ALLOWED_DEVS.includes(dev)) return res.status(400).send('State/dev invalido');

    // Intercambio code -> tokens
    const form = new URLSearchParams();
    form.append('grant_type', 'authorization_code');
    form.append('client_id', MP_CLIENT_ID);
    form.append('client_secret', MP_CLIENT_SECRET);
    form.append('code', code);
    form.append('redirect_uri', MP_REDIRECT_URI);

    const tokenRes = await axios.post('https://api.mercadopago.com/oauth/token', form, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });

    const t = tokenRes.data;
    const expiresAt = Date.now() + (Number(t.expires_in || 0) * 1000);

    tokensByDev[dev] = {
      access_token: t.access_token,
      refresh_token: t.refresh_token,
      token_type: t.token_type,
      expires_in: t.expires_in,
      expires_at: expiresAt,
      user_id: t.user_id || null,
      updated_at: Date.now(),
    };

    saveTokens(tokensByDev);

    res.send(
      `<h2>✅ Conectado OK</h2>
       <p>Dev: <b>${escapeHtml(dev)}</b></p>
       <p>Ya podés generar links para este dev usando la cuenta del vendedor.</p>
       <p>Volvé al <a href="/panel">/panel</a></p>`
    );
  } catch (err) {
    console.error('❌ Error en /oauth/callback:', err.response?.data || err.message);
    res.status(500).send('Error en OAuth callback. Mirá logs.');
  }
});

async function refreshTokenForDev(dev) {
  const current = tokensByDev[dev];
  if (!current?.refresh_token) throw new Error(`No hay refresh_token para ${dev}`);

  const form = new URLSearchParams();
  form.append('grant_type', 'refresh_token');
  form.append('client_id', MP_CLIENT_ID);
  form.append('client_secret', MP_CLIENT_SECRET);
  form.append('refresh_token', current.refresh_token);

  const tokenRes = await axios.post('https://api.mercadopago.com/oauth/token', form, {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });

  const t = tokenRes.data;
  const expiresAt = Date.now() + (Number(t.expires_in || 0) * 1000);

  tokensByDev[dev] = {
    access_token: t.access_token,
    refresh_token: t.refresh_token || current.refresh_token,
    token_type: t.token_type,
    expires_in: t.expires_in,
    expires_at: expiresAt,
    user_id: t.user_id || current.user_id || null,
    updated_at: Date.now(),
  };

  saveTokens(tokensByDev);
  return tokensByDev[dev].access_token;
}

async function getAccessTokenForDev(dev) {
  // bar1: por ahora usa tu token fijo (tu cuenta)
  if (dev === 'bar1') return ACCESS_TOKEN;

  const t = tokensByDev[dev];
  if (!t?.access_token) return null;

  // refrescar si vence pronto (margen 60s)
  const marginMs = 60_000;
  if (t.expires_at && Date.now() > (t.expires_at - marginMs)) {
    try {
      console.log(`🔁 Refresh token para ${dev}...`);
      return await refreshTokenForDev(dev);
    } catch (e) {
      console.error(`❌ No pude refrescar token para ${dev}:`, e.response?.data || e.message);
      return null;
    }
  }

  return t.access_token;
}

// ================== MP: CREAR PREFERENCIA ==================

    async function generarNuevoLinkParaDev(dev, priceOverride) {
    const baseItem = ITEM_BY_DEV[dev];
    if (!baseItem) throw new Error(`Item no definido para dev=${dev}`);

    // ✅ Clonar item para NO pisar ITEM_BY_DEV global
    const item = { ...baseItem };

    // ✅ Override de precio si viene
    if (Number.isFinite(priceOverride) && priceOverride >= 100 && priceOverride <= 65000) {
      item.unit_price = priceOverride;
    }

    const sellerToken = await getAccessTokenForDev(dev);
    if (!sellerToken) {
      throw new Error(`Dev ${dev} no está conectado por OAuth (no hay token vendedor)`);
    }

    const headers = { Authorization: `Bearer ${sellerToken}` };
    const extRef = buildUniqueExtRef(dev);

    const pct = Number(MARKETPLACE_FEE_PERCENT_BY_DEV[dev] || 0);

    // ✅ fee calculado con el precio final (override incluido)
    let fee = Math.round(item.unit_price * pct);
    if (pct > 0) fee = Math.max(MARKETPLACE_FEE_MIN, fee);

    const body = {
      items: [item],
      external_reference: extRef,
      notification_url: WEBHOOK_URL,
      ...(fee > 0 ? { marketplace_fee: fee } : {}),
    };

    const res = await axios.post(
      'https://api.mercadopago.com/checkout/preferences',
      body,
      { headers },
    );

    const pref = res.data;
    const prefId = pref.id || pref.preference_id;

    stateByDev[dev].ultimaPreferencia = prefId;
    stateByDev[dev].linkActual = pref.init_point;
    stateByDev[dev].expectedExtRef = extRef;

    // ✅ guardar precio vigente por dev (útil para panel/log)
    stateByDev[dev].lastPrice = item.unit_price;

    console.log(`🔄 Nuevo link generado para ${dev}:`, {
      preference_id: prefId,
      external_reference: extRef,
      link: pref.init_point,
      price: item.unit_price,
      marketplace_fee: fee,
    });

    return { preference_id: prefId, external_reference: extRef, link: pref.init_point, price: item.unit_price };
  }


function recargarLinkConReintento(dev, intento = 1) {
  const MAX_INTENTOS = 5;
  const esperaMs = 2000 * intento;

  generarNuevoLinkParaDev(dev, stateByDev[dev]?.lastPrice).catch((err) => {
    console.error(
      `❌ Error al regenerar link para ${dev} (intento ${intento}):`,
      err.response?.data || err.message,
    );

    if (intento < MAX_INTENTOS) {
      console.log(`⏳ Reintentando generar link para ${dev} en ${esperaMs} ms...`);
      setTimeout(() => recargarLinkConReintento(dev, intento + 1), esperaMs);
    } else {
      console.log(`⚠️ Se agotaron reintentos para ${dev}. Se mantiene último link.`);
    }
  });
}

// ================== RUTAS PRINCIPALES ==================

app.get('/', (req, res) => {
  res.send('Servidor QdRink mp-server OK');
});

app.get('/nuevo-link', async (req, res) => {
  try {
    const dev = (req.query.dev || '').toLowerCase();
    if (!ALLOWED_DEVS.includes(dev)) {
      return res.status(400).json({ error: 'dev invalido' });
    }

    // leer price del query (viene desde el ESP)
    let price = Number(req.query.price);
    if (!Number.isFinite(price) || price < 100 || price > 65000) price = undefined;

    const info = await generarNuevoLinkParaDev(dev, price);

    res.json({
      dev,
      link: info.link,
      title: ITEM_BY_DEV[dev].title,
      price: info.price, // precio real usado
      external_reference: info.external_reference,
    });
  } catch (error) {
    console.error('❌ Error en /nuevo-link:', error.response?.data || error.message);
    res.status(500).json({ error: String(error.message || 'no se pudo generar link') });
  }
});

app.get('/estado', (req, res) => {
  const dev = (req.query.dev || '').toLowerCase();
  if (!ALLOWED_DEVS.includes(dev)) {
    return res.status(400).json({ error: 'dev invalido' });
  }

  const st = stateByDev[dev];
  res.json({ dev, paidEvent: st.paidEvent });
});

app.get('/ack', (req, res) => {
  const dev = (req.query.dev || '').toLowerCase();
  const payment_id = String(req.query.payment_id || '');

  if (!ALLOWED_DEVS.includes(dev)) return res.status(400).json({ error: 'dev invalido' });
  if (!payment_id) return res.status(400).json({ error: 'payment_id requerido' });

  const st = stateByDev[dev];
  if (st.paidEvent && String(st.paidEvent.payment_id) === payment_id) {
    st.paidEvent = null;
    return res.json({ ok: true });
  }
  res.json({ ok: false });
});

app.get('/panel', (req, res) => {
  let html = `
  <html><head><meta charset="utf-8" />
  <title>Panel QdRink</title>
  <style>
    body { font-family: sans-serif; background:#111; color:#eee; padding: 10px; }
    a { color: #9ad; }
    table { border-collapse: collapse; width: 100%; margin-top: 10px; }
    th, td { border: 1px solid #444; padding: 6px 8px; font-size: 13px; }
    th { background: #222; }
    tr:nth-child(even) { background:#1b1b1b; }
    .muted { color:#aaa; font-size: 12px; }
    .box { background:#181818; border:1px solid #333; padding:10px; border-radius: 6px; }
  </style>
  </head><body>
    <h1>Panel QdRink</h1>

    <div class="box">
      <div class="muted">Conectar vendedor (tu socio) por dev:</div>
      <ul>
        <li><a href="/connect?dev=bar2">/connect?dev=bar2</a> (bar2)</li>
        <li><a href="/connect?dev=bar3">/connect?dev=bar3</a> (bar3)</li>
      </ul>
      <div class="muted">Tokens guardados (resumen):</div>
      <pre class="muted">${escapeHtml(JSON.stringify(Object.fromEntries(
        Object.entries(tokensByDev).map(([k,v]) => [k, { user_id: v.user_id, updated_at: v.updated_at, expires_at: v.expires_at }])
      ), null, 2))}</pre>
    </div>

    <div class="muted">Estado actual por dev:</div>
    <pre class="muted">${escapeHtml(JSON.stringify(stateByDev, null, 2))}</pre>

    <table>
      <tr>
        <th>Fecha/Hora</th><th>Dev</th><th>Producto</th><th>Monto</th>
        <th>Email</th><th>Estado</th><th>Medio</th><th>payment_id</th><th>pref_id</th><th>ext_ref</th>
      </tr>
  `;

  pagos.slice().reverse().forEach((p) => {
    html += `
      <tr>
        <td>${escapeHtml(p.fechaHora)}</td>
        <td>${escapeHtml(p.dev)}</td>
        <td>${escapeHtml(p.title)}</td>
        <td>${escapeHtml(p.monto)}</td>
        <td>${escapeHtml(p.email)}</td>
        <td>${escapeHtml(p.estado)}</td>
        <td>${escapeHtml(p.metodo)}</td>
        <td>${escapeHtml(p.payment_id)}</td>
        <td>${escapeHtml(p.preference_id || '')}</td>
        <td>${escapeHtml(p.external_reference || '')}</td>
      </tr>
    `;
  });

  html += `</table></body></html>`;
  res.send(html);
});

// ================== IPN / WEBHOOK ==================

async function fetchPaymentWithToken(paymentId, token) {
  const headers = { Authorization: `Bearer ${token}` };
  const url = `https://api.mercadopago.com/v1/payments/${paymentId}`;
  return axios.get(url, { headers });
}

app.post('/ipn', async (req, res) => {
  try {
    console.log('📥 IPN recibida:', { query: req.query, body: req.body });

    const topic = req.query.topic || req.query.type || req.body.topic || req.body.type;
    if (topic && topic !== 'payment') {
      console.log('ℹ️ IPN no-payment, se ignora:', topic);
      return res.sendStatus(200);
    }

    const paymentId =
      req.query['data.id'] ||
      req.body['data.id'] ||
      req.body?.data?.id ||
      req.query.id ||
      req.body.id;

    if (!paymentId) {
      console.log('⚠️ IPN sin payment_id.');
      return res.sendStatus(200);
    }

    if (processedPayments.has(String(paymentId))) {
      console.log('ℹ️ Pago ya procesado, ignoro:', paymentId);
      return res.sendStatus(200);
    }

    // 1) intentar con tu token
    let mpRes;
    try {
      mpRes = await fetchPaymentWithToken(paymentId, ACCESS_TOKEN);
    } catch (e) {
      // 2) fallback: intentar con tokens de vendedores guardados
      console.log('ℹ️ No pude leer pago con token marketplace, pruebo tokens vendedores...');
      const devs = Object.keys(tokensByDev);
      let lastErr = e;

      for (const dev of devs) {
        const tok = await getAccessTokenForDev(dev);
        if (!tok) continue;
        try {
          mpRes = await fetchPaymentWithToken(paymentId, tok);
          console.log(`✅ Leí el pago con token del dev=${dev}`);
          lastErr = null;
          break;
        } catch (ee) {
          lastErr = ee;
        }
      }

      if (!mpRes) {
        console.error('❌ No pude leer el pago con ningún token:', lastErr.response?.data || lastErr.message);
        return res.sendStatus(200);
      }
    }

    const data = mpRes.data;

    const estado = data.status;
    const status_detail = data.status_detail || null;
    const email = data.payer?.email || 'sin email';
    const monto = data.transaction_amount;
    const metodo = data.payment_method_id;
    const descripcion = data.description;
    const externalRef = data.external_reference || null;
    const preference_id = data.preference_id || null;

    console.log('📩 Pago recibido:', { estado, status_detail, email, monto, metodo, externalRef });

    const dev = (externalRef ? String(externalRef).split(':')[0] : '').toLowerCase();
    const devValido = ALLOWED_DEVS.includes(dev);

    if (estado !== 'approved') {
      console.log(`⚠️ Pago NO aprobado (${estado}). detalle:`, status_detail);
      processedPayments.add(String(paymentId));
      return res.sendStatus(200);
    }

    if (devValido && externalRef && externalRef === stateByDev[dev].expectedExtRef
    && preference_id === stateByDev[dev].ultimaPreferencia) {
      const st = stateByDev[dev];

      st.paidEvent = {
        payment_id: String(paymentId),
        at: Date.now(),
        monto,
        metodo,
        email,
        extRef: externalRef,
      };

      processedPayments.add(String(paymentId));

      const fechaHora = nowAR();
      console.log(`✅ Pago confirmado y válido para ${dev} (guardado hasta ACK)`);

      const registro = {
        fechaHora,
        dev,
        email,
        estado,
        monto,
        metodo,
        descripcion,
        payment_id: String(paymentId),
        preference_id,
        external_reference: externalRef,
        title: ITEM_BY_DEV[dev].title,
      };
      pagos.push(registro);

      const logMsg =
       `🕒 ${fechaHora} | Dev: ${dev}` +
       ` | Producto: ${ITEM_BY_DEV[dev].title}` +
       ` | Monto: ${monto}` +
       ` | Pago de: ${email}` +
       ` | Estado: ${estado}` +
       ` | extRef: ${externalRef}` +
       ` | pref: ${preference_id}` +
       ` | id: ${paymentId}` +
       ` | price: ${stateByDev[dev].lastPrice || ITEM_BY_DEV[dev].unit_price}\n`;
      fs.appendFileSync('pagos.log', logMsg);

      if (!st.rotateScheduled) {
        st.rotateScheduled = true;
        setTimeout(() => {
          recargarLinkConReintento(dev);
          st.rotateScheduled = false;
        }, ROTATE_DELAY_MS);
      }
    } else {
      console.log('⚠️ Pago aprobado pero NO corresponde al QR vigente (o dev inválido). Ignorado.');
      processedPayments.add(String(paymentId));
    }

    res.sendStatus(200);
  } catch (error) {
    console.error('❌ Error en /ipn:', error.response?.data || error.message);
    res.sendStatus(200);
  }
});

// ================== ARRANQUE ==================

app.listen(PORT, () => {
  console.log(`Servidor activo en http://localhost:${PORT}`);
  console.log('Generando links iniciales por dev...');

  ALLOWED_DEVS.forEach((dev) => {
    // Para devs OAuth (bar2/bar3) si todavía no están conectados, va a fallar
    recargarLinkConReintento(dev);
  });
});
