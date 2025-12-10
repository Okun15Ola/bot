import mongoose from "mongoose";

const ReminderSchema = new mongoose.Schema({
  to: { type: String, required: true },
  time: { type: String, required: true },  // HH:mm
  message: { type: String, required: true },
  createdAt: { type: Date, default: Date.now }
});

export default mongoose.model("Reminder", ReminderSchema);
