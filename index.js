// index.js – cola de eventos + sin spam y rotación configurable
// ─────────────────────────────────────────────────────────
const express = require('express');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 10000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ⚠️ Configurá tu token de MP en env var ACCESS_TOKEN
const ACCESS_TOKEN = process.env.ACCESS_TOKEN || 'APP_USR-6603583526397159-042819-b68923f859e89b4ddb8e28a65eb8a76d-153083685'; // ⚠️ Tu token real de producción

// ⏱️ Delay para rotar QR luego de aprobar pago (ms)
const ROTATE_DELAY_MS = Number(process.env.ROTATE_DELAY_MS || 20000); // 20 s por defecto

// Dispositivos e items
const ALLOWED_DEVS = ['bar1', 'bar2', 'bar3'];
const ITEM_BY_DEV = {
  bar1: { title: 'Pinta Rubia', quantity: 1, currency_id: 'ARS', unit_price: 100 },
  bar2: { title: 'Pinta Negra', quantity: 1, currency_id: 'ARS', unit_price: 110 },
  bar3: { title: 'Pinta Roja',  quantity: 1, currency_id: 'ARS', unit_price: 1000 }
};

// Estado por device
// devices[dev] = { linkPago, ultimaPreferencia, ultimaReferencia, ultimoIdNotificado, queue: [{ref,pref,ts}] }
const devices = Object.create(null);
const prefIndex = Object.create(null); // prefId → dev
const refIndex  = Object.create(null); // external_reference → dev

const log = (...a) => console.log(new Date().toISOString(), ...a);

function ensureDev(devId) {
  if (!devId) throw new Error('missing dev');
  if (!ALLOWED_DEVS.includes(devId)) throw new Error('invalid dev');
  if (!devices[devId]) {
    devices[devId] = {
      linkPago: '',
      ultimaPreferencia: '',
      ultimaReferencia:  '',
      ultimoIdNotificado: '',
      queue: []
    };
  }
  return devices[devId];
}

async function generarNuevoLink(devId) {
  const dev = ensureDev(devId);
  const item = ITEM_BY_DEV[devId];
  if (!item) throw new Error('no item for dev');

  const extRef = `${devId}:${Date.now()}`;

  try {
    const payload = { items: [item], external_reference: extRef /*, binary_mode: true*/ };
    const r = await axios.post(
      'https://api.mercadopago.com/checkout/preferences',
      payload,
      { headers: { Authorization: `Bearer ${ACCESS_TOKEN}` } }
    );

    const link = r.data.init_point || r.data.sandbox_init_point || '';
    const pref = r.data.id || '';

    dev.linkPago = link;
    dev.ultimaPreferencia = pref;
    dev.ultimaReferencia  = extRef;

    if (pref)   prefIndex[pref] = devId;
    if (extRef) refIndex[extRef] = devId;

    log('🔄 Preferencia creada', { dev: devId, pref, extRef, title: item.title, price: item.unit_price });
    return link;
  } catch (e) {
    log('❌ Error al generar preferencia', e.response?.data || e.message);
    return '';
  }
}

// ─────────── Rutas para el ESP ───────────

// Devuelve link vigente (o crea si falta)
app.get('/nuevo-link', async (req, res) => {
  const devId = req.query.dev;
  try {
    const dev = ensureDev(devId);
    if (!dev.linkPago) await generarNuevoLink(devId);
    return res.json({ link: dev.linkPago || '' });
  } catch (e) {
    log('❌ /nuevo-link error', e.message);
    return res.json({ link: '' });
  }
});

// Devuelve 1 evento pendiente (si hay) y lo consume
app.get('/estado', (req, res) => {
  const devId = req.query.dev;
  try {
    const dev = ensureDev(devId);
    if (dev.queue.length > 0) {
      const ev = dev.queue.shift();
      log('📤 /estado → pagado:true', { dev: devId, ref: ev.ref, pref: ev.pref, restantes: dev.queue.length });
      return res.json({ pagado: true, ref: ev.ref, pref: ev.pref });
    }
    // No spam: no logueamos pagado:false para cada poll
    return res.json({ pagado: false });
  } catch (e) {
    log('❌ /estado error', e.message);
    return res.json({ pagado: false });
  }
});

// Salud y diagnóstico
app.get('/health', (_req, res) => res.status(200).send('ok'));
app.get('/debug', (_req, res) => {
  const snap = {};
  for (const devId of ALLOWED_DEVS) {
    const d = devices[devId] || {};
    snap[devId] = {
      ultimaPreferencia: d.ultimaPreferencia || '',
      ultimaReferencia:  d.ultimaReferencia  || '',
      queueLen: (d.queue || []).length,
      linkShort: (d.linkPago || '').slice(0, 70)
    };
  }
  res.json(snap);
});

// ─────────── Webhook de MP ───────────
app.post('/ipn', async (req, res) => {
  try {
    const id    = req.query.id    || req.body?.data?.id;
    const topic = req.query.topic || req.body?.type;

    if (topic !== 'payment') return res.sendStatus(200);
    if (!id) {
      log('⚠️ Webhook sin id de pago');
      return res.sendStatus(200);
    }

    const r = await axios.get(
      `https://api.mercadopago.com/v1/payments/${id}`,
      { headers: { Authorization: `Bearer ${ACCESS_TOKEN}` } }
    );

    const data   = r.data || {};
    const estado = data.status;
    const prefId = data.preference_id || '';
    const extRef = data.external_reference || '';
    const email  = data.payer?.email || 'sin email';

    // Mapear dev
    let devId = null;
    if (extRef && refIndex[extRef])      devId = refIndex[extRef];
    else if (prefId && prefIndex[prefId]) devId = prefIndex[prefId];
    else if (extRef && extRef.includes(':')) {
      const guess = extRef.split(':')[0];
      if (ALLOWED_DEVS.includes(guess)) devId = guess;
    }

    log('📩 Pago recibido', { id, estado, email, prefId, extRef, devId });

    if (!devId) return res.sendStatus(200);
    const dev = ensureDev(devId);

    // Anti-duplicado
    if (dev.ultimoIdNotificado === id) return res.sendStatus(200);
    dev.ultimoIdNotificado = id;

    const coincide =
      (prefId && dev.ultimaPreferencia && prefId === dev.ultimaPreferencia) ||
      (extRef && dev.ultimaReferencia  && extRef === dev.ultimaReferencia);

    if (estado === 'approved' && coincide) {
      // Encolar evento
      dev.queue.push({ ref: dev.ultimaReferencia, pref: dev.ultimaPreferencia, ts: Date.now() });
      log('✅ Pago confirmado → evento encolado', { dev: devId, queueLen: dev.queue.length });

      // Rotar QR luego de un margen (para que el ESP termine y pida el nuevo link)
      setTimeout(async () => {
        const oldPref = dev.ultimaPreferencia;
        const oldRef  = dev.ultimaReferencia;
        await generarNuevoLink(devId);
        log('🔄 Nuevo enlace post-aprobación', { dev: devId, oldPref, oldRef });
      }, ROTATE_DELAY_MS);
    } else if (estado === 'approved' && !coincide) {
      log('🚫 Pago con QR ya usado', { dev: devId, prefId, extRef });
    } else {
      log('ℹ️ Pago no aprobado (estado)', { dev: devId, estado });
    }

    return res.sendStatus(200);
  } catch (e) {
    log('❌ Error en /ipn', e.response?.data || e.message);
    return res.sendStatus(200);
  }
});

// ─────────── Arranque ───────────
app.listen(PORT, () => {
  log(`Servidor activo en http://localhost:${PORT}`);
  log('URL pública Render: usa /nuevo-link?dev=bar1|bar2|bar3');
});
