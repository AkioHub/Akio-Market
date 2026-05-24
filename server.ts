import express from "express";
import { createServer as createViteServer } from "vite";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import midtransClient from 'midtrans-client';
import admin from 'firebase-admin';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Initialize Firebase Admin
try {
  const firebaseConfig = JSON.parse(await fs.readFile(path.join(__dirname, "firebase-applet-config.json"), "utf-8"));
  admin.initializeApp({
    projectId: firebaseConfig.projectId,
  });
  console.log("Firebase Admin initialized");
} catch (error) {
  console.error("Firebase Admin initialization error:", error);
}

const db = admin.firestore();

// Initialize Midtrans
let snap: midtransClient.Snap | null = null;

function getSnap() {
  if (!snap) {
    const serverKey = (process.env.MIDTRANS_SERVER_KEY || '').trim();
    const clientKey = (process.env.MIDTRANS_CLIENT_KEY || '').trim();
    const isProduction = process.env.MIDTRANS_IS_PRODUCTION === 'true';

    console.log(`Loading Midtrans configuration: Environment MIDTRANS_IS_PRODUCTION='${process.env.MIDTRANS_IS_PRODUCTION}'`);
    console.log(`Final Snap configuration: isProduction=${isProduction}`);
    console.log(`Server Key present: ${!!serverKey}, Client Key present: ${!!clientKey}`);                
    if (!serverKey || !clientKey || serverKey === 'YOUR_MIDTRANS_SERVER_KEY' || clientKey === 'YOUR_MIDTRANS_CLIENT_KEY' || serverKey.includes('YOUR_SERVER_KEY')) {
      console.error("Midtrans billing keys are missing or still set to default placeholders.");
      throw new Error("MIDTRANS_SERVER_KEY dan MIDTRANS_CLIENT_KEY must be configured in environment secrets.");
    }

    snap = new midtransClient.Snap({
      isProduction: isProduction,
      serverKey: serverKey,
      clientKey: clientKey
    });
  }
  return snap;
}

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json());

  // Midtrans Token Endpoint
  app.post("/api/payment/token", async (req, res) => {
    try {
      const { orderId, amount, itemDetails, customerDetails } = req.body;

      if (!orderId || !amount) {
        return res.status(400).json({ message: "Order ID and amount are required" });
      }

      const parameter = {
        transaction_details: {
          order_id: orderId,
          gross_amount: Math.round(amount)
        },
        item_details: itemDetails?.map((item: any) => ({
          ...item,
          price: Math.round(item.price)
        })),
        customer_details: customerDetails,
        credit_card: {
          secure: true
        }
      };

      const transaction = await getSnap().createTransaction(parameter);
      res.json({ token: transaction.token, redirect_url: transaction.redirect_url });
    } catch (error: any) {
      console.error("Midtrans token error:", error);
      let errorMessage = error.message;
      
      // Try to extract more useful info from Midtrans API response
      if (error.ApiResponse) {
        try {
          const apiResp = typeof error.ApiResponse === 'string' ? JSON.parse(error.ApiResponse) : error.ApiResponse;
          if (apiResp.error_messages && Array.isArray(apiResp.error_messages)) {
            errorMessage = apiResp.error_messages.join(", ");
          }
        } catch (e) {
          console.error("Could not parse Midtrans ApiResponse", e);
        }
      }
      
      res.status(500).json({ message: errorMessage });
    }
  });

  // Midtrans Status Check Endpoint
  app.get("/api/payment/status/:orderId", async (req, res) => {
    try {
      const orderId = req.params.orderId;
      const statusResponse = await getSnap().transaction.status(orderId);

      const transactionStatus = statusResponse.transaction_status;
      const fraudStatus = statusResponse.fraud_status;

      let orderStatus = 'pending';

      if (transactionStatus === 'capture') {
        if (fraudStatus === 'challenge') {
          orderStatus = 'challenge';
        } else if (fraudStatus === 'accept') {
          orderStatus = 'paid';
        }
      } else if (transactionStatus === 'settlement') {
        orderStatus = 'paid';
      } else if (transactionStatus === 'cancel' || transactionStatus === 'deny' || transactionStatus === 'expire') {
        orderStatus = 'failed';
      } else if (transactionStatus === 'pending') {
        orderStatus = 'pending';
      }

      // Update Order in Firestore
      if (orderId) {
        const orderRef = db.collection('orders').doc(orderId);
        await orderRef.update({
          status: orderStatus,
          paymentDetails: {
            status: transactionStatus,
            type: statusResponse.payment_type || '',
            time: statusResponse.transaction_time || ''
          },
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });
      }

      res.status(200).json({ status: orderStatus, midtrans_status: transactionStatus });
    } catch (error: any) {
      console.error("Midtrans status check error:", error);
      res.status(500).json({ message: error.message });
    }
  });

  // Midtrans Webhook Endpoint
  app.post("/api/payment/webhook", async (req, res) => {
    try {
      const notification = req.body;
      const statusResponse = await getSnap().transaction.notification(notification);

      const orderId = statusResponse.order_id;
      const transactionStatus = statusResponse.transaction_status;
      const fraudStatus = statusResponse.fraud_status;

      console.log(`Transaction notification received. Order ID: ${orderId}. Status: ${transactionStatus}. Fraud Status: ${fraudStatus}`);

      let orderStatus = 'pending';

      if (transactionStatus === 'capture') {
        if (fraudStatus === 'challenge') {
          orderStatus = 'challenge';
        } else if (fraudStatus === 'accept') {
          orderStatus = 'paid';
        }
      } else if (transactionStatus === 'settlement') {
        orderStatus = 'paid';
      } else if (transactionStatus === 'cancel' || transactionStatus === 'deny' || transactionStatus === 'expire') {
        orderStatus = 'failed';
      } else if (transactionStatus === 'pending') {
        orderStatus = 'pending';
      }

      // Update Order in Firestore
      if (orderId) {
        const orderRef = db.collection('orders').doc(orderId);
        await orderRef.update({
          status: orderStatus,
          paymentDetails: {
            status: transactionStatus,
            type: statusResponse.payment_type,
            time: statusResponse.transaction_time
          },
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });
      }

      res.status(200).send('OK');
    } catch (error: any) {
      console.error("Midtrans webhook error:", error);
      res.status(500).json({ message: error.message });
    }
  });

  // API Routes (Legacy/Existing)
  app.get("/api/health", (req, res) => {
    res.json({ status: "ok" });
  });

  // Vite middleware
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
