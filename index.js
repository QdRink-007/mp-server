const express = require("express");
const bodyParser = require("body-parser");
const fetch = require("node-fetch");
const app = express();
const PORT = process.env.PORT || 3000;

let estadoPago = false;
let linkActual = "";

const ACCESS_TOKEN = "TEST-4699237534437950-100119-ac22e3f3c10b5b87d08f8da9ea426da1-153083685";

// Genera un link de pago con monto fijo ($100)
async function generarNuevoLink() {
  const body = {
    items: [
      {
        title: "Cerveza tirada",
        quantity: 1,
        unit_price: 100,
        currency_id: "ARS",
      },
    ],
    notification_url: "https://mp-server-c1mg.onrender.com/ipn",
  };

  const response = await fetch("https://api.mercadopago.com/checkout/preferences", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${ACCESS_TOKEN}`,
    },
    body: JSON.stringify(body),
  });

  const data = await response.json();
  return data.init_point;
}

// Middleware
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Crear el primer link al iniciar
(async () => {
  linkActual = await generarNuevoLink();
})();

// Ruta para el ESP8266: obtener el QR actual
app.get("/nuevo-link", (req, res) => {
  res.json({ link: linkActual });
});

// Ruta para el ESP8266: verificar si ya se pagó
app.get("/estado", (req, res) => {
  res.json({ pagado: estadoPago });
});

// Ruta IPN: Mercado Pago avisa que hubo un pago
app.post("/ipn", async (req, res) => {
  const paymentId = req.query["data.id"];
  const topic = req.query["type"];

  if (topic === "payment") {
    const url = `https://api.mercadopago.com/v1/payments/${paymentId}`;
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${ACCESS_TOKEN}`,
      },
    });

    const data = await response.json();

    if (data.status === "approved") {
      estadoPago = true;
      console.log("✅ Pago confirmado");

      // Espera unos segundos y genera un nuevo link
      setTimeout(async () => {
        estadoPago = false;
        linkActual = await generarNuevoLink();
        console.log("🔄 Nuevo link generado");
      }, 12000); // después del contador del ESP8266 (10 seg + margen)
    }
  }

  res.sendStatus(200);
});

app.listen(PORT, () => {
  console.log(`Servidor escuchando en puerto ${PORT}`);
});