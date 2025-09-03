// index.js robusto (MP + ESP)
// ─────────────────────────────────────────────────────────
const express = require('express');
const axios = require('axios');
const bodyParser = require('body-parser'); // puedes usar express.json/urlencoded también
const app = express();
const PORT = process.env.PORT || 10000;

// Parsers para webhooks MP (aceptar JSON y x-www-form-urlencoded)
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(bodyParser.json()); // (redundante pero no molesta)

let linkPago = '';
let pagado = false;
let ultimoIdNotificado = '';
let ultimaPreferencia = '';      // preference_id de la última preferencia creada
let ultimaReferencia = '';       // external_reference de la última preferencia creada

const ACCESS_TOKEN = process.env.ACCESS_TOKEN || 'APP_USR-6603583526397159-042819-b68923f859e89b4ddb8e28a65eb8a76d-153083685'; // ⚠️ Tu token real de producción
const PREFERENCIA_BASE = {
  title: 'Pinta',
  quantity: 1,
  currency_id: 'ARS',
  unit_price: 100
};

// Utilidad para logs “seguros”
const log = (...args) => console.log(new Date().toISOString(), ...args);

// Generar nueva preferencia + link
async function generarNuevoLink() {
  try {
    const externalRef = `qdrink-${Date.now()}`; // referencia propia única
    const payload = {
      items: [PREFERENCIA_BASE],
      external_reference: externalRef,
      // binary_mode: true, // si querés evitar "pending" y aceptar solo aprobado/rechazado
    };
    const res = await axios.post(
      'https://api.mercadopago.com/checkout/preferences',
      payload,
      { headers: { Authorization: `Bearer ${ACCESS_TOKEN}` } }
    );

    linkPago = res.data.init_point || res.data.sandbox_init_point || '';
    ultimaPreferencia = res.data.id || '';
    ultimaReferencia = externalRef;

    log('🔄 Preferencia creada:',
      { preference_id: ultimaPreferencia, external_reference: ultimaReferencia });
    return linkPago;
  } catch (error) {
    const msg = error.response?.data || error.message;
    log('❌ Error al generar nuevo link:', msg);
    return '';
  }
}

// ───────────────── Rutas para el ESP ─────────────────

// Devuelve el link actual (si no hay, intenta crearlo)
app.get('/nuevo-link', async (req, res) => {
  try {
    if (!linkPago) {
      await generarNuevoLink();
    }
    return res.json({ link: linkPago || '' });
  } catch (e) {
    log('❌ /nuevo-link error:', e.message);
    // Nunca rompemos al ESP: devolvemos estructura válida
    return res.json({ link: '' });
  }
});

// Estado de pago: siempre responder 200 con JSON
app.get('/estado', (req, res) => {
  try {
    const estado = pagado;
    // reset después de leer true
    if (pagado) pagado = false;
    return res.json({ pagado: estado });
  } catch (e) {
    log('❌ /estado error:', e.message);
    // Blindado: devolvemos falso para que el ESP siga consultando
    return res.json({ pagado: false });
  }
});

// Salud simple para Render
app.get('/health', (req, res) => res.status(200).send('ok'));

// ───────────────── Webhook de Mercado Pago ─────────────────
// Recibe notificaciones de tipo "payment" (v1 ó v2)
app.post('/ipn', async (req, res) => {
  try {
    const id = req.query.id || req.body?.data?.id;     // v1 query o v2 body
    const topic = req.query.topic || req.body?.type;    // "payment" esperado

    if (topic !== 'payment') {
      log('ℹ️ Webhook no-payment ignorado:', topic);
      return res.sendStatus(200);
    }
    if (!id) {
      log('⚠️ Webhook sin id de pago (ignorando)');
      return res.sendStatus(200);
    }
    if (id === ultimoIdNotificado) {
      log('ℹ️ Webhook duplicado (id repetido), ignorando:', id);
      return res.sendStatus(200);
    }
    ultimoIdNotificado = id;

    // Consultar el pago en MP
    const response = await axios.get(
      `https://api.mercadopago.com/v1/payments/${id}`,
      { headers: { Authorization: `Bearer ${ACCESS_TOKEN}` } }
    );

    const data = response.data || {};
    const estado = data.status;
    const prefId = data.preference_id || '';
    const extRef = data.external_reference || '';
    const email = data.payer?.email || 'sin email';

    log('📩 Pago recibido:', { id, estado, email, prefId, extRef });
    log('🔐 Esperado:', { ultimaPreferencia, ultimaReferencia });

    // Validación robusta: preferimos external_reference, pero aceptamos también preference_id
    const coincide =
      (extRef && ultimaReferencia && extRef === ultimaReferencia) ||
      (prefId && ultimaPreferencia && prefId === ultimaPreferencia);

    if (estado === 'approved' && coincide) {
      pagado = true;
      log('✅ Pago confirmado y válido');

      // Log a archivo simple
      try {
        const fs = require('fs');
        const logMsg = `🕒 ${new Date().toLocaleString()} | Pago de: ${email} | Estado: ${estado} | pref:${prefId} | ext:${extRef}\n`;
        fs.appendFileSync('pagos.log', logMsg);
      } catch (e) {
        log('⚠️ No se pudo escribir pagos.log:', e.message);
      }

      // Regenerar link luego de 10s para invalidar QR anterior
      setTimeout(async () => {
        const nuevo = await generarNuevoLink();
        if (nuevo) {
          log('🔄 Nuevo link generado (post-aprobación)');
        }
      }, 10000);
    } else {
      log('⚠️ Pago aprobado pero no corresponde al QR actual (o falta pref/ext).');
    }

    return res.sendStatus(200);
  } catch (error) {
    const msg = error.response?.data || error.message;
    log('❌ Error en /ipn:', msg);
    return res.sendStatus(200); // Respondemos 200 para que MP no reintente agresivo
  }
});

// ───────────────── Inicio ─────────────────
(async () => {
  await generarNuevoLink(); // preparar primer link
})();

app.listen(PORT, () => {
  log(`Servidor activo en http://localhost:${PORT}`);
  log('Servicio listo en Render en la URL pública del deploy.');
});
