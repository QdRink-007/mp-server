const express = require('express');
const axios = require('axios');
const bodyParser = require('body-parser');
const app = express();
const PORT = process.env.PORT || 10000;

app.use(bodyParser.json());

let linkPago = '';
let pagado = false;
let ultimoId = '';

const ACCESS_TOKEN = 'APP_USR-6603583526397159-042819-b68923f859e89b4ddb8e28a65eb8a76d-153083685'; // ⚠️ Tu token real de producción
const PREFERENCIA_BASE = {
  title: 'Pinta Frescas',
  quantity: 1,
  currency_id: 'ARS',
  unit_price: 100
};

// 🔁 Generar link
async function generarNuevoLink() {
  try {
    const res = await axios.post(
      'https://api.mercadopago.com/checkout/preferences',
      { items: [PREFERENCIA_BASE] },
      { headers: { Authorization: `Bearer ${ACCESS_TOKEN}` } }
    );
    const nuevoLink = res.data.init_point;
    console.log('🔄 Nuevo link generado');
    return nuevoLink;
  } catch (error) {
    console.error('❌ Error al generar nuevo link:', error.response?.data || error.message);
    return '';
  }
}

// 🧠 ESP pide link actual
app.get('/nuevo-link', async (req, res) => {
  res.json({ link: linkPago });
});

// ESP verifica si hubo pago
app.get('/estado', async (req, res) => {
  res.json({ pagado });
  if (pagado) pagado = false; // Reset
});

// 📨 Mercado Pago notifica
app.post('/ipn', async (req, res) => {
  const id = req.query['id'] || req.body?.data?.id;
  const topic = req.query['topic'] || req.body?.type;

  if (topic !== 'payment') return res.sendStatus(200);
  if (!id || id === ultimoId) return res.sendStatus(200);
  ultimoId = id;

  try {
    const response = await axios.get(
      `https://api.mercadopago.com/v1/payments/${id}`,
      { headers: { Authorization: `Bearer ${ACCESS_TOKEN}` } }
    );

    const estado = response.data.status;
    const email = response.data.payer?.email || 'sin email';
    console.log('📩 Pago recibido:', estado, email);

    if (estado === 'approved') {
      pagado = true;
      console.log('✅ Pago confirmado');

      // Esperar un tiempo antes de generar nuevo link
      setTimeout(async () => {
        const nuevo = await generarNuevoLink();
        if (nuevo) {
          linkPago = nuevo;
          console.log('🔄 Nuevo link generado (con delay)');
        }
      }, 10000); // Esperar 10 segundos
    }

    res.sendStatus(200);
  } catch (error) {
    console.error('❌ Error al consultar pago:', error.response?.data || error.message);
    res.sendStatus(500);
  }
});

// Inicial
(async () => {
  linkPago = await generarNuevoLink();
})();

app.listen(PORT, () => {
  console.log(`Servidor activo en http://localhost:${PORT}`);
});
