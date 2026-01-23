// index.js – Servidor QdRink multi-BAR (modo PRODUCCION mp-server)
// ✅ Fixes:
// 1) Evento de pago persistente hasta ACK (evita perder pagos por timing / timeouts)
// 2) external_reference ÚNICO por cada QR (evita pagos atrasados / reintentos que “peguen” a QR viejo)
// 3) /estado ya NO “consume” el pago; se consume con /ack
// 4) Logs más claros (no dice “pago aprobado” si está rechazado)

const express = require('express');
const axios = require('axios');
const bodyParser = require('body-parser');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 10000;

// ================== CONFIG ==================

const ACCESS_TOKEN =
  process.env.MP_ACCESS_TOKEN ||
  'APP_USR-6603583526397159-042819-b68923f859e89b4ddb8e28a65eb8a76d-153083685'; // <-- Recomendado: usar ENV

const ROTATE_DELAY_MS = Number(process.env.ROTATE_DELAY_MS || 5000); // 5 s
const WEBHOOK_URL =
  process.env.WEBHOOK_URL || 'https://mp-server-c1mg.onrender.com/ipn';

const ALLOWED_DEVS = ['bar1', 'bar2', 'bar3'];

const ITEM_BY_DEV = {
  bar1: { title: 'Pinta Rubia', quantity: 1, currency_id: 'ARS', unit_price: 2000 },
  bar2: { title: 'Pinta', quantity: 1, currency_id: 'ARS', unit_price: 2000 },
  bar3: { title: 'Pinta Roja',  quantity: 1, currency_id: 'ARS', unit_price: 120 },
};

// Estado por dispositivo
// paidEvent persiste hasta que el ESP haga /ack
const stateByDev = {};
ALLOWED_DEVS.forEach((dev) => {
  stateByDev[dev] = {
    paidEvent: null,          // { payment_id, at, monto, metodo, email, extRef }
    expectedExtRef: null,     // external_reference del QR vigente (UNICO)
    ultimaPreferencia: null,  // preference_id (para log)
    linkActual: null,         // init_point
    rotateScheduled: false,   // evita rotaciones duplicadas
  };
});

// Historial de pagos + set de pagos ya procesados
const pagos = [];
const processedPayments = new Set();

// ================== MIDDLEWARE ==================

app.use(bodyParser.json());

// ================== HELPERS MP ==================

function buildUniqueExtRef(dev) {
  // ÚNICO por QR, para validar que el pago corresponde al QR vigente
  return `${dev}:${Date.now()}`;
}

function nowAR() {
  return new Date().toLocaleString('es-AR', {
    timeZone: 'America/Argentina/Buenos_Aires',
  });
}

async function generarNuevoLinkParaDev(dev) {
  const item = ITEM_BY_DEV[dev];
  if (!item) throw new Error(`Item no definido para dev=${dev}`);

  const headers = { Authorization: `Bearer ${ACCESS_TOKEN}` };

  const extRef = buildUniqueExtRef(dev);

  const body = {
    items: [item],
    external_reference: extRef, // ✅ único por QR
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
  stateByDev[dev].expectedExtRef = extRef;

  console.log(`🔄 Nuevo link generado para ${dev}:`, {
    preference_id: prefId,
    external_reference: extRef,
    link: pref.init_point,
  });

  return {
    preference_id: prefId,
    external_reference: extRef,
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
      console.log(`⏳ Reintentando generar link para ${dev} en ${esperaMs} ms...`);
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
      external_reference: info.external_reference, // útil para debug
    });
  } catch (error) {
    console.error('❌ Error en /nuevo-link:', error.response?.data || error.message);
    res.status(500).json({ error: 'no se pudo generar link' });
  }
});

// ✅ YA NO CONSUME: devuelve el evento pendiente (o null)
app.get('/estado', (req, res) => {
  const dev = (req.query.dev || '').toLowerCase();
  if (!ALLOWED_DEVS.includes(dev)) {
    return res.status(400).json({ error: 'dev invalido' });
  }

  const st = stateByDev[dev];
  res.json({
    dev,
    paidEvent: st.paidEvent, // { payment_id, ... } o null
  });
});

// ✅ ACK: el ESP confirma que ya accionó el relé
app.get('/ack', (req, res) => {
  const dev = (req.query.dev || '').toLowerCase();
  const payment_id = String(req.query.payment_id || '');

  if (!ALLOWED_DEVS.includes(dev)) {
    return res.status(400).json({ error: 'dev invalido' });
  }
  if (!payment_id) {
    return res.status(400).json({ error: 'payment_id requerido' });
  }

  const st = stateByDev[dev];
  if (st.paidEvent && String(st.paidEvent.payment_id) === payment_id) {
    st.paidEvent = null;
    return res.json({ ok: true });
  }

  res.json({ ok: false });
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
      .muted { color:#aaa; font-size: 12px; }
    </style>
  </head>
  <body>
    <h1>Panel QdRink TEST</h1>
    <div class="muted">Estado actual por dev:</div>
    <pre class="muted">${escapeHtml(JSON.stringify(stateByDev, null, 2))}</pre>
    <table>
      <tr>
        <th>Fecha/Hora</th><th>Dev</th><th>Producto</th><th>Monto</th>
        <th>Email</th><th>Estado</th><th>Medio</th><th>payment_id</th><th>pref_id</th><th>ext_ref</th>
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
        <td>${p.external_reference || ''}</td>
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
    if (processedPayments.has(String(paymentId))) {
      console.log('ℹ️ Pago ya procesado, se ignora payment_id =', paymentId);
      return res.sendStatus(200);
    }

    const headers = { Authorization: `Bearer ${ACCESS_TOKEN}` };
    const url = `https://api.mercadopago.com/v1/payments/${paymentId}`;

    const mpRes = await axios.get(url, { headers });
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
      descripcion,
      externalRef,
    });
    console.log('🔎 preference_id del pago:', preference_id);

    // dev viene dentro de external_reference = "bar1:timestamp"
    const dev = (externalRef ? String(externalRef).split(':')[0] : '').toLowerCase();
    const devValido = ALLOWED_DEVS.includes(dev);

    console.log('🔐 dev detectado por external_reference:', devValido ? dev : 'ninguno');
    if (devValido) {
      console.log('🔐 extRef esperado (QR vigente):', stateByDev[dev].expectedExtRef);
      console.log('🔐 extRef recibido (pago):', externalRef);
    }

    // Caso no aprobado: solo logueamos
    if (estado !== 'approved') {
      console.log(`⚠️ Pago NO aprobado (${estado}). Detalle:`, status_detail);
      // marcamos como procesado igual para no spamear logs con reintentos del mismo paymentId
      processedPayments.add(String(paymentId));
      return res.sendStatus(200);
    }

    // Validación fuerte: aprobado + dev válido + extRef coincide con QR vigente
    if (devValido && externalRef && externalRef === stateByDev[dev].expectedExtRef) {
      const st = stateByDev[dev];

      // Guardar evento persistente (hasta /ack)
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
      console.log(`✅ Pago confirmado y válido para ${dev} (evento guardado hasta ACK)`);

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
        console.log(`ℹ️ Rotación de QR ya agendada para ${dev}, no se agenda otra.`);
      }
    } else {
      // Aprobado pero no corresponde al QR vigente o dev no válido
      console.log('⚠️ Pago aprobado pero NO corresponde al QR vigente (o dev inválido). Ignorado.');
      processedPayments.add(String(paymentId));
    }

    res.sendStatus(200);
  } catch (error) {
    console.error('❌ Error en /ipn:', error.response?.data || error.message);
    res.sendStatus(200); // 200 igual para evitar reintentos infinitos
  }
});

// ================== UTILS ==================

function escapeHtml(str) {
  return String(str)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

// ================== ARRANQUE ==================

app.listen(PORT, () => {
  console.log(`Servidor activo en http://localhost:${PORT}`);
  console.log('Generando links iniciales por cada dev...');
  ALLOWED_DEVS.forEach((dev) => {
    recargarLinkConReintento(dev);
  });
});
