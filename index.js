// index.js – QdRink multi-BAR + OAuth Marketplace (PRODUCCION)
// - OAuth connect por dev (bar4, bar5)
// - Usa token del vendedor para crear QR interoperable con API Orders v1/orders
// - Mantiene OAuth para futuro
// - IPN intenta leer payment con token correcto (fallback)
// - refresh automático con refresh_token (offline_access)
// - ✅ Persistencia en Render Disk (/var/data): tokens + state + pagos.log
// - ✅ /nuevo-link idempotente (no regenera si hay QR vigente)
// - ✅ IPN valida principalmente por external_reference
// - ✅ V6.4: si Mercado Pago avisa order.expired, invalida y regenera QR

const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
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

// QR interoperable / API Orders
const MP_COLLECTOR_ID = process.env.MP_COLLECTOR_ID;
const MP_SPONSOR_ID = process.env.MP_SPONSOR_ID || '';
const MP_QR_MODE = String(process.env.MP_QR_MODE || 'dynamic').trim().toLowerCase();
const MP_STORE_ID = process.env.MP_STORE_ID || '';
const MP_STORE_EXTERNAL_ID = process.env.MP_STORE_EXTERNAL_ID || '';
const MP_POS_CATEGORY = Number(process.env.MP_POS_CATEGORY || 621102);

const ROTATE_DELAY_MS = Number(process.env.ROTATE_DELAY_MS || 5000);
const WEBHOOK_URL = process.env.WEBHOOK_URL;
const ADMIN_KEY = process.env.ADMIN_KEY;

const REQUIRED_ENVS = [
  'MP_ACCESS_TOKEN',
  'MP_CLIENT_ID',
  'MP_CLIENT_SECRET',
  'MP_REDIRECT_URI',
  'MP_COLLECTOR_ID',
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
    devices: {}
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

// tokensByClient[client_id] = { access_token, refresh_token, expires_at, user_id, ... }
let tokensByClient = loadTokens();
let devicesData = loadDevices();
let clientsData = loadClients();

ensureDeviceKeys();

console.log('🔑 tokens.json existe?', fs.existsSync(TOKENS_PATH));
console.log('🔑 tokens cargados por cliente:', Object.keys(tokensByClient));
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

function ensureDeviceKeys() {
  let changed = false;

  for (const [dev, cfg] of Object.entries(getDevices())) {
    if (!cfg.device_key || String(cfg.device_key).trim().length < 8) {
      cfg.device_key =
        'dk_' + Math.random().toString(36).slice(2, 12) + Date.now().toString(36);
      changed = true;
      console.log(`🔐 device_key generada para ${dev}`);
    }
  }

  if (changed) {
    saveDevices(devicesData);
  }
}

function loadClients() {
  const seed = {
    clients: {}
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

function normalizeTokensToClients() {
  let changed = false;
  const normalized = {};

  for (const [key, tok] of Object.entries(tokensByClient || {})) {
    if (!tok || typeof tok !== 'object' || !tok.access_token) continue;

    const keyStr = String(key || '').trim();
    const client = getClient(keyStr);

    if (client) {
      normalized[keyStr] = tok;
      continue;
    }

    const device = getDevice(keyStr);
    const legacyClientId = String(device?.client_id || '').trim();

    if (legacyClientId) {
      if (!normalized[legacyClientId]) {
        normalized[legacyClientId] = tok;
      }
      changed = true;
      console.log(`🔁 Migré token legacy dev=${keyStr} -> client_id=${legacyClientId}`);
      continue;
    }

    normalized[keyStr] = tok;
  }

  if (changed) {
    tokensByClient = normalized;
    saveTokens(tokensByClient);
  }
}

normalizeTokensToClients();

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
    qrRefreshEvent: stateByDev[dev].qrRefreshEvent ?? null,
    rotateScheduled: false,
    lastPrice: Number(stateByDev[dev].lastPrice ?? cfg.unit_price ?? 100),
    lastTitle: String(stateByDev[dev].lastTitle ?? cfg.title ?? 'Producto'),
  };
});

console.log('📦 stateByDev cargado:', Object.keys(stateByDev));
console.log('🧩 devices habilitados:', getAllowedDevs());

const pagos = [];
const processedPayments = new Set();
const processingPayments = new Set();

// ================== HELPERS ==================

function buildUniqueExtRef(dev) {
  return `${String(dev || '').toLowerCase()}_${Date.now()}`;
}

function findDevByExternalRef(externalRef) {
  if (!externalRef) return null;

  for (const dev of Object.keys(stateByDev)) {
    if (String(stateByDev[dev]?.expectedExtRef || '') === String(externalRef)) {
      return dev;
    }
  }

  return null;
}

function findDevByOrderId(orderId) {
  if (!orderId) return null;

  for (const dev of Object.keys(stateByDev)) {
    if (String(stateByDev[dev]?.ultimaPreferencia || '') === String(orderId)) {
      return dev;
    }
  }

  return null;
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

function buildOauthStateForClient(client_id) {
  return `client:${String(client_id || '').trim()}`;
}

function parseOauthState(stateRaw) {
  const s = String(stateRaw || '').trim();

  if (s.startsWith('client:')) {
    return { kind: 'client', client_id: s.slice('client:'.length) };
  }

  return { kind: 'legacy_dev', dev: s.toLowerCase() };
}


app.get('/connect', (req, res) => {
  const client_id = String(req.query.client_id || '').trim();
  const client = getClient(client_id);

  if (!client) return res.status(404).send('client_id invalido');
  if (client.active !== true) return res.status(403).send('cliente inactivo');

  const authUrl =
    `https://auth.mercadopago.com.ar/authorization` +
    `?response_type=code` +
    `&client_id=${encodeURIComponent(MP_CLIENT_ID)}` +
    `&redirect_uri=${encodeURIComponent(MP_REDIRECT_URI)}` +
    `&state=${encodeURIComponent(buildOauthStateForClient(client_id))}`;

  res.redirect(authUrl);
});

app.get('/oauth/callback', async (req, res) => {
  try {
    const code = String(req.query.code || '');
    const parsed = parseOauthState(req.query.state);

    if (!code) return res.status(400).send('Falta code');

    let client_id = null;

    if (parsed.kind === 'client') {
      client_id = String(parsed.client_id || '').trim();
      const client = getClient(client_id);
      if (!client) return res.status(400).send('State/client_id invalido');
    } else {
      const dev = String(parsed.dev || '').toLowerCase();
      if (!isDeviceEnabled(dev)) return res.status(400).send('State/dev invalido');

      const device = getDevice(dev);
      client_id = String(device?.client_id || '').trim();
      if (!client_id) return res.status(400).send('El dev no tiene client_id');
    }

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

    tokensByClient[client_id] = {
      access_token: t.access_token,
      refresh_token: t.refresh_token,
      token_type: t.token_type,
      expires_in: t.expires_in,
      expires_at: expiresAt,
      user_id: t.user_id || null,
      updated_at: Date.now(),
    };

    saveTokens(tokensByClient);

    res.send(
      `<h2>✅ Conectado OK</h2>
       <p>Cliente: <b>${escapeHtml(client_id)}</b></p>
       <p>Ya podés cobrar con todos los devices de este cliente.</p>
       <p>Volvé al <a href="/panel">/panel</a></p>`
    );
  } catch (err) {
    console.error('❌ Error en /oauth/callback:', err.response?.data || err.message);
    res.status(500).send('Error en OAuth callback. Mirá logs.');
  }
});

async function refreshTokenForClient(client_id) {
  const current = tokensByClient[client_id];
  if (!current?.refresh_token) throw new Error(`No hay refresh_token para client_id=${client_id}`);

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

  tokensByClient[client_id] = {
    access_token: t.access_token,
    refresh_token: t.refresh_token || current.refresh_token,
    token_type: t.token_type,
    expires_in: t.expires_in,
    expires_at: expiresAt,
    user_id: t.user_id || current.user_id || null,
    updated_at: Date.now(),
  };

  saveTokens(tokensByClient);
  return tokensByClient[client_id].access_token;
}

async function getAccessTokenForClient(client_id) {
  const id = String(client_id || '').trim();
  if (!id) return null;

  const t = tokensByClient[id];
  if (!t?.access_token) return null;

  const marginMs = 60_000;
  if (t.expires_at && Date.now() > (t.expires_at - marginMs)) {
    try {
      console.log(`🔁 Refresh token para client_id=${id}...`);
      return await refreshTokenForClient(id);
    } catch (e) {
      console.error(`❌ No pude refrescar token para client_id=${id}:`, e.response?.data || e.message);
      return null;
    }
  }

  return t.access_token;
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

  const client_id = String(cfg.client_id || '').trim();
  if (!client_id) return null;

  return await getAccessTokenForClient(client_id);
}

async function getCollectorIdForDev(dev) {
  const cfg = getDevice(dev);
  if (!cfg) return null;

  const tokenMode = String(cfg.token_mode || '').trim();

  if (tokenMode === 'main_account') {
    return String(MP_COLLECTOR_ID || '').trim() || null;
  }

  if (tokenMode !== 'oauth_seller') {
    return null;
  }

  const client_id = String(cfg.client_id || '').trim();
  if (!client_id) return null;

  await getAccessTokenForClient(client_id);
  const userId = tokensByClient[client_id]?.user_id;
  return userId ? String(userId).trim() : null;
}

function getExternalPosIdForDev(dev) {
  const cfg = getDevice(dev);
  const raw = String(cfg?.mp_external_pos_id || dev || '').trim().toLowerCase();
  return raw || null;
}

function moneyToMpString(value) {
  const n = Number(value || 0);
  return n.toFixed(2);
}

function buildQrItemForDev(dev, item, cfg) {
  return {
    title: String(item.title || 'Producto'),
    unit_price: moneyToMpString(item.unit_price || 0),
    quantity: Number(item.quantity || 1),
    unit_measure: 'unit',
    external_code: String(dev || 'item'),
    external_categories: [
      {
        id: String(cfg?.kind || 'generic')
      }
    ]
  };
}

function buildIdempotencyKey(dev, extRef) {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `${String(dev || 'dev')}-${String(extRef || Date.now())}-${Date.now()}`;
}

function buildOptionalIntegrationData() {
  const collectorId = String(MP_COLLECTOR_ID || '').trim();
  const sponsorId = String(MP_SPONSOR_ID || '').trim();

  if (!sponsorId || sponsorId === collectorId) {
    return undefined;
  }

  return {
    sponsor: {
      id: sponsorId
    }
  };
}

function buildPosExternalIdFromDev(dev) {
  return String(dev || '').trim().toLowerCase();
}

function validateMpPosExternalIdOrThrow(externalId) {
  if (!/^[a-zA-Z0-9]{3,40}$/.test(String(externalId || ''))) {
    throw new Error('El dev para auto-POS debe ser alfanumérico simple (3..40, sin guiones ni guion bajo)');
  }
}

function buildPosDisplayName(kind, title, dev) {
  const basePrefix = String(kind || '').trim() === 'ticket' ? 'QTIKET' : 'QDRINK';
  const rawTitle = String(title || '').trim().toUpperCase();
  const rawDev = String(dev || '').trim().toUpperCase();
  let name = `${basePrefix} ${rawDev}`.trim();

  if (!name || name.length < 3) {
    name = `${basePrefix} POS`;
  }

  if (name.length > 45) {
    name = name.slice(0, 45);
  }

  return name;
}

async function resolvePosProvisionContext({ client_id, token_mode }) {
  const tokenMode = String(token_mode || '').trim();

  if (tokenMode === 'main_account') {
    const storeId = Number(MP_STORE_ID || 0);
    const externalStoreId = String(MP_STORE_EXTERNAL_ID || '').trim();

    if (!storeId || !externalStoreId) {
      throw new Error('Faltan MP_STORE_ID y/o MP_STORE_EXTERNAL_ID en Render para auto-crear POS');
    }

    return {
      accessToken: ACCESS_TOKEN,
      collectorId: String(MP_COLLECTOR_ID || '').trim(),
      storeId,
      externalStoreId,
    };
  }

  if (tokenMode !== 'oauth_seller') {
    throw new Error(`token_mode inválido para auto-POS: ${JSON.stringify(tokenMode)}`);
  }

  const client = getClient(client_id);
  if (!client) {
    throw new Error(`cliente inexistente para auto-POS: ${client_id}`);
  }

  const accessToken = await getAccessTokenForClient(client_id);
  if (!accessToken) {
    throw new Error(`cliente ${client_id} sin OAuth conectado: no se pudo auto-crear POS`);
  }

  const collectorId = tokensByClient[client_id]?.user_id ? String(tokensByClient[client_id].user_id).trim() : '';
  const storeId = Number(client.mp_store_id || 0);
  const externalStoreId = String(client.mp_store_external_id || '').trim();

  if (!collectorId) {
    throw new Error(`cliente ${client_id} sin user_id OAuth: no se pudo auto-crear POS`);
  }

  if (!storeId || !externalStoreId) {
    throw new Error(`cliente ${client_id} sin mp_store_id/mp_store_external_id: cargalos antes de auto-crear POS`);
  }

  return {
    accessToken,
    collectorId,
    storeId,
    externalStoreId,
  };
}

async function createPosForNewDevice({ dev, title, kind, client_id, token_mode }) {
  const externalPosId = buildPosExternalIdFromDev(dev);
  validateMpPosExternalIdOrThrow(externalPosId);

  const ctx = await resolvePosProvisionContext({ client_id, token_mode });

  const body = {
    name: buildPosDisplayName(kind, title, dev),
    fixed_amount: true,
    category: MP_POS_CATEGORY,
    store_id: ctx.storeId,
    external_store_id: ctx.externalStoreId,
    external_id: externalPosId,
  };

  const headers = {
    Authorization: `Bearer ${ctx.accessToken}`,
    'Content-Type': 'application/json',
  };

  const res = await axios.post('https://api.mercadopago.com/pos', body, { headers });
  const pos = res.data || {};

  return {
    id: pos.id || null,
    name: pos.name || body.name,
    external_id: pos.external_id || externalPosId,
    store_id: pos.store_id || ctx.storeId,
    external_store_id: pos.external_store_id || ctx.externalStoreId,
    status: pos.status || null,
    user_id: pos.user_id || ctx.collectorId || null,
    qr_code: pos.qr_code || null,
  };
}

// ================== MP: CREAR QR INTEROPERABLE (API ORDERS) ==================

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

  const externalPosId = getExternalPosIdForDev(dev);
  if (!externalPosId) {
    throw new Error(`Dev ${dev} no tiene external_pos_id disponible`);
  }

  const extRef = buildUniqueExtRef(dev);
  const totalAmount = Number(item.unit_price || 0) * Number(item.quantity || 1);
  const idempotencyKey = buildIdempotencyKey(dev, extRef);
  const integrationData = buildOptionalIntegrationData();

  const headers = {
    Authorization: `Bearer ${sellerToken}`,
    'Content-Type': 'application/json',
    'X-Idempotency-Key': idempotencyKey
  };

  const body = {
    type: 'qr',
    external_reference: extRef,
    description: String(item.title || 'Producto'),
    total_amount: moneyToMpString(totalAmount),
    config: {
      qr: {
        external_pos_id: externalPosId,
        mode: MP_QR_MODE === 'static' ? 'static' : 'dynamic'
      }
    },
    transactions: {
      payments: [
        {
          amount: moneyToMpString(totalAmount)
        }
      ]
    },
    items: [buildQrItemForDev(dev, item, cfg)]
  };

  if (integrationData) {
    body.integration_data = integrationData;
  }

  const res = await axios.post(
    'https://api.mercadopago.com/v1/orders',
    body,
    { headers }
  );

  const order = res.data || {};
  const orderId = order.id || null;
  const qrData = order.type_response?.qr_data || null;

  if (!qrData) {
    throw new Error(`Mercado Pago no devolvió type_response.qr_data para dev=${dev}`);
  }

  if (!stateByDev[dev]) stateByDev[dev] = {};

  stateByDev[dev].ultimaPreferencia = orderId;
  stateByDev[dev].linkActual = qrData;
  stateByDev[dev].expectedExtRef = extRef;
  stateByDev[dev].lastPrice = item.unit_price;
  stateByDev[dev].lastTitle = item.title;

  saveState(stateByDev);

  console.log(`🔄 Nuevo QR interoperable generado para ${dev}:`, {
    order_id: orderId,
    external_reference: extRef,
    external_pos_id: externalPosId,
    qr_mode: body.config.qr.mode,
    price: item.unit_price
  });

  return {
    preference_id: orderId,
    external_reference: extRef,
    link: qrData,
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
      `❌ Error al regenerar QR para ${dev} (intento ${intento}):`,
      err.response?.data || err.message
    );

    if (intento < MAX_INTENTOS) {
      console.log(`⏳ Reintentando generar QR para ${dev} en ${esperaMs} ms...`);
      setTimeout(
        () => recargarLinkConReintento(dev, priceOverride, titleOverride, intento + 1),
        esperaMs
      );
    } else {
      console.log(`⚠️ Se agotaron reintentos para ${dev}. Se mantiene último QR.`);
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
      if (st.qrRefreshEvent) {
        st.qrRefreshEvent = null;
        saveState(stateByDev);
      }

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

    if (stateByDev[dev]?.qrRefreshEvent) {
      stateByDev[dev].qrRefreshEvent = null;
      saveState(stateByDev);
    }

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
    const mpError = error.response?.data || null;
    console.error('❌ Error en /nuevo-link:', mpError || error.message);
    res.status(500).json({
      error: String(error.message || 'no se pudo generar link'),
      mp_error: mpError
    });
  }
});

app.get('/estado', (req, res) => {
  const dev = (req.query.dev || '').toLowerCase();
  if (!isDeviceEnabled(dev)) {
    return res.status(400).json({ error: 'dev invalido' });
  }

  const st = stateByDev[dev];
  res.json({
    dev,
    paidEvent: st.paidEvent,
    qrRefreshEvent: st.qrRefreshEvent || null
  });
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

    // invalidar QR actual y exigir reinicio manual del equipo
    stateByDev[dev].paidEvent = null;
    stateByDev[dev].expectedExtRef = null;
    stateByDev[dev].ultimaPreferencia = null;
    stateByDev[dev].linkActual = null;

    saveState(stateByDev);

    res.json({
      ok: true,
      dev,
      price,
      title,
      restart_required: true,
      message: 'Configuración guardada. Reiniciá manualmente el equipo para generar y mostrar el nuevo QR.'
    });
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
      oauth_connected: !!tokensByClient[String(cfg?.client_id || '').trim()]?.access_token,
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

app.post('/admin/device/create', requireAdmin, async (req, res) => {
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

    const client = getClient(client_id);
    if (!client) {
      return res.status(404).json({ error: 'cliente inexistente' });
    }

    const posInfo = await createPosForNewDevice({
      dev,
      title,
      kind,
      client_id,
      token_mode,
    });

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
      device_key,
      mp_pos_id: posInfo.id,
      mp_external_pos_id: posInfo.external_id,
      mp_store_id: posInfo.store_id,
      mp_external_store_id: posInfo.external_store_id,
      mp_pos_status: posInfo.status,
      mp_user_id: posInfo.user_id,
      pos_auto_created: true,
    };

    saveDevices(devicesData);

    if (!stateByDev[dev]) {
      stateByDev[dev] = {
        paidEvent: null,
        expectedExtRef: null,
        ultimaPreferencia: null,
        linkActual: null,
        qrRefreshEvent: null,
        rotateScheduled: false,
        lastPrice: unit_price,
        lastTitle: title,
      };
      saveState(stateByDev);
    }

    res.json({
      ok: true,
      dev,
      device: devicesData.devices[dev],
      pos: posInfo,
      message: 'Device y POS creados correctamente'
    });
  } catch (e) {
    const mpError = e.response?.data || null;
    console.error('❌ Error en /admin/device/create:', mpError || e.message);
    res.status(500).json({ error: e.message, mp_error: mpError });
  }
});

app.post('/device/register', async (req, res) => {
  try {
    const client_id = String(req.body.client_id || '').trim();
    const dev = String(req.body.dev || '').trim().toLowerCase();
    const ap_password = String(req.body.ap_password || '').trim();
    const kind = String(req.body.kind || 'beer_tap').trim();

    if (!client_id) {
      return res.status(400).json({ error: 'client_id requerido' });
    }

    if (!/^[a-z0-9_-]{3,40}$/.test(dev)) {
      return res.status(400).json({ error: 'dev invalido (3..40, a-z0-9_-)' });
    }

    if (ap_password.length < 8 || ap_password.length > 63) {
      return res.status(400).json({ error: 'ap_password invalida (8..63)' });
    }

    const client = getClient(client_id);
    if (!client) {
      return res.status(404).json({ error: 'cliente no existe', code: 'client_not_found' });
    }

    if (client.active !== true) {
      return res.status(403).json({ error: 'cliente inactivo', code: 'client_inactive' });
    }

    const subStatus = String(client.subscription_status || '').trim();
    if (subStatus === 'suspended') {
      return res.status(403).json({ error: 'cliente suspendido', code: 'client_suspended' });
    }

    if (subStatus === 'expired') {
      return res.status(403).json({ error: 'cliente expirado', code: 'client_expired' });
    }

    if (isDateExpired(client.subscription_until)) {
      return res.status(403).json({ error: 'suscripción vencida', code: 'subscription_until_expired' });
    }

    const devices = getDevices();
    if (devices[dev]) {
      return res.status(400).json({ error: 'ese dev ya existe', code: 'dev_already_exists' });
    }

    const defaultFee = Number(client.default_fee_pct || 0);

    // V6.2:
    // En el alta desde equipo virgen usamos siempre la cuenta principal para poder
    // crear el POS aunque el cliente todavía no tenga OAuth conectado.
    // Más adelante se puede extender con un modo opcional para crear POS bajo OAuth.
    const inferredTokenMode = 'main_account';

    const device_key =
      'dk_' + Math.random().toString(36).slice(2, 12) + Date.now().toString(36);

    const deviceTitle = kind === 'ticket' ? 'Qtiket' : 'QdRink';

    const posInfo = await createPosForNewDevice({
      dev,
      title: deviceTitle,
      kind,
      client_id,
      token_mode: inferredTokenMode,
    });

    devicesData.devices[dev] = {
      client_id,
      title: deviceTitle,
      quantity: 1,
      currency_id: 'ARS',
      unit_price: 1000,
      fee_pct: defaultFee,
      token_mode: inferredTokenMode,
      enabled: true,
      kind,
      device_key,
      mp_pos_id: posInfo.id,
      mp_external_pos_id: posInfo.external_id,
      mp_store_id: posInfo.store_id,
      mp_external_store_id: posInfo.external_store_id,
      mp_user_id: posInfo.user_id,
    };

    saveDevices(devicesData);

    stateByDev[dev] = {
      paidEvent: null,
      expectedExtRef: null,
      ultimaPreferencia: null,
      linkActual: null,
      qrRefreshEvent: null,
      rotateScheduled: false,
      lastPrice: devicesData.devices[dev].unit_price,
      lastTitle: devicesData.devices[dev].title,
    };
    saveState(stateByDev);

    res.json({
      ok: true,
      client_id,
      dev,
      device_key,
      ap_password,
      kind
    });
  } catch (e) {
    const mpError = e.response?.data || null;
    console.error('❌ Error en /device/register:', mpError || e.message);
    res.status(500).json({ error: e.message, mp_error: mpError });
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
        qrRefreshEvent: null,
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
        qrRefreshEvent: null,
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

    res.json({
      ok: true,
      dev,
      device: devicesData.devices[dev],
      restart_required: true,
      message: 'Device actualizado. Reiniciá manualmente el equipo para generar y mostrar el nuevo QR.'
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});


app.post('/admin/device/delete', requireAdmin, (req, res) => {
  try {
    const dev = String(req.body.dev || '').trim().toLowerCase();

    if (!dev) {
      return res.status(400).json({ error: 'dev requerido' });
    }

    const current = getDevice(dev);
    if (!current) {
      return res.status(404).json({ error: 'dev no existe' });
    }

    delete devicesData.devices[dev];
    saveDevices(devicesData);

    if (stateByDev[dev]) {
      delete stateByDev[dev];
      saveState(stateByDev);
    }


    res.json({ ok: true, dev });
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

      const tok = tokensByClient[client_id] || null;

      return {
        client_id,
        ...cfg,
        devices_count: clientDevices.length,
        devices: clientDevices,
        oauth_connected: !!tok?.access_token,
        oauth_user_id: tok?.user_id || null,
        oauth_updated_at: tok?.updated_at || null
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


app.post('/admin/client/delete', requireAdmin, (req, res) => {
  try {
    const client_id = String(req.body.client_id || '').trim();

    if (!client_id) {
      return res.status(400).json({ error: 'client_id requerido' });
    }

    const current = getClient(client_id);
    if (!current) {
      return res.status(404).json({ error: 'client_id no existe' });
    }

    const linkedDevices = Object.entries(getDevices())
      .filter(([, d]) => d?.client_id === client_id)
      .map(([dev]) => dev);

    if (linkedDevices.length > 0) {
      return res.status(400).json({
        error: 'no se puede eliminar el cliente porque tiene devices asociados',
        code: 'client_has_devices',
        devices: linkedDevices
      });
    }

    delete clientsData.clients[client_id];
    saveClients(clientsData);

    if (tokensByClient[client_id]) {
      delete tokensByClient[client_id];
      saveTokens(tokensByClient);
    }

    res.json({ ok: true, client_id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});


app.get('/panel', requireAdmin, (req, res) => {
  const devicesEntries = Object.entries(getDevices()).sort((a, b) => a[0].localeCompare(b[0]));
  const clientsEntries = Object.entries(getClients()).sort((a, b) => a[0].localeCompare(b[0]));

  const deviceConfigBoxes = devicesEntries.map(([dev, d]) => {
    const st = stateByDev[dev] || {};
    return `
    <div class="box">
      <h3>Config ${escapeHtml(String(d.title || dev))} (${escapeHtml(dev)})</h3>
      <form method="post" action="/set-item" data-out="setResp_${escapeHtml(dev)}" onsubmit="return sendForm(event)">
        <input type="hidden" name="dev" value="${escapeHtml(dev)}" />

        <div style="margin:6px 0;">
          <label>Título:</label><br/>
          <input name="title" style="width:320px;" value="${escapeHtml(String(st.lastTitle || d.title || 'Producto'))}" />
        </div>

        <div style="margin:6px 0;">
          <label>Precio:</label><br/>
          <input name="price" style="width:120px;" value="${escapeHtml(String(st.lastPrice || d.unit_price || 100))}" />
        </div>

        <button type="submit">Guardar y regenerar QR interoperable</button>
        <div class="muted" id="setResp_${escapeHtml(dev)}" style="margin-top:6px;"></div>
      </form>
    </div>
    `;
  }).join('');

  const devicesTableRows = devicesEntries.map(([dev, d]) => {
    const oauthConnected = !!tokensByClient[String(d.client_id || '').trim()]?.access_token;
    const st = stateByDev[dev] || {};
    return `
      <tr>
        <td>${escapeHtml(dev)}</td>
        <td>${escapeHtml(String(d.client_id || ''))}</td>
        <td>${escapeHtml(String(d.title || ''))}</td>
        <td>${escapeHtml(String(d.unit_price || ''))}</td>
        <td>${escapeHtml(String(st.lastPrice || d.unit_price || ''))}</td>
        <td>${escapeHtml(String(d.fee_pct || 0))}</td>
        <td>${escapeHtml(String(d.token_mode || ''))}</td>
        <td>${escapeHtml(String(d.enabled))}</td>
        <td>${escapeHtml(String(d.kind || ''))}</td>
        <td>${oauthConnected ? 'sí' : 'no'}</td>
        <td><button type="button" onclick="deleteDevice('${escapeHtml(dev)}')">Eliminar</button></td>
      </tr>
    `;
  }).join('');

  const clientsTableRows = clientsEntries.map(([client_id, cfg]) => {
    const linkedDevices = devicesEntries
      .filter(([, d]) => d?.client_id === client_id)
      .map(([dev]) => dev);

    const devicesCount = String(linkedDevices.length).padStart(2, '0');
    const tok = tokensByClient[client_id] || null;
    const oauthConnected = !!tok?.access_token;
    const oauthUpdated = tok?.updated_at ? new Date(tok.updated_at).toLocaleString('es-AR') : '';

    return `
      <tr>
        <td>${escapeHtml(client_id)}</td>
        <td>${escapeHtml(String(cfg.display_name || ''))}</td>
        <td>${escapeHtml(String(cfg.plan_type || ''))}</td>
        <td>${escapeHtml(String(cfg.default_fee_pct || 0))}</td>
        <td>${escapeHtml(String(cfg.subscription_status || ''))}</td>
        <td>${escapeHtml(String(cfg.subscription_until || ''))}</td>
        <td>${escapeHtml(String(cfg.active))}</td>
        <td>${escapeHtml(devicesCount)}</td>
        <td>${escapeHtml(linkedDevices.join(', '))}</td>
        <td>${oauthConnected ? 'sí' : 'no'}</td>
        <td>${escapeHtml(String(tok?.user_id || ''))}</td>
        <td>${escapeHtml(String(oauthUpdated || ''))}</td>
        <td><a href="/connect?client_id=${encodeURIComponent(client_id)}&key=${encodeURIComponent(ADMIN_KEY)}">Conectar MP</a></td>
        <td><button type="button" onclick="deleteClient('${escapeHtml(client_id)}')">Eliminar</button></td>
      </tr>
    `;
  }).join('');

  let html = `
  <html>
  <head>
    <meta charset="utf-8" />
    <title>Panel QdRink</title>
    <style>
      body { font-family: sans-serif; background:#111; color:#eee; padding: 10px; }
      a { color: #9ad; }
      table { border-collapse: collapse; width: 100%; margin-top: 10px; }
      th, td { border: 1px solid #444; padding: 6px 8px; font-size: 13px; vertical-align: top; }
      th { background: #222; }
      tr:nth-child(even) { background:#1b1b1b; }
      .muted { color:#aaa; font-size: 12px; }
      .box { background:#181818; border:1px solid #333; padding:10px; border-radius: 6px; margin-top:10px; }
      input, select { padding:6px; border-radius:4px; border:1px solid #555; background:#222; color:#eee; }
      button { padding:8px 12px; border:none; border-radius:4px; background:#2d6cdf; color:white; cursor:pointer; }
      button:hover { opacity:0.9; }
      .danger { background:#a33; }
      .grid { display:grid; grid-template-columns: repeat(auto-fit, minmax(360px, 1fr)); gap:10px; }
      .pill { display:inline-block; padding:2px 8px; border-radius:999px; background:#222; border:1px solid #444; margin-right:6px; }
    </style>
  </head>
  <body>
    <h1>Panel QdRink</h1>

    <div class="box">
      <div class="muted">Resumen</div>
      <div style="margin-top:6px;">
        <span class="pill">Clients: ${clientsEntries.length}</span>
        <span class="pill">Devices: ${devicesEntries.length}</span>
        <span class="pill">Devices habilitados: ${getAllowedDevs().length}</span>
      </div>
      <div class="muted" style="margin-top:8px;">Ahora el panel ya no depende de bar4/bar5. Todo sale de clients.json y devices.json. Para Instore, cada dev debe tener un POS en MP con external_pos_id igual al dev o al mp_external_pos_id configurado.</div>
    </div>

    ${deviceConfigBoxes || '<div class="box"><div class="muted">No hay devices cargados todavía.</div></div>'}

    <div class="box">
      <div class="muted">Conectar vendedor (OAuth por cliente):</div>
      <ul>
        ${clientsEntries
          .filter(([client_id]) => devicesEntries.some(([, d]) => d?.client_id === client_id && d?.enabled === true && d?.token_mode === 'oauth_seller'))
          .map(([client_id, cfg]) => `<li><a href="/connect?client_id=${encodeURIComponent(client_id)}&key=${encodeURIComponent(ADMIN_KEY)}">/connect?client_id=${escapeHtml(client_id)}</a> <span class="muted">(${escapeHtml(String(cfg.display_name || ''))})</span></li>`)
          .join('') || '<li class="muted">No hay clientes con devices oauth_seller habilitados.</li>'}
      </ul>
    </div>

    <div class="grid">
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
            <select name="plan_type" style="width:220px;">
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
            <select name="subscription_status" style="width:220px;">
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
            <select name="active" style="width:220px;">
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
            <select name="plan_type" style="width:220px;">
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
            <select name="subscription_status" style="width:220px;">
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
            <select name="active" style="width:220px;">
              <option value="">(sin cambio)</option>
              <option value="true">true</option>
              <option value="false">false</option>
            </select>
          </div>

          <button type="submit">Actualizar cliente</button>
          <div class="muted" id="updateClientResp" style="margin-top:6px;"></div>
        </form>
      </div>

      <div class="box">
        <h3>Crear device</h3>
        <form onsubmit="return createDevice(event)">
          <div style="margin:6px 0;">
            <label>Dev:</label><br/>
            <input name="dev" style="width:220px;" placeholder="canilla01" />
          </div>

          <div style="margin:6px 0;">
            <label>Cliente ID:</label><br/>
            <input name="client_id" style="width:220px;" placeholder="cliente01" />
          </div>

          <div style="margin:6px 0;">
            <label>Título:</label><br/>
            <input name="title" style="width:320px;" placeholder="QdRink" />
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
            <select name="token_mode" style="width:220px;">
              <option value="main_account">main_account</option>
              <option value="oauth_seller">oauth_seller</option>
            </select>
          </div>

          <div style="margin:6px 0;">
            <label>Kind:</label><br/>
            <select name="kind" style="width:220px;">
                <option value="beer_tap">beer_tap</option>
                <option value="ticket">ticket</option>
              </select>
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
            <input name="dev" style="width:220px;" placeholder="canilla01" />
          </div>

          <div style="margin:6px 0;">
            <label>Cliente ID:</label><br/>
            <input name="client_id" style="width:220px;" placeholder="cliente01" />
          </div>

          <div style="margin:6px 0;">
            <label>Título:</label><br/>
            <input name="title" style="width:320px;" placeholder="QdRink" />
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
            <select name="token_mode" style="width:220px;">
              <option value="">(sin cambio)</option>
              <option value="main_account">main_account</option>
              <option value="oauth_seller">oauth_seller</option>
            </select>
          </div>

          <div style="margin:6px 0;">
            <label>Kind:</label><br/>
            <select name="kind" style="width:220px;">
              <option value="">(sin cambio)</option>
              <option value="beer_tap">beer_tap</option>
              <option value="ticket">ticket</option>
            </select>
          </div>

          <div style="margin:6px 0;">
            <label>Enabled:</label><br/>
            <select name="enabled" style="width:220px;">
              <option value="">(sin cambio)</option>
              <option value="true">true</option>
              <option value="false">false</option>
            </select>
          </div>

          <button type="submit">Actualizar device</button>
          <div class="muted" id="updateResp" style="margin-top:6px;"></div>
        </form>
      </div>
    </div>

    <div class="box">
      <h3>Registrar equipo virgen</h3>
      <div class="muted">Este es el mismo flujo del ESP nuevo/reset: entra a QdRink_Setup_XXXXX, el usuario pone su client_id, el nombre del device y la clave del AP local.</div>
      <form onsubmit="return registerDevice(event)">
        <div style="margin:6px 0;">
          <label>Client ID:</label><br/>
          <input name="client_id" style="width:220px;" placeholder="cliente01" />
        </div>

        <div style="margin:6px 0;">
          <label>Dev:</label><br/>
          <input name="dev" style="width:220px;" placeholder="canilla01" />
        </div>

        <div style="margin:6px 0;">
          <label>AP password:</label><br/>
          <input name="ap_password" style="width:220px;" placeholder="minimo 8 caracteres" />
        </div>

        <div style="margin:6px 0;">
          <label>Kind:</label><br/>
          <select name="kind" style="width:220px;">
            <option value="beer_tap">beer_tap</option>
            <option value="ticket">ticket</option>
          </select>
        </div>

        <button type="submit">Registrar equipo</button>
        <div class="muted" id="registerDeviceResp" style="margin-top:6px;"></div>
      </form>
    </div>

    <div class="box">
      <h3>Clients actuales</h3>
      <table>
        <tr>
          <th>Client ID</th>
          <th>Nombre</th>
          <th>Plan</th>
          <th>Fee default</th>
          <th>Status</th>
          <th>Hasta</th>
          <th>Activo</th>
          <th>Cantidad devs</th>
          <th>Devices</th>
          <th>OAuth</th>
          <th>user_id MP</th>
          <th>OAuth updated</th>
          <th>Conectar</th>
          <th>Acción</th>
        </tr>
        ${clientsTableRows || '<tr><td colspan="13" class="muted">No hay clients cargados.</td></tr>'}
      </table>
      <div class="muted" id="deleteClientResp" style="margin-top:6px;"></div>
    </div>

    <div class="box">
      <h3>Devices actuales</h3>
      <table>
        <tr>
          <th>Dev</th>
          <th>Cliente</th>
          <th>Título</th>
          <th>Precio base</th>
          <th>Último precio</th>
          <th>Fee</th>
          <th>Token</th>
          <th>Enabled</th>
          <th>Kind</th>
          <th>OAuth cliente</th>
          <th>Acción</th>
        </tr>
        ${devicesTableRows || '<tr><td colspan="11" class="muted">No hay devices cargados.</td></tr>'}
      </table>
      <div class="muted" id="deleteDeviceResp" style="margin-top:6px;"></div>
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
        <th>order_id</th>
        <th>ext_ref</th>
      </tr>
  `;

  const pagosUnicos = Array.from(
    new Map(
      pagos.map((p) => [String(p.payment_id || ''), p])
    ).values()
  );

  pagosUnicos.slice().reverse().forEach((p) => {
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

        const form = ev.target;
        const fd = new FormData(form);
        const outId = form.getAttribute('data-out');

        const body = {
          dev: String(fd.get('dev') || '').trim(),
          title: String(fd.get('title') || '').trim(),
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
        if (outId) document.getElementById(outId).textContent = JSON.stringify(j);

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
          j.ok ? ('OK: ' + j.dev + ' creado + POS MP ' + (j.pos?.external_id || '') + '. Recargá el panel.') : JSON.stringify(j);

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
          j.ok ? ('OK: ' + j.dev + ' actualizado. Recargá el panel.') : JSON.stringify(j);

        return false;
      }

      async function deleteDevice(dev) {
        if (!confirm('Eliminar device ' + dev + '?')) return false;

        const r = await fetch('/admin/device/delete', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-admin-key': ADMIN_KEY
          },
          body: JSON.stringify({ dev })
        });

        const j = await r.json();
        document.getElementById('deleteDeviceResp').textContent =
          j.ok ? ('OK: ' + j.dev + ' eliminado. Recargá el panel.') : JSON.stringify(j);

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
          j.ok ? ('OK: ' + j.client_id + ' creado. Recargá el panel.') : JSON.stringify(j);

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
          j.ok ? ('OK: ' + j.client_id + ' actualizado. Recargá el panel.') : JSON.stringify(j);

        return false;
      }

      async function deleteClient(client_id) {
        if (!confirm('Eliminar client ' + client_id + '?')) return false;

        const r = await fetch('/admin/client/delete', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-admin-key': ADMIN_KEY
          },
          body: JSON.stringify({ client_id })
        });

        const j = await r.json();
        document.getElementById('deleteClientResp').textContent =
          j.ok ? ('OK: ' + j.client_id + ' eliminado. Recargá el panel.') : JSON.stringify(j);

        return false;
      }

      async function registerDevice(ev) {
        ev.preventDefault();

        const fd = new FormData(ev.target);

        const body = {
          client_id: String(fd.get('client_id') || '').trim(),
          dev: String(fd.get('dev') || '').trim(),
          ap_password: String(fd.get('ap_password') || '').trim(),
          kind: String(fd.get('kind') || 'beer_tap').trim()
        };

        const r = await fetch('/device/register', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(body)
        });

        const j = await r.json();
        document.getElementById('registerDeviceResp').textContent =
          j.ok ? ('OK: ' + j.dev + ' registrado') : JSON.stringify(j);

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

function buildProcessedKey(prefix, id) {
  return `${prefix}:${String(id || '').trim()}`;
}

function registerPaidEventForDev(dev, payload) {
  const st = stateByDev[dev];
  if (!st) return false;

  const fechaHora = nowAR();
  const paymentId = String(payload.payment_id || payload.order_id || '');
  const orderId = payload.order_id ? String(payload.order_id) : null;
  const amount = Number(payload.monto || 0);
  const method = String(payload.metodo || 'qr');
  const email = String(payload.email || 'sin email');
  const externalRef = payload.external_reference || null;
  const descripcion = payload.descripcion || null;
  const estado = String(payload.estado || 'processed');
  const status_detail = payload.status_detail || null;

  st.paidEvent = {
    payment_id: paymentId,
    order_id: orderId,
    at: Date.now(),
    fechaHora,
    monto: amount,
    metodo: method,
    email,
    extRef: externalRef,
    title: stateByDev[dev].lastTitle || getDevice(dev)?.title || 'Producto',
    price: stateByDev[dev].lastPrice || getDevice(dev)?.unit_price || 100
  };

  // ✅ QR one-shot: el QR vigente queda invalidado apenas se confirma el primer pago válido.
  // No se regenera por tiempo; el ESP pedirá un nuevo QR después de servir/imprimir.
  st.expectedExtRef = null;
  st.ultimaPreferencia = null;
  st.linkActual = null;
  st.qrRefreshEvent = null;
  st.rotateScheduled = false;

  saveState(stateByDev);

  console.log(`✅ Pago confirmado, QR invalidado y evento guardado hasta ACK para ${dev}`);

  const registro = {
    fechaHora,
    dev,
    email,
    estado,
    monto: amount,
    metodo: method,
    descripcion,
    payment_id: paymentId,
    preference_id: orderId || st?.ultimaPreferencia || null,
    external_reference: externalRef,
    title: stateByDev[dev].lastTitle || getDevice(dev)?.title || 'Producto',
  };

  if (!pagos.some((p) => String(p.payment_id || '') === paymentId)) {
    pagos.push(registro);
  } else {
    console.log('ℹ️ Registro ya existente en tabla, no duplico:', paymentId);
  }

  const logMsg =
    `🕒 ${fechaHora} | Dev: ${dev}` +
    ` | Producto: ${(stateByDev[dev].lastTitle || getDevice(dev)?.title || 'Producto')}` +
    ` | Monto: ${amount}` +
    ` | Pago de: ${email}` +
    ` | Estado: ${estado}` +
    (status_detail ? `/${status_detail}` : '') +
    ` | extRef: ${externalRef}` +
    ` | order: ${orderId || st?.ultimaPreferencia || ''}` +
    ` | id: ${paymentId}` +
    ` | price: ${stateByDev[dev].lastPrice || getDevice(dev)?.unit_price || 100}\n`;

  fs.appendFileSync(PAYLOG_PATH, logMsg);

  // ✅ No regenerar QR automáticamente por tiempo.
  // El próximo QR lo solicita el ESP cuando corresponda.

  return true;
}


function markQrExpiredForDev(dev, payload) {
  const st = stateByDev[dev];
  if (!st) return false;

  const orderId = payload?.order_id ? String(payload.order_id) : '';
  const externalRef = payload?.external_reference ? String(payload.external_reference) : '';

  const okExt = !!(externalRef && String(st.expectedExtRef || '') === externalRef);
  const okOrder = !!(orderId && String(st.ultimaPreferencia || '') === orderId);

  if (!okExt && !okOrder) {
    console.log('ℹ️ Expired recibido pero no corresponde al QR vigente:', {
      dev,
      externalRef,
      expectedExtRef: st.expectedExtRef,
      orderId,
      ultimaPreferencia: st.ultimaPreferencia,
    });
    return false;
  }

  console.log(`⌛ QR expirado por Mercado Pago para ${dev}. Regenerando...`, {
    orderId,
    externalRef,
  });

  st.expectedExtRef = null;
  st.ultimaPreferencia = null;
  st.linkActual = null;
  st.rotateScheduled = false;

  st.qrRefreshEvent = {
    reason: 'mp_order_expired',
    at: Date.now(),
    order_id: orderId || null,
    external_reference: externalRef || null
  };

  saveState(stateByDev);

  recargarLinkConReintento(dev, st.lastPrice, st.lastTitle);

  return true;
}

app.post('/ipn', async (req, res) => {
  let processedKey = '';

  try {
    console.log('📥 IPN recibida:', { query: req.query, body: req.body });

    const topic = String(req.query.topic || req.query.type || req.body.topic || req.body.type || '').trim();
    const action = String(req.body.action || req.query.action || '').trim();

    // ============================================================
    // NUEVO FLUJO QR / ORDERS
    // ============================================================
    if (topic === 'order' || action.startsWith('order.')) {
      const order = req.body?.data || {};
      const orderId = String(order.id || req.query['data.id'] || req.body.id || '').trim();
      const externalRef = order.external_reference || null;
      const payment = Array.isArray(order?.transactions?.payments) ? (order.transactions.payments[0] || null) : null;
      const paymentId = String(payment?.id || orderId || '').trim();

      if (!orderId && !paymentId) {
        console.log('⚠️ Webhook order sin id utilizable.');
        return res.sendStatus(200);
      }

      processedKey = buildProcessedKey('order', orderId || paymentId);

      if (processedPayments.has(processedKey) || processingPayments.has(processedKey)) {
        console.log('ℹ️ Order ya procesada o en proceso, ignoro:', processedKey);
        return res.sendStatus(200);
      }

      processingPayments.add(processedKey);

      const orderStatus = String(order.status || '').trim().toLowerCase();
      const orderStatusDetail = String(order.status_detail || '').trim().toLowerCase();
      const paymentStatus = String(payment?.status || '').trim().toLowerCase();
      const paymentStatusDetail = String(payment?.status_detail || '').trim().toLowerCase();

      const expired = (
        action === 'order.expired' ||
        orderStatus === 'expired' ||
        orderStatusDetail === 'expired' ||
        paymentStatus === 'expired' ||
        paymentStatusDetail === 'expired'
      );

      if (expired) {
        const devByExtRef = findDevByExternalRef(externalRef);
        const devByOrderId = findDevByOrderId(orderId);
        const devFallback = (externalRef ? String(externalRef).split('_')[0] : '').toLowerCase();
        const dev = (devByExtRef || devByOrderId || devFallback || '').toLowerCase();

        if (isDeviceEnabled(dev)) {
          markQrExpiredForDev(dev, {
            order_id: orderId,
            external_reference: externalRef,
          });
        } else {
          console.log('ℹ️ Order expired para dev inválido/no encontrado:', {
            dev,
            externalRef,
            orderId,
          });
        }

        processedPayments.add(processedKey);
        return res.sendStatus(200);
      }

      const approved = (
        action === 'order.processed' ||
        orderStatus === 'processed' ||
        paymentStatus === 'processed' ||
        orderStatusDetail === 'accredited' ||
        paymentStatusDetail === 'accredited'
      );

      if (!approved) {
        console.log('ℹ️ Order recibida pero no procesada todavía:', {
          action,
          orderStatus,
          orderStatusDetail,
          paymentStatus,
          paymentStatusDetail,
          orderId,
        });
        processedPayments.add(processedKey);
        return res.sendStatus(200);
      }

      const devByExtRef = findDevByExternalRef(externalRef);
      const devFallback = (externalRef ? String(externalRef).split('_')[0] : '').toLowerCase();
      const dev = (devByExtRef || devFallback || '').toLowerCase();
      const devValido = isDeviceEnabled(dev);
      const st = devValido ? stateByDev[dev] : null;
      const okExt = !!(st && externalRef && externalRef === st.expectedExtRef);
      const okOrder = !!(st && orderId && String(orderId) === String(st.ultimaPreferencia || ''));

      if (devValido && (okExt || okOrder)) {
        registerPaidEventForDev(dev, {
          payment_id: paymentId || orderId,
          order_id: orderId,
          monto: Number(payment?.paid_amount ?? payment?.amount ?? order.total_paid_amount ?? order.total_amount ?? 0),
          metodo: payment?.payment_method?.id || 'qr',
          email: 'sin email',
          external_reference: externalRef,
          descripcion: stateByDev[dev].lastTitle || getDevice(dev)?.title || 'Producto',
          estado: orderStatus || paymentStatus || 'processed',
          status_detail: orderStatusDetail || paymentStatusDetail || null,
        });

        processedPayments.add(processedKey);
        return res.sendStatus(200);
      }

      console.log('⚠️ Order procesada pero NO corresponde al QR vigente (o dev inválido). Ignorada.');
      console.log('🧪 DEBUG mismatch order:', {
        dev,
        externalRef,
        expectedExtRef: stateByDev[dev]?.expectedExtRef,
        orderId,
        ultimaPreferencia: stateByDev[dev]?.ultimaPreferencia,
      });

      processedPayments.add(processedKey);
      return res.sendStatus(200);
    }

    // ============================================================
    // FLUJO VIEJO / PAYMENT (compatibilidad)
    // ============================================================
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

    processedKey = buildProcessedKey('payment', paymentId);

    if (processedPayments.has(processedKey) || processingPayments.has(processedKey)) {
      console.log('ℹ️ Pago ya procesado o en proceso, ignoro:', processedKey);
      return res.sendStatus(200);
    }

    processingPayments.add(processedKey);

    let mpRes;
    try {
      mpRes = await fetchPaymentWithToken(paymentId, ACCESS_TOKEN);
    } catch (e) {
      console.log('ℹ️ No pude leer pago con token marketplace, pruebo tokens vendedores...');
      const clientIds = Object.keys(tokensByClient);
      let lastErr = e;

      for (const client_id of clientIds) {
        const tok = await getAccessTokenForClient(client_id);
        if (!tok) continue;
        try {
          mpRes = await fetchPaymentWithToken(paymentId, tok);
          console.log(`✅ Leí el pago con token del client_id=${client_id}`);
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

    console.log('📩 Pago recibido:', {
      estado,
      status_detail,
      email,
      monto,
      metodo,
      externalRef,
      preference_id
    });

    const devByExtRef = findDevByExternalRef(externalRef);
    const devFallback = (externalRef ? String(externalRef).split('_')[0] : '').toLowerCase();
    const dev = (devByExtRef || devFallback || '').toLowerCase();
    const devValido = isDeviceEnabled(dev);

    if (estado !== 'approved') {
      console.log(`⚠️ Pago NO aprobado (${estado}). detalle:`, status_detail);
      processedPayments.add(processedKey);
      return res.sendStatus(200);
    }

    const st = devValido ? stateByDev[dev] : null;
    const okExt = !!(st && externalRef && externalRef === st.expectedExtRef);
    const okPref = !!(st && preference_id && preference_id === st.ultimaPreferencia);

    if (devValido && (okExt || okPref)) {
      registerPaidEventForDev(dev, {
        payment_id: String(paymentId),
        order_id: preference_id || st?.ultimaPreferencia || null,
        monto,
        metodo,
        email,
        external_reference: externalRef,
        descripcion,
        estado,
        status_detail,
      });

      processedPayments.add(processedKey);
      return res.sendStatus(200);
    }

    console.log('⚠️ Pago aprobado pero NO corresponde al QR vigente (o dev inválido). Ignorado.');
    console.log('🧪 DEBUG mismatch payment:', {
      dev,
      externalRef,
      expectedExtRef: stateByDev[dev]?.expectedExtRef,
      order_id: st?.ultimaPreferencia || null,
      preference_id,
      ultimaPreferencia: stateByDev[dev]?.ultimaPreferencia,
    });

    processedPayments.add(processedKey);
    return res.sendStatus(200);
  } catch (error) {
    console.error('❌ Error en /ipn:', error.response?.data || error.message);
    return res.sendStatus(200);
  } finally {
    if (processedKey) {
      processingPayments.delete(processedKey);
    }
  }
});

// ================== ARRANQUE ==================

app.listen(PORT, () => {
  console.log(`Servidor activo en http://localhost:${PORT}`);
  console.log('Generando QRs interoperables iniciales por dev...');

  getAllowedDevs().forEach((dev) => {
    const cfg = getDevice(dev);

    if (!cfg) return;

    const tokenMode = String(cfg.token_mode || '').trim();

    if (tokenMode === 'main_account') {
      recargarLinkConReintento(dev);
      return;
    }

    if (tokenMode === 'oauth_seller') {
      const client_id = String(cfg.client_id || '').trim();
      if (!tokensByClient[client_id]?.access_token) {
        console.log(`ℹ️ ${dev} sin OAuth de cliente: no genero link inicial.`);
        return;
      }
      recargarLinkConReintento(dev);
      return;
    }

    console.log(`⚠️ ${dev} con token_mode inválido: ${JSON.stringify(cfg.token_mode)}`);
  });
});
