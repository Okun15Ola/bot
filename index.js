import express from "express";
import bodyParser from "body-parser";
import dotenv from "dotenv";
import cron from "node-cron";
import twilio from "twilio";
import mongoose from "mongoose";
import axios from "axios";
import bcrypt from "bcryptjs";

import Reminder from "./models/Reminder.js";
import User from "./models/User.js";

dotenv.config();

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

// ===================== TWILIO CLIENT =====================
const client = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);
const FROM_NUMBER = process.env.TWILIO_WHATSAPP_NUMBER;

// ===================== BANK DICTIONARY =====================
const bankCodes = {
  access: "044",
  accessbank: "044",
  accessbankplc: "044",

  gtbank: "058",
  gt: "058",
  guaranty: "058",
  gtco: "058",

  first: "011",
  fbn: "011",
  firstbank: "011",

  zenith: "057",
  zenithbank: "057",

  uba: "033",
  unitedbank: "033",
  unitedbankafrica: "033",

  kuda: "50211",

  moniepoint: "50515",
  moniepointmfb: "50515",

  opay: "999992",
  palmpay: "999991",

  fidelity: "070",
  sterling: "232",
  union: "032",
  wema: "035",
  keystone: "082",
  providus: "101",

  fcmb: "214",
  polaris: "076",
};

// ===================== MONGODB CONNECT =====================
mongoose
  .connect(process.env.MONGO_URI)
  .then(() => console.log("MongoDB connected"))
  .catch((err) => console.error("MongoDB error:", err));

// Pending payments waiting for PIN
let pendingPayments = {};


// ===================== WEBHOOK =====================
app.post("/webhook", async (req, res) => {
  const from = req.body.From;
  const body = req.body.Body ? req.body.Body.toLowerCase().trim() : "";

  console.log("Incoming:", from, body);

  // ========= PIN ENTRY FOR PAYMENT =========
  if (pendingPayments[from] && /^\d{4}$/.test(body)) {
    const user = await User.findOne({ phone: from });

    if (!user) {
      await sendMessage(from, "You must set a PIN first. Use: set pin 1234");
      delete pendingPayments[from];
      return res.sendStatus(200);
    }

    const isMatch = await bcrypt.compare(body, user.pinHash);

    if (!isMatch) {
      await sendMessage(from, "❌ Incorrect PIN. Payment cancelled.");
      delete pendingPayments[from];
      return res.sendStatus(200);
    }

    await sendMessage(from, "Processing your payment...");

    const p = pendingPayments[from];
    delete pendingPayments[from];

    await sendFlutterwavePayment(
      p.amount,
      p.account,
      p.bankCode,
      from
    );

    return res.sendStatus(200);
  }

  // ========= SET PIN =========
  if (body.startsWith("set pin ")) {
    const pin = body.split(" ")[2];

    if (!/^\d{4}$/.test(pin)) {
      await sendMessage(from, "PIN must be a 4-digit number.");
      return res.sendStatus(200);
    }

    const hash = await bcrypt.hash(pin, 10);

    await User.findOneAndUpdate(
      { phone: from },
      { pinHash: hash },
      { upsert: true }
    );

    await sendMessage(from, "Your PIN has been set successfully 🔐");
    return res.sendStatus(200);
  }

  // ========= PAYMENT COMMAND =========
  if (body.startsWith("pay ")) {
    const parts = body.split(" ");

    if (parts.length < 5) {
      await sendMessage(from, "Format:\npay 5000 to 1234567890 kuda");
      return res.sendStatus(200);
    }

    const amount = parts[1];
    const account = parts[3];
    const bankName = parts[4].toLowerCase();

    const bankCode = bankCodes[bankName];

    if (!bankCode) {
      await sendMessage(
        from,
        `Unknown bank: ${bankName}\nTry: kuda, gtb, access, firstbank, zenith, moniepoint, uba...`
      );
      return res.sendStatus(200);
    }

    const user = await User.findOne({ phone: from });

    if (!user) {
      await sendMessage(from, "You must set a PIN first:\nset pin 1234");
      return res.sendStatus(200);
    }

    pendingPayments[from] = { amount, account, bankCode };

    await sendMessage(
      from,
      `You want to send ₦${amount} to ${account} (${bankName.toUpperCase()}).\nEnter your 4-digit PIN to continue.`
    );

    return res.sendStatus(200);
  }

  // ========= LIST REMINDERS =========
  if (body === "list") {
    const reminders = await Reminder.find({ to: from });

    if (!reminders.length) {
      await sendMessage(from, "You have no saved reminders.");
      return res.sendStatus(200);
    }

    let msg = "Your reminders:\n\n";
    reminders.forEach((r, i) => {
      msg += `${i + 1}. "${r.message}" at ${r.time} — ID: ${r._id}\n`;
    });

    await sendMessage(from, msg);
    return res.sendStatus(200);
  }

  // ========= CANCEL ONE =========
  if (body.startsWith("cancel ")) {
    const id = body.split(" ")[1];

    try {
      const deleted = await Reminder.findByIdAndDelete(id);

      if (!deleted) await sendMessage(from, "Invalid reminder ID.");
      else await sendMessage(from, "Reminder deleted.");

    } catch {
      await sendMessage(from, "Error deleting reminder.");
    }

    return res.sendStatus(200);
  }

  // ========= CANCEL ALL =========
  if (body === "cancel all") {
    await Reminder.deleteMany({ to: from });
    await sendMessage(from, "All reminders cancelled.");
    return res.sendStatus(200);
  }

  // ========= SCHEDULE =========
  if (body.startsWith("schedule ")) {
    const parts = body.split(" ");

    if (parts.length < 3) {
      await sendMessage(from, "Format:\nschedule 18:00 take your medicine");
      return res.sendStatus(200);
    }

    const time = parts[1];
    const message = parts.slice(2).join(" ");

    await Reminder.create({
      to: from,
      time,
      message
    });

    await sendMessage(from, `Saved:\n"${message}" every day at ${time}`);
    return res.sendStatus(200);
  }

  // ========= HELP =========
  await sendMessage(
    from,
    "Commands:\n\n" +
      "• schedule 18:00 drink water\n" +
      "• list — show reminders\n" +
      "• cancel <id>\n" +
      "• cancel all\n" +
      "• set pin 1234 — set payment PIN\n" +
      "• pay 5000 to 1234567890 kuda — send money"
  );

  res.sendStatus(200);
});


// ===================== CRON =====================
cron.schedule("* * * * *", async () => {
  const now = new Date();
  const currentTime = now.toTimeString().slice(0, 5);

  const due = await Reminder.find({ time: currentTime });

  for (let r of due) {
    await sendMessage(r.to, r.message);
  }
});


// ===================== TWILIO SEND MESSAGE =====================
function sendMessage(to, message) {
  return client.messages.create({
    from: FROM_NUMBER,
    body: message,
    to: to
  });
}


// ===================== FLUTTERWAVE PAYMENT =====================
async function sendFlutterwavePayment(amount, account_number, bank_code, user) {
  try {
    const payload = {
      account_bank: bank_code,
      account_number,
      amount: Number(amount),
      currency: "NGN",
      narration: "Automated transfer",
      reference: "ref-" + Date.now()
    };

    await axios.post(
      "https://api.flutterwave.com/v3/transfers",
      payload,
      {
        headers: {
          Authorization: `Bearer ${process.env.FLW_SECRET_KEY}`,
          "Content-Type": "application/json"
        }
      }
    );

    await sendMessage(user, "Payment sent successfully! 🎉");
  } catch (err) {
    console.error(err.response?.data || err);
    await sendMessage(user, "❌ Payment failed.");
  }
}


// ===================== PORT =====================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Bot running on port", PORT));
