const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(bodyParser.json());

let estadoPago = false;
let linkActual = "https://mpago.la/2CH2hxR"; // tu link de ejemplo inicial

app.get("/", (req, res) => {
  res.send("Servidor de Mercado Pago corriendo...");
});

// 👉 Ruta para generar un nuevo link de pago
app.get("/nuevo-link", (req, res) => {
  // Aquí podrías integrar Mercado Pago para generar un nuevo link dinámico.
  // Por ahora respondemos con uno fijo.
  res.json({ link: linkActual });
});

// 👉 Ruta IPN (notificación de pago de Mercado Pago)
app.post("/ipn", (req, res) => {
  console.log("💰 IPN recibido:", req.body);

  // Lógica simple: cuando Mercado Pago notifique, marcamos como pagado.
  estadoPago = true;

  res.sendStatus(200);
});

// 👉 Ruta para que el ESP verifique el estado del pago
app.get("/estado", (req, res) => {
  res.json({ pagado: estadoPago });

  // Reset después de notificar al ESP
  if (estadoPago) {
    console.log("🔁 Reiniciando estado...");
    estadoPago = false;
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Servidor corriendo en puerto ${PORT}`);
});