import express from "express";
import bodyParser from "body-parser";
import dotenv from "dotenv";
import { Twilio } from "twilio";
import cron from "node-cron";

dotenv.config();

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

const client = new Twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const FROM_NUMBER = process.env.TWILIO_WHATSAPP_NUMBER;

// In production → store in MongoDB
let schedules = [];

// ===================== WEBHOOK RECEIVE =====================
app.post("/webhook", (req, res) => {
  const from = req.body.From;
  const body = req.body.Body.toLowerCase();

  console.log("Incoming:", body);

  if (body.startsWith("schedule")) {
    const parts = body.split(" ");
    const time = parts[1]; // HH:mm format
    const message = parts.slice(2).join(" ");

    schedules.push({
      to: from,
      time,
      message
    });

    sendMessage(from, `Scheduled: "${message}" at ${time} every day.`);
  } else {
    sendMessage(from, "Use command:\nschedule 18:00 take your medicine");
  }

  res.sendStatus(200);
});

// ===================== SCHEDULER =====================
cron.schedule("* * * * *", () => {
  const now = new Date();
  const currentTime = now.toTimeString().slice(0, 5); // "18:00"

  schedules.forEach((job) => {
    if (job.time === currentTime) {
      sendMessage(job.to, job.message);
    }
  });
});

// ===================== SEND MESSAGE =====================
function sendMessage(to, message) {
  return client.messages.create({
    from: FROM_NUMBER,
    body: message,
    to: to
  });
}

app.listen(3000, () => console.log("Bot running on 3000"));
