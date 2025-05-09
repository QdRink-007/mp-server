const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const fetch = require('node-fetch');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(bodyParser.json());

let ultimoEstadoPago = 'pendiente';
let ultimoLinkPago = null;
let ultimoIdPago = null;

// Generar link de pago
app.get('/generar-link', async (req, res) => {
  try {
    const response = await fetch('https://api.mercadopago.com/checkout/preferences', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        items: [{
          title: 'Producto',
          quantity: 1,
          unit_price: 100
        }],
        notification_url: `${process.env.IPN_URL}`,
        external_reference: 'arduino-test'
      })
    });

    const data = await response.json();
    ultimoLinkPago = data.init_point;
    ultimoEstadoPago = 'pendiente';
    ultimoIdPago = null;

    res.json({ url: data.init_point });
  } catch (error) {
    console.error('Error generando link:', error);
    res.status(500).json({ error: 'Error generando link de pago' });
  }
});

// Endpoint para ESP8266
app.get('/estado', (req, res) => {
  res.json({
    estado: ultimoEstadoPago,
    url: ultimoLinkPago,
    id: ultimoIdPago
  });
});

// IPN - Mercado Pago enviará aquí los pagos confirmados
app.get('/ipn', async (req, res) => {
  const { id, topic } = req.query;

  if (topic === 'payment') {
    try {
      const response = await fetch(`https://api.mercadopago.com/v1/payments/${id}`, {
        headers: {
          Authorization: `Bearer ${process.env.ACCESS_TOKEN}`
        }
      });

      const data = await response.json();

      if (data.status === 'approved') {
        ultimoEstadoPago = 'aprobado';
        ultimoIdPago = data.id;
        console.log('Pago aprobado:', data.id);
      } else {
        ultimoEstadoPago = data.status;
        ultimoIdPago = data.id;
        console.log('Pago no aprobado:', data.status);
      }

      res.sendStatus(200);
    } catch (error) {
      console.error('Error al consultar pago:', error);
      res.sendStatus(500);
    }
  } else {
    res.sendStatus(400);
  }
});

// Inicia el servidor
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor corriendo en puerto ${PORT}`));

app.get("/", (req, res) => {
  res.send("Servidor de Mercado Pago corriendo...");
});