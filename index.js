// index.js (multi-dispositivo fijo: bar1, bar2, bar3)
// ─────────────────────────────────────────────────────────
const express = require('express');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 10000;

// Parsers para webhooks MP (acepta JSON y x-www-form-urlencoded)
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ⚠️ Configurá tu token en variables de entorno de Render:
// KEY: ACCESS_TOKEN, VALUE: APP_USR-xxxxx...
const ACCESS_TOKEN = process.env.ACCESS_TOKEN || 'APP_USR-6603583526397159-042819-b68923f859e89b4ddb8e28a65eb8a76d-153083685'; // ⚠️ Tu token real de producción

// Dispositivos habilitados e ítems por dev
const ALLOWED_DEVS = ['bar1', 'bar2', 'bar3'];
const ITEM_BY_DEV = {
  bar1: { title: 'Pinta Rubia', quantity: 1, currency_id: 'ARS', unit_price: 100 },
  bar2: { title: 'Pinta Negra', quantity: 1, currency_id: 'ARS', unit_price: 110 },
  bar3: { title: 'Pinta Roja',  quantity: 1, currency_id: 'ARS', unit_price: 1000 }
};

// Estado por dispositivo
// devices[devId] = {
//   linkPago, ultimaPreferencia, ultimaReferencia, ultimoIdNotificado,
//   queue: [{ref, pref, ts}], // eventos pendientes de “pagado”
// }
const devices = Object.create(null);

// Índices inversos para mapear pagos → dev
const prefIndex = Object.create(null);   // prefId → devId
const refIndex  = Object.create(null);   // external_reference → devId

const log = (...args) => console.log(new Date().toISOString(), ...args);

function ensureDev(devId) {
  if (!devId) throw new Error('missing dev');
  if (!ALLOWED_DEVS.includes(devId)) throw new Error('invalid dev');
  if (!devices[devId]) {
    devices[devId] = {
      linkPago: '',
      ultimaPreferencia: '',
      ultimaReferencia: '',
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

  const extRef = `${devId}:${Date.now()}`;  // ref única robusta

  try {
    const payload = {
      items: [item],
      external_reference: extRef,
      // binary_mode: true, // si querés forzar aprobación inmediata (sin pending)
    };
    const res = await axios.post(
      'https://api.mercadopago.com/checkout/preferences',
      payload,
      { headers: { Authorization: `Bearer ${ACCESS_TOKEN}` } }
    );

    const link = res.data.init_point || res.data.sandbox_init_point || '';
    const pref = res.data.id || '';

    // Actualizamos estado vigente
    dev.linkPago = link;
    dev.ultimaPreferencia = pref;
    dev.ultimaReferencia  = extRef;

    // Reindexar
    if (pref)  prefIndex[pref]  = devId;
    if (extRef) refIndex[extRef] = devId;

    log('🔄 Preferencia creada', { dev: devId, pref, extRef, title: item.title, price: item.unit_price });
    return link;
  } catch (e) {
    log('❌ Error al generar preferencia', e.response?.data || e.message);
    return '';
  }
}

// ─────────────── Rutas para ESP ───────────────

// Devuelve un link (reusa o crea si falta)
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

// Devuelve un evento pendiente (si hay), y lo consume (POP)
app.get('/estado', (req, res) => {
  const devId = req.query.dev;
  try {
    const dev = ensureDev(devId);

    if (dev.queue.length > 0) {
      const ev = dev.queue.shift(); // consume un evento
      log('📤 /estado → pagado:true', { dev: devId, ref: ev.ref, pref: ev.pref, restantes: dev.queue.length });
      return res.json({ pagado: true, ref: ev.ref, pref: ev.pref });
    } else {
      log('📤 /estado → pagado:false', { dev: devId });
      return res.json({ pagado: false });
    }
  } catch (e) {
    log('❌ /estado error', e.message);
    return res.json({ pagado: false });
  }
});

// Salud
app.get('/health', (_req, res) => res.status(200).send('ok'));

// Debug: estado por-dev (NO expongas en producción pública)
app.get('/debug', (_req, res) => {
  const snapshot = {};
  for (const devId of ALLOWED_DEVS) {
    const d = devices[devId] || {};
    snapshot[devId] = {
      ultimaPreferencia: d.ultimaPreferencia || '',
      ultimaReferencia:  d.ultimaReferencia || '',
      queueLen: (d.queue || []).length,
      linkShort: (d.linkPago || '').slice(0, 60) + (d.linkPago && d.linkPago.length > 60 ? '…' : '')
    };
  }
  res.json(snapshot);
});

// ─────────────── Webhook de MP ───────────────
app.post('/ipn', async (req, res) => {
  try {
    const id    = req.query.id    || req.body?.data?.id;  // v1/v2
    const topic = req.query.topic || req.body?.type;

    if (topic !== 'payment') {
      log('ℹ️ Webhook ignorado (topic)', topic);
      return res.sendStatus(200);
    }
    if (!id) {
      log('⚠️ Webhook sin id de pago');
      return res.sendStatus(200);
    }

    // Consultar pago a MP
    const r = await axios.get(
      `https://api.mercadopago.com/v1/payments/${id}`,
      { headers: { Authorization: `Bearer ${ACCESS_TOKEN}` } }
    );

    const data   = r.data || {};
    const estado = data.status;
    const prefId = data.preference_id || '';
    const extRef = data.external_reference || '';
    const email  = data.payer?.email || 'sin email';

    // Mapear dev (por external_reference o preference_id)
    let devId = null;
    if (extRef && refIndex[extRef])      devId = refIndex[extRef];
    else if (prefId && prefIndex[prefId]) devId = prefIndex[prefId];
    else if (extRef && extRef.includes(':')) {
      const guess = extRef.split(':')[0];
      if (ALLOWED_DEVS.includes(guess)) devId = guess;
    }

    log('📩 Pago recibido', { id, estado, email, prefId, extRef, devId });

    if (!devId) {
      log('⚠️ No se pudo mapear el pago a un dispositivo');
      return res.sendStatus(200);
    }
    const dev = ensureDev(devId);

    // Anti-duplicados por id de pago
    if (dev.ultimoIdNotificado === id) {
      log('ℹ️ Webhook duplicado', { dev: devId, id });
      return res.sendStatus(200);
    }
    dev.ultimoIdNotificado = id;

    // ¿Coincide con lo vigente?
    const coincide =
      (prefId && dev.ultimaPreferencia && prefId === dev.ultimaPreferencia) ||
      (extRef && dev.ultimaReferencia  && extRef === dev.ultimaReferencia);

    if (estado === 'approved' && coincide) {
      // Encolar evento de pago para el ESP
      dev.queue.push({
        ref: dev.ultimaReferencia,
        pref: dev.ultimaPreferencia,
        ts: Date.now()
      });
      log('✅ Pago confirmado → evento encolado', {
        dev: devId, queueLen: dev.queue.length
      });

      // Regenerar el link (invalidar QR usado)
      setTimeout(async () => {
        const oldPref = dev.ultimaPreferencia;
        const oldRef  = dev.ultimaReferencia;
        await generarNuevoLink(devId);
        log('🔄 Nuevo link post-aprobación', { dev: devId, oldPref, oldRef });
      }, 8000); // podés subir/bajar este delay
    } else if (estado === 'approved' && !coincide) {
      // Pago aprobado pero por un QR ya reemplazado → ignorar
      log('🚫 Pago con QR ya usado', { dev: devId, prefId, extRef });
    } else {
      log('ℹ️ Pago no aprobado (estado)', { dev: devId, estado });
    }

    return res.sendStatus(200);
  } catch (e) {
    log('❌ Error en /ipn', e.response?.data || e.message);
    // Igual 200 para que MP no reintente agresivo
    return res.sendStatus(200);
  }
});

// ─────────────── Arranque ───────────────
app.listen(PORT, () => {
  log(`Servidor activo en http://localhost:${PORT}`);
  log('URL pública de Render lista (usá /nuevo-link?dev=bar1|bar2|bar3).');
});
