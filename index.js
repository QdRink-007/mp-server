// index.js – Servidor QdRink multi-BAR (modo PRODUCCION mp-server)

const express = require('express');
const axios = require('axios');
const bodyParser = require('body-parser');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 10000;

// ================== CONFIG ==================

const ACCESS_TOKEN =
  process.env.MP_ACCESS_TOKEN ||
  'APP_USR-6603583526397159-042819-b68923f859e89b4ddb8e28a65eb8a76d-153083685';

const ROTATE_DELAY_MS = Number(process.env.ROTATE_DELAY_MS || 5000); // 5 s
const WEBHOOK_URL =
  process.env.WEBHOOK_URL || 'https://mp-server-c1mg.onrender.com/ipn';

const ALLOWED_DEVS = ['bar1', 'bar2', 'bar3'];

const ITEM_BY_DEV = {
  bar1: { title: 'Pinta Rubia', quantity: 1, currency_id: 'ARS', unit_price: 100 },
  bar2: { title: 'Pinta Negra', quantity: 1, currency_id: 'ARS', unit_price: 110 },
  bar3: { title: 'Pinta Roja',  quantity: 1, currency_id: 'ARS', unit_price: 120 },
};

// Estado por dispositivo
const stateByDev = {};
ALLOWED_DEVS.forEach((dev) => {
  stateByDev[dev] = {
    pagado: false,
    ultimaPreferencia: null,
    linkActual: null,
    rotateScheduled: false, // 👈 nuevo: evita rotaciones duplicadas
  };
});

// Historial de pagos + set de pagos ya procesados
const pagos = [];
const processedPayments = new Set();

// ================== MIDDLEWARE ==================

app.use(bodyParser.json());

// ================== HELPERS MP ==================

async function generarNuevoLinkParaDev(dev) {
  const item = ITEM_BY_DEV[dev];
  if (!item) throw new Error(`Item no definido para dev=${dev}`);

  const headers = { Authorization: `Bearer ${ACCESS_TOKEN}` };

  const body = {
    items: [item],
    external_reference: dev, // identifica al BAR
    notification_url: WEBHOOK_URL,
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

  console.log(`🔄 Nuevo link generado para ${dev}:`, {
    preference_id: prefId,
    link: pref.init_point,
  });

  return {
    preference_id: prefId,
    link: pref.init_point,
  };
}

function recargarLinkConReintento(dev, intento = 1) {
  const MAX_INTENTOS = 5;
  const esperaMs = 2000 * intento;

  generarNuevoLinkParaDev(dev).catch((err) => {
    console.error(
      `❌ Error al regenerar link para ${dev} (intento ${intento}):`,
      err.response?.data || err.message,
    );

    if (intento < MAX_INTENTOS) {
      console.log(
        `⏳ Reintentando generar link para ${dev} en ${esperaMs} ms...`,
      );
      setTimeout(() => recargarLinkConReintento(dev, intento + 1), esperaMs);
    } else {
      console.log(
        `⚠️ Se agotaron los reintentos para ${dev}, se mantiene el último link válido.`,
      );
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

    const info = await generarNuevoLinkParaDev(dev);

    res.json({
      dev,
      link: info.link,
      title: ITEM_BY_DEV[dev].title,
      price: ITEM_BY_DEV[dev].unit_price,
    });
  } catch (error) {
    console.error(
      '❌ Error en /nuevo-link:',
      error.response?.data || error.message,
    );
    res.status(500).json({ error: 'no se pudo generar link' });
  }
});

app.get('/estado', (req, res) => {
  const dev = (req.query.dev || '').toLowerCase();
  if (!ALLOWED_DEVS.includes(dev)) {
    return res.status(400).json({ error: 'dev invalido' });
  }

  const st = stateByDev[dev];
  const flag = st.pagado;
  if (flag) st.pagado = false; // consumimos el evento

  res.json({ dev, pagado: flag });
});

app.get('/panel', (req, res) => {
  let html = `
  <html>
  <head>
    <meta charset="utf-8" />
    <title>Panel QdRink TEST</title>
    <style>
      body { font-family: sans-serif; background:#111; color:#eee; }
      table { border-collapse: collapse; width: 100%; margin-top: 10px; }
      th, td { border: 1px solid #444; padding: 6px 8px; font-size: 13px; }
      th { background: #222; }
      tr:nth-child(even) { background:#1b1b1b; }
    </style>
  </head>
  <body>
    <h1>Panel QdRink TEST</h1>
    <table>
      <tr>
        <th>Fecha/Hora</th><th>Dev</th><th>Producto</th><th>Monto</th>
        <th>Email</th><th>Estado</th><th>Medio</th><th>payment_id</th><th>pref_id</th>
      </tr>
  `;

  pagos
    .slice()
    .reverse()
    .forEach((p) => {
      html += `
      <tr>
        <td>${p.fechaHora}</td>
        <td>${p.dev}</td>
        <td>${p.title}</td>
        <td>${p.monto}</td>
        <td>${p.email}</td>
        <td>${p.estado}</td>
        <td>${p.metodo}</td>
        <td>${p.payment_id}</td>
        <td>${p.preference_id || ''}</td>
      </tr>
    `;
    });

  html += `
    </table>
  </body>
  </html>`;

  res.send(html);
});

// ================== IPN / WEBHOOK ==================

app.post('/ipn', async (req, res) => {
  try {
    console.log('📥 IPN recibida:', { query: req.query, body: req.body });

    // Detectar tipo de evento
    const topic =
      req.query.topic ||
      req.query.type ||
      req.body.topic ||
      req.body.type;

    // Ignoramos merchant_order y cualquier cosa que no sea "payment"
    if (topic && topic !== 'payment') {
      console.log('ℹ️ IPN de tipo no-payment, se ignora:', topic);
      return res.sendStatus(200);
    }

    // Buscar paymentId en los distintos formatos
    const paymentId =
      req.query['data.id'] ||
      req.body['data.id'] ||
      req.body?.data?.id ||
      req.query.id ||
      req.body.id;

    if (!paymentId) {
      console.log('⚠️ IPN sin payment_id. Nada que hacer.');
      return res.sendStatus(200);
    }

    // Evitar procesar el mismo pago dos veces
    if (processedPayments.has(paymentId)) {
      console.log(
        'ℹ️ Pago ya procesado, se ignora payment_id =',
        paymentId,
      );
      return res.sendStatus(200);
    }

    const headers = { Authorization: `Bearer ${ACCESS_TOKEN}` };
    const url = `https://api.mercadopago.com/v1/payments/${paymentId}`;

    const mpRes = await axios.get(url, { headers });
    const data = mpRes.data;

    const estado = data.status;
    const email = data.payer?.email || 'sin email';
    const monto = data.transaction_amount;
    const metodo = data.payment_method_id;
    const descripcion = data.description;
    const externalRef = data.external_reference || null;
    const preference_id = data.preference_id || null;

    console.log('📩 Pago recibido:', {
      estado,
      email,
      monto,
      metodo,
      descripcion,
      externalRef,
    });
    console.log('🔎 preference_id del pago:', preference_id);

    const dev = ALLOWED_DEVS.includes(externalRef) ? externalRef : null;
    console.log(
      '🔐 dev detectado por external_reference:',
      dev || 'ninguno',
    );

    if (estado === 'approved' && dev) {
      const st = stateByDev[dev];
      st.pagado = true;

      processedPayments.add(paymentId); // marcamos como procesado

      const fechaHora = new Date().toLocaleString('es-AR', {
        timeZone: 'America/Argentina/Buenos_Aires',
      });

      console.log(`✅ Pago confirmado y válido para ${dev}`);

      const registro = {
        fechaHora,
        dev,
        email,
        estado,
        monto,
        metodo,
        descripcion,
        payment_id: paymentId,
        preference_id,
        title: ITEM_BY_DEV[dev].title,
      };

      pagos.push(registro);

      const logMsg =
        `🕒 ${fechaHora} | Dev: ${dev}` +
        ` | Producto: ${ITEM_BY_DEV[dev].title}` +
        ` | Monto: ${monto}` +
        ` | Pago de: ${email}` +
        ` | Estado: ${estado}` +
        ` | externalRef: ${externalRef}` +
        ` | pref: ${preference_id}` +
        ` | id: ${paymentId}\n`;

      fs.appendFileSync('pagos.log', logMsg);

      // Programar rotación de QR SOLO si aún no hay una agendada
      if (!st.rotateScheduled) {
        st.rotateScheduled = true;
        setTimeout(() => {
          recargarLinkConReintento(dev);
          st.rotateScheduled = false;
        }, ROTATE_DELAY_MS);
      } else {
        console.log(
          `ℹ️ Rotación de QR ya agendada para ${dev}, no se agenda otra.`,
        );
      }
    } else {
      console.log(
        '⚠️ Pago aprobado pero NO corresponde a ningún dev QdRink. Ignorado.',
      );
    }

    res.sendStatus(200);
  } catch (error) {
    console.error('❌ Error en /ipn:', error.response?.data || error.message);
    res.sendStatus(200); // Respondemos 200 igual para que MP no reintente infinito
  }
});

// ================== ARRANQUE ==================

app.listen(PORT, () => {
  console.log(`Servidor activo en http://localhost:${PORT}`);
  console.log('Generando links iniciales por cada dev...');
  ALLOWED_DEVS.forEach((dev) => {
    recargarLinkConReintento(dev);
  });
});
