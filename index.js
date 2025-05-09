const express = require('express');
const axios = require('axios');
const bodyParser = require('body-parser');
const app = express();
const PORT = process.env.PORT || 10000;

app.use(bodyParser.json());

// Variables globales
let linkPago = '';
let pagado = false;
let ultimoId = '';

// Acceso a Mercado Pago
const ACCESS_TOKEN = 'APP_USR-6603583526397159-042819-b68923f859e89b4ddb8e28a65eb8a76d-153083685'; // ⬅️ tu access token real
const PREFERENCIA_BASE = {
  title: '500cm³ Cerveza Blonde',
  quantity: 1,
  currency_id: 'ARS',
  unit_price: 100
};

// Genera un nuevo link de pago
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

// Ruta para el ESP8266
app.get('/nuevo-link', async (req, res) => {
  res.json({ link: linkPago });
});

app.get('/estado', async (req, res) => {
  res.json({ pagado });

  // Si ya se pagó, restablecer la bandera (NO generar nuevo link acá)
  if (pagado) {
    pagado = false;
  }
});

// IPN de Mercado Pago
app.post('/ipn', async (req, res) => {
  const id = req.query['id'] || req.body['data']?.id;
  const topic = req.query['topic'] || req.body['type'];

  if (topic !== 'payment') return res.sendStatus(200);
  if (!id || id === ultimoId) return res.sendStatus(200); // Evita duplicados
  ultimoId = id;

  try {
    const response = await axios.get(
      `https://api.mercadopago.com/v1/payments/${id}`,
      { headers: { Authorization: `Bearer ${ACCESS_TOKEN}` } }
    );

    const estado = response.data.status;
    const emailComprador = response.data.payer?.email;
    console.log('📩 Pago recibido:', estado, emailComprador);

    if (estado === 'approved') {
      pagado = true;
      console.log('✅ Pago confirmado');

      // Esperar 15 segundos antes de generar nuevo link
      console.log('⏳ Esperando 15 segundos para generar nuevo link...');
      setTimeout(async () => {
        linkPago = await generarNuevoLink();
        console.log('🔄 Nuevo link generado (con delay)');
      }, 15000);
    }

    res.sendStatus(200);
  } catch (error) {
    console.error('❌ Error al consultar pago:', error.response?.data || error.message);
    res.sendStatus(500);
  }
});

// Inicializa el link la primera vez
(async () => {
  linkPago = await generarNuevoLink();
})();

app.listen(PORT, () => {
  console.log(`Servidor activo en http://localhost:${PORT}`);
});