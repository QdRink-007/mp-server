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

const MARKETPLACE_FEE_MIN = 100; // piso mínimo en pesos

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
const CLIENTS_PATH = path.join(DATA_DIR, 'clients.json');

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

function pruneStateByDevices(stateObj) {
  const allowed = new Set(getAllowedDevs());
  const cleaned = {};

  for (const [dev, value] of Object.entries(stateObj || {})) {
    if (allowed.has(dev)) cleaned[dev] = value;
  }

  return cleaned;
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
let clientsData = loadClients();

console.log('🔑 tokens.json existe?', fs.existsSync(TOKENS_PATH));
console.log('🔑 tokens cargados:', Object.keys(tokensByDev));
console.log('🧩 devices.json existe?', fs.existsSync(DEVICES_PATH));
console.log('🧩 devices cargados:', Object.keys(devicesData.devices || {}));
console.log('👤 clients.json existe?', fs.existsSync(CLIENTS_PATH));
console.log('👤 clients cargados:', Object.keys(clientsData.clients || {}));

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

function loadClients() {
  const seed = {
    clients: {
      mariano: {
        display_name: 'Mariano',
        plan_type: 'direct',
        default_fee_pct: 0,
        subscription_status: 'active',
        subscription_until: null,
        active: true
      },
      cliente01: {
        display_name: 'Cliente 01',
        plan_type: 'subscription',
        default_fee_pct: 0.03,
        subscription_status: 'active',
        subscription_until: null,
        active: true
      }
    }
  };

  try {
    if (!fs.existsSync(CLIENTS_PATH)) {
      fs.writeFileSync(CLIENTS_PATH, JSON.stringify(seed, null, 2));
      return seed;
    }

    const raw = fs.readFileSync(CLIENTS_PATH, 'utf8');
    const parsed = JSON.parse(raw);

    if (!parsed || typeof parsed !== 'object') {
      throw new Error('clients.json inválido');
    }

    if (!parsed.clients || typeof parsed.clients !== 'object') {
      parsed.clients = {};
    }

    if (Object.keys(parsed.clients).length === 0) {
      fs.writeFileSync(CLIENTS_PATH, JSON.stringify(seed, null, 2));
      return seed;
    }

    return parsed;
  } catch (e) {
    console.error('❌ Error cargando clients.json:', e.message);
    return seed;
  }
}

function getClients() {
  return clientsData.clients || {};
}

function getClient(clientId) {
  const clients = getClients();
  return clients[String(clientId || '').trim()] || null;
}

function isDateExpired(dateStr) {
  if (!dateStr) return false;

  const s = String(dateStr).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;

  const today = new Date();
  const yyyy = today.getFullYear();
  const mm = String(today.getMonth() + 1).padStart(2, '0');
  const dd = String(today.getDate()).padStart(2, '0');
  const todayStr = `${yyyy}-${mm}-${dd}`;

  return s < todayStr;
}

function getDeviceAccessStatus(dev) {
  const device = getDevice(dev);
  if (!device) {
    return { ok: false, code: 'device_not_found', message: 'device inexistente' };
  }

  if (device.enabled !== true) {
    return { ok: false, code: 'device_disabled', message: 'device deshabilitado' };
  }

  const client = getClient(device.client_id);
  if (!client) {
    return { ok: false, code: 'client_not_found', message: 'cliente inexistente' };
  }

  if (client.active !== true) {
    return { ok: false, code: 'client_inactive', message: 'cliente inactivo' };
  }

  const subStatus = String(client.subscription_status || '').trim();

  if (subStatus === 'suspended') {
    return { ok: false, code: 'client_suspended', message: 'cliente suspendido' };
  }

  if (subStatus === 'expired') {
    return { ok: false, code: 'client_expired', message: 'cliente expirado' };
  }

  if (isDateExpired(client.subscription_until)) {
    return { ok: false, code: 'subscription_until_expired', message: 'suscripción vencida' };
  }

  return {
    ok: true,
    device,
    client
  };
}

function saveClients(clientsData) {
  try {
    fs.writeFileSync(CLIENTS_PATH, JSON.stringify(clientsData, null, 2));
  } catch (e) {
    console.error('❌ No pude guardar clients.json:', e.message);
  }
}

function saveState(obj) {
  try {
    fs.writeFileSync(STATE_PATH, JSON.stringify(obj, null, 2));
  } catch (e) {
    console.error('❌ No pude guardar stateByDev.json:', e.message);
  }
}

// ================== ESTADO POR DEV ==================

const stateByDev = pruneStateByDevices(loadState());
saveState(stateByDev);

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

  const tokenMode = String(cfg.token_mode || '').trim();

  if (tokenMode === 'main_account') {
    return ACCESS_TOKEN;
  }

  if (tokenMode !== 'oauth_seller') {
    console.error(`❌ token_mode inválido para ${dev}:`, JSON.stringify(cfg.token_mode));
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

function recargarLinkConReintento(dev, priceOverride, titleOverride, intento = 1) {
  const MAX_INTENTOS = 5;
  const esperaMs = 2000 * intento;

  generarNuevoLinkParaDev(
    dev,
    priceOverride,
    titleOverride
  ).catch((err) => {
    console.error(
      `❌ Error al regenerar link para ${dev} (intento ${intento}):`,
      err.response?.data || err.message
    );

    if (intento < MAX_INTENTOS) {
      console.log(`⏳ Reintentando generar link para ${dev} en ${esperaMs} ms...`);
      setTimeout(
        () => recargarLinkConReintento(dev, priceOverride, titleOverride, intento + 1),
        esperaMs
      );
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

    const access = getDeviceAccessStatus(dev);
    if (!access.ok) {
      return res.status(403).json({
        error: access.message,
        code: access.code,
        dev
      });
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

    recargarLinkConReintento(dev, price, title);

    res.json({ ok: true, dev, price, title });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/admin/devices', requireAdmin, (req, res) => {
  try {
    const devices = getDevices();

    const out = Object.entries(devices).map(([dev, cfg]) => ({
      dev,
      ...cfg,
      state: stateByDev[dev] || null,
      oauth_connected: !!tokensByDev[dev]?.access_token,
    }));

    res.json({
      ok: true,
      count: out.length,
      devices: out
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/admin/device/create', requireAdmin, (req, res) => {
  try {
    const dev = String(req.body.dev || '').trim().toLowerCase();
    const client_id = String(req.body.client_id || '').trim();
    const title = String(req.body.title || '').trim();
    const quantity = Number(req.body.quantity || 1);
    const currency_id = String(req.body.currency_id || 'ARS').trim().toUpperCase();
    const unit_price = Number(req.body.unit_price);
    const fee_pct = Number(req.body.fee_pct || 0);
    const token_mode = String(req.body.token_mode || '').trim();
    const enabled = req.body.enabled === false ? false : true;
    const kind = String(req.body.kind || 'generic').trim();

    if (!/^[a-z0-9_-]{3,40}$/.test(dev)) {
      return res.status(400).json({ error: 'dev invalido (3..40, a-z0-9_-)' });
    }

    if (!client_id || client_id.length < 2 || client_id.length > 60) {
      return res.status(400).json({ error: 'client_id invalido' });
    }

    if (!title || title.length < 2 || title.length > 60) {
      return res.status(400).json({ error: 'title invalido' });
    }

    if (!Number.isFinite(quantity) || quantity < 1 || quantity > 100) {
      return res.status(400).json({ error: 'quantity invalido' });
    }

    if (!currency_id || currency_id.length !== 3) {
      return res.status(400).json({ error: 'currency_id invalido' });
    }

    if (!Number.isFinite(unit_price) || unit_price < 100 || unit_price > 65000) {
      return res.status(400).json({ error: 'unit_price invalido' });
    }

    if (!Number.isFinite(fee_pct) || fee_pct < 0 || fee_pct > 1) {
      return res.status(400).json({ error: 'fee_pct invalido (usar 0.03 para 3%)' });
    }

    if (!['main_account', 'oauth_seller'].includes(token_mode)) {
      return res.status(400).json({ error: 'token_mode invalido' });
    }

    const devices = getDevices();

    if (devices[dev]) {
      return res.status(400).json({ error: 'ese dev ya existe' });
    }

    const device_key =
      String(req.body.device_key || '').trim() ||
      ('dk_' + Math.random().toString(36).slice(2, 12) + Date.now().toString(36));

    devicesData.devices[dev] = {
      client_id,
      title,
      quantity,
      currency_id,
      unit_price,
      fee_pct,
      token_mode,
      enabled,
      kind,
      device_key
    };

    saveDevices(devicesData);

    if (!stateByDev[dev]) {
      stateByDev[dev] = {
        paidEvent: null,
        expectedExtRef: null,
        ultimaPreferencia: null,
        linkActual: null,
        rotateScheduled: false,
        lastPrice: unit_price,
        lastTitle: title,
      };
      saveState(stateByDev);
    }

    res.json({
      ok: true,
      dev,
      device: devicesData.devices[dev]
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/device/config/update', (req, res) => {
  try {
    const dev = String(req.body.dev || '').trim().toLowerCase();
    const device_key = String(req.body.device_key || '').trim();
    const title = String(req.body.title || '').trim();
    const unit_price = Number(req.body.unit_price);

    if (!dev) {
      return res.status(400).json({ error: 'dev requerido' });
    }

    const device = getDevice(dev);
    if (!device) {
      return res.status(404).json({ error: 'device no existe' });
    }

    if (!device.device_key || device_key !== String(device.device_key)) {
      return res.status(401).json({ error: 'device_key invalida' });
    }

    if (title.length < 2 || title.length > 60) {
      return res.status(400).json({ error: 'title invalido' });
    }

    if (!Number.isFinite(unit_price) || unit_price < 100 || unit_price > 65000) {
      return res.status(400).json({ error: 'unit_price invalido' });
    }

    devicesData.devices[dev].title = title;
    devicesData.devices[dev].unit_price = unit_price;
    saveDevices(devicesData);

    if (!stateByDev[dev]) {
      stateByDev[dev] = {
        paidEvent: null,
        expectedExtRef: null,
        ultimaPreferencia: null,
        linkActual: null,
        rotateScheduled: false,
        lastPrice: unit_price,
        lastTitle: title,
      };
    } else {
      stateByDev[dev].lastTitle = title;
      stateByDev[dev].lastPrice = unit_price;
      stateByDev[dev].paidEvent = null;
      stateByDev[dev].expectedExtRef = null;
      stateByDev[dev].ultimaPreferencia = null;
      stateByDev[dev].linkActual = null;
    }

    saveState(stateByDev);
    recargarLinkConReintento(dev, unit_price, title);

    res.json({
      ok: true,
      dev,
      title,
      unit_price
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/admin/device/update', requireAdmin, (req, res) => {
  try {
    const dev = String(req.body.dev || '').trim().toLowerCase();
    const current = getDevice(dev);

    if (!current) {
      return res.status(404).json({ error: 'dev no existe' });
    }

    const patch = {};

    if (req.body.client_id !== undefined) {
      const client_id = String(req.body.client_id || '').trim();
      if (!client_id || client_id.length < 2 || client_id.length > 60) {
        return res.status(400).json({ error: 'client_id invalido' });
      }
      patch.client_id = client_id;
    }

    if (req.body.title !== undefined) {
      const title = String(req.body.title || '').trim();
      if (!title || title.length < 2 || title.length > 60) {
        return res.status(400).json({ error: 'title invalido' });
      }
      patch.title = title;
    }

    if (req.body.quantity !== undefined) {
      const quantity = Number(req.body.quantity);
      if (!Number.isFinite(quantity) || quantity < 1 || quantity > 100) {
        return res.status(400).json({ error: 'quantity invalido' });
      }
      patch.quantity = quantity;
    }

    if (req.body.currency_id !== undefined) {
      const currency_id = String(req.body.currency_id || '').trim().toUpperCase();
      if (!currency_id || currency_id.length !== 3) {
        return res.status(400).json({ error: 'currency_id invalido' });
      }
      patch.currency_id = currency_id;
    }

    if (req.body.unit_price !== undefined) {
      const unit_price = Number(req.body.unit_price);
      if (!Number.isFinite(unit_price) || unit_price < 100 || unit_price > 65000) {
        return res.status(400).json({ error: 'unit_price invalido' });
      }
      patch.unit_price = unit_price;
    }

    if (req.body.fee_pct !== undefined) {
      const fee_pct = Number(req.body.fee_pct);
      if (!Number.isFinite(fee_pct) || fee_pct < 0 || fee_pct > 1) {
        return res.status(400).json({ error: 'fee_pct invalido' });
      }
      patch.fee_pct = fee_pct;
    }

    if (req.body.token_mode !== undefined) {
      const token_mode = String(req.body.token_mode || '').trim();
      if (!['main_account', 'oauth_seller'].includes(token_mode)) {
        return res.status(400).json({ error: 'token_mode invalido' });
      }
      patch.token_mode = token_mode;
    }

    if (req.body.enabled !== undefined) {
      patch.enabled = !!req.body.enabled;
    }

    if (req.body.kind !== undefined) {
      patch.kind = String(req.body.kind || 'generic').trim();
    }

    if (req.body.device_key !== undefined) {
      const device_key = String(req.body.device_key || '').trim();
      if (!device_key || device_key.length < 8 || device_key.length > 120) {
        return res.status(400).json({ error: 'device_key invalida' });
      }
      patch.device_key = device_key;
    }

    devicesData.devices[dev] = {
      ...current,
      ...patch
    };

    saveDevices(devicesData);

    if (!stateByDev[dev]) {
      stateByDev[dev] = {
        paidEvent: null,
        expectedExtRef: null,
        ultimaPreferencia: null,
        linkActual: null,
        rotateScheduled: false,
        lastPrice: devicesData.devices[dev].unit_price,
        lastTitle: devicesData.devices[dev].title,
      };
    } else {
      stateByDev[dev].lastTitle = devicesData.devices[dev].title;
      stateByDev[dev].lastPrice = devicesData.devices[dev].unit_price;
    }

    stateByDev[dev].paidEvent = null;
    stateByDev[dev].expectedExtRef = null;
    stateByDev[dev].ultimaPreferencia = null;
    stateByDev[dev].linkActual = null;

    saveState(stateByDev);
    recargarLinkConReintento(
      dev,
      devicesData.devices[dev].unit_price,
      devicesData.devices[dev].title
    );

    res.json({
      ok: true,
      dev,
      device: devicesData.devices[dev]
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/admin/clients', requireAdmin, (req, res) => {
  try {
    const clients = getClients();
    const devices = getDevices();

    const out = Object.entries(clients).map(([client_id, cfg]) => {
      const clientDevices = Object.entries(devices)
        .filter(([, d]) => d?.client_id === client_id)
        .map(([dev, d]) => ({
          dev,
          title: d.title,
          unit_price: d.unit_price,
          token_mode: d.token_mode,
          enabled: d.enabled,
          kind: d.kind
        }));

      return {
        client_id,
        ...cfg,
        devices_count: clientDevices.length,
        devices: clientDevices
      };
    });

    res.json({
      ok: true,
      count: out.length,
      clients: out
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/admin/client/create', requireAdmin, (req, res) => {
  try {
    const client_id = String(req.body.client_id || '').trim();
    const display_name = String(req.body.display_name || '').trim();
    const plan_type = String(req.body.plan_type || '').trim();
    const default_fee_pct = Number(req.body.default_fee_pct || 0);
    const subscription_status = String(req.body.subscription_status || '').trim();
    const subscription_until_raw = req.body.subscription_until;
    const active = req.body.active === false ? false : true;

    if (!/^[a-zA-Z0-9_-]{2,60}$/.test(client_id)) {
      return res.status(400).json({ error: 'client_id invalido (2..60, a-zA-Z0-9_-)' });
    }

    if (!display_name || display_name.length < 2 || display_name.length > 80) {
      return res.status(400).json({ error: 'display_name invalido' });
    }

    if (!['direct', 'marketplace_fee', 'subscription'].includes(plan_type)) {
      return res.status(400).json({ error: 'plan_type invalido' });
    }

    if (!Number.isFinite(default_fee_pct) || default_fee_pct < 0 || default_fee_pct > 1) {
      return res.status(400).json({ error: 'default_fee_pct invalido (usar 0.03 para 3%)' });
    }

    if (!['active', 'suspended', 'expired'].includes(subscription_status)) {
      return res.status(400).json({ error: 'subscription_status invalido' });
    }

    let subscription_until = null;
    if (subscription_until_raw !== undefined && subscription_until_raw !== null && String(subscription_until_raw).trim() !== '') {
      const s = String(subscription_until_raw).trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) {
        return res.status(400).json({ error: 'subscription_until invalido (usar YYYY-MM-DD)' });
      }
      subscription_until = s;
    }

    const clients = getClients();
    if (clients[client_id]) {
      return res.status(400).json({ error: 'ese client_id ya existe' });
    }

    clientsData.clients[client_id] = {
      display_name,
      plan_type,
      default_fee_pct,
      subscription_status,
      subscription_until,
      active
    };

    saveClients(clientsData);

    res.json({
      ok: true,
      client_id,
      client: clientsData.clients[client_id]
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/admin/client/update', requireAdmin, (req, res) => {
  try {
    const client_id = String(req.body.client_id || '').trim();
    const current = getClient(client_id);

    if (!current) {
      return res.status(404).json({ error: 'client_id no existe' });
    }

    const patch = {};

    if (req.body.display_name !== undefined) {
      const display_name = String(req.body.display_name || '').trim();
      if (!display_name || display_name.length < 2 || display_name.length > 80) {
        return res.status(400).json({ error: 'display_name invalido' });
      }
      patch.display_name = display_name;
    }

    if (req.body.plan_type !== undefined) {
      const plan_type = String(req.body.plan_type || '').trim();
      if (!['direct', 'marketplace_fee', 'subscription'].includes(plan_type)) {
        return res.status(400).json({ error: 'plan_type invalido' });
      }
      patch.plan_type = plan_type;
    }

    if (req.body.default_fee_pct !== undefined) {
      const default_fee_pct = Number(req.body.default_fee_pct);
      if (!Number.isFinite(default_fee_pct) || default_fee_pct < 0 || default_fee_pct > 1) {
        return res.status(400).json({ error: 'default_fee_pct invalido (usar 0.03 para 3%)' });
      }
      patch.default_fee_pct = default_fee_pct;
    }

    if (req.body.subscription_status !== undefined) {
      const subscription_status = String(req.body.subscription_status || '').trim();
      if (!['active', 'suspended', 'expired'].includes(subscription_status)) {
        return res.status(400).json({ error: 'subscription_status invalido' });
      }
      patch.subscription_status = subscription_status;
    }

    if (req.body.subscription_until !== undefined) {
      const raw = req.body.subscription_until;
      if (raw === null || String(raw).trim() === '') {
        patch.subscription_until = null;
      } else {
        const s = String(raw).trim();
        if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) {
          return res.status(400).json({ error: 'subscription_until invalido (usar YYYY-MM-DD)' });
        }
        patch.subscription_until = s;
      }
    }

    if (req.body.active !== undefined) {
      patch.active = !!req.body.active;
    }

    clientsData.clients[client_id] = {
      ...current,
      ...patch
    };

    saveClients(clientsData);

    res.json({
      ok: true,
      client_id,
      client: clientsData.clients[client_id]
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/panel', requireAdmin, (req, res) => {
  const st4 = stateByDev.bar4 || {};
  const st5 = stateByDev.bar5 || {};
  const d4 = getDevice('bar4');
  const d5 = getDevice('bar5');

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

    ${d4 ? `
    <div class="box">
      <h3>Config ${escapeHtml(d4.title || 'bar4')} (bar4)</h3>
      <form method="post" action="/set-item" onsubmit="return sendForm(event)">
        <input type="hidden" name="dev" value="bar4" />

        <div style="margin:6px 0;">
          <label>Título:</label><br/>
          <input name="title" style="width:320px;" value="${escapeHtml(st4.lastTitle || d4.title || 'Producto')}" />
        </div>

        <div style="margin:6px 0;">
          <label>Precio:</label><br/>
          <input name="price" style="width:120px;" value="${escapeHtml(String(st4.lastPrice || d4.unit_price || 100))}" />
        </div>

        <button type="submit">Guardar y regenerar QR</button>
        <div class="muted" id="resp" style="margin-top:6px;"></div>
      </form>
    </div>
    ` : ''}

    ${d5 ? `
    <div class="box">
      <h3>Config ${escapeHtml(d5.title || 'bar5')} (bar5)</h3>
      <form method="post" action="/set-item" onsubmit="return sendForm(event)">
        <input type="hidden" name="dev" value="bar5" />

        <div style="margin:6px 0;">
          <label>Título:</label><br/>
          <input name="title" style="width:320px;" value="${escapeHtml(st5.lastTitle || d5.title || 'Producto')}" />
        </div>

        <div style="margin:6px 0;">
          <label>Precio:</label><br/>
          <input name="price" style="width:120px;" value="${escapeHtml(String(st5.lastPrice || d5.unit_price || 100))}" />
        </div>

        <button type="submit">Guardar y regenerar QR</button>
        <div class="muted" id="resp5" style="margin-top:6px;"></div>
      </form>
    </div>
    ` : ''}

    <div class="box">
      <div class="muted">Conectar vendedor (devices OAuth habilitados):</div>
      <ul>
        ${getAllowedDevs()
          .filter(dev => getDevice(dev)?.token_mode === 'oauth_seller')
          .map(dev => `<li><a href="/connect?dev=${encodeURIComponent(dev)}">/connect?dev=${escapeHtml(dev)}</a></li>`)
          .join('')}
      </ul>
    </div>

    <div class="box">
      <h3>Crear device</h3>
      <form onsubmit="return createDevice(event)">
        <div style="margin:6px 0;">
          <label>Dev:</label><br/>
          <input name="dev" style="width:220px;" placeholder="bar6" />
        </div>

        <div style="margin:6px 0;">
          <label>Cliente ID:</label><br/>
          <input name="client_id" style="width:220px;" placeholder="cliente01" />
        </div>

        <div style="margin:6px 0;">
          <label>Título:</label><br/>
          <input name="title" style="width:320px;" placeholder="Andes IPA" />
        </div>

        <div style="margin:6px 0;">
          <label>Precio:</label><br/>
          <input name="unit_price" style="width:120px;" placeholder="3800" />
        </div>

        <div style="margin:6px 0;">
          <label>Fee % (ej 0.03):</label><br/>
          <input name="fee_pct" style="width:120px;" value="0" />
        </div>

        <div style="margin:6px 0;">
          <label>Token mode:</label><br/>
          <select name="token_mode" style="width:220px; padding:6px; border-radius:4px; border:1px solid #555; background:#222; color:#eee;">
            <option value="main_account">main_account</option>
            <option value="oauth_seller">oauth_seller</option>
          </select>
        </div>

        <div style="margin:6px 0;">
          <label>Kind:</label><br/>
          <input name="kind" style="width:220px;" value="beer_tap" />
        </div>

        <button type="submit">Crear device</button>
        <div class="muted" id="createResp" style="margin-top:6px;"></div>
      </form>
    </div>

    <div class="box">
      <h3>Editar device</h3>
      <form onsubmit="return updateDevice(event)">
        <div style="margin:6px 0;">
          <label>Dev:</label><br/>
          <input name="dev" style="width:220px;" placeholder="bar6" />
        </div>

        <div style="margin:6px 0;">
          <label>Cliente ID:</label><br/>
          <input name="client_id" style="width:220px;" placeholder="cliente01" />
        </div>

        <div style="margin:6px 0;">
          <label>Título:</label><br/>
          <input name="title" style="width:320px;" placeholder="Andes IPA" />
        </div>

        <div style="margin:6px 0;">
          <label>Precio:</label><br/>
          <input name="unit_price" style="width:120px;" placeholder="3800" />
        </div>

        <div style="margin:6px 0;">
          <label>Fee % (ej 0.03):</label><br/>
          <input name="fee_pct" style="width:120px;" placeholder="0" />
        </div>

        <div style="margin:6px 0;">
          <label>Token mode:</label><br/>
          <select name="token_mode" style="width:220px; padding:6px; border-radius:4px; border:1px solid #555; background:#222; color:#eee;">
            <option value="">(sin cambio)</option>
            <option value="main_account">main_account</option>
            <option value="oauth_seller">oauth_seller</option>
          </select>
        </div>

        <div style="margin:6px 0;">
          <label>Kind:</label><br/>
          <input name="kind" style="width:220px;" placeholder="beer_tap" />
        </div>

        <div style="margin:6px 0;">
          <label>Enabled:</label><br/>
          <select name="enabled" style="width:220px; padding:6px; border-radius:4px; border:1px solid #555; background:#222; color:#eee;">
            <option value="">(sin cambio)</option>
            <option value="true">true</option>
            <option value="false">false</option>
          </select>
        </div>

        <button type="submit">Actualizar device</button>
        <div class="muted" id="updateResp" style="margin-top:6px;"></div>
      </form>
    </div>

    <div class="box">
      <h3>Devices actuales</h3>
      <table>
        <tr>
          <th>Dev</th>
          <th>Cliente</th>
          <th>Título</th>
          <th>Precio</th>
          <th>Fee</th>
          <th>Token</th>
          <th>Enabled</th>
          <th>Kind</th>
          <th>OAuth</th>
        </tr>
        ${getAllowedDevs().map(dev => {
          const d = getDevice(dev) || {};
          const oauthConnected = !!tokensByDev[dev]?.access_token;
          return `
            <tr>
              <td>${escapeHtml(dev)}</td>
              <td>${escapeHtml(String(d.client_id || ''))}</td>
              <td>${escapeHtml(String(d.title || ''))}</td>
              <td>${escapeHtml(String(d.unit_price || ''))}</td>
              <td>${escapeHtml(String(d.fee_pct || 0))}</td>
              <td>${escapeHtml(String(d.token_mode || ''))}</td>
              <td>${escapeHtml(String(d.enabled))}</td>
              <td>${escapeHtml(String(d.kind || ''))}</td>
              <td>${oauthConnected ? 'sí' : 'no'}</td>
            </tr>
          `;
        }).join('')}
      </table>
    </div>

    <div class="box">
      <h3>Crear cliente</h3>
      <form onsubmit="return createClient(event)">
        <div style="margin:6px 0;">
          <label>Client ID:</label><br/>
          <input name="client_id" style="width:220px;" placeholder="cliente02" />
        </div>

        <div style="margin:6px 0;">
          <label>Nombre visible:</label><br/>
          <input name="display_name" style="width:320px;" placeholder="Cliente 02" />
        </div>

        <div style="margin:6px 0;">
          <label>Plan:</label><br/>
          <select name="plan_type" style="width:220px; padding:6px; border-radius:4px; border:1px solid #555; background:#222; color:#eee;">
            <option value="direct">direct</option>
            <option value="marketplace_fee">marketplace_fee</option>
            <option value="subscription">subscription</option>
          </select>
        </div>

        <div style="margin:6px 0;">
          <label>Fee por defecto (ej 0.03):</label><br/>
          <input name="default_fee_pct" style="width:120px;" value="0" />
        </div>

        <div style="margin:6px 0;">
          <label>Subscription status:</label><br/>
          <select name="subscription_status" style="width:220px; padding:6px; border-radius:4px; border:1px solid #555; background:#222; color:#eee;">
            <option value="active">active</option>
            <option value="suspended">suspended</option>
            <option value="expired">expired</option>
          </select>
        </div>

        <div style="margin:6px 0;">
          <label>Subscription until (YYYY-MM-DD):</label><br/>
          <input name="subscription_until" style="width:160px;" placeholder="2026-12-31" />
        </div>

        <div style="margin:6px 0;">
          <label>Active:</label><br/>
          <select name="active" style="width:220px; padding:6px; border-radius:4px; border:1px solid #555; background:#222; color:#eee;">
            <option value="true">true</option>
            <option value="false">false</option>
          </select>
        </div>

        <button type="submit">Crear cliente</button>
        <div class="muted" id="createClientResp" style="margin-top:6px;"></div>
      </form>
    </div>

    <div class="box">
      <h3>Editar cliente</h3>
      <form onsubmit="return updateClient(event)">
        <div style="margin:6px 0;">
          <label>Client ID:</label><br/>
          <input name="client_id" style="width:220px;" placeholder="cliente02" />
        </div>

        <div style="margin:6px 0;">
          <label>Nombre visible:</label><br/>
          <input name="display_name" style="width:320px;" placeholder="Cliente 02" />
        </div>

        <div style="margin:6px 0;">
          <label>Plan:</label><br/>
          <select name="plan_type" style="width:220px; padding:6px; border-radius:4px; border:1px solid #555; background:#222; color:#eee;">
            <option value="">(sin cambio)</option>
            <option value="direct">direct</option>
            <option value="marketplace_fee">marketplace_fee</option>
            <option value="subscription">subscription</option>
          </select>
        </div>

        <div style="margin:6px 0;">
          <label>Fee por defecto (ej 0.03):</label><br/>
          <input name="default_fee_pct" style="width:120px;" placeholder="0.03" />
        </div>

        <div style="margin:6px 0;">
          <label>Subscription status:</label><br/>
          <select name="subscription_status" style="width:220px; padding:6px; border-radius:4px; border:1px solid #555; background:#222; color:#eee;">
            <option value="">(sin cambio)</option>
            <option value="active">active</option>
            <option value="suspended">suspended</option>
            <option value="expired">expired</option>
          </select>
        </div>

        <div style="margin:6px 0;">
          <label>Subscription until (YYYY-MM-DD):</label><br/>
          <input name="subscription_until" style="width:160px;" placeholder="2026-12-31" />
        </div>

        <div style="margin:6px 0;">
          <label>Active:</label><br/>
          <select name="active" style="width:220px; padding:6px; border-radius:4px; border:1px solid #555; background:#222; color:#eee;">
            <option value="">(sin cambio)</option>
            <option value="true">true</option>
            <option value="false">false</option>
          </select>
        </div>

        <button type="submit">Actualizar cliente</button>
        <div class="muted" id="updateClientResp" style="margin-top:6px;"></div>
      </form>
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

      async function createDevice(ev) {
        ev.preventDefault();

        const fd = new FormData(ev.target); 

        const body = {
          dev: String(fd.get('dev') || '').trim(),
          client_id: String(fd.get('client_id') || '').trim(),
          title: String(fd.get('title') || '').trim(),
          quantity: 1,
          currency_id: 'ARS',
          unit_price: Number(fd.get('unit_price')),
          fee_pct: Number(fd.get('fee_pct') || 0),
          token_mode: String(fd.get('token_mode') || '').trim(),
          enabled: true,
          kind: String(fd.get('kind') || 'generic').trim()
        };

        const r = await fetch('/admin/device/create', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-admin-key': ADMIN_KEY
          },
          body: JSON.stringify(body)
        });

        const j = await r.json();
        document.getElementById('createResp').textContent =
          j.ok ? ('OK: ' + j.dev + ' creado') : JSON.stringify(j);

        return false;
      }

      async function updateDevice(ev) {
        ev.preventDefault();

        const fd = new FormData(ev.target);

        const body = {
          dev: String(fd.get('dev') || '').trim()
        };

        const client_id = String(fd.get('client_id') || '').trim();
        const title = String(fd.get('title') || '').trim();
        const unit_price_raw = String(fd.get('unit_price') || '').trim();
        const fee_pct_raw = String(fd.get('fee_pct') || '').trim();
        const token_mode = String(fd.get('token_mode') || '').trim();
        const kind = String(fd.get('kind') || '').trim();
        const enabled_raw = String(fd.get('enabled') || '').trim();

        if (client_id) body.client_id = client_id;
        if (title) body.title = title;
        if (unit_price_raw) body.unit_price = Number(unit_price_raw);
        if (fee_pct_raw) body.fee_pct = Number(fee_pct_raw);
        if (token_mode) body.token_mode = token_mode;
        if (kind) body.kind = kind;
        if (enabled_raw === 'true') body.enabled = true;
        if (enabled_raw === 'false') body.enabled = false;

        const r = await fetch('/admin/device/update', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-admin-key': ADMIN_KEY
          },
          body: JSON.stringify(body)
        });

        const j = await r.json();
        document.getElementById('updateResp').textContent =
          j.ok ? ('OK: ' + j.dev + ' actualizado') : JSON.stringify(j);

        return false;
      }

     async function createClient(ev) {
       ev.preventDefault();

       const fd = new FormData(ev.target);

       const subscriptionUntil = String(fd.get('subscription_until') || '').trim();
       const activeRaw = String(fd.get('active') || 'true').trim();
     
       const body = {
         client_id: String(fd.get('client_id') || '').trim(),
         display_name: String(fd.get('display_name') || '').trim(),
         plan_type: String(fd.get('plan_type') || '').trim(),
         default_fee_pct: Number(fd.get('default_fee_pct') || 0),
         subscription_status: String(fd.get('subscription_status') || '').trim(),
         subscription_until: subscriptionUntil || null,
         active: activeRaw === 'true'
       };

       const r = await fetch('/admin/client/create', {
         method: 'POST',
         headers: {
           'Content-Type': 'application/json',
           'x-admin-key': ADMIN_KEY
         },
         body: JSON.stringify(body)
       });

       const j = await r.json();
       document.getElementById('createClientResp').textContent =
         j.ok ? ('OK: ' + j.client_id + ' creado') : JSON.stringify(j);
     
       return false;
     }

    async function updateClient(ev) {
      ev.preventDefault();

      const fd = new FormData(ev.target);

      const body = {
        client_id: String(fd.get('client_id') || '').trim()
      };

      const display_name = String(fd.get('display_name') || '').trim();
      const plan_type = String(fd.get('plan_type') || '').trim();
      const default_fee_pct_raw = String(fd.get('default_fee_pct') || '').trim();
      const subscription_status = String(fd.get('subscription_status') || '').trim();
      const subscription_until_raw = String(fd.get('subscription_until') || '').trim();
      const active_raw = String(fd.get('active') || '').trim();

      if (display_name) body.display_name = display_name;
      if (plan_type) body.plan_type = plan_type;
      if (default_fee_pct_raw) body.default_fee_pct = Number(default_fee_pct_raw);
      if (subscription_status) body.subscription_status = subscription_status;
      if (subscription_until_raw) body.subscription_until = subscription_until_raw;
      if (active_raw === 'true') body.active = true;
      if (active_raw === 'false') body.active = false;

      const r = await fetch('/admin/client/update', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-admin-key': ADMIN_KEY
        },
        body: JSON.stringify(body)
      });

      const j = await r.json();
      document.getElementById('updateClientResp').textContent =
        j.ok ? ('OK: ' + j.client_id + ' actualizado') : JSON.stringify(j);

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

    const tokenMode = String(cfg.token_mode || '').trim();

    if (tokenMode === 'main_account') {
      recargarLinkConReintento(dev);
      return;
    }

    if (tokenMode === 'oauth_seller') {
      if (!tokensByDev[dev]?.access_token) {
        console.log(`ℹ️ ${dev} sin OAuth: no genero link inicial.`);
        return;
      }
      recargarLinkConReintento(dev);
      return;
    }

    console.log(`⚠️ ${dev} con token_mode inválido: ${JSON.stringify(cfg.token_mode)}`);
  });
});
