// index.js – QdRink multi-BAR + OAuth Marketplace (PRODUCCION)
// - OAuth connect por dev (bar4, bar5)
// - Usa token del vendedor para crear preferencias 
// - marketplace_fee para comisión
// - IPN intenta leer payment con token correcto (fallback)
// - refresh automático con refresh_token (offline_access)
// - ✅ Persistencia en Render Disk (/var/data): tokens + state + pagos.log
// - ✅ /nuevo-link idempotente (no regenera si hay QR vigente)
// - ✅ IPN valida por externalRef O preference_id

const express = require('express');
const axios = require('axios');
const bodyParser = require('body-parser');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 10000;

app.use(bodyParser.json());

// ================== CONFIG ==================

const ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN;
const MP_CLIENT_ID = process.env.MP_CLIENT_ID;
const MP_CLIENT_SECRET = process.env.MP_CLIENT_SECRET;
const MP_REDIRECT_URI = process.env.MP_REDIRECT_URI;

const ROTATE_DELAY_MS = Number(process.env.ROTATE_DELAY_MS || 5000);
const WEBHOOK_URL = process.env.WEBHOOK_URL;
const ADMIN_KEY = process.env.ADMIN_KEY;

const REQUIRED_ENVS = [
  'MP_ACCESS_TOKEN',
  'MP_CLIENT_ID',
  'MP_CLIENT_SECRET',
  'MP_REDIRECT_URI',
  'WEBHOOK_URL',
  'ADMIN_KEY',
];

for (const name of REQUIRED_ENVS) {
  if (!process.env[name]) {
    console.error(`❌ Falta variable de entorno obligatoria: ${name}`);
    process.exit(1);
  }
}

// ✅ Render Disk mount
const DATA_DIR = process.env.DATA_DIR || '/var/data';
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

console.log('📦 DATA_DIR:', DATA_DIR);

// Comisión por DEV (porcentaje + piso mínimo)
const MARKETPLACE_FEE_PERCENT_BY_DEV = {
  bar1: 0,     // bar1 cobra a tu cuenta → sin comisión
  bar2: 0,     // bar2 cobra a tu cuenta (directo) → sin comisión
  bar3: 0,     // bar3 cobra a tu cuenta (directo) → sin comisión
  bar4: 0.03,  // ✅ bar4: 3% para vos (marketplace_fee)
  bar5: 0.03,
};

const MARKETPLACE_FEE_MIN = 10; // piso mínimo en pesos

// ✅ Agregamos bar4
const ALLOWED_DEVS = ['bar1', 'bar2', 'bar3', 'bar4', 'bar5'];

const ITEM_BY_DEV = {
  bar1: { title: 'Quilmes', quantity: 1, currency_id: 'ARS', unit_price: 100 },
  bar2: { title: 'Quilmes', quantity: 1, currency_id: 'ARS', unit_price: 110 },
  bar3: { title: 'Stella Artois', quantity: 1, currency_id: 'ARS', unit_price: 120 },
  // ✅ Default para bar4 (después lo pisás con ?price=)
  bar4: { title: 'Qtiket', quantity: 1, currency_id: 'ARS', unit_price: 4500 },
  bar5: { title: 'Qtiket', quantity: 1, currency_id: 'ARS', unit_price: 4500 },
};

// ================== middleware ==================

function requireAdmin(req, res, next) {
  const provided =
    req.query.key ||
    req.headers['x-admin-key'] ||
    req.body?.admin_key;

  if (!ADMIN_KEY) {
    return res.status(500).send('ADMIN_KEY no configurada');
  }

  if (provided !== ADMIN_KEY) {
    return res.status(401).send('No autorizado');
  }

  next();
}

// ================== TOKENS / STATE / DEVICES STORE ==================

const TOKENS_PATH = path.join(DATA_DIR, 'tokens.json');
const STATE_PATH = path.join(DATA_DIR, 'stateByDev.json');
const PAYLOG_PATH = path.join(DATA_DIR, 'pagos.log');
const DEVICES_PATH = path.join(DATA_DIR, 'devices.json');

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

function loadState() {
  try {
    if (!fs.existsSync(STATE_PATH)) return {};
    return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  } catch (e) {
    console.error('❌ No pude leer stateByDev.json:', e.message);
    return {};
  }
}

function saveState(obj) {
  try {
    fs.writeFileSync(STATE_PATH, JSON.stringify(obj, null, 2));
  } catch (e) {
    console.error('❌ No pude guardar stateByDev.json:', e.message);
  }
}

function loadDevices() {
  const seed = {
    devices: {
      bar1: {
        client_id: 'mariano',
        title: 'Quilmes',
        quantity: 1,
        currency_id: 'ARS',
        unit_price: 3000,
        fee_pct: 0,
        token_mode: 'main_account',
        enabled: true,
        kind: 'beer_tap'
      },
      bar4: {
        client_id: 'socio1',
        title: 'Qtiket',
        quantity: 1,
        currency_id: 'ARS',
        unit_price: 4500,
        fee_pct: 0.03,
        token_mode: 'oauth_seller',
        enabled: true,
        kind: 'ticket'
      }
    }
  };

  try {
    if (!fs.existsSync(DEVICES_PATH)) {
      fs.writeFileSync(DEVICES_PATH, JSON.stringify(seed, null, 2));
      return seed;
    }

    const raw = fs.readFileSync(DEVICES_PATH, 'utf8');
    const parsed = JSON.parse(raw);

    if (!parsed || typeof parsed !== 'object') {
      throw new Error('devices.json inválido');
    }

    if (!parsed.devices || typeof parsed.devices !== 'object') {
      parsed.devices = {};
    }

    if (Object.keys(parsed.devices).length === 0) {
      fs.writeFileSync(DEVICES_PATH, JSON.stringify(seed, null, 2));
      return seed;
    }

    return parsed;
  } catch (e) {
    console.error('❌ Error cargando devices.json:', e.message);
    return seed;
  }
}

function saveDevices(devicesData) {
  try {
    fs.writeFileSync(DEVICES_PATH, JSON.stringify(devicesData, null, 2));
  } catch (e) {
    console.error('❌ No pude guardar devices.json:', e.message);
  }
}

// tokensByDev[dev] = { access_token, refresh_token, expires_at, user_id, ... }
let tokensByDev = loadTokens();
let devicesData = loadDevices();

console.log('🔑 tokens.json existe?', fs.existsSync(TOKENS_PATH));
console.log('🔑 tokens cargados:', Object.keys(tokensByDev));
console.log('🧩 devices.json existe?', fs.existsSync(DEVICES_PATH));
console.log('🧩 devices cargados:', Object.keys(devicesData.devices || {}));

function getDevices() {
  return devicesData.devices || {};
}

function getDevice(dev) {
  const devices = getDevices();
  return devices[String(dev || '').toLowerCase()] || null;
}

function isDeviceEnabled(dev) {
  const d = getDevice(dev);
  return !!(d && d.enabled === true);
}

function getAllowedDevs() {
  return Object.entries(getDevices())
    .filter(([, cfg]) => cfg && cfg.enabled === true)
    .map(([dev]) => dev);
}

function getDeviceItem(dev) {
  const d = getDevice(dev);
  if (!d) return null;

  return {
    title: String(d.title || 'Producto'),
    quantity: Number(d.quantity || 1),
    currency_id: String(d.currency_id || 'ARS'),
    unit_price: Number(d.unit_price || 100),
  };
}

function saveState(obj) {
  try {
    fs.writeFileSync(STATE_PATH, JSON.stringify(obj, null, 2));
  } catch (e) {
    console.error('❌ No pude guardar stateByDev.json:', e.message);
  }
}

// ================== ESTADO POR DEV ==================

const stateByDev = loadState();

// asegurar defaults por cada dev habilitado en devices.json
getAllowedDevs().forEach((dev) => {
  const cfg = getDevice(dev) || {};

  if (!stateByDev[dev]) stateByDev[dev] = {};
  stateByDev[dev] = {
    paidEvent: stateByDev[dev].paidEvent ?? null,
    expectedExtRef: stateByDev[dev].expectedExtRef ?? null,
    ultimaPreferencia: stateByDev[dev].ultimaPreferencia ?? null,
    linkActual: stateByDev[dev].linkActual ?? null,
    rotateScheduled: false,
    lastPrice: Number(stateByDev[dev].lastPrice ?? cfg.unit_price ?? 100),
    lastTitle: String(stateByDev[dev].lastTitle ?? cfg.title ?? 'Producto'),
  };
});

console.log('📦 stateByDev cargado:', Object.keys(stateByDev));
console.log('🧩 devices habilitados:', getAllowedDevs());

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

app.get('/connect', (req, res) => {
  const dev = String(req.query.dev || '').toLowerCase();
  if (!isDeviceEnabled(dev)) return res.status(400).send('dev invalido');

  const authUrl =
    `https://auth.mercadopago.com.ar/authorization` +
    `?response_type=code` +
    `&client_id=${encodeURIComponent(MP_CLIENT_ID)}` +
    `&redirect_uri=${encodeURIComponent(MP_REDIRECT_URI)}` +
    `&state=${encodeURIComponent(dev)}`;

  res.redirect(authUrl);
});

app.get('/oauth/callback', async (req, res) => {
  try {
    const code = String(req.query.code || '');
    const dev = String(req.query.state || '').toLowerCase();

    if (!code) return res.status(400).send('Falta code');
    if (!isDeviceEnabled(dev)) return res.status(400).send('State/dev invalido');

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
  const cfg = getDevice(dev);
  if (!cfg) return null;

  if (cfg.token_mode === 'main_account') {
    return ACCESS_TOKEN;
  }

  if (cfg.token_mode !== 'oauth_seller') {
    console.error(`❌ token_mode inválido para ${dev}:`, cfg.token_mode);
    return null;
  }

  const t = tokensByDev[dev];
  if (!t?.access_token) return null;

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

async function generarNuevoLinkParaDev(dev, priceOverride, titleOverride) {
  const cfg = getDevice(dev);
  if (!cfg) throw new Error(`Device no definido para dev=${dev}`);

  const baseItem = getDeviceItem(dev);
  if (!baseItem) throw new Error(`Item no definido para dev=${dev}`);

  const item = { ...baseItem };

  if (typeof titleOverride === 'string') {
    const t = titleOverride.trim();
    if (t.length >= 2 && t.length <= 60) item.title = t;
  }

  if (Number.isFinite(priceOverride) && priceOverride >= 100 && priceOverride <= 65000) {
    item.unit_price = priceOverride;
  }

  const sellerToken = await getAccessTokenForDev(dev);
  if (!sellerToken) {
    throw new Error(`Dev ${dev} no tiene token disponible para cobrar`);
  }

  const headers = { Authorization: `Bearer ${sellerToken}` };
  const extRef = buildUniqueExtRef(dev);

  const pct = Number(cfg.fee_pct || 0);

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
    { headers }
  );

  const pref = res.data;
  const prefId = pref.id || pref.preference_id;

  if (!stateByDev[dev]) stateByDev[dev] = {};

  stateByDev[dev].ultimaPreferencia = prefId;
  stateByDev[dev].linkActual = pref.init_point;
  stateByDev[dev].expectedExtRef = extRef;
  stateByDev[dev].lastPrice = item.unit_price;
  stateByDev[dev].lastTitle = item.title;

  saveState(stateByDev);

  console.log(`🔄 Nuevo link generado para ${dev}:`, {
    preference_id: prefId,
    external_reference: extRef,
    link: pref.init_point,
    price: item.unit_price,
    marketplace_fee: fee,
  });

  return {
    preference_id: prefId,
    external_reference: extRef,
    link: pref.init_point,
    price: item.unit_price
  };
}

function recargarLinkConReintento(dev, intento = 1) {
  const MAX_INTENTOS = 5;
  const esperaMs = 2000 * intento;

  generarNuevoLinkParaDev(
    dev,
    stateByDev[dev]?.lastPrice,
    stateByDev[dev]?.lastTitle || getDevice(dev)?.title || 'Producto'
  ).catch((err) => {
    console.error(
      `❌ Error al regenerar link para ${dev} (intento ${intento}):`,
      err.response?.data || err.message
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
    if (!isDeviceEnabled(dev)) {
      return res.status(400).json({ error: 'dev invalido' });
    }

    const force = String(req.query.force || '') === '1';
    const st = stateByDev[dev];

    let titleReq = req.query.title;
    if (typeof titleReq === 'string') {
      titleReq = titleReq.trim();
      if (titleReq.length < 2 || titleReq.length > 60) titleReq = null;
    } else {
      titleReq = null;
    }

    // si no mandan title por query, usa el último guardado
    const finalTitle = titleReq ?? String(st?.lastTitle ?? getDevice(dev)?.title ?? 'Producto');
    const titleChanged = (finalTitle && String(st?.lastTitle) !== String(finalTitle));

    let priceReq = Number(req.query.price);
    if (!Number.isFinite(priceReq) || priceReq < 100 || priceReq > 65000) priceReq = null;

    const priceChanged = (priceReq !== null && Number(st?.lastPrice) !== Number(priceReq));

    if (!force && st?.linkActual && st?.expectedExtRef && st?.ultimaPreferencia && !priceChanged && !titleChanged) {
      return res.json({
        dev,
        link: st.linkActual,
        title: st.lastTitle || getDevice(dev)?.title || 'Producto',
        price: st.lastPrice,
        external_reference: st.expectedExtRef,
        preference_id: st.ultimaPreferencia,
        reused: true,
      });
    }

    let price = Number(req.query.price);
    if (!Number.isFinite(price) || price < 100 || price > 65000) price = undefined;

    const info = await generarNuevoLinkParaDev(dev, price, finalTitle);

    res.json({
      dev,
      link: info.link,
      title: stateByDev[dev].lastTitle || getDevice(dev)?.title || 'Producto',
      price: info.price,
      external_reference: info.external_reference,
      preference_id: info.preference_id,
      reused: false,
    });
  } catch (error) {
    console.error('❌ Error en /nuevo-link:', error.response?.data || error.message);
    res.status(500).json({ error: String(error.message || 'no se pudo generar link') });
  }
});

app.get('/estado', (req, res) => {
  const dev = (req.query.dev || '').toLowerCase();
  if (!isDeviceEnabled(dev)) {
    return res.status(400).json({ error: 'dev invalido' });
  }

  const st = stateByDev[dev];
  res.json({ dev, paidEvent: st.paidEvent });
});

app.get('/ack', (req, res) => {
  const dev = (req.query.dev || '').toLowerCase();
  const payment_id = String(req.query.payment_id || '');

  if (!isDeviceEnabled(dev)) return res.status(400).json({ error: 'dev invalido' });
  if (!payment_id) return res.status(400).json({ error: 'payment_id requerido' });

  const st = stateByDev[dev];
  if (st.paidEvent && String(st.paidEvent.payment_id) === payment_id) {
    st.paidEvent = null;
    saveState(stateByDev);
    return res.json({ ok: true });
  }
  res.json({ ok: false });
});

app.post('/set-item', requireAdmin, (req, res) => {
  try {
    const dev = String(req.body.dev || '').toLowerCase();
    if (!isDeviceEnabled(dev)) {
      return res.status(400).json({ error: 'dev invalido' });
    }

    let price = Number(req.body.price);
    if (!Number.isFinite(price) || price < 100 || price > 65000) {
      return res.status(400).json({ error: 'price invalido' });
    }

    let title = String(req.body.title || '').trim();
    if (title.length < 2 || title.length > 60) {
      return res.status(400).json({ error: 'title invalido (2..60)' });
    }

    stateByDev[dev].lastPrice = price;
    stateByDev[dev].lastTitle = title;
    stateByDev[dev].paidEvent = null;

    saveState(stateByDev);

    recargarLinkConReintento(dev);

    res.json({ ok: true, dev, price, title });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/panel', requireAdmin, (req, res) => {
  const st4 = stateByDev.bar4 || {};
  const st5 = stateByDev.bar5 || {};

  let html = `
  <html>
  <head>
    <meta charset="utf-8" />
    <title>Panel QdRink</title>
    <style>
      body { font-family: sans-serif; background:#111; color:#eee; padding: 10px; }
      a { color: #9ad; }
      table { border-collapse: collapse; width: 100%; margin-top: 10px; }
      th, td { border: 1px solid #444; padding: 6px 8px; font-size: 13px; }
      th { background: #222; }
      tr:nth-child(even) { background:#1b1b1b; }
      .muted { color:#aaa; font-size: 12px; }
      .box { background:#181818; border:1px solid #333; padding:10px; border-radius: 6px; margin-top:10px; }
      input { padding:6px; border-radius:4px; border:1px solid #555; background:#222; color:#eee; }
      button { padding:8px 12px; border:none; border-radius:4px; background:#2d6cdf; color:white; cursor:pointer; }
      button:hover { opacity:0.9; }
    </style>
  </head>
  <body>
    <h1>Panel QdRink</h1>

    <div class="box">
      <h3>Config Qtiket (bar4)</h3>
      <form method="post" action="/set-item" onsubmit="return sendForm(event)">
        <input type="hidden" name="dev" value="bar4" />

        <div style="margin:6px 0;">
          <label>Título:</label><br/>
          <input name="title" style="width:320px;" value="${escapeHtml(st4.lastTitle || getDevice('bar4')?.title || 'Producto')}" />
        </div>

        <div style="margin:6px 0;">
          <label>Precio:</label><br/>
          <input name="price" style="width:120px;" value="${escapeHtml(String(st4.lastPrice || getDevice('bar4')?.unit_price || 100))}" />
        </div>

        <button type="submit">Guardar y regenerar QR</button>
        <div class="muted" id="resp" style="margin-top:6px;"></div>
      </form>
    </div>

    <div class="box">
      <h3>Config Qtiket (bar5)</h3>
      <form method="post" action="/set-item" onsubmit="return sendForm(event)">
        <input type="hidden" name="dev" value="bar5" />

        <div style="margin:6px 0;">
          <label>Título:</label><br/>
          <input name="title" style="width:320px;" value="${escapeHtml(st5.lastTitle || getDevice('bar5')?.title || 'Producto')}" />
        </div>

        <div style="margin:6px 0;">
          <label>Precio:</label><br/>
          <input name="price" style="width:120px;" value="${escapeHtml(String(st5.lastPrice || getDevice('bar5')?.unit_price || 100))}" />
        </div>

        <button type="submit">Guardar y regenerar QR</button>
        <div class="muted" id="resp5" style="margin-top:6px;"></div>
      </form>
    </div>

    <div class="box">
      <div class="muted">Conectar vendedor (tu socio) por dev:</div>
      <ul>
        <li><a href="/connect?dev=bar2">/connect?dev=bar2</a> (bar2)</li>
        <li><a href="/connect?dev=bar3">/connect?dev=bar3</a> (bar3)</li>
        <li><a href="/connect?dev=bar4">/connect?dev=bar4</a> (bar4 ✅ OAuth + 3%)</li>
        <li><a href="/connect?dev=bar5">/connect?dev=bar5</a> (bar5 ✅ OAuth + 3%)</li>
      </ul>
    </div>

    <table>
      <tr>
        <th>Fecha/Hora</th>
        <th>Dev</th>
        <th>Producto</th>
        <th>Monto</th>
        <th>Email</th>
        <th>Estado</th>
        <th>Medio</th>
        <th>payment_id</th>
        <th>pref_id</th>
        <th>ext_ref</th>
      </tr>
  `;

  pagos.slice().reverse().forEach((p) => {
    html += `
      <tr>
        <td>${escapeHtml(String(p.fechaHora || ''))}</td>
        <td>${escapeHtml(String(p.dev || ''))}</td>
        <td>${escapeHtml(String(p.title || ''))}</td>
        <td>${escapeHtml(String(p.monto || ''))}</td>
        <td>${escapeHtml(String(p.email || ''))}</td>
        <td>${escapeHtml(String(p.estado || ''))}</td>
        <td>${escapeHtml(String(p.metodo || ''))}</td>
        <td>${escapeHtml(String(p.payment_id || ''))}</td>
        <td>${escapeHtml(String(p.preference_id || ''))}</td>
        <td>${escapeHtml(String(p.external_reference || ''))}</td>
      </tr>
    `;
  });

  html += `
    </table>

    <script>
      const ADMIN_KEY = new URLSearchParams(location.search).get('key') || '';

      async function sendForm(ev) {
        ev.preventDefault();

        const fd = new FormData(ev.target);
        const dev = fd.get('dev');

        const body = {
          dev,
          title: fd.get('title'),
          price: Number(fd.get('price'))
        };

        const r = await fetch('/set-item', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-admin-key': ADMIN_KEY
          },
          body: JSON.stringify(body)
        });

        const j = await r.json();

        const outId = (dev === 'bar5') ? 'resp5' : 'resp';
        document.getElementById(outId).textContent = JSON.stringify(j);

        return false;
      }
    </script>
  </body>
  </html>
  `;

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

    console.log('📩 Pago recibido:', { estado, status_detail, email, monto, metodo, externalRef, preference_id });

    const dev = (externalRef ? String(externalRef).split(':')[0] : '').toLowerCase();
    const devValido = isDeviceEnabled(dev);

    if (estado !== 'approved') {
      console.log(`⚠️ Pago NO aprobado (${estado}). detalle:`, status_detail);
      processedPayments.add(String(paymentId));
      return res.sendStatus(200);
    }

    const st = devValido ? stateByDev[dev] : null;
    const okExt = !!(st && externalRef && externalRef === st.expectedExtRef);
    const okPref = !!(st && preference_id && preference_id === st.ultimaPreferencia);

    if (devValido && (okExt || okPref)) {
    const fechaHora = nowAR();

    st.paidEvent = {
      payment_id: String(paymentId),
      at: Date.now(),
      fechaHora, // ✅ para imprimir en el ticket sin RTC
      monto,
      metodo,
      email,
      extRef: externalRef,
      title: stateByDev[dev].lastTitle || getDevice(dev)?.title || 'Producto',
      price: stateByDev[dev].lastPrice || getDevice(dev)?.unit_price || 100
    };

    saveState(stateByDev);
    processedPayments.add(String(paymentId));

    console.log(`✅ Pago confirmado y válido para ${dev} (guardado hasta ACK)`);

    // y acá seguís igual con el registro para la tabla:
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
      title: stateByDev[dev].lastTitle || getDevice(dev)?.title || 'Producto',
    };
    pagos.push(registro);

      const logMsg =
       `🕒 ${fechaHora} | Dev: ${dev}` +
       ` | Producto: ${(stateByDev[dev].lastTitle || getDevice(dev)?.title || 'Producto')}` +
       ` | Monto: ${monto}` +
       ` | Pago de: ${email}` +
       ` | Estado: ${estado}` +
       ` | extRef: ${externalRef}` +
       ` | pref: ${preference_id}` +
       ` | id: ${paymentId}` +
       ` | price: ${stateByDev[dev].lastPrice || getDevice(dev)?.unit_price || 100}\n`;

      fs.appendFileSync(PAYLOG_PATH, logMsg);

      if (!st.rotateScheduled) {
        st.rotateScheduled = true;
        setTimeout(() => {
          recargarLinkConReintento(dev);
          st.rotateScheduled = false;
        }, ROTATE_DELAY_MS);
      }
    } else {
      console.log('⚠️ Pago aprobado pero NO corresponde al QR vigente (o dev inválido). Ignorado.');
      console.log('🧪 DEBUG mismatch:', {
        dev,
        externalRef,
        expectedExtRef: stateByDev[dev]?.expectedExtRef,
        preference_id,
        ultimaPreferencia: stateByDev[dev]?.ultimaPreferencia,
      });

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

  getAllowedDevs().forEach((dev) => {
    const cfg = getDevice(dev);

    if (!cfg) return;

    if (cfg.token_mode === 'main_account') {
      recargarLinkConReintento(dev);
      return;
    }

    if (cfg.token_mode === 'oauth_seller') {
      if (!tokensByDev[dev]?.access_token) {
        console.log(`ℹ️ ${dev} sin OAuth: no genero link inicial.`);
        return;
      }
      recargarLinkConReintento(dev);
      return;
    }

    console.log(`⚠️ ${dev} con token_mode inválido: ${cfg.token_mode}`);
  });
});
