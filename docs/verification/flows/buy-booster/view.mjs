export const title = "Buy a paid booster";
const screens = {
  shop: "Shop open",
  busy: "Pack reserved by another buyer",
  invoice: "Lightning invoice shown",
  expired: "Invoice expired, nothing paid",
  opened: "Your quoted pack opened",
  nextPack: "Next pack opened for your payment",
};
export const state = (v) => {
  if (screens[v.screen]) return screens[v.screen];
  if (v.screen === "away") return v.ownPackSold ? "Away, your pack sold to someone else" : "Paid, tab closed";
  return v.ownPackSold ? "Collecting with a sold pack" : "Paid, collecting cards";
};
const steps = {
  YouBuy: "you press buy",
  ShopBusy: "someone else holds the next pack",
  TryLater: "you try again later",
  YouPay: "you pay the invoice",
  InvoiceExpires: "the invoice expires",
  YouLeave: "you close the tab",
  SomeoneTakesYourPack: "the claim grace lapses and someone else claims your pack",
  YouReturn: "you come back",
  MintIssues: "the mint signs your cards",
};
export const step = (action) => steps[action] ?? null;
export const group = (v) =>
  ["opened", "nextPack"].includes(v.screen) ? "settled"
  : ["expired", "busy"].includes(v.screen) ? "stopped" : "working";
export const colors = { settled: "teal", stopped: "orange", working: "blue" };
