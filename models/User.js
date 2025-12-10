import mongoose from "mongoose";

const UserSchema = new mongoose.Schema({
  phone: { type: String, unique: true },
  pinHash: { type: String }
});

export default mongoose.model("User", UserSchema);
