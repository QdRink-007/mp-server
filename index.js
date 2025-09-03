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

// Whitelist de dispositivos y títulos por dev
const ALLOWED_DEVS = ['bar1', 'bar2', 'bar3'];
const ITEM_BY_DEV = {
  bar1: { title: 'Pinta Rubia', quantity: 1, currency_id: 'ARS', unit_price: 100 },
  bar2: { title: 'Pinta Negra', quantity: 1, currency_id: 'ARS', unit_price: 100 },
  bar3: { title: 'Pinta Roja',  quantity: 1, currency_id: 'ARS', unit_price: 100 }
};

// Estado por-dispositivo
// devices[devId] = { linkPago, pagado, ultimaPreferencia, ultimaReferencia, ultimoIdNotificado }
const devices = Object.create(null);

// Indexes inversos para mapear pagos → dev
// prefIndex[prefId] = devId, refIndex[external_reference] = devId
const prefIndex = Object.create(null);
const refIndex  = Object.create(null);

const log = (...args) => console.log(new Date().toISOString(), ...args);

function ensureDev(devId) {
  if (!devId) throw new Error('missing dev');
  if (!ALLOWED_DEVS.includes(devId)) throw new Error('invalid dev');
  if (!devices[devId]) {
    devices[devId] = {
      linkPago: '',
      pagado: false,
      ultimaPreferencia: '',
      ultimaReferencia: '',
      ultimoIdNotificado: ''
    };
  }
  return devices[devId];
}

// Crea preferencia para el dev fijo
async function generarNuevoLink(devId) {
  const dev = ensureDev(devId);
  const item = ITEM_BY_DEV[devId];
  if (!item) throw new Error('no item for dev');

  // external_reference robusto: "<devId>:<uid>"
  const extRef = `${devId}:${Date.now()}`;

  try {
    const payload = {
      items: [item],
      external_reference: extRef,
      // binary_mode: true, // opcional: fuerza aprobado/rechazado (sin "pending" largos)
    };
    const res = await axios.post(
      'https://api.mercadopago.com/checkout/preferences',
      payload,
      { headers: { Authorization: `Bearer ${ACCESS_TOKEN}` } }
    );

    const link = res.data.init_point || res.data.sandbox_init_point || '';
    const pref = res.data.id || '';

    dev.linkPago = link;
    dev.ultimaPreferencia = pref;
    dev.ultimaReferencia  = extRef;

    prefIndex[pref]  = devId;
    refIndex[extRef] = devId;

    log('🔄 Preferencia creada', { dev: devId, pref, extRef, title: item.title, price: item.unit_price });
    return link;
  } catch (e) {
    log('❌ Error al generar preferencia', e.response?.data || e.message);
    return '';
  }
}

// ─────────────── Rutas para ESP (dev obligatorio) ───────────────

// Devuelve el link actual del dispositivo (si no hay, lo crea)
app.get('/nuevo-link', async (req, res) => {
  const devId = req.query.dev;
  try {
    const dev = ensureDev(devId);
    if (!dev.linkPago) await generarNuevoLink(devId);
    return res.json({ link: dev.linkPago || '' });
  } catch (e) {
    log('❌ /nuevo-link error', e.message);
    return res.json({ link: '' }); // nunca romper al ESP
  }
});

// Devuelve y resetea el flag de pagado del dispositivo
app.get('/estado', (req, res) => {
  const devId = req.query.dev;
  try {
    const dev = ensureDev(devId);
    const estado = !!dev.pagado;
    if (dev.pagado) dev.pagado = false;
    return res.json({ pagado: estado });
  } catch (e) {
    log('❌ /estado error', e.message);
    return res.json({ pagado: false });
  }
});

// Salud simple
app.get('/health', (req, res) => res.status(200).send('ok'));

// ─────────────── Webhook de MP ───────────────
app.post('/ipn', async (req, res) => {
  try {
    const id    = req.query.id   || req.body?.data?.id;   // v1/v2
    const topic = req.query.topic|| req.body?.type;

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

    // Mapear dev por external_reference o preference_id
    let devId = null;
    if (extRef && refIndex[extRef]) {
      devId = refIndex[extRef];
    } else if (prefId && prefIndex[prefId]) {
      devId = prefIndex[prefId];
    } else if (extRef && extRef.includes(':')) {
      const guess = extRef.split(':')[0];
      if (ALLOWED_DEVS.includes(guess)) devId = guess;
    }

    log('📩 Pago recibido', { id, estado, email, prefId, extRef, devId });

    if (!devId) {
      log('⚠️ No se pudo mapear el pago a un dispositivo');
      return res.sendStatus(200);
    }
    const dev = ensureDev(devId);

    // Anti-duplicado a nivel dev
    if (dev.ultimoIdNotificado === id) {
      log('ℹ️ Webhook duplicado', { dev: devId, id });
      return res.sendStatus(200);
    }
    dev.ultimoIdNotificado = id;

    // Validación robusta: aceptamos prefId o extRef si coincide con lo vigente
    const coincide =
      (prefId && dev.ultimaPreferencia && prefId === dev.ultimaPreferencia) ||
      (extRef && dev.ultimaReferencia  && extRef === dev.ultimaReferencia);

    if (estado === 'approved' && coincide) {
      dev.pagado = true;
      log('✅ Pago confirmado', { dev: devId });

      // Regenerar SOLO el link de este dev en 10s (invalida el QR usado)
      setTimeout(async () => {
        await generarNuevoLink(devId);
        log('🔄 Nuevo link post-aprobacion', { dev: devId });
      }, 10000);
    } else {
      log('⚠️ Pago aprobado pero no coincide con preferencia/referencia vigente', {
        dev: devId,
        esperado: { pref: dev.ultimaPreferencia, ext: dev.ultimaReferencia }
      });
    }

    return res.sendStatus(200);
  } catch (e) {
    log('❌ Error en /ipn', e.response?.data || e.message);
    // Respondemos 200 igual para que MP no reintente agresivo
    return res.sendStatus(200);
  }
});

// ─────────────── Arranque ───────────────
app.listen(PORT, () => {
  log(`Servidor activo en http://localhost:${PORT}`);
  log('URL pública de Render lista (usá /nuevo-link?dev=bar1|bar2|bar3).');
});
